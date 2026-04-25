const crypto = require('crypto');
const db = require('../db');
const Guild = require('./guild');

const generateInviteCode = () => crypto.randomBytes(5).toString('base64url').slice(0, 8);

const mapPartialUser = (user) => ({
  id: String(user.id),
  username: user.username,
  discriminator: user.discriminator,
  global_name: user.global_name,
  avatar: user.avatar,
});

const mapInviteGuild = (guild) => ({
  id: String(guild.id),
  name: guild.name,
  icon: guild.icon,
  description: guild.description,
  banner: guild.banner,
  splash: guild.splash,
  verification_level: guild.verification_level,
  features: guild.features || [],
  vanity_url_code: guild.vanity_url_code,
  premium_subscription_count: guild.premium_subscription_count,
  premium_tier: guild.premium_tier,
  nsfw: guild.nsfw_level > 0,
  nsfw_level: guild.nsfw_level,
});

const mapInvite = (invite, guild, channel, inviter, counts = null) => {
  const expiresAt = invite.max_age > 0
    ? new Date(new Date(invite.created_at).getTime() + (invite.max_age * 1000)).toISOString()
    : null;

  return {
    code: invite.code,
    type: invite.type,
    guild_id: String(invite.guild_id),
    guild: mapInviteGuild(guild),
    channel: {
      id: String(channel.id),
      type: channel.type,
      name: channel.name,
    },
    inviter: mapPartialUser(inviter),
    flags: invite.flags,
    uses: invite.uses,
    max_uses: invite.max_uses,
    max_age: invite.max_age,
    temporary: invite.temporary,
    created_at: invite.created_at.toISOString(),
    expires_at: expiresAt,
    approximate_member_count: counts?.member_count,
    approximate_presence_count: counts?.presence_count,
  };
};

class Invite {
  static async get(code, options = {}) {
    const invite = await db.oneOrNone('SELECT * FROM invites WHERE code = $1', [code]);
    if (!invite) {
      return null;
    }
    const [guild, channel, inviter, counts] = await Promise.all([
      db.one('SELECT * FROM guilds WHERE id = $1', [invite.guild_id]),
      db.one('SELECT * FROM guild_channels WHERE id = $1', [invite.channel_id]),
      db.one('SELECT id, username, discriminator, global_name, avatar FROM users WHERE id = $1', [invite.inviter_id]),
      options.withCounts
        ? db.one(
            'SELECT COUNT(*)::int AS member_count, COUNT(*)::int AS presence_count FROM guild_members WHERE guild_id = $1',
            [invite.guild_id],
          )
        : null,
    ]);

    if (invite.max_age > 0) {
      const expiresAt = new Date(new Date(invite.created_at).getTime() + (invite.max_age * 1000));
      if (expiresAt.getTime() < Date.now()) {
        await db.none('DELETE FROM invites WHERE code = $1', [code]);
        return null;
      }
    }

    return mapInvite(invite, guild, channel, inviter, counts || undefined);
  }

  static async listForChannel(channelId) {
    const invites = await db.manyOrNone('SELECT code FROM invites WHERE channel_id = $1 ORDER BY created_at DESC', [channelId]);
    const result = [];
    for (const invite of invites) {
      const mapped = await this.get(invite.code, { withCounts: true });
      if (mapped) {
        result.push(mapped);
      }
    }
    return result;
  }

  static async listForGuild(guildId) {
    const invites = await db.manyOrNone('SELECT code FROM invites WHERE guild_id = $1 ORDER BY created_at DESC', [guildId]);
    const result = [];
    for (const invite of invites) {
      const mapped = await this.get(invite.code, { withCounts: true });
      if (mapped) {
        result.push(mapped);
      }
    }
    return result;
  }

  static async create(channelId, inviterId, data = {}) {
    const channel = await db.oneOrNone('SELECT * FROM guild_channels WHERE id = $1', [channelId]);
    if (!channel) {
      return null;
    }

    const code = generateInviteCode();
    await db.none(
      `
        INSERT INTO invites (code, guild_id, channel_id, inviter_id, type, flags, max_age, max_uses, temporary)
        VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8)
      `,
      [
        code,
        channel.guild_id,
        channelId,
        inviterId,
        data.flags || 0,
        data.max_age ?? 86400,
        data.max_uses ?? 0,
        Boolean(data.temporary),
      ],
    );

    return this.get(code, { withCounts: true });
  }

  static async delete(code) {
    const invite = await this.get(code, { withCounts: true });
    if (!invite) {
      return null;
    }
    await db.none('DELETE FROM invites WHERE code = $1', [code]);
    return invite;
  }

  static async accept(code, userId) {
    return db.tx(async (tx) => {
      const invite = await tx.oneOrNone('SELECT * FROM invites WHERE code = $1', [code]);
      if (!invite) {
        return null;
      }

      if (invite.max_age > 0) {
        const expiresAt = new Date(new Date(invite.created_at).getTime() + (invite.max_age * 1000));
        if (expiresAt.getTime() < Date.now()) {
          await tx.none('DELETE FROM invites WHERE code = $1', [code]);
          return null;
        }
      }

      if (invite.max_uses > 0 && invite.uses >= invite.max_uses) {
        await tx.none('DELETE FROM invites WHERE code = $1', [code]);
        return null;
      }

      const existingMember = await tx.oneOrNone(
        'SELECT 1 FROM guild_members WHERE guild_id = $1 AND user_id = $2',
        [invite.guild_id, userId],
      );
      if (!existingMember) {
        await tx.none(
          'INSERT INTO guild_members (guild_id, user_id, role_ids, flags) VALUES ($1, $2, $3, 0)',
          [invite.guild_id, userId, JSON.stringify([String(invite.guild_id)])],
        );
      }

      await tx.none('UPDATE invites SET uses = uses + 1 WHERE code = $1', [code]);
      const refreshedInvite = await tx.one('SELECT * FROM invites WHERE code = $1', [code]);
      const [guild, channel, inviter, counts] = await Promise.all([
        tx.one('SELECT * FROM guilds WHERE id = $1', [refreshedInvite.guild_id]),
        tx.one('SELECT * FROM guild_channels WHERE id = $1', [refreshedInvite.channel_id]),
        tx.one('SELECT id, username, discriminator, global_name, avatar FROM users WHERE id = $1', [refreshedInvite.inviter_id]),
        tx.one(
          'SELECT COUNT(*)::int AS member_count, COUNT(*)::int AS presence_count FROM guild_members WHERE guild_id = $1',
          [refreshedInvite.guild_id],
        ),
      ]);
      const acceptedInvite = mapInvite(refreshedInvite, guild, channel, inviter, counts);

      if (refreshedInvite.max_uses > 0 && refreshedInvite.uses >= refreshedInvite.max_uses) {
        await tx.none('DELETE FROM invites WHERE code = $1', [code]);
      }
      return acceptedInvite;
    });
  }
}

module.exports = Invite;