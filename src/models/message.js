const db = require('../db');
const { generateSnowflake } = require('../utils/discordAuth');

const mapPartialUser = (user) => ({
  id: String(user.id),
  username: user.username,
  discriminator: user.discriminator,
  global_name: user.global_name,
  avatar: user.avatar,
});

const mapMessage = (message, author) => ({
  id: String(message.id),
  type: message.type,
  content: message.content,
  channel_id: String(message.channel_id),
  author: mapPartialUser(author),
  attachments: message.attachments || [],
  embeds: message.embeds || [],
  mentions: message.mentions || [],
  mention_roles: (message.mention_roles || []).map(String),
  pinned: message.pinned,
  mention_everyone: message.mention_everyone,
  tts: message.tts,
  timestamp: message.created_at.toISOString(),
  edited_timestamp: message.edited_timestamp ? message.edited_timestamp.toISOString() : null,
  flags: message.flags,
  components: message.components || [],
  nonce: message.nonce,
  message_reference: message.message_reference || undefined,
});

class Message {
  static async list(channelId, options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit) || 50, 100));
    const values = [channelId];
    const filters = ['m.channel_id = $1'];

    if (options.before) {
      filters.push(`m.id < ($${values.length + 1})::bigint`);
      values.push(String(options.before));
    }
    if (options.after) {
      filters.push(`m.id > ($${values.length + 1})::bigint`);
      values.push(String(options.after));
    }

    let rows;
    if (options.around) {
      values.push(String(options.around), limit);
      rows = await db.manyOrNone(
        `
          SELECT m.*, u.id AS user_id, u.username, u.discriminator, u.global_name, u.avatar
          FROM messages m
          INNER JOIN users u ON u.id = m.author_id
          WHERE m.channel_id = $1
          ORDER BY ABS((m.id::numeric) - ($2)::numeric) ASC, m.id DESC
          LIMIT $3
        `,
        values,
      );
      rows.sort((left, right) => Number(BigInt(right.id) - BigInt(left.id)));
    } else {
      values.push(limit);
      rows = await db.manyOrNone(
        `
          SELECT m.*, u.id AS user_id, u.username, u.discriminator, u.global_name, u.avatar
          FROM messages m
          INNER JOIN users u ON u.id = m.author_id
          WHERE ${filters.join(' AND ')}
          ORDER BY m.id DESC
          LIMIT $${values.length}
        `,
        values,
      );
    }

    return rows.map((row) => mapMessage(row, row));
  }

  static async get(channelId, messageId) {
    const row = await db.oneOrNone(
      `
        SELECT m.*, u.id AS user_id, u.username, u.discriminator, u.global_name, u.avatar
        FROM messages m
        INNER JOIN users u ON u.id = m.author_id
        WHERE m.channel_id = $1 AND m.id::text = $2
      `,
      [channelId, String(messageId)],
    );
    return row ? mapMessage(row, row) : null;
  }

  static async getByNonce(channelId, authorId, nonce) {
    if (!nonce) {
      return null;
    }
    const row = await db.oneOrNone(
      `
        SELECT m.*, u.id AS user_id, u.username, u.discriminator, u.global_name, u.avatar
        FROM messages m
        INNER JOIN users u ON u.id = m.author_id
        WHERE m.channel_id = $1 AND m.author_id = $2 AND m.nonce = $3
      `,
      [channelId, authorId, String(nonce)],
    );
    return row ? mapMessage(row, row) : null;
  }

  static async create(channelId, authorId, data) {
    const existing = await this.getByNonce(channelId, authorId, data.nonce);
    if (existing) {
      return existing;
    }

    const messageId = generateSnowflake();
    const row = await db.tx(async (tx) => {
      const created = await tx.one(
        `
          INSERT INTO messages (
            id, channel_id, author_id, content, nonce, tts, mention_everyone, mentions,
            mention_roles, attachments, embeds, components, pinned, type, flags, message_reference
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false, 0, $13, $14)
          RETURNING *
        `,
        [
          messageId,
          channelId,
          authorId,
          data.content || '',
          data.nonce || null,
          Boolean(data.tts),
          Boolean(data.mention_everyone),
          JSON.stringify(data.mentions || []),
          JSON.stringify((data.mention_roles || []).map(String)),
          JSON.stringify(data.attachments || []),
          JSON.stringify(data.embeds || []),
          JSON.stringify(data.components || []),
          data.flags || 0,
          data.message_reference ? JSON.stringify(data.message_reference) : null,
        ],
      );
      await tx.none('UPDATE guild_channels SET last_message_id = $2 WHERE id = $1', [channelId, messageId]);
      return created;
    });

    return this.get(channelId, row.id);
  }

  static async update(channelId, messageId, updates) {
    const fields = [];
    const values = [channelId, String(messageId)];
    const assign = (column, value) => {
      fields.push(`${column} = $${values.length + 1}`);
      values.push(value);
    };

    if (Object.prototype.hasOwnProperty.call(updates, 'content')) {
      assign('content', updates.content ?? '');
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'flags')) {
      assign('flags', updates.flags ?? 0);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'embeds')) {
      assign('embeds', JSON.stringify(updates.embeds || []));
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'components')) {
      assign('components', JSON.stringify(updates.components || []));
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'attachments')) {
      assign('attachments', JSON.stringify(updates.attachments || []));
    }
    assign('edited_timestamp', new Date());

    await db.none(
      `UPDATE messages SET ${fields.join(', ')} WHERE channel_id = $1 AND id::text = $2`,
      values,
    );

    return this.get(channelId, messageId);
  }

  static async delete(channelId, messageId) {
    return db.tx(async (tx) => {
      const result = await tx.result(
        'DELETE FROM messages WHERE channel_id = $1 AND id::text = $2',
        [channelId, String(messageId)],
      );
      if (result.rowCount > 0) {
        const latest = await tx.oneOrNone(
          'SELECT id FROM messages WHERE channel_id = $1 ORDER BY id DESC LIMIT 1',
          [channelId],
        );
        await tx.none('UPDATE guild_channels SET last_message_id = $2 WHERE id = $1', [channelId, latest?.id || null]);
      }
      return result.rowCount > 0;
    });
  }
}

module.exports = Message;