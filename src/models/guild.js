const db = require('../db');
const { generateSnowflake } = require('../utils/discordAuth');
const {
  ADMINISTRATOR,
  CREATE_INSTANT_INVITE,
  MANAGE_NICKNAMES,
  MANAGE_CHANNELS,
  MANAGE_MESSAGES,
  MANAGE_GUILD,
  MANAGE_ROLES,
  KICK_MEMBERS,
  MODERATE_MEMBERS,
  READ_MESSAGE_HISTORY,
  SEND_MESSAGES,
  VIEW_CHANNEL,
  hasPermission,
  normalizePermissionString,
  computeBasePermissions,
  computeChannelPermissions,
} = require('../utils/permissions');

const DEFAULT_EVERYONE_PERMISSIONS = '2251804225353728';
const DEFAULT_CHANNEL_PERMISSIONS = '0';

const mapRole = (role) => ({
  id: String(role.id),
  name: role.name,
  description: role.description,
  permissions: normalizePermissionString(role.permissions),
  position: role.position,
  color: role.color,
  colors: role.colors || {
    primary_color: role.color || 0,
    secondary_color: null,
    tertiary_color: null,
  },
  hoist: role.hoist,
  managed: role.managed,
  mentionable: role.mentionable,
  icon: role.icon,
  unicode_emoji: role.unicode_emoji,
  flags: role.flags || 0,
  tags: role.tags,
});

const mapChannel = (channel) => ({
  id: String(channel.id),
  guild_id: String(channel.guild_id),
  parent_id: channel.parent_id ? String(channel.parent_id) : null,
  name: channel.name,
  type: channel.type,
  position: channel.position,
  flags: channel.flags || 0,
  topic: channel.topic,
  nsfw: channel.nsfw,
  last_message_id: channel.last_message_id ? String(channel.last_message_id) : null,
  bitrate: channel.bitrate,
  user_limit: channel.user_limit,
  rate_limit_per_user: channel.rate_limit_per_user,
  permissions: channel.permissions,
  permission_overwrites: channel.permission_overwrites || [],
});

const mapPartialUser = (user) => ({
  id: String(user.id),
  username: user.username,
  discriminator: user.discriminator,
  global_name: user.global_name,
  avatar: user.avatar,
});

const mapGatewayUser = (user) => ({
  id: String(user.id),
  username: user.username,
  discriminator: user.discriminator,
  global_name: user.global_name,
  avatar: user.avatar,
  banner: user.banner,
  accent_color: user.accent_color,
  pronouns: user.pronouns,
  bio: user.bio,
  email: user.email,
  verified: user.verified,
  mfa_enabled: user.mfa_enabled,
  flags: user.flags,
  public_flags: user.public_flags,
  premium_type: user.premium_type,
});

const mapMember = (member, user, permissions) => ({
  user: mapGatewayUser(user),
  nick: member.nick,
  avatar: member.avatar,
  banner: member.banner,
  bio: member.bio,
  roles: (member.role_ids || []).map(String),
  joined_at: member.joined_at.toISOString(),
  premium_since: member.premium_since ? member.premium_since.toISOString() : null,
  deaf: member.deaf,
  mute: member.mute,
  pending: member.pending,
  communication_disabled_until: member.communication_disabled_until
    ? member.communication_disabled_until.toISOString()
    : null,
  unusual_dm_activity_until: member.unusual_dm_activity_until
    ? member.unusual_dm_activity_until.toISOString()
    : null,
  flags: member.flags,
  permissions,
});

const mapGuild = (guild, roles, counts = null) => ({
  id: String(guild.id),
  name: guild.name,
  icon: guild.icon,
  banner: guild.banner,
  splash: guild.splash,
  discovery_splash: guild.discovery_splash,
  owner_id: String(guild.owner_id),
  description: guild.description,
  afk_channel_id: guild.afk_channel_id ? String(guild.afk_channel_id) : null,
  afk_timeout: guild.afk_timeout,
  widget_enabled: guild.widget_enabled,
  widget_channel_id: guild.widget_channel_id ? String(guild.widget_channel_id) : null,
  verification_level: guild.verification_level,
  default_message_notifications: guild.default_message_notifications,
  explicit_content_filter: guild.explicit_content_filter,
  roles: roles.map(mapRole),
  emojis: [],
  stickers: [],
  features: guild.features || [],
  mfa_level: guild.mfa_level,
  system_channel_id: guild.system_channel_id ? String(guild.system_channel_id) : null,
  system_channel_flags: guild.system_channel_flags,
  rules_channel_id: guild.rules_channel_id ? String(guild.rules_channel_id) : null,
  public_updates_channel_id: guild.public_updates_channel_id ? String(guild.public_updates_channel_id) : null,
  safety_alerts_channel_id: guild.safety_alerts_channel_id ? String(guild.safety_alerts_channel_id) : null,
  max_presences: guild.max_presences,
  max_members: guild.max_members,
  vanity_url_code: guild.vanity_url_code,
  premium_tier: guild.premium_tier,
  premium_subscription_count: guild.premium_subscription_count,
  preferred_locale: guild.preferred_locale,
  max_video_channel_users: guild.max_video_channel_users,
  max_stage_video_channel_users: guild.max_stage_video_channel_users,
  nsfw: guild.nsfw_level > 0,
  nsfw_level: guild.nsfw_level,
  premium_progress_bar_enabled: guild.premium_progress_bar_enabled,
  approximate_member_count: counts?.member_count,
  approximate_presence_count: counts?.presence_count,
});

