const db = require('../db');
const { generateSnowflake } = require('../utils/discordAuth');

const DEFAULT_MESSAGE_TYPE = 0;
const REPLY_MESSAGE_TYPE = 19;

const USER_MENTION_PATTERN = /<@!?(\d+)>/g;
const ROLE_MENTION_PATTERN = /<@&(\d+)>/g;
const CHANNEL_MENTION_PATTERN = /<#(\d+)>/g;

const MESSAGE_SELECT = `
  SELECT
    m.*,
    ch.guild_id,
    ch.type AS channel_type,
    au.id AS author_user_id,
    au.username AS author_username,
    au.discriminator AS author_discriminator,
    au.global_name AS author_global_name,
    au.avatar AS author_avatar
  FROM messages m
  INNER JOIN guild_channels ch ON ch.id = m.channel_id
  INNER JOIN users au ON au.id = m.author_id
`;

const MESSAGE_SCHEMA_UPDATES = [
  "ALTER TABLE messages ADD COLUMN IF NOT EXISTS mention_channels JSONB NOT NULL DEFAULT '[]'::jsonb",
  "ALTER TABLE messages ADD COLUMN IF NOT EXISTS reactions JSONB NOT NULL DEFAULT '[]'::jsonb",
  "ALTER TABLE messages ADD COLUMN IF NOT EXISTS sticker_items JSONB NOT NULL DEFAULT '[]'::jsonb",
  'ALTER TABLE messages ADD COLUMN IF NOT EXISTS activity JSONB',
  'ALTER TABLE messages ADD COLUMN IF NOT EXISTS application JSONB',
  'ALTER TABLE messages ADD COLUMN IF NOT EXISTS application_id BIGINT',
  'ALTER TABLE messages ADD COLUMN IF NOT EXISTS poll JSONB',
  'ALTER TABLE messages ADD COLUMN IF NOT EXISTS referenced_message_id BIGINT',
  'ALTER TABLE messages ADD COLUMN IF NOT EXISTS interaction_metadata JSONB',
  'ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread JSONB',
  'ALTER TABLE messages ADD COLUMN IF NOT EXISTS call JSONB',
  "ALTER TABLE messages ADD COLUMN IF NOT EXISTS soundboard_sounds JSONB NOT NULL DEFAULT '[]'::jsonb",
  'CREATE INDEX IF NOT EXISTS idx_messages_channel_id_id ON messages(channel_id, id DESC)',
  'CREATE INDEX IF NOT EXISTS idx_messages_nonce_lookup ON messages(channel_id, author_id, nonce)',
];

let schemaReadyPromise;

const toArray = (value) => {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string' && value.length) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

const toObjectOrNull = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string' && value.length) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
};

const toJsonValue = (value, fallback) => {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
};

const uniqueIds = (matches) => [...new Set(matches.map(String))];

const collectMatches = (content, pattern) => {
  const ids = [];
  for (const match of content.matchAll(pattern)) {
    if (match[1]) {
      ids.push(match[1]);
    }
  }
  return uniqueIds(ids);
};

const parseListRule = (allowedMentions, type) => {
  if (!allowedMentions || typeof allowedMentions !== 'object') {
    return { parseEnabled: true, explicitIds: [] };
  }

  const parse = Array.isArray(allowedMentions.parse) ? allowedMentions.parse : null;
  const parseEnabled = parse ? parse.includes(type) : true;
  const explicitIds = Array.isArray(allowedMentions[type]) ? allowedMentions[type].map(String) : [];
  return { parseEnabled, explicitIds };
};

const filterAllowedIds = (ids, allowedMentions, type) => {
  const { parseEnabled, explicitIds } = parseListRule(allowedMentions, type);
  if (!explicitIds.length) {
    return parseEnabled ? ids : [];
  }
  return ids.filter((id) => explicitIds.includes(String(id)));
};

const shouldMentionEveryone = (content, allowedMentions) => {
  if (!content.includes('@everyone') && !content.includes('@here')) {
    return false;
  }
  const parse = Array.isArray(allowedMentions?.parse) ? allowedMentions.parse : null;
  return parse ? parse.includes('everyone') : true;
};

const mapPartialUser = (row) => ({
  id: String(row.author_user_id ?? row.id),
  username: row.author_username ?? row.username,
  discriminator: row.author_discriminator ?? row.discriminator,
  global_name: row.author_global_name ?? row.global_name,
  avatar: row.author_avatar ?? row.avatar,
});

