const WebSocket = require('ws');
const zlib = require('zlib');
const crypto = require('crypto');
const { SimpleZSTD } = require('simple-zstd');
const User = require('./models/user');
const Guild = require('./models/guild');
const Message = require('./models/message');
const UserSettingsProto = require('./models/userSettingsProto');
const db = require('./db');
const { parseDiscordToken, verifyDiscordToken } = require('./utils/discordAuth');

const CLOSE_DECODE_ERROR = 1007;
const CLOSE_POLICY_VIOLATION = 1008;
const connections = new Set();

const createZlibCompressor = () => {
  const stream = zlib.createDeflate({
    flush: zlib.constants.Z_SYNC_FLUSH,
    finishFlush: zlib.constants.Z_SYNC_FLUSH,
  });
  stream.on('error', (err) => console.error('Zlib compressor error:', err));
  return stream;
};

const ensureZstdSession = (ws) => {
  if (!ws._zstdSession) {
    ws._zstdSession = SimpleZSTD.create();
  }
  return ws._zstdSession;
};

const closeWithCode = (conn, code, reason) => {
  if (!conn || conn.readyState !== WebSocket.OPEN) {
    return;
  }
  conn.close(code, reason);
};

const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');

const getOptionalParam = (req, key) => {
  const url = new URL(req.url || '', 'http://localhost');
  return url.searchParams.get(key) || null;
};

const buildGatewayUrl = ({ protocol = 'ws', host, port, version, encoding, compress }) => {
  const baseUrl = new URL(`${protocol}://${host}`);
  if (port) {
    baseUrl.port = String(port);
  }
  baseUrl.searchParams.set('v', String(version));
  baseUrl.searchParams.set('encoding', encoding);
  if (compress) {
    baseUrl.searchParams.set('compress', compress);
  }
  return baseUrl.toString();
};

const buildTrace = () => [`["wishcord-js-gateway",{"micros":0}]`];

const buildGatewayUser = (user) => ({
  id: user.id,
  username: user.username,
  discriminator: user.discriminator || '0000',
  global_name: user.global_name,
  avatar: user.avatar || null,
  avatar_decoration_data: null,
  banner: null,
  banner_color: null,
  accent_color: null,
  bio: user.bio || '',
  locale: 'en-US',
  nsfw_allowed: true,
  mfa_enabled: false,
  premium_type: 0,
  public_flags: 0,
  flags: 0,
  verified: Boolean(user.verified),
  email: user.email,
  bot: false,
  system: false,
});

const omit = (object, keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));

const buildMessageDispatchPayload = async (message) => {
  const channel = await Guild.getChannelRecord(message.channel_id);
  if (!channel) {
    return null;
  }

  const [member, hydratedMessage] = await Promise.all([
    Guild.getMember(channel.guild_id, message.author.id),
    Message.get(message.channel_id, message.id),
  ]);

  if (!hydratedMessage) {
    return null;
  }

  return {
    ...hydratedMessage,
    channel_type: channel.type,
    guild_id: String(channel.guild_id),
    member: member ? omit(member, ['user', 'permissions']) : undefined,
  };
};

const sendDispatch = async (ws, eventName, data) => {
  ws._session.sequence += 1;
  await sendGateway(ws, {
    op: 0,
    t: eventName,
    s: ws._session.sequence,
    d: data,
  });
};

const getInterestedConnectionsForChannel = async (channelId) => {
  const channel = await Guild.getChannelRecord(channelId);
  if (!channel) {
    return [];
  }

  const connected = Array.from(connections).filter((ws) => ws.readyState === WebSocket.OPEN && ws._session?.identified && ws._user);
  const interested = [];

  for (const ws of connected) {
    const context = await Guild.getContext(channel.guild_id, ws._user.id);
    if (context && Guild.canViewChannel(context, String(channelId))) {
      interested.push(ws);
    }
  }

  return interested;
};

