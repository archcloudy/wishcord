const db = require('../db');

const READ_STATE_SCHEMA_UPDATES = [
  `CREATE TABLE IF NOT EXISTS read_states (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL REFERENCES guild_channels(id) ON DELETE CASCADE,
    last_acked_id BIGINT,
    last_message_id BIGINT,
    mention_count INTEGER NOT NULL DEFAULT 0,
    badge_count INTEGER NOT NULL DEFAULT 0,
    flags INTEGER NOT NULL DEFAULT 0,
    last_viewed BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, channel_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_read_states_user_id ON read_states(user_id)',
];

let schemaReadyPromise;

const toEntry = (row) => ({
  id: String(row.channel_id),
  last_message_id: row.last_message_id ? String(row.last_message_id) : null,
  last_acked_id: row.last_acked_id ? String(row.last_acked_id) : null,
  mention_count: row.mention_count || 0,
  badge_count: row.badge_count || 0,
  flags: row.flags || 0,
  last_viewed: row.last_viewed ? String(row.last_viewed) : '0',
});

class ReadState {
  static async ensureSchema() {
    if (!schemaReadyPromise) {
      schemaReadyPromise = (async () => {
        for (const statement of READ_STATE_SCHEMA_UPDATES) {
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
    const rows = await db.manyOrNone(
      `
        SELECT channel_id, last_message_id, last_acked_id, mention_count, badge_count, flags, last_viewed
        FROM read_states
        WHERE user_id::text = $1
        ORDER BY updated_at DESC, channel_id DESC
      `,
      [String(userId)],
    );

    return rows.map(toEntry);
  }

  static async ack(userId, channelId, messageId) {
    await this.ensureSchema();

    const messageRow = await db.oneOrNone(
      `
        SELECT id, channel_id
        FROM messages
        WHERE channel_id::text = $1 AND id::text = $2
      `,
      [String(channelId), String(messageId)],
    );

    if (!messageRow) {
      return null;
    }

    const updated = await db.one(
      `
        INSERT INTO read_states (
          user_id,
          channel_id,
          last_acked_id,
          last_message_id,
          mention_count,
          badge_count,
          flags,
          last_viewed,
          updated_at
        )
        VALUES ($1, $2, $3, $3, 0, 0, 0, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, channel_id)
        DO UPDATE SET
          last_acked_id = EXCLUDED.last_acked_id,
          last_message_id = GREATEST(COALESCE(read_states.last_message_id, 0), EXCLUDED.last_message_id),
          mention_count = 0,
          badge_count = 0,
          last_viewed = EXCLUDED.last_viewed,
          updated_at = CURRENT_TIMESTAMP
        RETURNING channel_id, last_message_id, last_acked_id, mention_count, badge_count, flags, last_viewed
      `,
      [String(userId), String(channelId), String(messageId)],
    );

    return toEntry(updated);
  }

  static async markOwnMessageRead(userId, channelId, messageId) {
    await this.ensureSchema();
    await db.none(
      `
        INSERT INTO read_states (
          user_id,
          channel_id,
          last_acked_id,
          last_message_id,
          mention_count,
          badge_count,
          flags,
          last_viewed,
          updated_at
        )
        VALUES ($1, $2, $3, $3, 0, 0, 0, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, channel_id)
        DO UPDATE SET
          last_acked_id = EXCLUDED.last_acked_id,
          last_message_id = EXCLUDED.last_message_id,
          mention_count = 0,
          badge_count = 0,
          last_viewed = EXCLUDED.last_viewed,
          updated_at = CURRENT_TIMESTAMP
      `,
      [String(userId), String(channelId), String(messageId)],
    );
  }
}

module.exports = ReadState;
