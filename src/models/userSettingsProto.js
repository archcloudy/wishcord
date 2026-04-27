const db = require('../db');

const DEFAULT_SETTINGS_BASE64 = '';
const SETTINGS_SCHEMA_UPDATES = [
  'ALTER TABLE user_settings_proto ADD COLUMN IF NOT EXISTS client_version INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE user_settings_proto ADD COLUMN IF NOT EXISTS server_version INTEGER NOT NULL DEFAULT 0',
];
let schemaReadyPromise;

// User Settings Proto Types as defined in Discord documentation
const PROTO_TYPES = {
  PRELOADED: 1,    // General Discord user settings, sent in the Ready event
  FRECENCY: 2,     // Frecency and favorites storage, used for low-priority, lazy-loaded settings
  TEST_SETTINGS: 3 // Unknown/Test settings
};

class UserSettingsProto {
  static async ensureSchema() {
    if (!schemaReadyPromise) {
      schemaReadyPromise = (async () => {
        for (const statement of SETTINGS_SCHEMA_UPDATES) {
          await db.none(statement);
        }
      })().catch((error) => {
        schemaReadyPromise = null;
        throw error;
      });
    }

    return schemaReadyPromise;
  }

  static get PROTO_TYPES() {
    return PROTO_TYPES;
  }

  static normalizeType(protoType) {
    const normalized = Number.parseInt(protoType, 10);
    if (!Object.values(PROTO_TYPES).includes(normalized)) {
      return null;
    }
    return normalized;
  }

  static getTypeName(protoType) {
    return Object.keys(PROTO_TYPES).find(key => PROTO_TYPES[key] === protoType) || 'UNKNOWN';
  }

  static async get(userId, protoType) {
    await this.ensureSchema();
    const normalizedType = this.normalizeType(protoType);
    if (normalizedType == null) {
      return null;
    }

    // Use a more defensive query that doesn't reference potentially missing columns
    const row = await db.oneOrNone(
      `
       SELECT user_id, proto_type, settings_base64, data_version,
         client_version, server_version,
               created_at, updated_at
        FROM user_settings_proto
        WHERE user_id::text = $1 AND proto_type = $2
      `,
      [String(userId), normalizedType],
    );

    if (!row) {
      return {
        user_id: String(userId),
        proto_type: normalizedType,
        settings_base64: DEFAULT_SETTINGS_BASE64,
        data_version: 0,
        client_version: 0,
        server_version: 0,
        created_at: null,
        updated_at: null,
      };
    }

    return row;
  }

  static async getAll(userId) {
    await this.ensureSchema();
    const rows = await db.manyOrNone(
      `
        SELECT user_id, proto_type, settings_base64, data_version,
               client_version, server_version,
               created_at, updated_at
        FROM user_settings_proto
        WHERE user_id::text = $1
        ORDER BY proto_type
      `,
      [String(userId)],
    );

    // Ensure all proto types exist, even if empty
    const result = {};
    Object.values(PROTO_TYPES).forEach(type => {
      const existing = rows.find(row => row.proto_type === type);
      if (existing) {
        result[type] = existing;
      } else {
        result[type] = {
          user_id: String(userId),
          proto_type: type,
          settings_base64: DEFAULT_SETTINGS_BASE64,
          data_version: 0,
          client_version: 0,
          server_version: 0,
          created_at: null,
          updated_at: null,
        };
      }
    });

    return result;
  }

  static async update(userId, protoType, settingsBase64, requiredDataVersion, clientVersion = 0) {
    await this.ensureSchema();
    const normalizedType = this.normalizeType(protoType);
    if (normalizedType == null) {
      return null;
    }

    // Validate base64 string
    if (typeof settingsBase64 !== 'string') {
      throw new Error('settings must be a base64 string');
    }

    // Check maximum length (5MB as per Discord docs)
    if (settingsBase64.length > 5242880) {
      throw new Error('settings exceeds maximum length of 5242880 characters');
    }

    return db.tx(async (tx) => {
      const current = await tx.oneOrNone(
        `
           SELECT user_id, proto_type, settings_base64, data_version,
             client_version, server_version,
                 updated_at
          FROM user_settings_proto
          WHERE user_id::text = $1 AND proto_type = $2
          FOR UPDATE
        `,
        [String(userId), normalizedType],
      );

      const currentDataVersion = current?.data_version ?? 0;

      // Check required data version for optimistic concurrency control
      if (requiredDataVersion != null && Number(requiredDataVersion) !== currentDataVersion) {
        return {
          settings_base64: current?.settings_base64 ?? DEFAULT_SETTINGS_BASE64,
          data_version: currentDataVersion,
          client_version: current?.client_version ?? 0,
          server_version: current?.server_version ?? 0,
          out_of_date: true,
        };
      }

      const nextDataVersion = currentDataVersion + 1;
      const serverVersion = 0; // As per Discord docs, server_version is currently 0
      await tx.none(
        `
          INSERT INTO user_settings_proto (user_id, proto_type, settings_base64, data_version, client_version, server_version, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
          ON CONFLICT (user_id, proto_type)
          DO UPDATE
          SET settings_base64 = EXCLUDED.settings_base64,
              data_version = EXCLUDED.data_version,
              client_version = EXCLUDED.client_version,
              server_version = EXCLUDED.server_version,
              updated_at = CURRENT_TIMESTAMP
        `,
        [String(userId), normalizedType, settingsBase64, nextDataVersion, clientVersion, serverVersion],
      );

      return {
        settings_base64: settingsBase64,
        data_version: nextDataVersion,
        client_version: clientVersion,
        server_version: serverVersion,
        out_of_date: false,
      };
    });
  }

  static async delete(userId, protoType) {
    await this.ensureSchema();
    const normalizedType = this.normalizeType(protoType);
    if (normalizedType == null) {
      return false;
    }

    const result = await db.result(
      `
        DELETE FROM user_settings_proto
        WHERE user_id::text = $1 AND proto_type = $2
      `,
      [String(userId), normalizedType],
    );

    return result.rowCount > 0;
  }

  static async getVersions(userId, protoType) {
    const settings = await this.get(userId, protoType);
    if (!settings) {
      return null;
    }

    return {
      client_version: settings.client_version || 0,
      server_version: settings.server_version || 0,
      data_version: settings.data_version || 0,
    };
  }

  // Batch update multiple proto types (for efficiency)
  static async batchUpdate(userId, updates) {
    await this.ensureSchema();
    if (!Array.isArray(updates) || updates.length === 0) {
      throw new Error('updates must be a non-empty array');
    }

    const results = [];
    for (const update of updates) {
      const protoType = update.protoType ?? update.type;
      const settingsBase64 = update.settingsBase64 ?? update.settings;
      const result = await this.update(
        userId,
        protoType,
        settingsBase64,
        update.requiredDataVersion ?? update.required_data_version,
        update.clientVersion ?? update.client_version ?? 0,
      );

      results.push({
        proto_type: Number(protoType),
        ...result,
      });
    }

    return results;
  }
}

module.exports = UserSettingsProto;