const broadcastMessageCreate = async (message) => {
  const payload = await buildMessageDispatchPayload(message);
  if (!payload) {
    return;
  }
  const targets = await getInterestedConnectionsForChannel(message.channel_id);
  await Promise.all(targets
    .filter((ws) => String(ws._user?.id) !== String(message.author.id))
    .map((ws) => sendDispatch(ws, 'MESSAGE_CREATE', payload).catch((error) => {
    console.error('Gateway MESSAGE_CREATE dispatch failed:', error);
    })));
};

const broadcastMessageUpdate = async (message) => {
  const payload = await buildMessageDispatchPayload(message);
  if (!payload) {
    return;
  }
  const targets = await getInterestedConnectionsForChannel(message.channel_id);
  await Promise.all(targets.map((ws) => sendDispatch(ws, 'MESSAGE_UPDATE', payload).catch((error) => {
    console.error('Gateway MESSAGE_UPDATE dispatch failed:', error);
  })));
};

const broadcastMessageDelete = async ({ id, channelId, guildId }) => {
  const targets = await getInterestedConnectionsForChannel(channelId);
  const payload = {
    id: String(id),
    channel_id: String(channelId),
    guild_id: guildId ? String(guildId) : undefined,
  };
  await Promise.all(targets.map((ws) => sendDispatch(ws, 'MESSAGE_DELETE', payload).catch((error) => {
    console.error('Gateway MESSAGE_DELETE dispatch failed:', error);
  })));
};

const getConnectionsForUser = (userId) =>
  Array.from(connections).filter((ws) => ws.readyState === WebSocket.OPEN && String(ws._user?.id) === String(userId));

const broadcastUserSettingsProtoUpdate = async (userId, payload) => {
  const targets = getConnectionsForUser(userId);
  await Promise.all(targets.map((ws) => sendDispatch(ws, 'USER_SETTINGS_PROTO_UPDATE', payload).catch((error) => {
    console.error('Gateway USER_SETTINGS_PROTO_UPDATE dispatch failed:', error);
  })));
};

const buildPresenceForMember = (member, guildId) => ({
  user: { id: String(member.user.id) },
  guild_id: String(guildId),
  status: 'online',
  activities: [],
  client_status: { web: 'online' },
});

const sendGuildMembersChunk = async (ws, guildId, members, options = {}) => {
  const chunkSize = 1000;
  const chunkCount = Math.max(1, Math.ceil(members.length / chunkSize));
  for (let index = 0; index < chunkCount; index += 1) {
    const slice = members.slice(index * chunkSize, (index + 1) * chunkSize);
    await sendDispatch(ws, 'GUILD_MEMBERS_CHUNK', {
      guild_id: String(guildId),
      members: slice,
      chunk_index: index,
      chunk_count: chunkCount,
      not_found: options.notFound?.length ? options.notFound : undefined,
      presences: options.presences ? slice.map((member) => buildPresenceForMember(member, guildId)) : undefined,
      nonce: options.nonce || undefined,
    });
  }
};

const toMemberListItem = (member) => ({
  member: {
    ...omit(member, ['permissions']),
    user: member.user,
  },
});

const buildMemberListOps = (members, channelRanges = []) => {
  const normalizedRanges = Array.isArray(channelRanges) && channelRanges.length
    ? channelRanges
    : [[0, Math.max(0, members.length - 1)]];

  return normalizedRanges.map((range) => {
    const start = Math.max(0, Number(range?.[0]) || 0);
    const end = Math.max(start, Number(range?.[1]) || start);
    const slice = members.slice(start, end + 1);

    return {
      op: 'SYNC',
      range: [start, end],
      items: slice.map(toMemberListItem),
    };
  });
};

