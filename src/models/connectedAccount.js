const db = require('../db');
const { generateSnowflake } = require('../utils/discordAuth');

const CONNECTED_ACCOUNTS_SCHEMA_UPDATES = [
  `CREATE TABLE IF NOT EXISTS connected_accounts (
    id BIGINT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(32) NOT NULL,
    account_identifier VARCHAR(128) NOT NULL,
    name VARCHAR(128) NOT NULL,
    verified BOOLEAN NOT NULL DEFAULT FALSE,
    friend_sync BOOLEAN NOT NULL DEFAULT TRUE,
    show_activity BOOLEAN NOT NULL DEFAULT TRUE,
    visibility INTEGER NOT NULL DEFAULT 1,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_connected_accounts_user_id ON connected_accounts(user_id, created_at DESC)',
];

let schemaReadyPromise;

const toConnection = (row) => ({
  id: String(row.id),
  type: row.type,
  name: row.name,
  verified: Boolean(row.verified),
  friend_sync: Boolean(row.friend_sync),
  show_activity: Boolean(row.show_activity),
  visibility: row.visibility,
  metadata: row.metadata || {},
});

class ConnectedAccount {
  static async ensureSchema() {
    if (!schemaReadyPromise) {
      schemaReadyPromise = (async () => {
        for (const statement of CONNECTED_ACCOUNTS_SCHEMA_UPDATES) {
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
        SELECT id, type, account_identifier, name, verified, friend_sync, show_activity, visibility, metadata
        FROM connected_accounts
        WHERE user_id::text = $1
        ORDER BY created_at DESC, id DESC
      `,
      [String(userId)],
    );
    return rows.map((row) => ({ ...toConnection(row), account_identifier: row.account_identifier }));
  }

  static async create(userId, payload) {
    await this.ensureSchema();
    const row = await db.one(
      `
        INSERT INTO connected_accounts (
          id, user_id, type, account_identifier, name, verified, friend_sync, show_activity, visibility, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, type, account_identifier, name, verified, friend_sync, show_activity, visibility, metadata
      `,
      [
        generateSnowflake(),
        String(userId),
        payload.type,
        payload.account_identifier,
        payload.name,
        Boolean(payload.verified),
        payload.friend_sync !== false,
        payload.show_activity !== false,
        payload.visibility ?? 1,
        payload.metadata || {},
      ],
    );
    return { ...toConnection(row), account_identifier: row.account_identifier };
  }

  static async update(userId, type, connectionId, payload) {
    await this.ensureSchema();
    const fields = [];
    const values = [String(userId), String(type), String(connectionId)];

    if (Object.prototype.hasOwnProperty.call(payload, 'name')) {
      values.push(payload.name);
      fields.push(`name = $${values.length}`);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'show_activity')) {
      values.push(Boolean(payload.show_activity));
      fields.push(`show_activity = $${values.length}`);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'friend_sync')) {
      values.push(Boolean(payload.friend_sync));
      fields.push(`friend_sync = $${values.length}`);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'visibility')) {
      values.push(Number(payload.visibility));
      fields.push(`visibility = $${values.length}`);
    }

    if (!fields.length) {
      return this.getByTypeAndId(userId, type, connectionId);
    }

    const row = await db.oneOrNone(
      `
        UPDATE connected_accounts
        SET ${fields.join(', ')}
        WHERE user_id::text = $1 AND type = $2 AND id::text = $3
        RETURNING id, type, account_identifier, name, verified, friend_sync, show_activity, visibility, metadata
      `,
      values,
    );

    return row ? { ...toConnection(row), account_identifier: row.account_identifier } : null;
  }

  static async delete(userId, type, connectionId) {
    await this.ensureSchema();
    const result = await db.result(
      'DELETE FROM connected_accounts WHERE user_id::text = $1 AND type = $2 AND id::text = $3',
      [String(userId), String(type), String(connectionId)],
    );
    return result.rowCount > 0;
  }

  static async getByTypeAndId(userId, type, connectionId) {
    await this.ensureSchema();
    const row = await db.oneOrNone(
      `
        SELECT id, type, account_identifier, name, verified, friend_sync, show_activity, visibility, metadata
        FROM connected_accounts
        WHERE user_id::text = $1 AND type = $2 AND id::text = $3
      `,
      [String(userId), String(type), String(connectionId)],
    );
    return row ? { ...toConnection(row), account_identifier: row.account_identifier } : null;
  }
}

module.exports = ConnectedAccount;
