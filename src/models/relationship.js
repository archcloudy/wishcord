const db = require('../db');
const User = require('./user');

const RELATIONSHIP_TYPES = {
  NONE: 0,
  FRIEND: 1,
  BLOCKED: 2,
  INCOMING_REQUEST: 3,
  OUTGOING_REQUEST: 4,
  IMPLICIT: 5,
};

const RELATIONSHIP_SCHEMA_UPDATES = [
  `CREATE TABLE IF NOT EXISTS relationships (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type INTEGER NOT NULL DEFAULT 0,
    nickname VARCHAR(32),
    user_ignored BOOLEAN NOT NULL DEFAULT FALSE,
    since TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, target_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_relationships_user_id ON relationships(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_relationships_target_id ON relationships(target_id)',
];

let schemaReadyPromise;

const toRelationship = (row) => ({
  id: String(row.target_id),
  type: row.type,
  user: {
    id: String(row.id),
    username: row.username,
    discriminator: row.discriminator,
    global_name: row.global_name,
    avatar: row.avatar,
    banner: row.banner,
    accent_color: row.accent_color,
    public_flags: 0,
    avatar_decoration_data: null,
    primary_guild: null,
  },
  nickname: row.nickname || null,
  user_ignored: Boolean(row.user_ignored),
  since: row.since ? new Date(row.since).toISOString() : null,
  is_spam_request: false,
  stranger_request: false,
});

class Relationship {
  static get TYPES() {
    return RELATIONSHIP_TYPES;
  }

  static async ensureSchema() {
    if (!schemaReadyPromise) {
      schemaReadyPromise = (async () => {
        for (const statement of RELATIONSHIP_SCHEMA_UPDATES) {
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
        SELECT
          r.user_id,
          r.target_id,
          r.type,
          r.nickname,
          r.user_ignored,
          r.since,
          u.id,
          u.username,
          u.discriminator,
          u.global_name,
          u.avatar,
          u.banner,
          u.accent_color
        FROM relationships r
        INNER JOIN users u ON u.id = r.target_id
        WHERE r.user_id::text = $1
        ORDER BY r.since DESC, r.target_id DESC
      `,
      [String(userId)],
    );

    return rows.map(toRelationship);
  }

  static async get(userId, targetId) {
    await this.ensureSchema();
    const rows = await this.listForUser(userId);
    return rows.find((relationship) => String(relationship.id) === String(targetId)) || null;
  }

  static async createFriendRequest(userId, targetId) {
    await this.ensureSchema();

    if (String(userId) === String(targetId)) {
      return null;
    }

    return db.tx(async (tx) => {
      await tx.none(
        `
          INSERT INTO relationships (user_id, target_id, type, since)
          VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
          ON CONFLICT (user_id, target_id)
          DO UPDATE SET
            type = EXCLUDED.type,
            since = CURRENT_TIMESTAMP
        `,
        [String(userId), String(targetId), RELATIONSHIP_TYPES.OUTGOING_REQUEST],
      );

      await tx.none(
        `
          INSERT INTO relationships (user_id, target_id, type, since)
          VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
          ON CONFLICT (user_id, target_id)
          DO UPDATE SET
            type = EXCLUDED.type,
            since = CURRENT_TIMESTAMP
        `,
        [String(targetId), String(userId), RELATIONSHIP_TYPES.INCOMING_REQUEST],
      );
    });
  }

  static async setRelationship(userId, targetId, type) {
    await this.ensureSchema();

    return db.tx(async (tx) => {
      if (type === RELATIONSHIP_TYPES.FRIEND) {
        await tx.none(
          `
            INSERT INTO relationships (user_id, target_id, type, since)
            VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id, target_id)
            DO UPDATE SET type = EXCLUDED.type
          `,
          [String(userId), String(targetId), RELATIONSHIP_TYPES.FRIEND],
        );
        await tx.none(
          `
            INSERT INTO relationships (user_id, target_id, type, since)
            VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id, target_id)
            DO UPDATE SET type = EXCLUDED.type
          `,
          [String(targetId), String(userId), RELATIONSHIP_TYPES.FRIEND],
        );
      } else if (type === RELATIONSHIP_TYPES.BLOCKED) {
        await tx.none(
          `
            INSERT INTO relationships (user_id, target_id, type, since)
            VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id, target_id)
            DO UPDATE SET type = EXCLUDED.type
          `,
          [String(userId), String(targetId), RELATIONSHIP_TYPES.BLOCKED],
        );
        await tx.none(
          'DELETE FROM relationships WHERE user_id::text = $1 AND target_id::text = $2',
          [String(targetId), String(userId)],
        );
      } else {
        await tx.none(
          `
            INSERT INTO relationships (user_id, target_id, type, since)
            VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id, target_id)
            DO UPDATE SET type = EXCLUDED.type
          `,
          [String(userId), String(targetId), type],
        );
      }
    });

    return this.get(userId, targetId);
  }

  static async acceptOrRequest(userId, targetId) {
    await this.ensureSchema();
    const incoming = await this.get(userId, targetId);
    if (incoming?.type === RELATIONSHIP_TYPES.INCOMING_REQUEST) {
      return this.setRelationship(userId, targetId, RELATIONSHIP_TYPES.FRIEND);
    }

    await this.createFriendRequest(userId, targetId);
    return this.get(userId, targetId);
  }

  static async updateNickname(userId, targetId, nickname) {
    await this.ensureSchema();
    await db.none(
      `
        UPDATE relationships
        SET nickname = $3
        WHERE user_id::text = $1 AND target_id::text = $2 AND type = $4
      `,
      [String(userId), String(targetId), nickname || null, RELATIONSHIP_TYPES.FRIEND],
    );
    return this.get(userId, targetId);
  }

  static async remove(userId, targetId) {
    await this.ensureSchema();
    return db.tx(async (tx) => {
      const existing = await tx.oneOrNone(
        'SELECT type FROM relationships WHERE user_id::text = $1 AND target_id::text = $2',
        [String(userId), String(targetId)],
      );

      await tx.none('DELETE FROM relationships WHERE user_id::text = $1 AND target_id::text = $2', [String(userId), String(targetId)]);

      if (existing?.type === RELATIONSHIP_TYPES.FRIEND) {
        await tx.none('DELETE FROM relationships WHERE user_id::text = $1 AND target_id::text = $2', [String(targetId), String(userId)]);
      }

      if (existing?.type === RELATIONSHIP_TYPES.OUTGOING_REQUEST || existing?.type === RELATIONSHIP_TYPES.INCOMING_REQUEST) {
        await tx.none('DELETE FROM relationships WHERE user_id::text = $1 AND target_id::text = $2', [String(targetId), String(userId)]);
      }

      return Boolean(existing);
    });
  }

  static async mutualFriends(userId, otherUserId) {
    await this.ensureSchema();
    const rows = await db.manyOrNone(
      `
        SELECT u.id, u.username, u.discriminator, u.global_name, u.avatar, u.banner, u.accent_color
        FROM relationships r1
        INNER JOIN relationships r2 ON r2.target_id = r1.target_id
        INNER JOIN users u ON u.id = r1.target_id
        WHERE r1.user_id::text = $1
          AND r2.user_id::text = $2
          AND r1.type = $3
          AND r2.type = $3
      `,
      [String(userId), String(otherUserId), RELATIONSHIP_TYPES.FRIEND],
    );

    return rows.map((row) => ({
      id: String(row.id),
      username: row.username,
      discriminator: row.discriminator,
      global_name: row.global_name,
      avatar: row.avatar,
      banner: row.banner,
      accent_color: row.accent_color,
      public_flags: 0,
      avatar_decoration_data: null,
      primary_guild: null,
    }));
  }

  static async findTargetByTag(username, discriminator = null) {
    if (discriminator == null || discriminator === '0') {
      return User.findByUsername(username);
    }

    return db.oneOrNone(
      `
        SELECT id, username, discriminator, global_name, avatar, banner, accent_color, bio, email, verified, created_at
        FROM users
        WHERE username = $1 AND discriminator = $2
      `,
      [username, discriminator],
    );
  }
}

module.exports = Relationship;
