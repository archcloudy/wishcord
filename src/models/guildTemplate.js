const crypto = require('crypto');
const db = require('../db');
const Guild = require('./guild');
const { normalizePermissionString } = require('../utils/permissions');

const generateTemplateCode = () => crypto.randomBytes(9).toString('base64url').slice(0, 12);

const mapPartialUser = (user) => ({
  id: String(user.id),
  username: user.username,
  discriminator: user.discriminator,
  global_name: user.global_name,
  avatar: user.avatar,
});

const buildSnapshot = async (guildId) => {
  const guild = await db.one('SELECT * FROM guilds WHERE id = $1', [guildId]);
  const roles = await db.manyOrNone(
    'SELECT * FROM guild_roles WHERE guild_id = $1 ORDER BY position ASC, id ASC',
    [guildId],
  );
  const channels = await db.manyOrNone(
    'SELECT * FROM guild_channels WHERE guild_id = $1 ORDER BY position ASC, id ASC',
    [guildId],
  );
  const overwrites = channels.length
    ? await db.manyOrNone(
        'SELECT * FROM channel_permission_overwrites WHERE channel_id IN ($1:csv)',
        [channels.map((channel) => channel.id)],
      )
    : [];

  // roles/channels use integer placeholders so a template can be replayed into a brand new guild
  const roleIndexById = new Map(roles.map((role, index) => [String(role.id), index]));
  const channelIndexById = new Map(channels.map((channel, index) => [String(channel.id), index + 1]));

  const overwritesByChannel = new Map();
  for (const overwrite of overwrites) {
    const key = String(overwrite.channel_id);
    if (!overwritesByChannel.has(key)) {
      overwritesByChannel.set(key, []);
    }
    const targetId = roleIndexById.has(String(overwrite.target_id))
      ? roleIndexById.get(String(overwrite.target_id))
      : String(overwrite.target_id);
    overwritesByChannel.get(key).push({
      id: targetId,
      type: overwrite.type,
      allow: normalizePermissionString(overwrite.allow),
      deny: normalizePermissionString(overwrite.deny),
    });
  }

  return {
    name: guild.name,
    description: guild.description,
    region: null,
    icon_hash: guild.icon,
    afk_timeout: guild.afk_timeout,
    verification_level: guild.verification_level,
    default_message_notifications: guild.default_message_notifications,
    explicit_content_filter: guild.explicit_content_filter,
    preferred_locale: guild.preferred_locale,
    system_channel_flags: guild.system_channel_flags,
    roles: roles.map((role, index) => ({
      id: index,
      name: role.name,
      permissions: normalizePermissionString(role.permissions),
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
    })),
    channels: channels.map((channel) => ({
      id: channelIndexById.get(String(channel.id)),
      name: channel.name,
      type: channel.type,
      position: channel.position,
      topic: channel.topic,
      nsfw: channel.nsfw,
      bitrate: channel.bitrate,
      user_limit: channel.user_limit,
      rate_limit_per_user: channel.rate_limit_per_user,
      parent_id: channel.parent_id ? channelIndexById.get(String(channel.parent_id)) ?? null : null,
      permission_overwrites: overwritesByChannel.get(String(channel.id)) || [],
    })),
  };
};

const mapTemplate = (template, creator, isDirty) => ({
  code: template.code,
  name: template.name,
  description: template.description,
  usage_count: template.usage_count,
  creator_id: String(template.creator_id),
  creator: mapPartialUser(creator),
  created_at: template.created_at.toISOString(),
  updated_at: template.updated_at.toISOString(),
  source_guild_id: String(template.source_guild_id),
  serialized_source_guild: template.serialized_source_guild,
  is_dirty: isDirty,
});

class GuildTemplate {
  static async get(code) {
    const template = await db.oneOrNone('SELECT * FROM guild_templates WHERE code = $1', [code]);
    if (!template) {
      return null;
    }
    const creator = await db.oneOrNone(
      'SELECT id, username, discriminator, global_name, avatar FROM users WHERE id = $1',
      [template.creator_id],
    );
    const currentSnapshot = await buildSnapshot(template.source_guild_id).catch(() => null);
    const isDirty = currentSnapshot
      ? JSON.stringify(currentSnapshot) !== JSON.stringify(template.serialized_source_guild)
      : null;
    return mapTemplate(template, creator, isDirty);
  }

  static async listForGuild(guildId) {
    const templates = await db.manyOrNone(
      'SELECT code FROM guild_templates WHERE source_guild_id = $1 ORDER BY created_at ASC',
      [guildId],
    );
    const results = [];
    for (const template of templates) {
      const mapped = await this.get(template.code);
      if (mapped) {
        results.push(mapped);
      }
    }
    return results;
  }

  static async create(guildId, creatorId, data) {
    const code = generateTemplateCode();
    const snapshot = await buildSnapshot(guildId);
    await db.none(
      `
        INSERT INTO guild_templates (code, source_guild_id, creator_id, name, description, serialized_source_guild)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [code, guildId, creatorId, data.name, data.description || null, JSON.stringify(snapshot)],
    );
    return this.get(code);
  }

  static async sync(guildId, code) {
    const existing = await db.oneOrNone(
      'SELECT code FROM guild_templates WHERE code = $1 AND source_guild_id = $2',
      [code, guildId],
    );
    if (!existing) {
      return null;
    }
    const snapshot = await buildSnapshot(guildId);
    await db.none(
      'UPDATE guild_templates SET serialized_source_guild = $2, updated_at = CURRENT_TIMESTAMP WHERE code = $1',
      [code, JSON.stringify(snapshot)],
    );
    return this.get(code);
  }

  static async update(guildId, code, data) {
    const existing = await db.oneOrNone(
      'SELECT code FROM guild_templates WHERE code = $1 AND source_guild_id = $2',
      [code, guildId],
    );
    if (!existing) {
      return null;
    }
    const fields = [];
    const values = [code];
    if (Object.prototype.hasOwnProperty.call(data, 'name')) {
      fields.push(`name = $${values.length + 1}`);
      values.push(data.name);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'description')) {
      fields.push(`description = $${values.length + 1}`);
      values.push(data.description || null);
    }
    if (fields.length) {
      await db.none(`UPDATE guild_templates SET ${fields.join(', ')} WHERE code = $1`, values);
    }
    return this.get(code);
  }

  static async delete(guildId, code) {
    const existing = await db.oneOrNone(
      'SELECT * FROM guild_templates WHERE code = $1 AND source_guild_id = $2',
      [code, guildId],
    );
    if (!existing) {
      return null;
    }
    const mapped = await this.get(code);
    await db.none('DELETE FROM guild_templates WHERE code = $1', [code]);
    return mapped;
  }

  static async use(code, creatorId, data) {
    const template = await db.oneOrNone('SELECT * FROM guild_templates WHERE code = $1', [code]);
    if (!template) {
      return null;
    }
    const snapshot = template.serialized_source_guild;
    const guild = await Guild.create(creatorId, {
      name: data.name,
      icon: data.icon || null,
      description: snapshot.description,
      verification_level: snapshot.verification_level,
      default_message_notifications: snapshot.default_message_notifications,
      explicit_content_filter: snapshot.explicit_content_filter,
      preferred_locale: snapshot.preferred_locale,
      afk_timeout: snapshot.afk_timeout,
      system_channel_flags: snapshot.system_channel_flags,
      roles: snapshot.roles,
      channels: snapshot.channels,
    });
    await db.none('UPDATE guild_templates SET usage_count = usage_count + 1 WHERE code = $1', [code]);
    return guild;
  }
}

module.exports = GuildTemplate;
