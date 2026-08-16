const express = require('express');
const Guild = require('../models/guild');
const GuildTemplate = require('../models/guildTemplate');
const { authenticate } = require('../middleware/auth');
const {
  invalidFormBody,
  missingPermissions,
  unknownGuild,
  unknownGuildTemplate,
} = require('../utils/discordError');

const router = express.Router();

const validateGuildName = (name) => typeof name === 'string' && name.trim().length >= 2 && name.trim().length <= 100;

router.get('/guilds/templates/:code', async (req, res) => {
  const template = await GuildTemplate.get(req.params.code);
  if (!template) {
    return unknownGuildTemplate(res);
  }
  res.json(template);
});

router.post('/guilds/templates/:code', authenticate, async (req, res) => {
  if (!validateGuildName(req.body.name)) {
    return invalidFormBody(res, {
      name: {
        _errors: [{ code: 'BASE_TYPE_BAD_LENGTH', message: 'Guild name must be between 2 and 100 characters.' }],
      },
    });
  }

  const guild = await GuildTemplate.use(req.params.code, req.user.id, {
    name: req.body.name.trim(),
    icon: req.body.icon || null,
  });
  if (!guild) {
    return unknownGuildTemplate(res);
  }
  res.status(201).json(guild);
});

router.get('/guilds/:guildId/templates', authenticate, async (req, res) => {
  const context = await Guild.getContext(req.params.guildId, req.user.id);
  if (!context) {
    const guild = await Guild.getById(req.params.guildId);
    if (!guild) {
      return unknownGuild(res);
    }
    return missingPermissions(res);
  }
  if (!Guild.canManageGuild(context)) {
    return missingPermissions(res);
  }
  const templates = await GuildTemplate.listForGuild(req.params.guildId);
  res.json(templates);
});

router.post('/guilds/:guildId/templates', authenticate, async (req, res) => {
  const context = await Guild.getContext(req.params.guildId, req.user.id);
  if (!context) {
    const guild = await Guild.getById(req.params.guildId);
    if (!guild) {
      return unknownGuild(res);
    }
    return missingPermissions(res);
  }
  if (!Guild.canManageGuild(context)) {
    return missingPermissions(res);
  }

  if (typeof req.body.name !== 'string' || req.body.name.trim().length < 1 || req.body.name.trim().length > 100) {
    return invalidFormBody(res, {
      name: {
        _errors: [{ code: 'BASE_TYPE_BAD_LENGTH', message: 'Template name must be between 1 and 100 characters.' }],
      },
    });
  }

  const template = await GuildTemplate.create(req.params.guildId, req.user.id, {
    name: req.body.name.trim(),
    description: req.body.description || null,
  });
  res.status(201).json(template);
});

router.put('/guilds/:guildId/templates/:code', authenticate, async (req, res) => {
  const context = await Guild.getContext(req.params.guildId, req.user.id);
  if (!context) {
    const guild = await Guild.getById(req.params.guildId);
    if (!guild) {
      return unknownGuild(res);
    }
    return missingPermissions(res);
  }
  if (!Guild.canManageGuild(context)) {
    return missingPermissions(res);
  }

  const template = await GuildTemplate.sync(req.params.guildId, req.params.code);
  if (!template) {
    return unknownGuildTemplate(res);
  }
  res.json(template);
});

router.patch('/guilds/:guildId/templates/:code', authenticate, async (req, res) => {
  const context = await Guild.getContext(req.params.guildId, req.user.id);
  if (!context) {
    const guild = await Guild.getById(req.params.guildId);
    if (!guild) {
      return unknownGuild(res);
    }
    return missingPermissions(res);
  }
  if (!Guild.canManageGuild(context)) {
    return missingPermissions(res);
  }

  const updates = {};
  if (Object.prototype.hasOwnProperty.call(req.body, 'name')) {
    if (typeof req.body.name !== 'string' || req.body.name.trim().length < 1 || req.body.name.trim().length > 100) {
      return invalidFormBody(res, {
        name: {
          _errors: [{ code: 'BASE_TYPE_BAD_LENGTH', message: 'Template name must be between 1 and 100 characters.' }],
        },
      });
    }
    updates.name = req.body.name.trim();
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'description')) {
    updates.description = req.body.description;
  }

  const template = await GuildTemplate.update(req.params.guildId, req.params.code, updates);
  if (!template) {
    return unknownGuildTemplate(res);
  }
  res.json(template);
});

router.delete('/guilds/:guildId/templates/:code', authenticate, async (req, res) => {
  const context = await Guild.getContext(req.params.guildId, req.user.id);
  if (!context) {
    const guild = await Guild.getById(req.params.guildId);
    if (!guild) {
      return unknownGuild(res);
    }
    return missingPermissions(res);
  }
  if (!Guild.canManageGuild(context)) {
    return missingPermissions(res);
  }

  const template = await GuildTemplate.delete(req.params.guildId, req.params.code);
  if (!template) {
    return unknownGuildTemplate(res);
  }
  res.json(template);
});

module.exports = router;
