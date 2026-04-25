const express = require('express');
const Invite = require('../models/invite');
const Guild = require('../models/guild');
const { authenticate } = require('../middleware/auth');
const { discordError, invalidFormBody, missingPermissions, unknownInvite, unknownGuild } = require('../utils/discordError');

const router = express.Router();

router.get('/invites/:code', authenticate, async (req, res) => {
  const invite = await Invite.get(req.params.code, {
    withCounts: String(req.query.with_counts).toLowerCase() === 'true',
  });
  if (!invite) {
    return unknownInvite(res);
  }
  res.json(invite);
});

router.post('/invites/:code', authenticate, async (req, res) => {
  const accepted = await Invite.accept(req.params.code, req.user.id);
  if (!accepted) {
    return unknownInvite(res);
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