const db = require('../db');

const DEFAULT_SETTINGS_BASE64 = '';

class UserSettingsProto {
  static normalizeType(protoType) {
    const normalized = Number.parseInt(protoType, 10);
    if (![1, 2, 3].includes(normalized)) {
      return null;
    }
    return normalized;
  }

  static async get(userId, protoType) {
    const normalizedType = this.normalizeType(protoType);
    if (normalizedType == null) {
      return null;
    }

    const row = await db.oneOrNone(
      `
        SELECT user_id, proto_type, settings_base64, data_version, updated_at
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
        updated_at: null,
      };
    }

    return row;
  }

  static async update(userId, protoType, settingsBase64, requiredDataVersion) {
    const normalizedType = this.normalizeType(protoType);
    if (normalizedType == null) {
      return null;
    }

    return db.tx(async (tx) => {
      const current = await tx.oneOrNone(
        `
          SELECT user_id, proto_type, settings_base64, data_version, updated_at
          FROM user_settings_proto
          WHERE user_id::text = $1 AND proto_type = $2
          FOR UPDATE
        `,
        [String(userId), normalizedType],
      );

      const currentDataVersion = current?.data_version ?? 0;
      if (requiredDataVersion != null && Number(requiredDataVersion) !== currentDataVersion) {
        return {
          settings_base64: current?.settings_base64 ?? DEFAULT_SETTINGS_BASE64,
          data_version: currentDataVersion,
          out_of_date: true,
        };
      }

      const nextDataVersion = currentDataVersion + 1;
      await tx.none(
        `
          INSERT INTO user_settings_proto (user_id, proto_type, settings_base64, data_version, updated_at)
          VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
          ON CONFLICT (user_id, proto_type)
          DO UPDATE
          SET settings_base64 = EXCLUDED.settings_base64,
              data_version = EXCLUDED.data_version,
              updated_at = CURRENT_TIMESTAMP
        `,
        [String(userId), normalizedType, settingsBase64, nextDataVersion],
      );

      return {
        settings_base64: settingsBase64,
        data_version: nextDataVersion,
        out_of_date: false,
      };
    });
  }
}

module.exports = UserSettingsProto;