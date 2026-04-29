const WebSocket = require('ws');
const zlib = require('zlib');
const crypto = require('crypto');
const { SimpleZSTD } = require('simple-zstd');
const User = require('./models/user');
const Guild = require('./models/guild');
const Message = require('./models/message');
const ReadState = require('./models/readState');
const Relationship = require('./models/relationship');
const ConnectedAccount = require('./models/connectedAccount');
const PrivateChannel = require('./models/privateChannel');
const UserGuildSettings = require('./models/userGuildSettings');
const UserNote = require('./models/userNote');
const UserSettingsProto = require('./models/userSettingsProto');
const { parseDiscordToken, verifyDiscordToken } = require('./utils/discordAuth');

const CLOSE_DECODE_ERROR = 1007;
const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_ALREADY_AUTHENTICATED = 4005;
const CLOSE_AUTH_FAILED = 4004;
const CLOSE_INVALID_INTENTS = 4013;
const CLOSE_TOO_MANY_SESSIONS = 4015;
const CLOSE_SESSION_TIMED_OUT = 4009;

const HEARTBEAT_INTERVAL_MS = 45000;
const MAX_SESSIONS_PER_USER = 8;

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_PRESENCE_UPDATE = 3;
const OP_VOICE_STATE_UPDATE = 4;
const OP_VOICE_SERVER_PING = 5;
const OP_RESUME = 6;
const OP_REQUEST_GUILD_MEMBERS = 8;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;
const OP_GUILD_SYNC = 12;
const OP_CALL_CONNECT = 13;
const OP_GUILD_SUBSCRIPTIONS = 14;
const OP_LOBBY_CONNECT = 15;
const OP_LOBBY_DISCONNECT = 16;
const OP_LOBBY_VOICE_STATES = 17;
const OP_STREAM_CREATE = 18;
const OP_STREAM_DELETE = 19;
const OP_STREAM_WATCH = 20;
const OP_STREAM_PING = 21;
const OP_STREAM_SET_PAUSED = 22;
const OP_LFG_SUBSCRIPTIONS = 23;
const OP_REQUEST_GUILD_APP_CMDS = 24;
const OP_EMBEDDED_ACTIVITY_CREATE = 25;
const OP_EMBEDDED_ACTIVITY_DELETE = 26;
const OP_EMBEDDED_ACTIVITY_UPDATE = 27;
const OP_REQUEST_FORUM_UNREADS = 28;
const OP_REMOTE_COMMAND = 29;
const OP_REQUEST_DELETED_ENTITY_IDS = 30;
const OP_REQUEST_SOUNDBOARD_SOUNDS = 31;
const OP_SPEED_TEST_CREATE = 32;
const OP_SPEED_TEST_DELETE = 33;
const OP_REQUEST_LAST_MESSAGES = 34;
const OP_SEARCH_RECENT_MEMBERS = 35;
const OP_REQUEST_CHANNEL_STATUSES = 36;
const OP_GUILD_SUBSCRIPTIONS_BULK = 37;
const OP_GUILD_CHANNELS_RESYNC = 38;
const OP_REQUEST_CHANNEL_MEMBER_COUNT = 39;
const OP_QOS_HEARTBEAT = 40;
const OP_UPDATE_TIME_SPENT_SESSION_ID = 41;
const OP_LOBBY_VOICE_SERVER_PING = 42;
const OP_REQUEST_CHANNEL_INFO = 43;

const connections = new Set();
const sessions = new Map();
const userSessions = new Map();

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

const buildTrace = () => ['wishcord'];

const normalizedStatus = (presence = {}) => {
  const status = typeof presence.status === 'string' ? presence.status : 'online';
  return status && status !== 'unknown' ? status : 'online';
};

const overallStatus = (sessionList) => {
  const priority = ['dnd', 'online', 'idle', 'invisible', 'offline'];
  for (const candidate of priority) {
    for (const session of sessionList) {
      if (normalizedStatus(session.presence) === candidate) {
        return candidate;
      }
    }
  }
  return 'offline';
};

