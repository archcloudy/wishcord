const db = require('../db');
const { generateSnowflake, generateDiscriminator } = require('../utils/discordAuth');

const USER_SCHEMA_UPDATES = [
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS banner TEXT',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS accent_color INTEGER',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS pronouns VARCHAR(40)',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS flags BIGINT NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS public_flags BIGINT NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_type INTEGER NOT NULL DEFAULT 0',
];

let schemaReadyPromise;

const USER_RETURNING_FIELDS = `
  id, username, discriminator, global_name, avatar, banner, accent_color, pronouns, bio, email, verified, mfa_enabled, flags, public_flags, premium_type, created_at
`;

class User {
  static async ensureSchema() {
    if (!schemaReadyPromise) {
      schemaReadyPromise = (async () => {
        for (const statement of USER_SCHEMA_UPDATES) {
          await db.none(statement);
        }
      })().catch((error) => {
        schemaReadyPromise = null;
        throw error;
      });
    }

    return schemaReadyPromise;
  }

  static async create(userData) {
    await this.ensureSchema();
    const {
      id = generateSnowflake(),
      username,
      email,
      password,
      discriminator = generateDiscriminator(),
      global_name = null,
    } = userData;
    const query = `
      INSERT INTO users (id, username, discriminator, global_name, email, password_hash)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING ${USER_RETURNING_FIELDS}
    `;
    const values = [id, username, discriminator, global_name, email, password];
    return db.one(query, values);
  }

  static async findById(id) {
    await this.ensureSchema();
    const query = `
      SELECT ${USER_RETURNING_FIELDS}
      FROM users
      WHERE id::text = $1
    `;
    return db.oneOrNone(query, [String(id)]);
  }

  static async findByIdWithPasswordHash(id) {
    await this.ensureSchema();
    const query = `
      SELECT ${USER_RETURNING_FIELDS}, password_hash
      FROM users
      WHERE id::text = $1
    `;
    return db.oneOrNone(query, [String(id)]);
  }

  static async findByUsername(username) {
    await this.ensureSchema();
    const query = `
      SELECT ${USER_RETURNING_FIELDS}
      FROM users
      WHERE username = $1
    `;
    return db.oneOrNone(query, [username]);
  }

  static async findByEmail(email) {
    await this.ensureSchema();
    const query = `
      SELECT ${USER_RETURNING_FIELDS}, password_hash
      FROM users
      WHERE email = $1
    `;
    return db.oneOrNone(query, [email]);
  }

  static async update(id, updates) {
    await this.ensureSchema();
    const fields = Object.keys(updates);
    const values = Object.values(updates);
    const setClause = fields.map((field, index) => `${field} = $${index + 2}`).join(', ');
    const query = `
      UPDATE users
      SET ${setClause}
      WHERE id = $1
      RETURNING ${USER_RETURNING_FIELDS}
    `;
    return db.one(query, [id, ...values]);
  }
}

module.exports = User;