const buildPresence = (userId, guildId, status = 'online') => ({
  user: { id: String(userId) },
  guild_id: String(guildId),
  status,
  activities: [],
  client_status: {
    web: status,
  },
});

const mapPartialGuild = (guild, counts = null) => ({
  id: String(guild.id),
  name: guild.name,
  icon: guild.icon,
  description: guild.description,
  splash: guild.splash,
  discovery_splash: guild.discovery_splash,
  home_header: null,
  features: guild.features || [],
  emojis: [],
  stickers: [],
  approximate_member_count: counts?.member_count,
  approximate_presence_count: counts?.presence_count,
});

class Guild {
  static async create(ownerId, data) {
    return db.tx(async (tx) => {
      const guildId = data.id || generateSnowflake();
      const rolePlaceholderMap = new Map();
      const guild = await tx.one(
        `
          INSERT INTO guilds (
            id, name, description, icon, owner_id, afk_channel_id, afk_timeout,
            verification_level, default_message_notifications, explicit_content_filter,
            preferred_locale, features, system_channel_id, system_channel_flags,
            rules_channel_id, public_updates_channel_id, safety_alerts_channel_id,
            premium_progress_bar_enabled
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10,
            $11, $12, $13, $14,
            $15, $16, $17,
            $18
          )
          RETURNING *
        `,
        [
          guildId,
          data.name,
          data.description || null,
          data.icon || null,
          ownerId,
          data.afk_channel_id || null,
          data.afk_timeout || 300,
          data.verification_level || 0,
          data.default_message_notifications || 0,
          data.explicit_content_filter || 0,
          data.preferred_locale || 'en-US',
          JSON.stringify(data.features || []),
          data.system_channel_id || null,
          data.system_channel_flags || 0,
          data.rules_channel_id || null,
          data.public_updates_channel_id || null,
          data.safety_alerts_channel_id || null,
          Boolean(data.premium_progress_bar_enabled),
        ],
      );

      const bootstrapRoles = Array.isArray(data.roles) ? data.roles : [];
      const everyoneSeed = bootstrapRoles[0] || {};

      await tx.one(
        `
          INSERT INTO guild_roles (
            id, guild_id, name, description, color, colors, hoist, icon,
            unicode_emoji, position, permissions, managed, mentionable, flags, tags
          )
          VALUES ($1, $2, '@everyone', $3, $4, $5, $6, $7, $8, 0, $9, false, $10, $11, null)
          RETURNING *
        `,
        [
          guildId,
          guildId,
          everyoneSeed.description || null,
          everyoneSeed.color || everyoneSeed.colors?.primary_color || 0,
          JSON.stringify({
            primary_color: everyoneSeed.color || everyoneSeed.colors?.primary_color || 0,
            secondary_color: everyoneSeed.colors?.secondary_color ?? null,
            tertiary_color: everyoneSeed.colors?.tertiary_color ?? null,
          }),
          Boolean(everyoneSeed.hoist),
          everyoneSeed.icon || null,
          everyoneSeed.unicode_emoji || null,
          normalizePermissionString(everyoneSeed.permissions || DEFAULT_EVERYONE_PERMISSIONS),
          Boolean(everyoneSeed.mentionable),
          everyoneSeed.flags || 0,
        ],
      );

      if (Number.isInteger(everyoneSeed.id)) {
        rolePlaceholderMap.set(everyoneSeed.id, guildId);
      }

      const extraRoles = bootstrapRoles.slice(1);
      for (let index = 0; index < extraRoles.length; index += 1) {
        const role = extraRoles[index];
        const roleId = generateSnowflake();
        if (Number.isInteger(role.id)) {
          rolePlaceholderMap.set(role.id, roleId);
        }
        await tx.none(
          `
            INSERT INTO guild_roles (
              id, guild_id, name, description, color, colors, hoist, icon,
              unicode_emoji, position, permissions, managed, mentionable, flags, tags
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, $12, 0, null)
          `,
          [
            roleId,
            guildId,
            role.name || 'new role',
            role.description || null,
            role.color || role.colors?.primary_color || 0,
            JSON.stringify({
              primary_color: role.color || role.colors?.primary_color || 0,
              secondary_color: role.colors?.secondary_color ?? null,
              tertiary_color: role.colors?.tertiary_color ?? null,
            }),
            Boolean(role.hoist),
            role.icon || null,
            role.unicode_emoji || null,
            index + 1,
            normalizePermissionString(role.permissions || DEFAULT_CHANNEL_PERMISSIONS),
            Boolean(role.mentionable),
          ],
        );
      }

      await tx.none(
        `
          INSERT INTO guild_members (guild_id, user_id, role_ids, flags)
          VALUES ($1, $2, $3, 0)
        `,
        [guildId, ownerId, JSON.stringify([guildId])],
      );

      const placeholderMap = new Map();
      const channels = Array.isArray(data.channels) && data.channels.length
        ? data.channels
        : [
            {
              name: 'general',
              type: 0,
              position: 0,
            },
            {
              name: 'General',
              type: 2,
              position: 1,
            },
          ];
      for (let index = 0; index < channels.length; index += 1) {
        const channel = channels[index];
        const actualId = generateSnowflake();
        if (Number.isInteger(channel.id)) {
          placeholderMap.set(channel.id, actualId);
        }
        await tx.none(
          `
            INSERT INTO guild_channels (
              id, guild_id, parent_id, name, type, position, topic, nsfw,
              bitrate, user_limit, rate_limit_per_user
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          `,
          [
            actualId,
            guildId,
            channel.parent_id && Number.isInteger(channel.parent_id)
              ? null
              : channel.parent_id || null,
            channel.name || `channel-${index + 1}`,
            channel.type || 0,
            channel.position ?? index,
            channel.topic || null,
            Boolean(channel.nsfw),
            channel.bitrate || null,
            channel.user_limit || null,
            channel.rate_limit_per_user || 0,
          ],
        );
      }

      for (const channel of channels) {
        const channelId = Number.isInteger(channel.id) ? placeholderMap.get(channel.id) : channel.id;
        if (channel.parent_id && Number.isInteger(channel.parent_id)) {
          await tx.none(
            'UPDATE guild_channels SET parent_id = $2 WHERE id = $1',
            [channelId, placeholderMap.get(channel.parent_id) || null],
          );
        }

        const overwrites = Array.isArray(channel.permission_overwrites) ? channel.permission_overwrites : [];
        for (const overwrite of overwrites) {
          const resolvedTargetId = Number.isInteger(overwrite.id)
            ? rolePlaceholderMap.get(overwrite.id) || placeholderMap.get(overwrite.id) || overwrite.id
            : overwrite.id;
          await tx.none(
            `
              INSERT INTO channel_permission_overwrites (channel_id, target_id, type, allow, deny)
              VALUES ($1, $2, $3, $4, $5)
            `,
            [
              channelId,
              resolvedTargetId,
              overwrite.type,
              normalizePermissionString(overwrite.allow),
              normalizePermissionString(overwrite.deny),
            ],
          );
        }
      }

      if (!data.system_channel_id && channels.length) {
        const firstTextChannel = channels.find((channel) => (channel.type ?? 0) === 0 || channel.type === 5);
        if (firstTextChannel) {
          const resolvedChannelId = Number.isInteger(firstTextChannel.id)
            ? placeholderMap.get(firstTextChannel.id)
            : null;
          if (resolvedChannelId) {
            await tx.none('UPDATE guilds SET system_channel_id = $2 WHERE id = $1', [guildId, resolvedChannelId]);
          }
        }
      }

      return this.getById(guild.id, { tx, withCounts: true });
    });
  }