const buildLivePresence = (userId) => {
  const userConnections = getConnectionsForUser(userId);
  const sessionsForUser = userConnections.map((conn) => sessions.get(conn)).filter(Boolean);
  const firstActive = sessionsForUser.find((s) => normalizedStatus(s?.presence) !== 'offline') || sessionsForUser[0];
  const status = overallStatus(sessionsForUser);
  return {
    status,
    activities: firstActive?.presence?.activities || [],
    client_status: firstActive?.presence?.client_status || (status === 'offline' || status === 'invisible' ? {} : { web: status }),
  };
};

const buildPresenceUpdatePayload = (userId, guildId = null) => {
  const presence = buildLivePresence(userId);
  return {
    user: { id: String(userId) },
    guild_id: guildId ? String(guildId) : undefined,
    status: presence.status,
    activities: presence.activities,
    client_status: presence.client_status,
  };
};

const buildGatewayUser = (user, wsSession = null) => ({
  id: String(user.id),
  username: user.username,
  discriminator: user.discriminator || '0000',
  global_name: user.global_name ?? null,
  avatar: user.avatar ?? null,
  avatar_decoration_data: null,
  banner: user.banner ?? null,
  banner_color: null,
  accent_color: user.accent_color ?? null,
  bio: user.bio || '',
  pronouns: user.pronouns || '',
  locale: 'en-US',
  nsfw_allowed: true,
  mfa_enabled: Boolean(user.mfa_enabled),
  authenticator_types: user.mfa_enabled ? [2] : [],
  premium_type: Number(user.premium_type || 0),
  premium: Number(user.premium_type || 0) > 0,
  premium_usage_flags: 0,
  purchased_flags: 0,
  public_flags: Number(user.public_flags || 0),
  flags: Number(user.flags || 0),
  verified: Boolean(user.verified),
  email: user.email ?? null,
  phone: null,
  bot: false,
  system: false,
  desktop: false,
  mobile: false,
  collectibles: null,
  display_name_styles: null,
  primary_guild: null,
  status: wsSession ? normalizedStatus(wsSession.presence) : 'offline',
  activities: wsSession?.presence?.activities || [],
  client_status: wsSession?.presence?.client_status || {},
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

const broadcastRelationshipAdd = async (userId, payload) => {
  const targets = getConnectionsForUser(userId);
  await Promise.all(targets.map((ws) => sendDispatch(ws, 'RELATIONSHIP_ADD', payload).catch((error) => {
    console.error('Gateway RELATIONSHIP_ADD dispatch failed:', error);
  })));
};

const broadcastRelationshipUpdate = async (userId, payload) => {
  const targets = getConnectionsForUser(userId);
  await Promise.all(targets.map((ws) => sendDispatch(ws, 'RELATIONSHIP_UPDATE', payload).catch((error) => {
    console.error('Gateway RELATIONSHIP_UPDATE dispatch failed:', error);
  })));
};

const broadcastRelationshipRemove = async (userId, relationshipId) => {
  const targets = getConnectionsForUser(userId);
  const payload = { id: String(relationshipId) };
  await Promise.all(targets.map((ws) => sendDispatch(ws, 'RELATIONSHIP_REMOVE', payload).catch((error) => {
    console.error('Gateway RELATIONSHIP_REMOVE dispatch failed:', error);
  })));
};

const broadcastUserNoteUpdate = async (userId, payload) => {
  const targets = getConnectionsForUser(userId);
  await Promise.all(targets.map((ws) => sendDispatch(ws, 'USER_NOTE_UPDATE', payload).catch((error) => {
    console.error('Gateway USER_NOTE_UPDATE dispatch failed:', error);
  })));
};

const broadcastReadStateUpdate = async (userId, payload) => {
  const targets = getConnectionsForUser(userId);
  await Promise.all(targets.map((ws) => sendDispatch(ws, 'MESSAGE_ACK', payload).catch((error) => {
    console.error('Gateway MESSAGE_ACK dispatch failed:', error);
  })));
};

const sortMembersForList = (members) => [...members].sort((left, right) => {
  const leftPresence = buildLivePresence(left.user.id);
  const rightPresence = buildLivePresence(right.user.id);
  const leftOnline = !['offline', 'invisible'].includes(leftPresence.status) ? 1 : 0;
  const rightOnline = !['offline', 'invisible'].includes(rightPresence.status) ? 1 : 0;
  if (leftOnline !== rightOnline) {
    return rightOnline - leftOnline;
  }
  const leftName = String(left.nick || left.user.global_name || left.user.username || '').toLowerCase();
  const rightName = String(right.nick || right.user.global_name || right.user.username || '').toLowerCase();
  return leftName.localeCompare(rightName);
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
      presences: options.presences ? slice.map((member) => buildPresenceUpdatePayload(member.user.id, guildId)) : undefined,
      nonce: typeof options.nonce === 'string' && Buffer.byteLength(options.nonce) <= 32 ? options.nonce : undefined,
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

  const members = sortMembersForList(await Guild.listMembers(guildId));
  const channels = subscription.channels && typeof subscription.channels === 'object'
    ? subscription.channels
    : {};
  const channelEntries = Object.entries(channels);

  const onlineCount = members.filter((m) => !['offline', 'invisible'].includes(buildLivePresence(m.user.id).status)).length;

  if (!channelEntries.length) {
    await sendDispatch(ws, 'GUILD_MEMBER_LIST_UPDATE', {
      guild_id: String(guildId),
      id: 'everyone',
      member_count: members.length,
      online_count: onlineCount,
      groups: [{ id: 'online', count: onlineCount }, { id: 'offline', count: members.length - onlineCount }],
      ops: buildMemberListOps(members),
    });
    return;
  }

  for (const [channelId, ranges] of channelEntries) {
    await sendDispatch(ws, 'GUILD_MEMBER_LIST_UPDATE', {
      guild_id: String(guildId),
      id: String(channelId),
      member_count: members.length,
      online_count: onlineCount,
      groups: [{ id: 'online', count: onlineCount }, { id: 'offline', count: members.length - onlineCount }],
      ops: buildMemberListOps(members, ranges),
    });
  }
};

const handleRequestGuildMembers = async (ws, payload) => {
  const data = payload.d || payload;
  const guildIds = Array.isArray(data.guild_id) ? data.guild_id : [data.guild_id];
  for (const guildId of guildIds.filter(Boolean)) {
    const context = await Guild.getContext(guildId, ws._user.id);
    if (!context) {
      continue;
    }

    let members = sortMembersForList(await Guild.listMembers(guildId));
    let notFound = [];

    if (Array.isArray(data.user_ids) && data.user_ids.length) {
      const requestedIds = new Set(data.user_ids.map(String));
      notFound = data.user_ids.map(String).filter((userId) => !members.some((member) => String(member.user.id) === userId));
      members = members.filter((member) => requestedIds.has(String(member.user.id)));
    } else if (typeof data.query === 'string') {
      const query = data.query.toLowerCase();
      if (query) {
        members = members.filter((member) => String(member.nick || member.user.global_name || member.user.username || '').toLowerCase().startsWith(query));
      }
      const limit = Number(data.limit);
      if (!Number.isNaN(limit) && limit > 0) {
        members = members.slice(0, limit);
      }
    }

    await sendGuildMembersChunk(ws, guildId, members, {
      presences: Boolean(data.presences),
      nonce: data.nonce,
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

  let members = sortMembersForList(await Guild.listMembers(guildId));
  const requestedLimit = getRequestedRangeLimit(subscription);
  if (requestedLimit !== null) {
    members = members.slice(0, requestedLimit);
  }

  if (!members.length) {
    return;
  }

  await sendGuildMembersChunk(ws, guildId, members, { presences: true });
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
  const gatewayUser = buildGatewayUser(user, ws._session);
  const readyGuilds = await Guild.listGuildsForReady(user.id);
  const guilds = readyGuilds.map((guild) => buildGatewayGuild(guild, user.id));
  const notificationSettings = await UserGuildSettings.getNotificationSettings(user.id).catch(() => ({ flags: 16 }));
  const userGuildSettingsEntries = await UserGuildSettings.listForUser(user.id).catch(() => []);
  const preloadedSettings = await UserSettingsProto.get(user.id, 1).catch(() => ({ settings_base64: '' }));

  const privateChannels = await PrivateChannel.listForUser(user.id).catch(() => []);
  const connectedAccounts = await ConnectedAccount.listForUser(user.id).catch(() => []);
  const relationships = await Relationship.listForUser(user.id).catch(() => []);
  const notes = await UserNote.listForUser(user.id).catch(() => ({}));
  const readStateEntries = await ReadState.listForUser(user.id).catch(() => []);

  const mergedMembers = readyGuilds.map((guild) => guild.members || []);
  const guildPresences = readyGuilds.map((guild) => (guild.members || []).map((member) => buildPresenceUpdatePayload(member.user.id, guild.id)));

  const dedupedUsers = new Map();
  dedupedUsers.set(String(user.id), gatewayUser);
  for (const guild of readyGuilds) {
    for (const member of guild.members || []) {
      if (!dedupedUsers.has(String(member.user.id))) {
        dedupedUsers.set(String(member.user.id), buildGatewayUser(member.user, null));
      }
    }
  }

  return {
    _trace: buildTrace(),
    v: ws._session.version,
    user: gatewayUser,
    user_settings_proto: preloadedSettings?.settings_base64 || '',
    guilds,
    guild_join_requests: [],
    private_channels: privateChannels,
    connected_accounts: connectedAccounts,
    relationships,
    game_relationships: [],
    presences: guildPresences.flat(),
    merged_members: mergedMembers,
    merged_presences: {
      friends: relationships.map((relationship) => buildPresenceUpdatePayload(relationship.id)).filter(Boolean),
      guilds: guildPresences,
    },
    users: Array.from(dedupedUsers.values()),
    notes,
    user_guild_settings: {
      entries: userGuildSettingsEntries,
      partial: false,
      version: 0,
    },
    read_state: {
      entries: readStateEntries,
      partial: false,
      version: 0,
    },
    notification_settings: notificationSettings,
    sessions: [],
    friend_suggestion_count: 0,
    geo_ordered_rtc_regions: ['us-east', 'us-central', 'us-west', 'europe'],
    auth: { authenticator_types: user.mfa_enabled ? [2] : [] },
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
    auth_session_id_hash: ws._session.authSessionIdHash || ws._session.session_id,
    static_client_session_id: ws._session.staticClientSessionId,
  };
};

const buildReadySupplementalPayload = async (ws, user) => {
  const readyGuilds = await Guild.listGuildsForReady(user.id);
  const guilds = readyGuilds.map((guild) => buildGatewayGuild(guild, user.id));
  const mergedMembers = readyGuilds.map((guild) => guild.members || []);

  return {
    guilds: guilds.map((g) => ({ id: g.id, properties: g.properties, member_count: g.member_count })),
    merged_members: mergedMembers,
    merged_presences: {
      friends: [],
      guilds: guilds.map((guild) => (guild.members || []).map((member) => buildPresenceUpdatePayload(member.user.id, guild.id))),
    },
    lazy_private_channels: [],
    disclose: [],
  };
};

const getIdentifyUser = async (identifyPayload = {}) => {
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
  console.error('Gateway identify failed for user:', String(requestedUserId));
};

const createAcceptConfig = (req) => {
  const accepted = { version: 10, encoding: 'json', compress: null };

  const version = getOptionalParam(req, 'v');
  if (version !== null) {
    const parsed = Number.parseInt(version, 10);
    if (Number.isNaN(parsed)) return null;
    accepted.version = parsed;
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
    if (!['zlib-stream', 'zstd-stream'].includes(compress)) {
      return null;
    }
    accepted.compress = compress;
  }

  return accepted;
};

const compressZlibStream = (ws, payload) => {
  if (!ws._zlibCompressor) {
    ws._zlibCompressor = createZlibCompressor();
  }
  const stream = ws._zlibCompressor;
  const chunks = [];
  return new Promise((resolve, reject) => {
    const onData = (chunk) => chunks.push(chunk);
    const onError = (error) => {
      stream.off('data', onData);
      reject(error);
    };
    stream.on('data', onData);
    stream.once('error', onError);
    stream.write(payload, (error) => {
      stream.off('error', onError);
      stream.off('data', onData);
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    stream.flush(zlib.constants.Z_SYNC_FLUSH);
  });
};

const compressZstdStream = async (ws, payload) => {
  const session = await ensureZstdSession(ws);
  return session.compress(Buffer.from(payload));
};

const encodeGatewayPayload = async (payload, compression, ws) => {
  const serialized = JSON.stringify(payload);
  if (!compression) return serialized;
  if (compression === 'zlib-stream') {
    return compressZlibStream(ws, Buffer.from(serialized));
  }
  if (compression === 'zstd-stream') {
    return compressZstdStream(ws, serialized);
  }
  return serialized;
};

const decodeGatewayPayload = async (message) => JSON.parse(String(message));

const sendPayloadToConnection = async (ws, payload, compression) => {
  const previousSend = ws._sendChain || Promise.resolve();
  const nextSend = previousSend.then(async () => {
    const encoded = await encodeGatewayPayload(payload, compression, ws);
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

const sendGateway = async (ws, payload) => sendPayloadToConnection(ws, payload, ws._compression);

const cleanupTransport = async (ws) => {
  if (ws?._zlibCompressor) {
    try {
      ws._zlibCompressor.close();
    } catch (err) {
      console.error('Error closing zlib compressor:', err);
    }
    ws._zlibCompressor = null;
  }
  if (ws?._zstdSession) {
    try {
      const zstdSession = await ws._zstdSession;
      await zstdSession.destroy();
    } catch (err) {
      console.error('Error destroying zstd session:', err);
    }
    ws._zstdSession = null;
  }
};

let heartbeatSweepTimer = null;

const sweepHeartbeats = async () => {
  const now = Date.now();
  for (const [connection, session] of sessions.entries()) {
    if (session.identified && now - session.lastHeartbeat > HEARTBEAT_INTERVAL_MS * 2) {
      closeWithCode(connection, CLOSE_SESSION_TIMED_OUT, 'heartbeat timeout');
    }
  }
};

const attachUserSession = (userId, ws) => {
  if (!userId) return;
  if (!userSessions.has(userId)) {
    userSessions.set(userId, new Set());
  }
  userSessions.get(userId).add(ws);
};

const detachUserSession = (userId, ws) => {
  if (!userId) return;
  const set = userSessions.get(userId);
  if (!set) return;
  set.delete(ws);
  if (!set.size) {
    userSessions.delete(userId);
  }
};

const handleIdentifyClient = async (ws, payload) => {
  if (ws._session.identified) {
    closeWithCode(ws, CLOSE_ALREADY_AUTHENTICATED, 'already authenticated');
    return;
  }
  if (!payload.d || typeof payload.d !== 'object') {
    closeWithCode(ws, CLOSE_DECODE_ERROR, 'invalid identify payload');
    return;
  }

  const identifyResult = await getIdentifyUser(payload.d);
  if (!identifyResult.user) {
    if (identifyResult.userId) {
      await logGatewayUserDiagnostics(identifyResult.userId);
    }
    console.error('Gateway identify rejected:', {
      reason: identifyResult.reason,
      userId: identifyResult.userId || null,
      hasToken: Boolean(payload.d?.token),
    });
    closeWithCode(ws, CLOSE_AUTH_FAILED, 'authentication failed');
    return;
  }

  const userConnections = userSessions.get(String(identifyResult.user.id));
  if (userConnections && userConnections.size >= MAX_SESSIONS_PER_USER) {
    closeWithCode(ws, CLOSE_TOO_MANY_SESSIONS, 'too many sessions');
    return;
  }

  ws._session.identified = true;
  ws._user = identifyResult.user;
  ws._session.userId = String(identifyResult.user.id);
  ws._session.capabilities = Number(payload.d.capabilities || 0);

  if (payload.d.intents != null && !Number.isInteger(payload.d.intents)) {
    closeWithCode(ws, CLOSE_INVALID_INTENTS, 'invalid intents');
    return;
  }
  ws._session.intents = payload.d.intents || 0;

  if (payload.d.properties && typeof payload.d.properties === 'object') {
    const props = payload.d.properties;
    ws._session.clientInfo = {
      client: props.browser || props.$browser || 'web',
      os: props.os || props.$os || 'linux',
      version: Number(props.client_build_number || 0),
    };
  }

  if (payload.d.presence && typeof payload.d.presence === 'object') {
    const presence = payload.d.presence;
    const status = normalizedStatus(presence);
    ws._session.presence = {
      status,
      activities: Array.isArray(presence.activities) ? presence.activities : [],
      since: presence.since ?? null,
      afk: Boolean(presence.afk),
      client_status: status === 'offline' || status === 'invisible' ? {} : { web: status },
    };
  } else {
    ws._session.presence = { status: 'online', activities: [], since: null, afk: false, client_status: { web: 'online' } };
  }

  ws._session.staticClientSessionId = randomHex(16);
  ws._session.authSessionIdHash = ws._session.session_id;

  sessions.set(ws, ws._session);
  attachUserSession(ws._session.userId, ws);

  await sendDispatch(ws, 'READY', await buildReadyPayload(ws, ws._user));
  await sendDispatch(ws, 'READY_SUPPLEMENTAL', await buildReadySupplementalPayload(ws, ws._user));
};

const handleHeartbeat = async (ws) => {
  ws._session.lastHeartbeat = Date.now();
  await sendGateway(ws, { op: OP_HEARTBEAT_ACK });
};

const handlePresenceUpdate = async (ws, payload) => {
  const data = payload.d || payload;
  const requestedStatus = typeof data.status === 'string' ? data.status : null;
  const status = ['online', 'idle', 'dnd', 'invisible', 'offline'].includes(requestedStatus) ? requestedStatus : normalizedStatus(ws._session.presence);
  ws._session.presence = {
    status,
    activities: Array.isArray(data.activities) ? data.activities : (ws._session.presence?.activities || []),
    since: data.since ?? null,
    afk: Boolean(data.afk),
    client_status: status === 'offline' || status === 'invisible' ? {} : { web: status },
  };
};

const handleResume = async (ws, payload) => {
  if (!payload.d || typeof payload.d !== 'object') {
    closeWithCode(ws, CLOSE_DECODE_ERROR, 'invalid resume payload');
    return;
  }
  const identifyResult = await getIdentifyUser(payload.d);
  if (!identifyResult.user) {
    closeWithCode(ws, CLOSE_AUTH_FAILED, 'authentication failed');
    return;
  }

  const sessionId = String(payload.d.session_id || '');
  const seq = Number(payload.d.seq || 0);

  const userConnections = userSessions.get(String(identifyResult.user.id));
  let sourceSession = null;
  if (userConnections) {
    for (const conn of userConnections) {
      const session = sessions.get(conn);
      if (session?.session_id === sessionId) {
        sourceSession = session;
        break;
      }
    }
  }

  if (!sourceSession) {
    await sendGateway(ws, { op: OP_INVALID_SESSION, d: false });
    return;
  }

  ws._session.identified = true;
  ws._session.userId = sourceSession.userId;
  ws._session.user = sourceSession.user;
  ws._user = sourceSession.user;
  ws._session.presence = sourceSession.presence;
  ws._session.clientInfo = sourceSession.clientInfo;
  ws._session.staticClientSessionId = sourceSession.staticClientSessionId;
  ws._session.authSessionIdHash = sourceSession.authSessionIdHash;

  sessions.set(ws, ws._session);
  attachUserSession(ws._session.userId, ws);

  await sendGateway(ws, { op: OP_DISPATCH, t: 'RESUMED', s: ws._session.sequence, d: {} });
};

const createGatewayServer = (port = 8080) => {
  if (heartbeatSweepTimer) {
    clearInterval(heartbeatSweepTimer);
  }

  const wss = new WebSocket.Server({ port });
  console.log(`Gateway WebSocket listening on port ${port}`);

  heartbeatSweepTimer = setInterval(() => {
    sweepHeartbeats().catch((error) => console.error('Heartbeat sweep failed:', error));
  }, 15000);

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

    const sessionId = randomHex(16);
    ws._session = {
      session_id: sessionId,
      staticClientSessionId: randomHex(16),
      authSessionIdHash: '',
      sequence: 0,
      version: acceptConfig.version,
      encoding: acceptConfig.encoding,
      compress: acceptConfig.compress,
      identified: false,
      lastHeartbeat: Date.now(),
      userId: null,
      user: null,
      presence: { status: 'online', activities: [], since: null, afk: false, client_status: { web: 'online' } },
      clientInfo: { client: 'web', os: 'linux', version: 0 },
      capabilities: 0,
      intents: 0,
      subscribedGuilds: new Set(),
      guildSubscriptions: new Map(),
    };

    ws._compression = acceptConfig.compress;
    ws._gatewayUrl = buildGatewayUrl({
      protocol: req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws',
      host: req.headers['x-forwarded-host'] || req.headers.host || 'localhost',
      version: acceptConfig.version,
      encoding: acceptConfig.encoding,
      compress: acceptConfig.compress,
    });

    sessions.set(ws, ws._session);

    sendGateway(ws, {
      op: OP_HELLO,
      d: {
        heartbeat_interval: HEARTBEAT_INTERVAL_MS,
        _trace: buildTrace(),
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
        const data = await decodeGatewayPayload(message);
        const liveSession = sessions.get(ws);
        if (!liveSession) return;

        switch (data.op) {
          case OP_HEARTBEAT:
          case OP_QOS_HEARTBEAT:
            await handleHeartbeat(ws);
            break;
          case OP_IDENTIFY:
            await handleIdentifyClient(ws, data);
            break;
          case OP_PRESENCE_UPDATE:
            await handlePresenceUpdate(ws, data);
            break;
          case OP_RESUME:
            await handleResume(ws, data);
            break;
          case OP_REQUEST_GUILD_MEMBERS:
            await handleRequestGuildMembers(ws, data.d || {});
            break;
          case OP_GUILD_SUBSCRIPTIONS:
            await handleGuildSubscriptionsWithDispatch(ws, data.d || {});
            break;
          case OP_GUILD_SUBSCRIPTIONS_BULK:
            await handleGuildSubscriptionsBulkWithDispatch(ws, data.d || {});
            break;
          case OP_VOICE_STATE_UPDATE:
          case OP_VOICE_SERVER_PING:
          case OP_CALL_CONNECT:
          case OP_LOBBY_CONNECT:
          case OP_LOBBY_DISCONNECT:
          case OP_LOBBY_VOICE_STATES:
          case OP_LFG_SUBSCRIPTIONS:
          case OP_REQUEST_GUILD_APP_CMDS:
          case OP_EMBEDDED_ACTIVITY_CREATE:
          case OP_EMBEDDED_ACTIVITY_DELETE:
          case OP_EMBEDDED_ACTIVITY_UPDATE:
          case OP_REQUEST_FORUM_UNREADS:
          case OP_REQUEST_DELETED_ENTITY_IDS:
          case OP_SPEED_TEST_CREATE:
          case OP_SPEED_TEST_DELETE:
          case OP_LOBBY_VOICE_SERVER_PING:
            break;
          default:
            break;
        }
      } catch (error) {
        console.error('Gateway decode error:', error);
        closeWithCode(ws, CLOSE_DECODE_ERROR, 'decode error');
      }
    });

    ws.on('close', async (reason) => {
      const closingSession = sessions.get(ws);
      if (closingSession) {
        const userId = closingSession.userId;
        detachUserSession(userId, ws);
        await cleanupTransport(ws);
        sessions.delete(ws);
      }
      connections.delete(ws);
      console.log('Gateway connection closed:', reason?.toString());
    });

    ws.on('error', async (error) => {
      const erroredSession = sessions.get(ws);
      if (erroredSession) {
        detachUserSession(erroredSession.userId, ws);
        await cleanupTransport(ws);
        sessions.delete(ws);
      }
      connections.delete(ws);
      console.error('Gateway websocket error:', error);
    });
  });

  return wss;
};

module.exports = {
  createGatewayServer,
  buildGatewayUrl,
  broadcastMessageCreate,
  broadcastMessageUpdate,
  broadcastMessageDelete,
  broadcastReadStateUpdate,
  broadcastRelationshipAdd,
  broadcastRelationshipUpdate,
  broadcastRelationshipRemove,
  broadcastUserSettingsProtoUpdate,
  broadcastUserNoteUpdate,
};
