const express = require('express');
const Invite = require('../models/invite');
const Guild = require('../models/guild');
const { authenticate } = require('../middleware/auth');
const { discordError, invalidFormBody, missingPermissions, unknownInvite, unknownGuild } = require('../utils/discordError');
const { broadcastGuildCreateForUser, broadcastGuildMemberAdd, broadcastInviteDelete } = require('../gateway');

const router = express.Router();

const toBoolean = (value, fallback = false) => {
  if (typeof value === 'string') {
    return ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return fallback;
};

router.get('/invites/:code', async (req, res) => {
  const invite = await Invite.get(req.params.code, {
    withCounts: toBoolean(req.query.with_counts),
  });

  if (!invite) {
    return unknownInvite(res);
  }

  res.json(invite);
});

router.post('/invites/:code', authenticate, async (req, res) => {
  const sessionId = req.body?.session_id;
  const invitePreview = await Invite.get(req.params.code);
  const wasAlreadyMember = invitePreview
    ? Boolean(await Guild.getMemberRecord(invitePreview.guild_id, req.user.id))
    : false;

  const accepted = await Invite.accept(req.params.code, req.user.id, { sessionId });

  if (!accepted) {
    return unknownInvite(res);
  }

  if (!wasAlreadyMember) {
    const [fullGuild, member] = await Promise.all([
      Guild.getFullGuild(accepted.guild_id, { withCounts: true }),
      Guild.getMember(accepted.guild_id, req.user.id),
    ]);
    if (fullGuild) {
      await broadcastGuildCreateForUser(req.user.id, fullGuild);
    }
    if (member) {
      await broadcastGuildMemberAdd(accepted.guild_id, member);
    }
  }

  res.json(accepted);
});

router.delete('/invites/:code', authenticate, async (req, res) => {
  const invite = await Invite.get(req.params.code, { withCounts: true });
  if (!invite) {
    return unknownInvite(res);
  }
  const context = await Guild.getContext(invite.guild_id, req.user.id);
  if (!context || (!Guild.canManageGuild(context) && !Guild.canManageChannels(context))) {
    return missingPermissions(res);
  }
  const deleted = await Invite.delete(req.params.code);
  await broadcastInviteDelete(invite);
  res.json(deleted);
});

router.get('/guilds/:guildId/invites', authenticate, async (req, res) => {
  const context = await Guild.getContext(req.params.guildId, req.user.id);
  if (!context) {
    const guild = await Guild.getById(req.params.guildId);
    if (!guild) {
      return unknownGuild(res);
    }
    return discordError(res, 403, 50001, 'Missing Access');
  }
  if (!Guild.canManageGuild(context)) {
    return missingPermissions(res);
  }
  const invites = await Invite.listForGuild(req.params.guildId);
  res.json(invites);
});

module.exports = router;