  static async getById(guildId, options = {}) {
    const executor = options.tx || db;
    const guild = await executor.oneOrNone('SELECT * FROM guilds WHERE id = $1', [guildId]);
    if (!guild) {
      return null;
    }

    const roles = await executor.manyOrNone(
      'SELECT * FROM guild_roles WHERE guild_id = $1 ORDER BY position ASC, id ASC',
      [guildId],
    );

    let counts = null;
    if (options.withCounts) {
      counts = await executor.one(
        `
          SELECT COUNT(*)::int AS member_count,
                 COUNT(*)::int AS presence_count
          FROM guild_members
          WHERE guild_id = $1
        `,
        [guildId],
      );
    }

    return mapGuild(guild, roles, counts);
  }

  static async getFullGuild(guildId, options = {}) {
    const guild = await this.getById(guildId, options);
    if (!guild) {
      return null;
    }
    const channels = await this.listChannels(guildId);
    return {
      ...guild,
      channels,
      members: [],
      presences: [],
    };
  }

  static async getForMember(guildId, userId, options = {}) {
    const guild = await this.getById(guildId, options);
    if (!guild) {
      return null;
    }

    const membership = await this.getMemberRecord(guildId, userId, options.tx || db);
    if (!membership) {
      return null;
    }

    return guild;
  }

  static async getBasic(guildId) {
    const guild = await db.oneOrNone('SELECT * FROM guilds WHERE id = $1', [guildId]);
    if (!guild) {
      return null;
    }
    return mapPartialGuild(guild);
  }

  static async getPreview(guildId) {
    const guild = await db.oneOrNone('SELECT * FROM guilds WHERE id = $1', [guildId]);
    if (!guild) {
      return null;
    }
    const counts = await db.one(
      'SELECT COUNT(*)::int AS member_count, COUNT(*)::int AS presence_count FROM guild_members WHERE guild_id = $1',
      [guildId],
    );
    return mapPartialGuild(guild, counts);
  }

