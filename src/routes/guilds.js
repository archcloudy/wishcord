const express = require('express');
const Guild = require('../models/guild');
const { authenticate } = require('../middleware/auth');
const {
  invalidFormBody,
  discordError,
  unknownGuild,
  unknownMember,
  unknownRole,
  missingPermissions,
} = require('../utils/discordError');

const router = express.Router();

const validateGuildName = (name) => typeof name === 'string' && name.trim().length >= 2 && name.trim().length <= 100;

const requireGuildContext = async (req, res, next) => {
  const context = await Guild.getContext(req.params.guildId, req.user.id);
  if (!context) {
    const guild = await Guild.getById(req.params.guildId);
    if (!guild) {
      return unknownGuild(res);
    }
    return discordError(res, 403, 50001, 'Missing Access');
  }
  req.guildContext = context;
  next();
};

router.get('/users/@me/guilds', authenticate, async (req, res) => {
  const withCounts = String(req.query.with_counts).toLowerCase() === 'true';
  const guilds = await Guild.listForUser(req.user.id, withCounts);
  res.json(guilds);
});

router.delete('/users/@me/guilds/:guildId', authenticate, async (req, res) => {
  const removed = await Guild.removeMember(req.params.guildId, req.user.id);
  if (!removed) {
    const guild = await Guild.getById(req.params.guildId);
    if (!guild) {
      return unknownGuild(res);
    }
    return unknownMember(res);
  }
  res.status(204).send();
});

router.post('/guilds', authenticate, async (req, res) => {
  if (!validateGuildName(req.body.name)) {
    return invalidFormBody(res, {
      name: {
        _errors: [{ code: 'BASE_TYPE_BAD_LENGTH', message: 'Guild name must be between 2 and 100 characters.' }],
      },
    });
  }

  if (req.body.description && String(req.body.description).length > 300) {
    return invalidFormBody(res, {
      description: {
        _errors: [{ code: 'BASE_TYPE_BAD_LENGTH', message: 'Guild description must be 300 characters or fewer.' }],
      },
    });
  }

  try {
    const guild = await Guild.create(req.user.id, { ...req.body, name: req.body.name.trim() });
    res.status(201).json(guild);
  } catch (error) {
    console.error('Failed to create guild:', error);
    res.status(500).json({ message: 'Unknown Error', code: 50000 });
  }
});

router.get('/guilds/:guildId', authenticate, async (req, res) => {
  const guild = await Guild.getForMember(req.params.guildId, req.user.id, {
    withCounts: String(req.query.with_counts).toLowerCase() === 'true',
  });
  if (!guild) {
    const exists = await Guild.getById(req.params.guildId);
    if (!exists) {
      return unknownGuild(res);
    }
    return discordError(res, 403, 50001, 'Missing Access');
  }
  res.json(guild);
});

router.get('/guilds/:guildId/basic', authenticate, async (req, res) => {
  const guild = await Guild.getBasic(req.params.guildId);
  if (!guild) {
    return unknownGuild(res);
  }
  res.json(guild);
});

router.get('/guilds/:guildId/preview', authenticate, async (req, res) => {
  const guild = await Guild.getPreview(req.params.guildId);
  if (!guild) {
    return unknownGuild(res);
  }
  res.json(guild);
});

router.patch('/guilds/:guildId', authenticate, requireGuildContext, async (req, res) => {
  if (!Guild.canManageGuild(req.guildContext)) {
    return missingPermissions(res);
  }

  const updates = {};
  const allowedFields = [
    'name',
    'description',
    'icon',
    'banner',
    'splash',
    'discovery_splash',
    'afk_channel_id',
    'afk_timeout',
    'verification_level',
    'default_message_notifications',
    'explicit_content_filter',
    'features',
    'system_channel_id',
    'system_channel_flags',
    'rules_channel_id',
    'public_updates_channel_id',
    'safety_alerts_channel_id',
    'preferred_locale',
    'premium_progress_bar_enabled',
  ];

  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      updates[field] = field === 'features' ? JSON.stringify(req.body[field] || []) : req.body[field];
    }
  }

  if (updates.name && !validateGuildName(updates.name)) {
    return invalidFormBody(res, {
      name: {
        _errors: [{ code: 'BASE_TYPE_BAD_LENGTH', message: 'Guild name must be between 2 and 100 characters.' }],
      },
    });
  }

  const guild = await Guild.update(req.params.guildId, updates);
  res.json(guild);
});

router.get('/guilds/:guildId/channels', authenticate, requireGuildContext, async (req, res) => {
  const channels = await Guild.listChannelsForUser(
    req.params.guildId,
    req.user.id,
    String(req.query.permissions).toLowerCase() === 'true',
  );
  res.json(channels);
});

router.post('/guilds/:guildId/channels', authenticate, requireGuildContext, async (req, res) => {
  if (!Guild.canManageChannels(req.guildContext)) {
    return missingPermissions(res);
  }
  if (typeof req.body.name !== 'string' || req.body.name.trim().length < 1 || req.body.name.trim().length > 100) {
    return invalidFormBody(res, {
      name: {
        _errors: [{ code: 'BASE_TYPE_BAD_LENGTH', message: 'Channel name must be between 1 and 100 characters.' }],
      },
    });
  }
  const channel = await Guild.createChannel(req.params.guildId, {
    ...req.body,
    name: req.body.name.trim(),
  });
  res.status(201).json(channel);
});

