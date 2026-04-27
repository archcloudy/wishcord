const db = require('../db');

const USER_GUILD_SETTINGS_SCHEMA_UPDATES = [
  `CREATE TABLE IF NOT EXISTS user_guild_settings (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    guild_id BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    channel_overrides JSONB NOT NULL DEFAULT '[]'::jsonb,
    flags INTEGER NOT NULL DEFAULT 0,
    hide_muted_channels BOOLEAN NOT NULL DEFAULT FALSE,
    message_notifications INTEGER NOT NULL DEFAULT 0,
    mobile_push BOOLEAN NOT NULL DEFAULT TRUE,
    mute_scheduled_events BOOLEAN NOT NULL DEFAULT FALSE,
    muted BOOLEAN NOT NULL DEFAULT FALSE,
    mute_config JSONB,
    notify_highlights INTEGER NOT NULL DEFAULT 0,
    suppress_everyone BOOLEAN NOT NULL DEFAULT FALSE,
    suppress_roles BOOLEAN NOT NULL DEFAULT FALSE,
    version INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, guild_id)
  )`,
  `CREATE TABLE IF NOT EXISTS user_notification_settings (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    flags INTEGER NOT NULL DEFAULT 16
  )`,
  'CREATE INDEX IF NOT EXISTS idx_user_guild_settings_user_id ON user_guild_settings(user_id)',
];

let schemaReadyPromise;

const toGuildSettings = (row) => ({
  guild_id: String(row.guild_id),
  channel_overrides: row.channel_overrides || [],
  flags: row.flags || 0,
  hide_muted_channels: Boolean(row.hide_muted_channels),
  message_notifications: row.message_notifications || 0,
  mobile_push: Boolean(row.mobile_push),
  mute_scheduled_events: Boolean(row.mute_scheduled_events),
  muted: Boolean(row.muted),
  mute_config: row.mute_config || null,
  notify_highlights: row.notify_highlights || 0,
  suppress_everyone: Boolean(row.suppress_everyone),
  suppress_roles: Boolean(row.suppress_roles),
  version: row.version || 0,
});

class UserGuildSettings {
  static async ensureSchema() {
    if (!schemaReadyPromise) {
      schemaReadyPromise = (async () => {
        for (const statement of USER_GUILD_SETTINGS_SCHEMA_UPDATES) {
          await db.none(statement);
        }
      })().catch((error) => {
        schemaReadyPromise = null;
        throw error;
      });
    }
    return schemaReadyPromise;
  }

  static async ensureDefaults(userId) {
    await this.ensureSchema();
    await db.none(
      `
        INSERT INTO user_notification_settings (user_id, flags)
        VALUES ($1, 16)
        ON CONFLICT (user_id) DO NOTHING
      `,
      [String(userId)],
    );

    await db.none(
      `
        INSERT INTO user_guild_settings (
          user_id, guild_id, channel_overrides, flags, hide_muted_channels,
          message_notifications, mobile_push, mute_scheduled_events, muted,
          mute_config, notify_highlights, suppress_everyone, suppress_roles, version
        )
        SELECT
          gm.user_id, gm.guild_id, '[]'::jsonb, 0, FALSE,
          0, TRUE, FALSE, FALSE,
          NULL, 0, FALSE, FALSE, 0
        FROM guild_members gm
        WHERE gm.user_id::text = $1
        ON CONFLICT (user_id, guild_id) DO NOTHING
      `,
      [String(userId)],
    );
  }

  static async listForUser(userId) {
    await this.ensureDefaults(userId);
    const rows = await db.manyOrNone(
      `
        SELECT guild_id, channel_overrides, flags, hide_muted_channels, message_notifications,
               mobile_push, mute_scheduled_events, muted, mute_config, notify_highlights,
               suppress_everyone, suppress_roles, version
        FROM user_guild_settings
        WHERE user_id::text = $1
        ORDER BY guild_id DESC
      `,
      [String(userId)],
    );

    return rows.map(toGuildSettings);
  }

  static async getNotificationSettings(userId) {
    await this.ensureDefaults(userId);
    const row = await db.one(
      'SELECT flags FROM user_notification_settings WHERE user_id::text = $1',
      [String(userId)],
    );
    return { flags: row.flags || 0 };
  }
}

module.exports = UserGuildSettings;