  static async listForUser(userId, withCounts = false) {
    const guilds = await db.manyOrNone(
      `
        SELECT g.*
        FROM guilds g
        INNER JOIN guild_members gm ON gm.guild_id = g.id
        WHERE gm.user_id = $1
        ORDER BY g.id DESC
      `,
      [userId],
    );

    const results = [];
    for (const guild of guilds) {
      const roles = await db.manyOrNone(
        'SELECT * FROM guild_roles WHERE guild_id = $1 ORDER BY position ASC, id ASC',
        [guild.id],
      );
      let counts = null;
      if (withCounts) {
        counts = await db.one(
          'SELECT COUNT(*)::int AS member_count, COUNT(*)::int AS presence_count FROM guild_members WHERE guild_id = $1',
          [guild.id],
        );
      }
      const member = await this.getMemberRecord(guild.id, userId, db);
      const roleIds = new Set((member.role_ids || []).map(String));
      const memberRoles = roles.filter((role) => roleIds.has(String(role.id)) || String(role.id) === String(guild.id));
      const permissions = computeBasePermissions({
        guild,
        member: { user: { id: userId } },
        roles: memberRoles,
      }).toString();
      results.push({
        id: String(guild.id),
        name: guild.name,
        icon: guild.icon,
        banner: guild.banner,
        owner: String(guild.owner_id) === String(userId),
        features: guild.features || [],
        permissions,
        approximate_member_count: counts?.member_count,
        approximate_presence_count: counts?.presence_count,
      });
    }

    return results;
  }

  static async update(guildId, updates) {
    const fields = Object.keys(updates);
    if (!fields.length) {
      return this.getById(guildId);
    }
    const values = fields.map((field) => updates[field]);
    const setClause = fields.map((field, index) => `${field} = $${index + 2}`).join(', ');
    await db.none(`UPDATE guilds SET ${setClause} WHERE id = $1`, [guildId, ...values]);
    return this.getById(guildId, { withCounts: true });
  }

  static async getWidgetSettings(guildId) {
    const guild = await db.oneOrNone(
      'SELECT widget_enabled, widget_channel_id FROM guilds WHERE id = $1',
      [guildId],
    );
    if (!guild) {
      return null;
    }
    return {
      enabled: guild.widget_enabled,
      channel_id: guild.widget_channel_id ? String(guild.widget_channel_id) : null,
    };
  }