const toTimestamp = (value) => {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const mapMessageRow = (row) => ({
  id: String(row.id),
  type: row.type ?? DEFAULT_MESSAGE_TYPE,
  content: row.content ?? '',
  channel_id: String(row.channel_id),
  channel_type: row.channel_type,
  guild_id: row.guild_id ? String(row.guild_id) : undefined,
  author: mapPartialUser(row),
  attachments: toArray(row.attachments),
  embeds: toArray(row.embeds),
  mentions: toArray(row.mentions),
  mention_roles: toArray(row.mention_roles).map(String),
  mention_channels: toArray(row.mention_channels),
  pinned: Boolean(row.pinned),
  mention_everyone: Boolean(row.mention_everyone),
  tts: Boolean(row.tts),
  timestamp: toTimestamp(row.created_at),
  edited_timestamp: toTimestamp(row.edited_timestamp),
  flags: row.flags ?? 0,
  components: toArray(row.components),
  nonce: row.nonce ?? null,
  message_reference: toObjectOrNull(row.message_reference) || undefined,
  referenced_message: toJsonValue(row.referenced_message, null),
  reactions: toArray(row.reactions),
  sticker_items: toArray(row.sticker_items),
  activity: toJsonValue(row.activity, null),
  application: toJsonValue(row.application, null),
  application_id: row.application_id ? String(row.application_id) : null,
  poll: toJsonValue(row.poll, null),
  interaction_metadata: toJsonValue(row.interaction_metadata, null),
  thread: toJsonValue(row.thread, null),
  call: toJsonValue(row.call, null),
  soundboard_sounds: toArray(row.soundboard_sounds),
  position: undefined,
});

const serializeJson = (value, fallback) => JSON.stringify(value ?? fallback);

class Message {
  static async ensureSchema() {
    if (!schemaReadyPromise) {
      schemaReadyPromise = (async () => {
        for (const statement of MESSAGE_SCHEMA_UPDATES) {
          await db.none(statement);
        }
      })().catch((error) => {
        schemaReadyPromise = null;
        throw error;
      });
    }
    return schemaReadyPromise;
  }

  static async fetchUsersByIds(userIds) {
    if (!userIds.length) {
      return [];
    }
    return db.manyOrNone(
      `
        SELECT id, username, discriminator, global_name, avatar
        FROM users
        WHERE id::text IN ($1:csv)
      `,
      [userIds.map(String)],
    );
  }

  static async fetchMentionChannels(channelIds, guildId) {
    if (!channelIds.length) {
      return [];
    }
    const rows = await db.manyOrNone(
      `
        SELECT id, guild_id, type, name
        FROM guild_channels
        WHERE id::text IN ($1:csv)
          AND ($2::bigint IS NULL OR guild_id = $2)
      `,
      [channelIds.map(String), guildId ? String(guildId) : null],
    );
    return rows.map((row) => ({
      id: String(row.id),
      guild_id: row.guild_id ? String(row.guild_id) : null,
      type: row.type,
      name: row.name,
    }));
  }

  static async resolveMentions(channelId, content, allowedMentions = null) {
    const channel = await db.one(
      'SELECT id, guild_id FROM guild_channels WHERE id::text = $1',
      [String(channelId)],
    );

    const mentionedUserIds = filterAllowedIds(collectMatches(content, USER_MENTION_PATTERN), allowedMentions, 'users');
    const mentionedRoleIds = filterAllowedIds(collectMatches(content, ROLE_MENTION_PATTERN), allowedMentions, 'roles');
    const mentionedChannelIds = collectMatches(content, CHANNEL_MENTION_PATTERN);

    const [users, channels] = await Promise.all([
      this.fetchUsersByIds(mentionedUserIds),
      this.fetchMentionChannels(mentionedChannelIds, channel.guild_id),
    ]);

    return {
      mentions: users.map((user) => ({
        id: String(user.id),
        username: user.username,
        discriminator: user.discriminator,
        global_name: user.global_name,
        avatar: user.avatar,
      })),
      mention_roles: mentionedRoleIds,
      mention_channels: channels,
      mention_everyone: shouldMentionEveryone(content, allowedMentions),
    };
  }

  static async get(channelId, messageId) {
    await this.ensureSchema();
    const row = await db.oneOrNone(
      `${MESSAGE_SELECT}
       WHERE m.channel_id::text = $1 AND m.id::text = $2`,
      [String(channelId), String(messageId)],
    );
    return row ? mapMessageRow(row) : null;
  }

  static async getByNonce(channelId, authorId, nonce) {
    await this.ensureSchema();
    if (!nonce) {
      return null;
    }
    const row = await db.oneOrNone(
      `${MESSAGE_SELECT}
       WHERE m.channel_id::text = $1 AND m.author_id::text = $2 AND m.nonce = $3`,
      [String(channelId), String(authorId), String(nonce)],
    );
    return row ? mapMessageRow(row) : null;
  }

  static async list(channelId, options = {}) {
    await this.ensureSchema();
    const limit = Math.max(1, Math.min(Number(options.limit) || 50, 100));

    if (options.around) {
      const rows = await db.manyOrNone(
        `${MESSAGE_SELECT}
         WHERE m.channel_id::text = $1
         ORDER BY ABS((m.id::numeric) - ($2)::numeric) ASC, m.id DESC
         LIMIT $3`,
        [String(channelId), String(options.around), limit],
      );
      rows.sort((left, right) => Number(BigInt(right.id) - BigInt(left.id)));
      return rows.map(mapMessageRow);
    }

    const filters = ['m.channel_id::text = $1'];
    const values = [String(channelId)];
    if (options.before) {
      filters.push(`m.id < ($${values.length + 1})::bigint`);
      values.push(String(options.before));
    }
    if (options.after) {
      filters.push(`m.id > ($${values.length + 1})::bigint`);
      values.push(String(options.after));
    }
    values.push(limit);

    const rows = await db.manyOrNone(
      `${MESSAGE_SELECT}
       WHERE ${filters.join(' AND ')}
       ORDER BY m.id DESC
       LIMIT $${values.length}`,
      values,
    );
    return rows.map(mapMessageRow);
  }

  static async buildReferencePayload(channelId, messageReference) {
    const reference = toObjectOrNull(messageReference);
    if (!reference?.message_id) {
      return {
        message_reference: null,
        referenced_message_id: null,
        type: DEFAULT_MESSAGE_TYPE,
      };
    }

    const referenced = await this.get(channelId, reference.message_id);
    return {
      message_reference: {
        channel_id: String(reference.channel_id || channelId),
        guild_id: reference.guild_id ? String(reference.guild_id) : referenced?.guild_id,
        message_id: String(reference.message_id),
      },
      referenced_message_id: String(reference.message_id),
      type: REPLY_MESSAGE_TYPE,
    };
  }

  static async create(channelId, authorId, data) {
    await this.ensureSchema();
    const existing = await this.getByNonce(channelId, authorId, data.nonce);
    if (existing) {
      return existing;
    }

    const content = typeof data.content === 'string' ? data.content : '';
    const mentionState = await this.resolveMentions(channelId, content, data.allowed_mentions || null);
    const referenceState = await this.buildReferencePayload(channelId, data.message_reference);
    const messageId = generateSnowflake();

    await db.tx(async (tx) => {
      await tx.none(
        `
          INSERT INTO messages (
            id, channel_id, author_id, content, nonce, tts, mention_everyone, mentions,
            mention_roles, mention_channels, attachments, embeds, reactions, components,
            sticker_items, pinned, type, flags, activity, application, application_id, poll,
            message_reference, referenced_message_id, edited_timestamp, interaction_metadata,
            thread, call, soundboard_sounds
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11, $12, $13, $14,
            $15, false, $16, $17, $18, $19, $20, $21,
            $22, $23, null, $24,
            $25, $26, $27
          )
        `,
        [
          messageId,
          String(channelId),
          String(authorId),
          content,
          data.nonce || null,
          Boolean(data.tts),
          mentionState.mention_everyone,
          serializeJson(mentionState.mentions, []),
          serializeJson(mentionState.mention_roles.map(String), []),
          serializeJson(mentionState.mention_channels, []),
          serializeJson(toArray(data.attachments), []),
          serializeJson(toArray(data.embeds), []),
          serializeJson([], []),
          serializeJson(toArray(data.components), []),
          serializeJson(toArray(data.sticker_items), []),
          referenceState.type,
          data.flags || 0,
          data.activity ? JSON.stringify(data.activity) : null,
          data.application ? JSON.stringify(data.application) : null,
          data.application_id || null,
          data.poll ? JSON.stringify(data.poll) : null,
          referenceState.message_reference ? JSON.stringify(referenceState.message_reference) : null,
          referenceState.referenced_message_id || null,
          data.interaction_metadata ? JSON.stringify(data.interaction_metadata) : null,
          data.thread ? JSON.stringify(data.thread) : null,
          data.call ? JSON.stringify(data.call) : null,
          serializeJson(toArray(data.soundboard_sounds), []),
        ],
      );
      await tx.none('UPDATE guild_channels SET last_message_id = $2 WHERE id = $1', [String(channelId), messageId]);
    });

    return this.get(channelId, messageId);
  }

  static async update(channelId, messageId, updates) {
    await this.ensureSchema();
    const existing = await this.get(channelId, messageId);
    if (!existing) {
      return null;
    }

    const nextContent = Object.prototype.hasOwnProperty.call(updates, 'content')
      ? String(updates.content ?? '')
      : existing.content;
    const shouldRebuildMentions = Object.prototype.hasOwnProperty.call(updates, 'content')
      || Object.prototype.hasOwnProperty.call(updates, 'allowed_mentions');
    const mentionState = shouldRebuildMentions
      ? await this.resolveMentions(channelId, nextContent, updates.allowed_mentions || null)
      : {
          mentions: existing.mentions,
          mention_roles: existing.mention_roles,
          mention_channels: existing.mention_channels,
          mention_everyone: existing.mention_everyone,
        };

    const fields = [];
    const values = [];
    const assign = (column, value) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };

    assign('content', nextContent);
    assign('mentions', serializeJson(mentionState.mentions, []));
    assign('mention_roles', serializeJson(mentionState.mention_roles.map(String), []));
    assign('mention_channels', serializeJson(mentionState.mention_channels, []));
    assign('mention_everyone', mentionState.mention_everyone);

    if (Object.prototype.hasOwnProperty.call(updates, 'flags')) {
      assign('flags', updates.flags ?? 0);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'embeds')) {
      assign('embeds', serializeJson(toArray(updates.embeds), []));
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'components')) {
      assign('components', serializeJson(toArray(updates.components), []));
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'attachments')) {
      assign('attachments', serializeJson(toArray(updates.attachments), []));
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'sticker_items')) {
      assign('sticker_items', serializeJson(toArray(updates.sticker_items), []));
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'activity')) {
      assign('activity', updates.activity ? JSON.stringify(updates.activity) : null);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'application')) {
      assign('application', updates.application ? JSON.stringify(updates.application) : null);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'application_id')) {
      assign('application_id', updates.application_id || null);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'poll')) {
      assign('poll', updates.poll ? JSON.stringify(updates.poll) : null);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'interaction_metadata')) {
      assign('interaction_metadata', updates.interaction_metadata ? JSON.stringify(updates.interaction_metadata) : null);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'thread')) {
      assign('thread', updates.thread ? JSON.stringify(updates.thread) : null);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'call')) {
      assign('call', updates.call ? JSON.stringify(updates.call) : null);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'soundboard_sounds')) {
      assign('soundboard_sounds', serializeJson(toArray(updates.soundboard_sounds), []));
    }

    assign('edited_timestamp', new Date());
    values.push(String(channelId), String(messageId));

    await db.none(
      `UPDATE messages SET ${fields.join(', ')} WHERE channel_id::text = $${values.length - 1} AND id::text = $${values.length}`,
      values,
    );

    return this.get(channelId, messageId);
  }

  static async delete(channelId, messageId) {
    await this.ensureSchema();
    return db.tx(async (tx) => {
      const result = await tx.result(
        'DELETE FROM messages WHERE channel_id::text = $1 AND id::text = $2',
        [String(channelId), String(messageId)],
      );
      if (result.rowCount > 0) {
        const latest = await tx.oneOrNone(
          'SELECT id FROM messages WHERE channel_id::text = $1 ORDER BY id DESC LIMIT 1',
          [String(channelId)],
        );
        await tx.none('UPDATE guild_channels SET last_message_id = $2 WHERE id = $1', [String(channelId), latest?.id || null]);
      }
      return result.rowCount > 0;
    });
  }
}

module.exports = Message;