const sendGuildMemberListUpdate = async (ws, guildId, subscription = {}) => {
  const context = await Guild.getContext(guildId, ws._user.id);
  if (!context) {
    return;
  }

  const members = await Guild.listMembers(guildId);
  const channels = subscription.channels && typeof subscription.channels === 'object'
    ? subscription.channels
    : {};
  const channelEntries = Object.entries(channels);

  if (!channelEntries.length) {
    await sendDispatch(ws, 'GUILD_MEMBER_LIST_UPDATE', {
      guild_id: String(guildId),
      id: 'everyone',
      member_count: members.length,
      online_count: members.length,
      groups: [],
      ops: buildMemberListOps(members),
    });
    return;
  }

  for (const [channelId, ranges] of channelEntries) {
    await sendDispatch(ws, 'GUILD_MEMBER_LIST_UPDATE', {
      guild_id: String(guildId),
      id: String(channelId),
      member_count: members.length,
      online_count: members.length,
      groups: [],
      ops: buildMemberListOps(members, ranges),
    });
  }
};

const handleRequestGuildMembers = async (ws, payload) => {
  const guildIds = Array.isArray(payload.guild_id) ? payload.guild_id : [payload.guild_id];
  for (const guildId of guildIds.filter(Boolean)) {
    const context = await Guild.getContext(guildId, ws._user.id);
    if (!context) {
      continue;
    }

    let members = await Guild.listMembers(guildId);
    let notFound = [];

    if (Array.isArray(payload.user_ids) && payload.user_ids.length) {
      const requestedIds = new Set(payload.user_ids.map(String));
      notFound = payload.user_ids.map(String).filter((userId) => !members.some((member) => String(member.user.id) === userId));
      members = members.filter((member) => requestedIds.has(String(member.user.id)));
    } else if (typeof payload.query === 'string') {
      const query = payload.query.toLowerCase();
      if (query) {
        members = members.filter((member) => {
          const name = (member.nick || member.user.global_name || member.user.username || '').toLowerCase();
          return name.startsWith(query);
        });
      }
      const limit = Number(payload.limit);
      if (!Number.isNaN(limit) && limit > 0) {
        members = members.slice(0, limit);
      }
    }

    await sendGuildMembersChunk(ws, guildId, members, {
      presences: Boolean(payload.presences),
      nonce: payload.nonce,
      notFound,
    });
  }
};

const handleGuildSubscriptions = (ws, payload) => {
  ws._guildSubscriptions = ws._guildSubscriptions || new Map();
  if (payload?.guild_id) {
    ws._guildSubscriptions.set(String(payload.guild_id), payload);
  }
};

const handleGuildSubscriptionsBulk = (ws, payload) => {
  ws._guildSubscriptions = ws._guildSubscriptions || new Map();
  for (const [guildId, subscription] of Object.entries(payload || {})) {
    ws._guildSubscriptions.set(String(guildId), subscription);
  }
};

const getRequestedRangeLimit = (subscription = {}) => {
  const channels = subscription.channels;
  if (!channels || typeof channels !== 'object') {
    return null;
  }

  let highestIndex = -1;
  for (const ranges of Object.values(channels)) {
    if (!Array.isArray(ranges)) {
      continue;
    }

    for (const range of ranges) {
      if (!Array.isArray(range) || range.length < 2) {
        continue;
      }

      const end = Number(range[1]);
      if (!Number.isNaN(end)) {
        highestIndex = Math.max(highestIndex, end);
      }
    }
  }

  return highestIndex >= 0 ? highestIndex + 1 : null;
};

const buildChannelUnreadUpdates = async (guildId, channelIds) => {
  const requestedIds = channelIds ? new Set(channelIds.map(String)) : null;
  const guild = await Guild.getFullGuild(guildId, { withCounts: true });
  const channels = Array.isArray(guild?.channels) ? guild.channels : [];

  return channels
    .filter((channel) => !requestedIds || requestedIds.has(String(channel.id)))
    .filter((channel) => channel.type !== 4)
    .map((channel) => ({
      id: String(channel.id),
      last_message_id: channel.last_message_id ? String(channel.last_message_id) : null,
      last_pin_timestamp: channel.last_pin_timestamp || undefined,
    }));
};