  static async updateWidgetSettings(guildId, updates) {
    const fields = [];
    const values = [guildId];
    if (Object.prototype.hasOwnProperty.call(updates, 'enabled')) {
      fields.push(`widget_enabled = $${values.length + 1}`);
      values.push(Boolean(updates.enabled));
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'channel_id')) {
      fields.push(`widget_channel_id = $${values.length + 1}`);
      values.push(updates.channel_id || null);
    }
    if (fields.length) {
      await db.none(`UPDATE guilds SET ${fields.join(', ')} WHERE id = $1`, values);
    }
    return this.getWidgetSettings(guildId);
  }

  static async getWidget(guildId) {
    const guild = await db.oneOrNone('SELECT * FROM guilds WHERE id = $1', [guildId]);
    if (!guild || !guild.widget_enabled) {
      return null;
    }

    const counts = await db.one(
      'SELECT COUNT(*)::int AS member_count, COUNT(*)::int AS presence_count FROM guild_members WHERE guild_id = $1',
      [guildId],
    );
    const channels = (await this.listChannels(guildId))
      .filter((channel) => [2, 13].includes(channel.type))
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        position: channel.position,
      }));

    return {
      id: String(guild.id),
      name: guild.name,
      instant_invite: null,
      presence_count: counts.presence_count,
      channels,
      members: [],
    };
  }

  static async getVanityUrl(guildId) {
    const guild = await db.oneOrNone('SELECT vanity_url_code FROM guilds WHERE id = $1', [guildId]);
    if (!guild) {
      return null;
    }
    return {
      code: guild.vanity_url_code,
      uses: 0,
    };
  }

  static async updateVanityUrl(guildId, code) {
    await db.none('UPDATE guilds SET vanity_url_code = $2 WHERE id = $1', [guildId, code || null]);
    return this.getVanityUrl(guildId);
  }

  static async listChannels(guildId) {
    const channels = await db.manyOrNone(
      'SELECT * FROM guild_channels WHERE guild_id = $1 ORDER BY position ASC, id ASC',
      [guildId],
    );

    if (!channels.length) {
      return [];
    }

    const overwrites = await db.manyOrNone(
      `
        SELECT channel_id, target_id, type, allow, deny
        FROM channel_permission_overwrites
        WHERE channel_id IN ($1:csv)
        ORDER BY channel_id ASC, target_id ASC
      `,
      [channels.map((channel) => channel.id)],
    );

    const byChannel = new Map();
    for (const overwrite of overwrites) {
      if (!byChannel.has(String(overwrite.channel_id))) {
        byChannel.set(String(overwrite.channel_id), []);
      }
      byChannel.get(String(overwrite.channel_id)).push({
        id: String(overwrite.target_id),
        type: overwrite.type,
        allow: normalizePermissionString(overwrite.allow),
        deny: normalizePermissionString(overwrite.deny),
      });
    }

    return channels.map((channel) =>
      mapChannel({
        ...channel,
        flags: 0,
        permission_overwrites: byChannel.get(String(channel.id)) || [],
      }),
    );
  }

  static async listChannelsForUser(guildId, userId, withPermissions = false) {
    const channels = await this.listChannels(guildId);
    if (!withPermissions) {
      return channels;
    }

    const context = await this.getContext(guildId, userId);
    if (!context) {
      return channels;
    }

    return channels.map((channel) => ({
      ...channel,
      permissions: context.channelPermissions[channel.id],
    }));
  }

  static async createChannel(guildId, data) {
    const maxPosition = await db.one(
      'SELECT COALESCE(MAX(position), 0)::int AS position FROM guild_channels WHERE guild_id = $1',
      [guildId],
    );

    const channelId = generateSnowflake();
    await db.tx(async (tx) => {
      await tx.none(
        `
          INSERT INTO guild_channels (
            id, guild_id, parent_id, name, type, position, topic, nsfw,
            bitrate, user_limit, rate_limit_per_user
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `,
        [
          channelId,
          guildId,
          data.parent_id || null,
          data.name,
          data.type ?? 0,
          data.position ?? (maxPosition.position + 1),
          data.topic || null,
          Boolean(data.nsfw),
          data.bitrate || null,
          data.user_limit ?? null,
          data.rate_limit_per_user || 0,
        ],
      );

      const overwrites = Array.isArray(data.permission_overwrites) ? data.permission_overwrites : [];
      for (const overwrite of overwrites) {
        await tx.none(
          `
            INSERT INTO channel_permission_overwrites (channel_id, target_id, type, allow, deny)
            VALUES ($1, $2, $3, $4, $5)
          `,
          [
            channelId,
            overwrite.id,
            overwrite.type,
            normalizePermissionString(overwrite.allow),
            normalizePermissionString(overwrite.deny),
          ],
        );
      }
    });

    return this.getChannel(channelId);
  }

  static async updateChannelPositions(guildId, updates) {
    await db.tx(async (tx) => {
      for (const update of updates) {
        const assignments = [];
        const values = [guildId, update.id];
        if (update.position !== undefined) {
          assignments.push(`position = $${values.length + 1}`);
          values.push(update.position);
        }
        if (Object.prototype.hasOwnProperty.call(update, 'parent_id')) {
          assignments.push(`parent_id = $${values.length + 1}`);
          values.push(update.parent_id || null);
        }
        if (!assignments.length) {
          continue;
        }
        await tx.none(
          `UPDATE guild_channels SET ${assignments.join(', ')} WHERE guild_id = $1 AND id = $2`,
          values,
        );
      }
    });
  }

  static async getChannelRecord(channelId) {
    return db.oneOrNone('SELECT * FROM guild_channels WHERE id = $1', [channelId]);
  }

  static async getChannel(channelId, userId = null) {
    const channel = await this.getChannelRecord(channelId);
    if (!channel) {
      return null;
    }

    const channels = await this.listChannels(channel.guild_id);
    const resolved = channels.find((item) => String(item.id) === String(channelId));
    if (!resolved) {
      return null;
    }

    if (!userId) {
      return resolved;
    }

    const context = await this.getContext(channel.guild_id, userId);
    if (!context) {
      return resolved;
    }

    return {
      ...resolved,
      permissions: context.channelPermissions[resolved.id],
    };
  }

  static async updateChannel(channelId, updates) {
    return db.tx(async (tx) => {
      const fields = [];
      const values = [channelId];

      const assign = (column, value) => {
        fields.push(`${column} = $${values.length + 1}`);
        values.push(value);
      };

      const directFields = [
        'name',
        'type',
        'position',
        'topic',
        'nsfw',
        'bitrate',
        'user_limit',
        'rate_limit_per_user',
        'parent_id',
      ];

      for (const field of directFields) {
        if (Object.prototype.hasOwnProperty.call(updates, field)) {
          assign(field, updates[field]);
        }
      }

      if (fields.length) {
        await tx.none(`UPDATE guild_channels SET ${fields.join(', ')} WHERE id = $1`, values);
      }

      if (Object.prototype.hasOwnProperty.call(updates, 'permission_overwrites')) {
        await tx.none('DELETE FROM channel_permission_overwrites WHERE channel_id = $1', [channelId]);
        const overwrites = Array.isArray(updates.permission_overwrites) ? updates.permission_overwrites : [];
        for (const overwrite of overwrites) {
          await tx.none(
            `
              INSERT INTO channel_permission_overwrites (channel_id, target_id, type, allow, deny)
              VALUES ($1, $2, $3, $4, $5)
            `,
            [
              channelId,
              overwrite.id,
              overwrite.type,
              normalizePermissionString(overwrite.allow),
              normalizePermissionString(overwrite.deny),
            ],
          );
        }
      }

      return this.getChannel(channelId);
    });
  }

  static async deleteChannel(channelId) {
    const existing = await this.getChannel(channelId);
    if (!existing) {
      return null;
    }

    await db.tx(async (tx) => {
      if (existing.type === 4) {
        await tx.none('UPDATE guild_channels SET parent_id = null WHERE parent_id = $1', [channelId]);
      }
      await tx.none('DELETE FROM guild_channels WHERE id = $1', [channelId]);
    });

    return existing;
  }

  static async upsertChannelOverwrite(channelId, overwriteId, overwrite) {
    await db.none(
      `
        INSERT INTO channel_permission_overwrites (channel_id, target_id, type, allow, deny)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (channel_id, target_id)
        DO UPDATE SET type = EXCLUDED.type, allow = EXCLUDED.allow, deny = EXCLUDED.deny
      `,
      [
        channelId,
        overwriteId,
        overwrite.type,
        normalizePermissionString(overwrite.allow),
        normalizePermissionString(overwrite.deny),
      ],
    );
  }

  static async deleteChannelOverwrite(channelId, overwriteId) {
    await db.none(
      'DELETE FROM channel_permission_overwrites WHERE channel_id = $1 AND target_id = $2',
      [channelId, overwriteId],
    );
  }

  static async getMemberRecord(guildId, userId, executor = db) {
    return executor.oneOrNone(
      'SELECT * FROM guild_members WHERE guild_id = $1 AND user_id = $2',
      [guildId, userId],
    );
  }

  static async getMember(guildId, userId) {
    const [guild, member, user, roles] = await Promise.all([
      db.oneOrNone('SELECT * FROM guilds WHERE id = $1', [guildId]),
      this.getMemberRecord(guildId, userId),
      db.oneOrNone(
        `
          SELECT id, username, discriminator, global_name, avatar, banner, accent_color, pronouns,
                 bio, email, verified, mfa_enabled, flags, public_flags, premium_type
          FROM users
          WHERE id = $1
        `,
        [userId],
      ),
      db.manyOrNone('SELECT * FROM guild_roles WHERE guild_id = $1 ORDER BY position ASC, id ASC', [guildId]),
    ]);

    if (!guild || !member || !user) {
      return null;
    }

    const roleIds = new Set((member.role_ids || []).map(String));
    const memberRoles = roles.filter((role) => roleIds.has(String(role.id)) || String(role.id) === String(guild.id));
    const permissions = computeBasePermissions({ guild, member: { user }, roles: memberRoles }).toString();
    return mapMember(member, user, permissions);
  }

  static async listMembers(guildId) {
    const [guild, members, users, roles] = await Promise.all([
      db.oneOrNone('SELECT * FROM guilds WHERE id = $1', [guildId]),
      db.manyOrNone('SELECT * FROM guild_members WHERE guild_id = $1 ORDER BY joined_at ASC', [guildId]),
      db.manyOrNone(
        `
          SELECT u.id, u.username, u.discriminator, u.global_name, u.avatar, u.banner, u.accent_color,
                 u.pronouns, u.bio, u.email, u.verified, u.mfa_enabled, u.flags, u.public_flags,
                 u.premium_type
          FROM users u
          INNER JOIN guild_members gm ON gm.user_id = u.id
          WHERE gm.guild_id = $1
        `,
        [guildId],
      ),
      db.manyOrNone('SELECT * FROM guild_roles WHERE guild_id = $1 ORDER BY position ASC, id ASC', [guildId]),
    ]);

    if (!guild) {
      return [];
    }

    const userMap = new Map(users.map((user) => [String(user.id), user]));
    return members
      .map((member) => {
        const user = userMap.get(String(member.user_id));
        if (!user) {
          return null;
        }
        const roleIds = new Set((member.role_ids || []).map(String));
        const memberRoles = roles.filter((role) => roleIds.has(String(role.id)) || String(role.id) === String(guild.id));
        const permissions = computeBasePermissions({ guild, member: { user }, roles: memberRoles }).toString();
        return mapMember(member, user, permissions);
      })
      .filter(Boolean);
  }

  static async listGuildsForReady(userId) {
    const guilds = await db.manyOrNone(
      `
        SELECT g.id
        FROM guilds g
        INNER JOIN guild_members gm ON gm.guild_id = g.id
        WHERE gm.user_id = $1
        ORDER BY g.id DESC
      `,
      [userId],
    );

    const result = [];
    for (const guildRef of guilds) {
      const [guild, members] = await Promise.all([
        this.getFullGuild(guildRef.id, { withCounts: true }),
        this.listMembers(guildRef.id),
      ]);
      if (!guild) {
        continue;
      }
      result.push({
        ...guild,
        members,
        presences: members.map((member) => buildPresence(member.user.id, guild.id)),
      });
    }

    return result;
  }

  static async addMemberRole(guildId, userId, roleId) {
    const member = await this.getMemberRecord(guildId, userId);
    if (!member) {
      return null;
    }
    const next = new Set((member.role_ids || []).map(String));
    next.add(String(roleId));
    await db.none(
      'UPDATE guild_members SET role_ids = $3 WHERE guild_id = $1 AND user_id = $2',
      [guildId, userId, JSON.stringify([...next])],
    );
    return this.getMember(guildId, userId);
  }

  static async removeMemberRole(guildId, userId, roleId) {
    const member = await this.getMemberRecord(guildId, userId);
    if (!member) {
      return null;
    }
    const next = (member.role_ids || []).map(String).filter((id) => id !== String(roleId));
    await db.none(
      'UPDATE guild_members SET role_ids = $3 WHERE guild_id = $1 AND user_id = $2',
      [guildId, userId, JSON.stringify(next)],
    );
    return this.getMember(guildId, userId);
  }

  static async updateMember(guildId, userId, updates) {
    const fields = [];
    const values = [guildId, userId];

    const assign = (column, value) => {
      fields.push(`${column} = $${values.length + 1}`);
      values.push(value);
    };

    for (const [key, value] of Object.entries(updates)) {
      if (key === 'roles') {
        assign('role_ids', JSON.stringify((value || []).map(String)));
      } else {
        assign(key, value);
      }
    }

    if (fields.length) {
      await db.none(
        `UPDATE guild_members SET ${fields.join(', ')} WHERE guild_id = $1 AND user_id = $2`,
        values,
      );
    }

    return this.getMember(guildId, userId);
  }

  static async removeMember(guildId, userId) {
    const result = await db.result(
      'DELETE FROM guild_members WHERE guild_id = $1 AND user_id = $2',
      [guildId, userId],
    );
    return result.rowCount > 0;
  }

  static async listRoles(guildId) {
    const roles = await db.manyOrNone(
      'SELECT * FROM guild_roles WHERE guild_id = $1 ORDER BY position ASC, id ASC',
      [guildId],
    );
    return roles.map(mapRole);
  }

  static async getRole(guildId, roleId) {
    const role = await db.oneOrNone(
      'SELECT * FROM guild_roles WHERE guild_id = $1 AND id = $2',
      [guildId, roleId],
    );
    return role ? mapRole(role) : null;
  }

  static async updateRolePositions(guildId, updates) {
    await db.tx(async (tx) => {
      for (const update of updates) {
        if (update.position === undefined) {
          continue;
        }
        await tx.none(
          'UPDATE guild_roles SET position = $3 WHERE guild_id = $1 AND id = $2',
          [guildId, update.id, update.position],
        );
      }
    });
    return this.listRoles(guildId);
  }

  static async createRole(guildId, data) {
    const maxPosition = await db.one(
      'SELECT COALESCE(MAX(position), 0)::int AS position FROM guild_roles WHERE guild_id = $1',
      [guildId],
    );
    const role = await db.one(
      `
        INSERT INTO guild_roles (
          id, guild_id, name, description, color, colors, hoist, icon,
          unicode_emoji, position, permissions, managed, mentionable, flags, tags
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, $12, 0, null)
        RETURNING *
      `,
      [
        generateSnowflake(),
        guildId,
        data.name || 'new role',
        data.description || null,
        data.color || data.colors?.primary_color || 0,
        JSON.stringify({
          primary_color: data.color || data.colors?.primary_color || 0,
          secondary_color: data.colors?.secondary_color ?? null,
          tertiary_color: data.colors?.tertiary_color ?? null,
        }),
        Boolean(data.hoist),
        data.icon || null,
        data.unicode_emoji || null,
        maxPosition.position + 1,
        normalizePermissionString(data.permissions || DEFAULT_CHANNEL_PERMISSIONS),
        Boolean(data.mentionable),
      ],
    );
    return mapRole(role);
  }

  static async updateRole(guildId, roleId, updates) {
    const fields = [];
    const values = [guildId, roleId];

    const assign = (column, value) => {
      fields.push(`${column} = $${values.length + 1}`);
      values.push(value);
    };

    for (const [key, value] of Object.entries(updates)) {
      if (key === 'colors') {
        assign('colors', JSON.stringify(value));
      } else if (key === 'permissions') {
        assign('permissions', normalizePermissionString(value));
      } else {
        assign(key, value);
      }
    }

    if (fields.length) {
      await db.none(
        `UPDATE guild_roles SET ${fields.join(', ')} WHERE guild_id = $1 AND id = $2`,
        values,
      );
    }

    return this.getRole(guildId, roleId);
  }

  static async deleteRole(guildId, roleId) {
    await db.tx(async (tx) => {
      const members = await tx.manyOrNone('SELECT * FROM guild_members WHERE guild_id = $1', [guildId]);
      for (const member of members) {
        const filtered = (member.role_ids || []).map(String).filter((id) => id !== String(roleId));
        await tx.none(
          'UPDATE guild_members SET role_ids = $3 WHERE guild_id = $1 AND user_id = $2',
          [guildId, member.user_id, JSON.stringify(filtered)],
        );
      }
      await tx.none('DELETE FROM guild_roles WHERE guild_id = $1 AND id = $2', [guildId, roleId]);
    });
  }

  static async getRoleMemberCounts(guildId) {
    const roles = await this.listRoles(guildId);
    const members = await db.manyOrNone('SELECT role_ids FROM guild_members WHERE guild_id = $1', [guildId]);
    const counts = Object.fromEntries(roles.map((role) => [role.id, 0]));
    for (const member of members) {
      for (const roleId of member.role_ids || []) {
        const key = String(roleId);
        if (counts[key] !== undefined) {
          counts[key] += 1;
        }
      }
    }
    return counts;
  }

  static async getRoleMemberIds(guildId, roleId) {
    const members = await db.manyOrNone('SELECT user_id, role_ids FROM guild_members WHERE guild_id = $1', [guildId]);
    return members
      .filter((member) => (member.role_ids || []).map(String).includes(String(roleId)))
      .map((member) => String(member.user_id))
      .slice(0, 100);
  }

  static async addRoleMembers(guildId, roleId, memberIds) {
    const updatedMembers = {};
    for (const memberId of memberIds) {
      const member = await this.addMemberRole(guildId, memberId, roleId);
      if (member) {
        updatedMembers[String(memberId)] = member;
      }
    }
    return updatedMembers;
  }

  static async getContext(guildId, userId) {
    const [guild, member, user, roles, channels] = await Promise.all([
      db.oneOrNone('SELECT * FROM guilds WHERE id = $1', [guildId]),
      this.getMemberRecord(guildId, userId),
      db.oneOrNone('SELECT id, username, discriminator, global_name, avatar FROM users WHERE id = $1', [userId]),
      db.manyOrNone('SELECT * FROM guild_roles WHERE guild_id = $1 ORDER BY position ASC, id ASC', [guildId]),
      this.listChannels(guildId),
    ]);
    if (!guild || !member || !user) {
      return null;
    }
    const roleIds = new Set((member.role_ids || []).map(String));
    const memberRoles = roles.filter((role) => roleIds.has(String(role.id)) || String(role.id) === String(guild.id));
    const basePermissions = computeBasePermissions({ guild, member: { user }, roles: memberRoles }).toString();
    const channelPermissions = Object.fromEntries(
      channels.map((channel) => [
        channel.id,
        computeChannelPermissions({ guild, member: { user }, roles: memberRoles, channel }),
      ]),
    );

    return {
      guild,
      member: mapMember(member, user, basePermissions),
      basePermissions,
      channelPermissions,
      roles: memberRoles.map(mapRole),
    };
  }

  static canManageGuild(context) {
    return hasPermission(context.basePermissions, ADMINISTRATOR)
      || hasPermission(context.basePermissions, MANAGE_GUILD);
  }

  static canManageRoles(context) {
    return hasPermission(context.basePermissions, ADMINISTRATOR)
      || hasPermission(context.basePermissions, MANAGE_ROLES);
  }

  static canManageNicknames(context) {
    return hasPermission(context.basePermissions, ADMINISTRATOR)
      || hasPermission(context.basePermissions, MANAGE_NICKNAMES);
  }

  static canKickMembers(context) {
    return hasPermission(context.basePermissions, ADMINISTRATOR)
      || hasPermission(context.basePermissions, KICK_MEMBERS);
  }

  static canModerateMembers(context) {
    return hasPermission(context.basePermissions, ADMINISTRATOR)
      || hasPermission(context.basePermissions, MODERATE_MEMBERS)
      || hasPermission(context.basePermissions, MANAGE_GUILD);
  }

  static canManageChannels(context) {
    return hasPermission(context.basePermissions, ADMINISTRATOR)
      || hasPermission(context.basePermissions, MANAGE_CHANNELS);
  }

  static canViewChannel(context, channelId) {
    const channelPermissions = context.channelPermissions[channelId] || '0';
    return hasPermission(channelPermissions, VIEW_CHANNEL) || hasPermission(context.basePermissions, ADMINISTRATOR);
  }

  static canReadMessageHistory(context, channelId) {
    const channelPermissions = context.channelPermissions[channelId] || '0';
    return hasPermission(channelPermissions, READ_MESSAGE_HISTORY)
      || hasPermission(channelPermissions, VIEW_CHANNEL)
      || hasPermission(context.basePermissions, ADMINISTRATOR);
  }

  static canSendMessages(context, channelId) {
    const channelPermissions = context.channelPermissions[channelId] || '0';
    return hasPermission(channelPermissions, SEND_MESSAGES)
      || hasPermission(context.basePermissions, ADMINISTRATOR);
  }

  static canManageMessages(context, channelId) {
    const channelPermissions = context.channelPermissions[channelId] || '0';
    return hasPermission(channelPermissions, MANAGE_MESSAGES)
      || hasPermission(context.basePermissions, ADMINISTRATOR);
  }

  static canCreateInstantInvite(context, channelId) {
    const channelPermissions = context.channelPermissions[channelId] || '0';
    return hasPermission(channelPermissions, CREATE_INSTANT_INVITE)
      || hasPermission(context.basePermissions, ADMINISTRATOR);
  }
}

module.exports = Guild;