router.patch('/guilds/:guildId/channels', authenticate, requireGuildContext, async (req, res) => {
  if (!Guild.canManageChannels(req.guildContext)) {
    return missingPermissions(res);
  }
  await Guild.updateChannelPositions(req.params.guildId, Array.isArray(req.body) ? req.body : []);
  res.status(204).send();
});

router.get('/guilds/:guildId/widget', authenticate, requireGuildContext, async (req, res) => {
  if (!Guild.canManageGuild(req.guildContext)) {
    return missingPermissions(res);
  }
  const widget = await Guild.getWidgetSettings(req.params.guildId);
  if (!widget) {
    return unknownGuild(res);
  }
  res.json(widget);
});

router.patch('/guilds/:guildId/widget', authenticate, requireGuildContext, async (req, res) => {
  if (!Guild.canManageGuild(req.guildContext)) {
    return missingPermissions(res);
  }
  const widget = await Guild.updateWidgetSettings(req.params.guildId, req.body || {});
  res.json(widget);
});

router.get('/guilds/:guildId/widget.json', async (req, res) => {
  const widget = await Guild.getWidget(req.params.guildId);
  if (!widget) {
    return unknownGuild(res);
  }
  res.json(widget);
});

router.get('/guilds/:guildId/vanity-url', authenticate, requireGuildContext, async (req, res) => {
  if (!Guild.canManageGuild(req.guildContext)) {
    return missingPermissions(res);
  }
  const vanity = await Guild.getVanityUrl(req.params.guildId);
  if (!vanity) {
    return unknownGuild(res);
  }
  res.json(vanity);
});

router.patch('/guilds/:guildId/vanity-url', authenticate, requireGuildContext, async (req, res) => {
  if (!Guild.canManageGuild(req.guildContext)) {
    return missingPermissions(res);
  }
  const vanity = await Guild.updateVanityUrl(req.params.guildId, req.body.code);
  res.json(vanity);
});

router.get('/guilds/:guildId/members/:userId', authenticate, requireGuildContext, async (req, res) => {
  const member = await Guild.getMember(req.params.guildId, req.params.userId);
  if (!member) {
    return unknownMember(res);
  }
  res.json(member);
});

router.patch('/guilds/:guildId/members/:userId', authenticate, requireGuildContext, async (req, res) => {
  const existing = await Guild.getMember(req.params.guildId, req.params.userId);
  if (!existing) {
    return unknownMember(res);
  }

  const updates = {};
  if (Object.prototype.hasOwnProperty.call(req.body, 'nick')) {
    if (!Guild.canManageNicknames(req.guildContext)) {
      return missingPermissions(res);
    }
    updates.nick = req.body.nick;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'roles')) {
    if (!Guild.canManageRoles(req.guildContext)) {
      return missingPermissions(res);
    }
    updates.roles = req.body.roles;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'communication_disabled_until')) {
    if (!Guild.canModerateMembers(req.guildContext)) {
      return missingPermissions(res);
    }
    updates.communication_disabled_until = req.body.communication_disabled_until;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'flags')) {
    if (!Guild.canModerateMembers(req.guildContext)) {
      return missingPermissions(res);
    }
    updates.flags = req.body.flags;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'mute')) {
    updates.mute = Boolean(req.body.mute);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'deaf')) {
    updates.deaf = Boolean(req.body.deaf);
  }

  const member = await Guild.updateMember(req.params.guildId, req.params.userId, updates);
  res.json(member);
});

router.delete('/guilds/:guildId/members/:userId', authenticate, requireGuildContext, async (req, res) => {
  if (!Guild.canKickMembers(req.guildContext)) {
    return missingPermissions(res);
  }
  const removed = await Guild.removeMember(req.params.guildId, req.params.userId);
  if (!removed) {
    return unknownMember(res);
  }
  res.status(204).send();
});

router.get('/users/@me/guilds/:guildId/member', authenticate, async (req, res) => {
  const member = await Guild.getMember(req.params.guildId, req.user.id);
  if (!member) {
    const guild = await Guild.getById(req.params.guildId);
    if (!guild) {
      return unknownGuild(res);
    }
    return unknownMember(res);
  }
  res.json(member);
});

router.patch('/guilds/:guildId/members/@me', authenticate, requireGuildContext, async (req, res) => {
  const updates = {};
  if (Object.prototype.hasOwnProperty.call(req.body, 'nick')) {
    updates.nick = req.body.nick;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'bio')) {
    updates.bio = req.body.bio;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'banner')) {
    updates.banner = req.body.banner;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'avatar')) {
    updates.avatar = req.body.avatar;
  }

  const member = await Guild.updateMember(req.params.guildId, req.user.id, updates);
  if (!member) {
    return unknownMember(res);
  }
  res.json(member);
});