const sendChannelUnreadUpdate = async (ws, guildId, subscription = {}) => {
  const channelIds = subscription.channels && typeof subscription.channels === 'object'
    ? Object.keys(subscription.channels)
    : undefined;
  const channelUnreadUpdates = await buildChannelUnreadUpdates(guildId, channelIds);
  if (!channelUnreadUpdates.length) {
    return;
  }

  await sendDispatch(ws, 'CHANNEL_UNREAD_UPDATE', {
    guild_id: String(guildId),
    channel_unread_updates: channelUnreadUpdates,
  });
};

const sendLastMessages = async (ws, guildId, subscription = {}) => {
  const channelIds = subscription.channels && typeof subscription.channels === 'object'
    ? Object.keys(subscription.channels)
    : [];
  if (!channelIds.length) {
    return;
  }

  const messages = [];
  for (const channelId of channelIds) {
    const channel = await Guild.getChannel(channelId, ws._user.id);
    if (!channel?.last_message_id) {
      continue;
    }
    const message = await Message.get(channelId, channel.last_message_id);
    if (message) {
      messages.push(message);
    }
  }

  if (!messages.length) {
    return;
  }

  await sendDispatch(ws, 'LAST_MESSAGES', {
    guild_id: String(guildId),
    messages,
  });
};

const sendSubscriptionMemberRanges = async (ws, guildId, subscription = {}) => {
  const context = await Guild.getContext(guildId, ws._user.id);
  if (!context) {
    return;
  }

  let members = await Guild.listMembers(guildId);
  const requestedLimit = getRequestedRangeLimit(subscription);
  if (requestedLimit !== null) {
    members = members.slice(0, requestedLimit);
  }

  if (!members.length) {
    return;
  }

  await sendGuildMembersChunk(ws, guildId, members, {
    presences: true,
  });
};

const sendSubscriptionBootstrap = async (ws, guildId, subscription = {}) => {
  await Promise.all([
    sendGuildMemberListUpdate(ws, guildId, subscription),
    sendSubscriptionMemberRanges(ws, guildId, subscription),
    sendChannelUnreadUpdate(ws, guildId, subscription),
    sendLastMessages(ws, guildId, subscription),
    sendThreadListSync(ws, guildId, subscription),
  ]);
};

const sendThreadListSync = async (ws, guildId, subscription = {}) => {
  const channelIds = Array.isArray(subscription.channel_ids)
    ? subscription.channel_ids.map(String)
    : undefined;
  await sendDispatch(ws, 'THREAD_LIST_SYNC', {
    guild_id: String(guildId),
    channel_ids: channelIds,
    threads: [],
    members: [],
  });
};

const handleGuildSubscriptionsWithDispatch = async (ws, payload) => {
  handleGuildSubscriptions(ws, payload);
  if (payload?.guild_id) {
    await sendSubscriptionBootstrap(ws, payload.guild_id, payload);
  }
};

const handleGuildSubscriptionsBulkWithDispatch = async (ws, payload) => {
  const subscriptions = payload?.subscriptions && typeof payload.subscriptions === 'object'
    ? payload.subscriptions
    : payload;

  handleGuildSubscriptionsBulk(ws, subscriptions);
  for (const [guildId, subscription] of Object.entries(subscriptions || {})) {
    await sendSubscriptionBootstrap(ws, guildId, subscription || {});
  }
};

