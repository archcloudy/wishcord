const express = require('express');
const Guild = require('../models/guild');
const Invite = require('../models/invite');
const Message = require('../models/message');
const ReadState = require('../models/readState');
const {
  broadcastMessageCreate,
  broadcastMessageUpdate,
  broadcastMessageDelete,
  broadcastReadStateUpdate,
} = require('../gateway');
const { authenticate } = require('../middleware/auth');
const {
  discordError,
  invalidFormBody,
  missingPermissions,
  unknownMessage,
} = require('../utils/discordError');

const router = express.Router();

const unknownChannel = (res) => discordError(res, 404, 10003, 'Unknown Channel');

const requireChannelContext = async (req, res, next) => {
  const channel = await Guild.getChannel(req.params.channelId, req.user.id);
  if (!channel) {
    return unknownChannel(res);
  }
  const context = await Guild.getContext(channel.guild_id, req.user.id);
  if (!context) {
    return discordError(res, 403, 50001, 'Missing Access');
  }
  req.channel = channel;
  req.guildContext = context;
  next();
};

router.get('/channels/:channelId', authenticate, requireChannelContext, async (req, res) => {
  if (!Guild.canViewChannel(req.guildContext, req.channel.id)) {
    return discordError(res, 403, 50001, 'Missing Access');
  }
  res.json(req.channel);
});

router.get('/channels/:channelId/messages', authenticate, requireChannelContext, async (req, res) => {
  if (!Guild.canViewChannel(req.guildContext, req.channel.id)) {
    return discordError(res, 403, 50001, 'Missing Access');
  }
  if (!Guild.canReadMessageHistory(req.guildContext, req.channel.id)) {
    return res.json([]);
  }
  const messages = await Message.list(req.params.channelId, {
    around: req.query.around,
    before: req.query.before,
    after: req.query.after,
    limit: req.query.limit,
  });
  res.json(messages);
});

router.post('/channels/:channelId/messages', authenticate, requireChannelContext, async (req, res) => {
  if (!Guild.canSendMessages(req.guildContext, req.channel.id)) {
    return missingPermissions(res);
  }
  const hasRenderableContent = [
    typeof req.body.content === 'string' && req.body.content.length > 0,
    Array.isArray(req.body.embeds) && req.body.embeds.length > 0,
    Array.isArray(req.body.components) && req.body.components.length > 0,
    Array.isArray(req.body.attachments) && req.body.attachments.length > 0,
  ].some(Boolean);
  if (!hasRenderableContent) {
    return invalidFormBody(res, {
      content: {
        _errors: [{ code: 'BASE_TYPE_REQUIRED', message: 'Message content, embeds, components, or attachments are required.' }],
      },
    });
  }
  const message = await Message.create(req.params.channelId, req.user.id, req.body || {});
  await ReadState.markOwnMessageRead(req.user.id, req.params.channelId, message.id);
  await broadcastMessageCreate(message);
  res.status(200).json(message);
});

router.post('/channels/:channelId/messages/:messageId/ack', authenticate, requireChannelContext, async (req, res) => {
  if (!Guild.canViewChannel(req.guildContext, req.channel.id)) {
    return discordError(res, 403, 50001, 'Missing Access');
  }

  const message = await Message.get(req.params.channelId, req.params.messageId);
  if (!message) {
    return unknownMessage(res);
  }

  const entry = await ReadState.ack(req.user.id, req.params.channelId, req.params.messageId);
  if (!entry) {
    return unknownMessage(res);
  }

  const payload = {
    channel_id: String(req.params.channelId),
    message_id: String(req.params.messageId),
    last_acked_id: String(req.params.messageId),
    version: 0,
    manual: true,
    mention_count: 0,
  };

  await broadcastReadStateUpdate(req.user.id, payload);
  res.status(200).json({ token: null, ...entry });
});