router.patch('/guilds/:guildId/members/@me/nick', authenticate, requireGuildContext, async (req, res) => {
  const member = await Guild.updateMember(req.params.guildId, req.user.id, { nick: req.body.nick ?? null });
  if (!member) {
    return unknownMember(res);
  }
  res.json({ nick: member.nick });
});

router.post('/users/@me/guilds/:guildId/member/ack-dm-upsell-settings', authenticate, async (req, res) => {
  const member = await Guild.getMember(req.params.guildId, req.user.id);
  if (!member) {
    const guild = await Guild.getById(req.params.guildId);
    if (!guild) {
      return unknownGuild(res);
    }
    return unknownMember(res);
  }
  await Guild.updateMember(req.params.guildId, req.user.id, { flags: member.flags | (1 << 9) });
  res.status(204).send();
});

router.put('/guilds/:guildId/members/:userId/roles/:roleId', authenticate, requireGuildContext, async (req, res) => {
  if (!Guild.canManageRoles(req.guildContext)) {
    return missingPermissions(res);
  }

  const role = await Guild.getRole(req.params.guildId, req.params.roleId);
  if (!role) {
    return unknownRole(res);
  }
  const member = await Guild.addMemberRole(req.params.guildId, req.params.userId, req.params.roleId);
  if (!member) {
    return unknownMember(res);
  }
  res.status(204).send();
});

router.delete('/guilds/:guildId/members/:userId/roles/:roleId', authenticate, requireGuildContext, async (req, res) => {
  if (!Guild.canManageRoles(req.guildContext)) {
    return missingPermissions(res);
  }

  const role = await Guild.getRole(req.params.guildId, req.params.roleId);
  if (!role) {
    return unknownRole(res);
  }
  const member = await Guild.removeMemberRole(req.params.guildId, req.params.userId, req.params.roleId);
  if (!member) {
    return unknownMember(res);
  }
  res.status(204).send();
});

router.get('/guilds/:guildId/roles', authenticate, requireGuildContext, async (req, res) => {
  const roles = await Guild.listRoles(req.params.guildId);
  res.json(roles);
});

router.get('/guilds/:guildId/roles/member-counts', authenticate, requireGuildContext, async (req, res) => {
  const counts = await Guild.getRoleMemberCounts(req.params.guildId);
  res.json(counts);
});

router.get('/guilds/:guildId/roles/:roleId/member-ids', authenticate, requireGuildContext, async (req, res) => {
  if (String(req.params.roleId) === String(req.params.guildId)) {
    return res.json([]);
  }
  const role = await Guild.getRole(req.params.guildId, req.params.roleId);
  if (!role) {
    return unknownRole(res);
  }
  const memberIds = await Guild.getRoleMemberIds(req.params.guildId, req.params.roleId);
  res.json(memberIds);
});

router.get('/guilds/:guildId/roles/:roleId', authenticate, requireGuildContext, async (req, res) => {
  const role = await Guild.getRole(req.params.guildId, req.params.roleId);
  if (!role) {
    return unknownRole(res);
  }
  res.json(role);
});

router.post('/guilds/:guildId/roles', authenticate, requireGuildContext, async (req, res) => {
  if (!Guild.canManageRoles(req.guildContext)) {
    return missingPermissions(res);
  }
  const role = await Guild.createRole(req.params.guildId, req.body || {});
  res.status(201).json(role);
});

router.patch('/guilds/:guildId/roles', authenticate, requireGuildContext, async (req, res) => {
  if (!Guild.canManageRoles(req.guildContext)) {
    return missingPermissions(res);
  }
  const roles = await Guild.updateRolePositions(req.params.guildId, Array.isArray(req.body) ? req.body : []);
  res.json(roles);
});

router.patch('/guilds/:guildId/roles/:roleId', authenticate, requireGuildContext, async (req, res) => {
  if (!Guild.canManageRoles(req.guildContext)) {
    return missingPermissions(res);
  }
  const existing = await Guild.getRole(req.params.guildId, req.params.roleId);
  if (!existing) {
    return unknownRole(res);
  }
  const role = await Guild.updateRole(req.params.guildId, req.params.roleId, req.body || {});
  res.json(role);
});

router.delete('/guilds/:guildId/roles/:roleId', authenticate, requireGuildContext, async (req, res) => {
  if (!Guild.canManageRoles(req.guildContext)) {
    return missingPermissions(res);
  }
  const existing = await Guild.getRole(req.params.guildId, req.params.roleId);
  if (!existing) {
    return unknownRole(res);
  }
  await Guild.deleteRole(req.params.guildId, req.params.roleId);
  res.status(204).send();
});

router.patch('/guilds/:guildId/roles/:roleId/members', authenticate, requireGuildContext, async (req, res) => {
  if (!Guild.canManageRoles(req.guildContext)) {
    return missingPermissions(res);
  }
  const existing = await Guild.getRole(req.params.guildId, req.params.roleId);
  if (!existing) {
    return unknownRole(res);
  }
  const members = await Guild.addRoleMembers(
    req.params.guildId,
    req.params.roleId,
    Array.isArray(req.body.member_ids) ? req.body.member_ids : [],
  );
  res.json(members);
});

module.exports = router;