const buildGatewayGuildProperties = (guild) => ({
  id: guild.id,
  name: guild.name,
  icon: guild.icon,
  banner: guild.banner,
  splash: guild.splash,
  discovery_splash: guild.discovery_splash,
  owner_id: guild.owner_id,
  description: guild.description,
  afk_channel_id: guild.afk_channel_id,
  afk_timeout: guild.afk_timeout,
  widget_enabled: guild.widget_enabled,
  widget_channel_id: guild.widget_channel_id,
  verification_level: guild.verification_level,
  default_message_notifications: guild.default_message_notifications,
  explicit_content_filter: guild.explicit_content_filter,
  roles: guild.roles,
  emojis: guild.emojis || [],
  stickers: guild.stickers || [],
  features: guild.features || [],
  mfa_level: guild.mfa_level,
  system_channel_id: guild.system_channel_id,
  system_channel_flags: guild.system_channel_flags,
  rules_channel_id: guild.rules_channel_id,
  public_updates_channel_id: guild.public_updates_channel_id,
  safety_alerts_channel_id: guild.safety_alerts_channel_id,
  max_presences: guild.max_presences,
  max_members: guild.max_members,
  vanity_url_code: guild.vanity_url_code,
  premium_tier: guild.premium_tier,
  premium_subscription_count: guild.premium_subscription_count,
  preferred_locale: guild.preferred_locale,
  max_video_channel_users: guild.max_video_channel_users,
  max_stage_video_channel_users: guild.max_stage_video_channel_users,
  nsfw: guild.nsfw,
  nsfw_level: guild.nsfw_level,
  premium_progress_bar_enabled: guild.premium_progress_bar_enabled,
});

const buildGatewayGuild = (guild, currentUserId) => {
  const currentMember = (guild.members || []).find((member) => String(member.user?.id) === String(currentUserId));

  return {
    id: guild.id,
    joined_at: currentMember?.joined_at || new Date().toISOString(),
    large: false,
    unavailable: false,
    member_count: guild.approximate_member_count ?? guild.members?.length ?? 1,
    channels: guild.channels || [],
    threads: [],
    voice_states: [],
    activity_instances: [],
    stage_instances: [],
    guild_scheduled_events: [],
    data_mode: 'full',
    properties: buildGatewayGuildProperties(guild),
    roles: guild.roles || [],
    emojis: guild.emojis || [],
    stickers: guild.stickers || [],
    premium_subscription_count: guild.premium_subscription_count || 0,
  };
};

const buildReadyPayload = async (ws, user) => {
  const gatewayUser = buildGatewayUser(user);
  const readyGuilds = await Guild.listGuildsForReady(user.id);
  const guilds = readyGuilds.map((guild) => buildGatewayGuild(guild, user.id));
  const presences = readyGuilds.flatMap((guild) => guild.presences || []);
  const mergedMembers = readyGuilds.map((guild) => guild.members || []);
  const preloadedSettings = await UserSettingsProto.get(user.id, 1);

  return {
    _trace: buildTrace(),
    v: ws._session.version,
    user: gatewayUser,
    user_settings_proto: preloadedSettings?.settings_base64 || '',
    guilds,
    guild_join_requests: [],
    private_channels: [],
    connected_accounts: [],
    relationships: [],
    game_relationships: [],
    presences,
    merged_members: mergedMembers,
    merged_presences: {
      friends: [],
      guilds: guilds.map((guild) => guild.presences || []),
    },
    users: [gatewayUser],
    notes: {},
    user_guild_settings: {
      entries: [],
      partial: false,
      version: 0,
    },
    read_state: {
      entries: [],
      partial: false,
      version: 0,
    },
    notification_settings: {},
    sessions: [],
    friend_suggestion_count: 0,
    geo_ordered_rtc_regions: ['us-east', 'us-central', 'us-west', 'europe'],
    auth: {},
    experiments: [],
    guild_experiments: [],
    tutorial: null,
    consents: {},
    analytics_token: randomHex(16),
    country_code: 'US',
    session_id: ws._session.session_id,
    session_type: 'normal',
    resume_gateway_url: ws._gatewayUrl,
    api_code_version: 0,
    auth_session_id_hash: '',
    static_client_session_id: ws._session.session_id,
  };
};

