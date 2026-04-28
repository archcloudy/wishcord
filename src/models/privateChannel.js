const db = require('../db');
const { generateSnowflake } = require('../utils/discordAuth');

const PRIVATE_CHANNEL_SCHEMA_UPDATES = [
  `CREATE TABLE IF NOT EXISTS private_channels (
    id BIGINT PRIMARY KEY,
    type INTEGER NOT NULL DEFAULT 1,
    owner_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    name VARCHAR(100),
    icon TEXT,
    last_message_id BIGINT,
    flags INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS private_channel_recipients (
    channel_id BIGINT NOT NULL REFERENCES private_channels(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, user_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_private_channel_recipients_user_id ON private_channel_recipients(user_id)',
];

let schemaReadyPromise;

const mapRecipient = (row) => ({
  id: String(row.user_id),
  username: row.username,
  discriminator: row.discriminator,
  global_name: row.global_name,
  avatar: row.avatar,
});

class PrivateChannel {
  static async ensureSchema() {
    if (!schemaReadyPromise) {
      schemaReadyPromise = (async () => {
        for (const statement of PRIVATE_CHANNEL_SCHEMA_UPDATES) {
          await db.none(statement);
        }
      })().catch((error) => {
        schemaReadyPromise = null;
        throw error;
      });
    }
    return schemaReadyPromise;
  }

  static async listForUser(userId) {
    await this.ensureSchema();
    const channels = await db.manyOrNone(
      `
        SELECT pc.id, pc.type, pc.owner_id, pc.name, pc.icon, pc.last_message_id, pc.flags
        FROM private_channels pc
        INNER JOIN private_channel_recipients pcr ON pcr.channel_id = pc.id
        WHERE pcr.user_id::text = $1
        ORDER BY pc.last_message_id DESC NULLS LAST, pc.id DESC
      `,
      [String(userId)],
    );

    if (!channels.length) {
      return [];
    }

    const recipientRows = await db.manyOrNone(
      `
        SELECT pcr.channel_id, u.id AS user_id, u.username, u.discriminator, u.global_name, u.avatar
        FROM private_channel_recipients pcr
        INNER JOIN users u ON u.id = pcr.user_id
        WHERE pcr.channel_id IN ($1:csv)
        ORDER BY pcr.channel_id ASC, u.id ASC
      `,
      [channels.map((channel) => channel.id)],
    );

    const byChannel = new Map();
    for (const row of recipientRows) {
      const key = String(row.channel_id);
      if (!byChannel.has(key)) {
        byChannel.set(key, []);
      }
      byChannel.get(key).push(mapRecipient(row));
    }

    return channels.map((channel) => ({
      id: String(channel.id),
      type: channel.type,
      last_message_id: channel.last_message_id ? String(channel.last_message_id) : null,
      flags: channel.flags || 0,
      name: channel.name || null,
      icon: channel.icon || null,
      owner_id: channel.owner_id ? String(channel.owner_id) : null,
      recipients: (byChannel.get(String(channel.id)) || []).filter((recipient) => String(recipient.id) !== String(userId)),
    }));
  }

  static async getDMChannel(userId, recipientId) {
    await this.ensureSchema();
    const row = await db.oneOrNone(
      `
        SELECT pc.id, pc.type, pc.owner_id, pc.name, pc.icon, pc.last_message_id, pc.flags
        FROM private_channels pc
        INNER JOIN private_channel_recipients self_recipient ON self_recipient.channel_id = pc.id
        INNER JOIN private_channel_recipients other_recipient ON other_recipient.channel_id = pc.id
        WHERE pc.type = 1
          AND self_recipient.user_id::text = $1
          AND other_recipient.user_id::text = $2
      `,
      [String(userId), String(recipientId)],
    );

    if (!row) {
      return null;
    }

    const channels = await this.listForUser(userId);
    return channels.find((channel) => String(channel.id) === String(row.id)) || null;
  }

  static async createChannel(userId, recipientIds, options = {}) {
    await this.ensureSchema();
    const uniqueRecipients = [...new Set([String(userId), ...recipientIds.map(String)])];
    const type = uniqueRecipients.length <= 2 ? 1 : 3;

    return db.tx(async (tx) => {
      if (type === 1 && uniqueRecipients.length === 2) {
        const existing = await this.getDMChannel(userId, uniqueRecipients.find((id) => id !== String(userId)));
        if (existing) {
          return existing;
        }
      }

      const channelId = generateSnowflake();
      await tx.none(
        `
          INSERT INTO private_channels (id, type, owner_id, name, icon, flags)
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [channelId, type, String(userId), options.name || null, options.icon || null, 0],
      );

      for (const recipientId of uniqueRecipients) {
        await tx.none(
          'INSERT INTO private_channel_recipients (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [String(channelId), String(recipientId)],
        );
      }

      const channels = await this.listForUser(userId);
      return channels.find((channel) => String(channel.id) === String(channelId)) || null;
    });
  }
}

module.exports = PrivateChannel;