router.get('/channels/:channelId/messages/:messageId', authenticate, requireChannelContext, async (req, res) => {
  if (!Guild.canReadMessageHistory(req.guildContext, req.channel.id)) {
    return unknownMessage(res);
  }
  const message = await Message.get(req.params.channelId, req.params.messageId);
  if (!message) {
    return unknownMessage(res);
  }
  res.json(message);
});

router.get('/channels/:channelId/invites', authenticate, requireChannelContext, async (req, res) => {
  if (!Guild.canManageChannels(req.guildContext)) {
    return missingPermissions(res);
  }
  const invites = await Invite.listForChannel(req.params.channelId);
  res.json(invites);
});

router.post('/channels/:channelId/invites', authenticate, requireChannelContext, async (req, res) => {
  if (!Guild.canCreateInstantInvite(req.guildContext, req.channel.id) && !Guild.canManageChannels(req.guildContext)) {
    return missingPermissions(res);
  }
  const maxAge = req.body.max_age ?? 86400;
  const maxUses = req.body.max_uses ?? 0;
  if (maxAge < 0 || maxAge > 5184000 || maxUses < 0 || maxUses > 100) {
    return invalidFormBody(res);
  }
  const invite = await Invite.create(req.params.channelId, req.user.id, req.body || {});
  res.status(200).json(invite);
});

router.patch('/channels/:channelId/messages/:messageId', authenticate, requireChannelContext, async (req, res) => {
  const existing = await Message.get(req.params.channelId, req.params.messageId);
  if (!existing) {
    return unknownMessage(res);
  }
  const isAuthor = String(existing.author.id) === String(req.user.id);
  if (!isAuthor && !Guild.canManageMessages(req.guildContext, req.channel.id)) {
    return missingPermissions(res);
  }
  const message = await Message.update(req.params.channelId, req.params.messageId, req.body || {});
  await broadcastMessageUpdate(message);
  res.json(message);
});

router.delete('/channels/:channelId/messages/:messageId', authenticate, requireChannelContext, async (req, res) => {
  const existing = await Message.get(req.params.channelId, req.params.messageId);
  if (!existing) {
    return unknownMessage(res);
  }
  const isAuthor = String(existing.author.id) === String(req.user.id);
  if (!isAuthor && !Guild.canManageMessages(req.guildContext, req.channel.id)) {
    return missingPermissions(res);
  }
  const guildId = req.channel.guild_id;
  await Message.delete(req.params.channelId, req.params.messageId);
  await broadcastMessageDelete({
    id: req.params.messageId,
    channelId: req.params.channelId,
    guildId,
  });
  res.status(204).send();
});

router.patch('/channels/:channelId', authenticate, requireChannelContext, async (req, res) => {
  const modifyingOverwrites = Object.prototype.hasOwnProperty.call(req.body, 'permission_overwrites');
  if (!Guild.canManageChannels(req.guildContext)) {
    return missingPermissions(res);
  }
  if (modifyingOverwrites && !Guild.canManageRoles(req.guildContext)) {
    return missingPermissions(res);
  }
  const channel = await Guild.updateChannel(req.params.channelId, req.body || {});
  res.json(channel);
});

router.delete('/channels/:channelId', authenticate, requireChannelContext, async (req, res) => {
  if (!Guild.canManageChannels(req.guildContext)) {
    return missingPermissions(res);
  }
  const channel = await Guild.deleteChannel(req.params.channelId);
  res.json(channel);
});

router.put('/channels/:channelId/permissions/:overwriteId', authenticate, requireChannelContext, async (req, res) => {
  if (!Guild.canManageRoles(req.guildContext)) {
    return missingPermissions(res);
  }
  await Guild.upsertChannelOverwrite(req.params.channelId, req.params.overwriteId, req.body || {});
  res.status(204).send();
});

router.delete('/channels/:channelId/permissions/:overwriteId', authenticate, requireChannelContext, async (req, res) => {
  if (!Guild.canManageRoles(req.guildContext)) {
    return missingPermissions(res);
  }
  await Guild.deleteChannelOverwrite(req.params.channelId, req.params.overwriteId);
  res.status(204).send();
});

module.exports = router;