const getIdentifyUser = async (identifyPayload) => {
  const token = identifyPayload?.token;
  const parsed = parseDiscordToken(token);
  if (!parsed) {
    return { user: null, reason: 'token-parse-failed' };
  }

  const user = await User.findByIdWithPasswordHash(parsed.userId);
  if (!user) {
    return { user: null, reason: 'user-not-found', userId: parsed.userId };
  }

  if (!verifyDiscordToken(token, user.password_hash)) {
    return { user: null, reason: 'token-verification-failed', userId: parsed.userId };
  }

  return { user, reason: null };
};

const logGatewayUserDiagnostics = async (requestedUserId) => {
  try {
    const rows = await db.manyOrNone(
      'SELECT id::text AS id, username, email FROM users ORDER BY created_at DESC LIMIT 50',
    );
    console.error('Gateway user diagnostics:', {
      requestedUserId: String(requestedUserId),
      knownUserIds: rows.map((row) => row.id),
      users: rows,
    });
  } catch (error) {
    console.error('Failed to collect gateway user diagnostics:', error);
  }
};

const createAcceptConfig = (req) => {
  const accepted = {
    version: 10,
    encoding: 'json',
    compress: null,
  };

  const versionParam = getOptionalParam(req, 'v');
  if (versionParam !== null) {
    const version = Number.parseInt(versionParam, 10);
    if (Number.isNaN(version)) return null;
    accepted.version = version;
  }

  if (accepted.version < 6 || accepted.version > 10) {
    return null;
  }

  const encoding = getOptionalParam(req, 'encoding');
  if (encoding !== null) {
    accepted.encoding = encoding;
  }
  if (accepted.encoding !== 'json') {
    return null;
  }

  const compress = getOptionalParam(req, 'compress');
  if (compress !== null) {
    if (compress !== 'zlib-stream' && compress !== 'zstd-stream') {
      return null;
    }
    accepted.compress = compress;
  }

  return accepted;
};

const compressZlibStream = (ws, payload) =>
  new Promise((resolve, reject) => {
    if (!ws._zlibCompressor) {
      ws._zlibCompressor = createZlibCompressor();
    }

    const stream = ws._zlibCompressor;
    const chunks = [];
    const onData = (chunk) => chunks.push(chunk);
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      stream.removeListener('data', onData);
      stream.removeListener('error', onError);
    };

    stream.on('data', onData);
    stream.on('error', onError);

    stream.write(Buffer.from(payload), (err) => {
      if (err) return onError(err);
      stream.flush(zlib.constants.Z_SYNC_FLUSH, (flushErr) => {
        cleanup();
        if (flushErr) return reject(flushErr);
        resolve(Buffer.concat(chunks));
      });
    });
  });

const compressZstdStream = async (ws, payload) => {
  const session = await ensureZstdSession(ws);
  return session.compressBuffer(Buffer.from(payload));
};

const encodeGatewayPayload = async (payload, compression, ws) => {
  const json = JSON.stringify(payload);
  if (!compression) return json;
  if (compression === 'zlib-stream') {
    return compressZlibStream(ws, json);
  }
  if (compression === 'zstd-stream') {
    return compressZstdStream(ws, json);
  }
  return json;
};

const decodeGatewayPayload = async (message, isBinary) => {
  if (typeof message === 'string') {
    return JSON.parse(message);
  }

  const data = Buffer.isBuffer(message) ? message : Buffer.from(message);

  if (!isBinary) {
    return JSON.parse(data.toString('utf8'));
  }

  throw new Error('Binary client payloads are not supported');
};

const sendGateway = async (ws, payload) => {
  const previousSend = ws._sendChain || Promise.resolve();

  const nextSend = previousSend.then(async () => {
    const encoded = await encodeGatewayPayload(payload, ws._compression, ws);
    await new Promise((resolve, reject) => {
      ws.send(encoded, { binary: Buffer.isBuffer(encoded) }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  ws._sendChain = nextSend.catch(() => {});
  return nextSend;
};

const cleanupTransport = async (ws) => {
  if (ws._zlibCompressor) {
    try {
      ws._zlibCompressor.close();
    } catch (err) {
      console.error('Error closing zlib compressor:', err);
    }
    ws._zlibCompressor = null;
  }
  if (ws._zlibBuffer) {
    ws._zlibBuffer = null;
  }
  if (ws._zstdSession) {
    try {
      const session = await ws._zstdSession;
      await session.destroy();
    } catch (err) {
      console.error('Error destroying zstd session:', err);
    }
    ws._zstdSession = null;
  }
};

const createGatewayServer = (port = 8080) => {
  const wss = new WebSocket.Server({ port });
  console.log(`Gateway WebSocket listening on port ${port}`);

  wss.on('connection', (ws, req) => {
    connections.add(ws);
    if (ws._socket?.setNoDelay) {
      ws._socket.setNoDelay(true);
    }

    const acceptConfig = createAcceptConfig(req);
    if (!acceptConfig) {
      closeWithCode(ws, CLOSE_POLICY_VIOLATION, 'invalid gateway parameters');
      return;
    }

    ws._session = {
      session_id: randomHex(16),
      sequence: 0,
      version: acceptConfig.version,
      encoding: acceptConfig.encoding,
      compress: acceptConfig.compress,
      identified: false,
      last_heartbeat: Date.now(),
    };

    ws._compression = acceptConfig.compress;
    ws._gatewayUrl = buildGatewayUrl({
      protocol: req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws',
      host: req.headers['x-forwarded-host'] || req.headers.host || 'localhost',
      version: acceptConfig.version,
      encoding: acceptConfig.encoding,
      compress: acceptConfig.compress,
    });

    sendGateway(ws, {
      op: 10,
      d: {
        heartbeat_interval: 45000,
        _trace: ['wishcord-js-gateway'],
      },
    }).catch((err) => console.error('Gateway send error:', err));

    ws.on('message', async (message, isBinary) => {
      if (isBinary) {
        closeWithCode(ws, CLOSE_DECODE_ERROR, 'binary payloads not supported');
        return;
      }

      if (Buffer.byteLength(message) > 15 * 1024) {
        closeWithCode(ws, CLOSE_DECODE_ERROR, 'payload too large');
        return;
      }

      try {
        const data = await decodeGatewayPayload(message, isBinary);

        console.log('Received:', data);

        if (data.op === 2) {
          const identifyResult = await getIdentifyUser(data.d);
          if (!identifyResult.user) {
            if (identifyResult.userId) {
              await logGatewayUserDiagnostics(identifyResult.userId);
            }
            console.error('Gateway identify rejected:', {
              reason: identifyResult.reason,
              userId: identifyResult.userId || null,
              hasToken: Boolean(data.d?.token),
            });
            closeWithCode(ws, 4004, 'Authentication failed');
            return;
          }

          const identifiedUser = identifyResult.user;

          ws._session.identified = true;
          ws._user = identifiedUser;

          await sendDispatch(ws, 'READY', await buildReadyPayload(ws, identifiedUser));
        } else if (data.op === 1) {
          await sendGateway(ws, { op: 11 });
        } else if (data.op === 8) {
          await handleRequestGuildMembers(ws, data.d || {});
        } else if (data.op === 14) {
          await handleGuildSubscriptionsWithDispatch(ws, data.d || {});
        } else if (data.op === 37) {
          await handleGuildSubscriptionsBulkWithDispatch(ws, data.d || {});
        }
      } catch (error) {
        console.error('Error parsing message:', error);
        closeWithCode(ws, CLOSE_DECODE_ERROR, 'decode error');
      }
    });

    ws.on('close', async () => {
      connections.delete(ws);
      await cleanupTransport(ws);
      console.log('WebSocket connection closed');
    });

    ws.on('error', (error) => {
      connections.delete(ws);
      console.error('WebSocket error:', error);
    });
  });
};

module.exports = {
  createGatewayServer,
  buildGatewayUrl,
  broadcastMessageCreate,
  broadcastMessageUpdate,
  broadcastMessageDelete,
  broadcastUserSettingsProtoUpdate,
};
