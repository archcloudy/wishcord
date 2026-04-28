const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const Relationship = require('../models/relationship');
const ConnectedAccount = require('../models/connectedAccount');
const PrivateChannel = require('../models/privateChannel');
const UserGuildSettings = require('../models/userGuildSettings');
const UserNote = require('../models/userNote');
const UserSettingsProto = require('../models/userSettingsProto');
const {
  broadcastRelationshipAdd,
  broadcastRelationshipRemove,
  broadcastRelationshipUpdate,
  broadcastUserNoteUpdate,
  broadcastUserSettingsProtoUpdate,
} = require('../gateway');
const { authenticate } = require('../middleware/auth');
const {
  invalidFormBody,
  discordError,
  unknownUser,
  parseDbError,
} = require('../utils/discordError');

const router = express.Router();

const buildUserResponse = (user, options = {}) => ({
  id: String(user.id),
  username: user.username,
  discriminator: user.discriminator || '0000',
  global_name: user.global_name ?? null,
  avatar: user.avatar ?? null,
  avatar_decoration_data: null,
  banner: user.banner ?? null,
  accent_color: user.accent_color ?? null,
  bio: user.bio || '',
  pronouns: user.pronouns || '',
  locale: 'en-US',
  nsfw_allowed: true,
  mfa_enabled: Boolean(options.mfaEnabled ?? user.mfa_enabled),
  authenticator_types: Array.isArray(options.authenticatorTypes)
    ? options.authenticatorTypes
    : (user.mfa_enabled ? [2] : []),
  premium_type: Number(user.premium_type || 0),
  premium: Number(user.premium_type || 0) > 0,
  premium_usage_flags: 0,
  purchased_flags: 0,
  public_flags: Number(user.public_flags || 0),
  flags: Number(user.flags || 0),
  verified: Boolean(user.verified),
  email: options.includeEmail === false ? undefined : (user.email ?? null),
  phone: null,
  bot: Boolean(options.bot),
  system: false,
  desktop: false,
  mobile: false,
  banner_color: null,
  collectibles: null,
  display_name_styles: null,
  primary_guild: null,
  analytics_token: options.includeAnalyticsToken ? 'wishcord-analytics-token' : undefined,
});

// Get current user
router.get('/@me', authenticate, async (req, res) => {
  const withAnalyticsToken = String(req.query.with_analytics_token).toLowerCase() === 'true';
  res.json(buildUserResponse(req.user, {
    includeAnalyticsToken: withAnalyticsToken,
    mfaEnabled: false,
    authenticatorTypes: [],
    includeEmail: true,
    bot: false,
  }));
});

router.get('/@me/guilds/settings', authenticate, async (req, res) => {
  try {
    const entries = await UserGuildSettings.listForUser(req.user.id);
    res.json(entries);
  } catch (error) {
    console.error('Error fetching user guild settings:', error);
    discordError(res, 500, 50000, 'Unknown Error');
  }
});
router.get('/@me/channels', authenticate, async (req, res) => {
  try {
    const channels = await PrivateChannel.listForUser(req.user.id);
    res.json(channels);
  } catch (error) {
    console.error('Error fetching private channels:', error);
    discordError(res, 500, 50000, 'Unknown Error');
  }
});

router.get('/@me/dms/:id', authenticate, async (req, res) => {
  try {
    const channel = await PrivateChannel.getDMChannel(req.user.id, req.params.id);
    if (!channel) {
      return discordError(res, 404, 10003, 'Unknown Channel');
    }
    res.json(channel);
  } catch (error) {
    console.error('Error fetching DM channel:', error);
    discordError(res, 500, 50000, 'Unknown Error');
  }
});

router.post('/@me/channels', authenticate, async (req, res) => {
  const recipientIds = Array.isArray(req.body.recipients)
    ? req.body.recipients.map(String)
    : (req.body.recipient_id ? [String(req.body.recipient_id)] : []);

  if (!recipientIds.length) {
    return invalidFormBody(res, {
      recipients: {
        _errors: [{ code: 'BASE_TYPE_REQUIRED', message: 'recipient_id or recipients is required.' }],
      },
    });
  }

  try {
    const channel = await PrivateChannel.createChannel(req.user.id, recipientIds, {
      name: typeof req.body.name === 'string' ? req.body.name : null,
      icon: req.body.icon || null,
    });
    res.json(channel);
  } catch (error) {
    console.error('Error creating private channel:', error);
    discordError(res, 500, 50000, 'Unknown Error');
  }
});
router.get('/@me/notification-settings', authenticate, async (req, res) => {
  try {
    const settings = await UserGuildSettings.getNotificationSettings(req.user.id);
    res.json(settings);
  } catch (error) {
    console.error('Error fetching notification settings:', error);
    discordError(res, 500, 50000, 'Unknown Error');
  }
});

router.patch('/@me/account', authenticate, async (req, res) => {
  const updates = {};

  if (Object.prototype.hasOwnProperty.call(req.body, 'global_name')) {
    if (!(req.body.global_name == null || typeof req.body.global_name === 'string')) {
      return invalidFormBody(res, {
        global_name: {
          _errors: [{ code: 'BASE_TYPE_STRING', message: 'global_name must be a string or null.' }],
        },
      });
    }

    if (typeof req.body.global_name === 'string' && (req.body.global_name.length < 1 || req.body.global_name.length > 32)) {
      return invalidFormBody(res, {
        global_name: {
          _errors: [{ code: 'BASE_TYPE_BAD_LENGTH', message: 'global_name must be between 1 and 32 characters.' }],
        },
      });
    }

    updates.global_name = req.body.global_name ?? null;
  }

  if (!Object.keys(updates).length) {
    return invalidFormBody(res, {
      _errors: [{ code: 'BASE_TYPE_INVALID', message: 'No account update fields provided.' }],
    });
  }

  try {
    const user = await User.update(req.user.id, updates);
    res.json({
      id: String(user.id),
      username: user.username,
      discriminator: user.discriminator || '0000',
      global_name: user.global_name ?? null,
      avatar: user.avatar ?? null,
    });
  } catch (error) {
    console.error('Error updating account:', error);
    discordError(res, 500, 50000, 'Unknown Error');
  }
});

router.get('/@me/settings-proto/:type', authenticate, async (req, res) => {
  const protoType = UserSettingsProto.normalizeType(req.params.type);
  if (protoType == null) {
    return invalidFormBody(res, {
      type: {
        _errors: [{ code: 'BASE_TYPE_CHOICES', message: 'type must be one of 1 (PRELOADED), 2 (FRECENCY), or 3 (TEST_SETTINGS).' }],
      },
    });
  }

  try {
    const settings = await UserSettingsProto.get(req.user.id, protoType);
    if (!settings) {
      return discordError(res, 404, 50000, 'Unknown User Settings Proto Type');
    }

    res.json({
      settings: settings.settings_base64 || '',
      data_version: settings.data_version || 0,
      client_version: settings.client_version || 0,
      server_version: settings.server_version || 0,
    });
  } catch (error) {
    console.error('Error fetching user settings proto:', error);
    discordError(res, 500, 50000, 'Unknown Error');
  }
});

router.patch('/@me/settings-proto/:type', authenticate, async (req, res) => {
  const protoType = UserSettingsProto.normalizeType(req.params.type);
  if (protoType == null) {
    return invalidFormBody(res, {
      type: {
        _errors: [{ code: 'BASE_TYPE_CHOICES', message: 'type must be one of 1 (PRELOADED), 2 (FRECENCY), or 3 (TEST_SETTINGS).' }],
      },
    });
  }

  if (typeof req.body?.settings !== 'string') {
    return invalidFormBody(res, {
      settings: {
        _errors: [{ code: 'BASE_TYPE_REQUIRED', message: 'settings must be a base64 string.' }],
      },
    });
  }

  // Validate base64 string length (max 5MB as per Discord docs)
  if (req.body.settings.length > 5242880) {
    return invalidFormBody(res, {
      settings: {
        _errors: [{ code: 'BASE_TYPE_MAX_LENGTH', message: 'settings exceeds maximum length of 5242880 characters.' }],
      },
    });
  }

  const requiredDataVersion = req.body.required_data_version;
  if (requiredDataVersion != null && !Number.isInteger(requiredDataVersion)) {
    return invalidFormBody(res, {
      required_data_version: {
        _errors: [{ code: 'BASE_TYPE_INTEGER', message: 'required_data_version must be an integer.' }],
      },
    });
  }
  
  const clientVersion = req.body.client_version;
  if (clientVersion != null && !Number.isInteger(clientVersion)) {
    return invalidFormBody(res, {
      client_version: {
        _errors: [{ code: 'BASE_TYPE_INTEGER', message: 'client_version must be an integer.' }],
      },
    });
  }

  try {
    const result = await UserSettingsProto.update(
      req.user.id,
      protoType,
      req.body.settings,
      requiredDataVersion,
      clientVersion
    );

  if (!result.out_of_date) {
    await broadcastUserSettingsProtoUpdate(req.user.id, {
      settings: {
        type: protoType,
        proto: result.settings_base64,
      },
      partial: false,
    });
  }

  res.json({
      settings: result.settings_base64 || '',
      data_version: result.data_version || 0,
      client_version: result.client_version || 0,
      server_version: result.server_version || 0,
      out_of_date: result.out_of_date || undefined,
    });
  } catch (error) {
    console.error('Error updating user settings proto:', error);
    if (error.message.includes('settings must be a base64 string')) {
      return invalidFormBody(res, {
        settings: {
          _errors: [{ code: 'BASE_TYPE_INVALID', message: error.message }],
        },
      });
    }
    if (error.message.includes('exceeds maximum length')) {
      return invalidFormBody(res, {
        settings: {
          _errors: [{ code: 'BASE_TYPE_MAX_LENGTH', message: error.message }],
        },
      });
    }
    discordError(res, 500, 50000, 'Unknown Error');
  }
});

// Get all user settings proto types
router.get('/@me/settings-proto', authenticate, async (req, res) => {
  try {
    const allSettings = await UserSettingsProto.getAll(req.user.id);
    const response = {};

    Object.keys(allSettings).forEach(type => {
      const settings = allSettings[type];
      response[type] = {
        settings: settings.settings_base64 || '',
        data_version: settings.data_version || 0,
        client_version: settings.client_version || 0,
        server_version: settings.server_version || 0,
      };
    });

    res.json(response);
  } catch (error) {
    console.error('Error fetching all user settings proto:', error);
    discordError(res, 500, 50000, 'Unknown Error');
  }
});

// Batch update multiple proto types (for efficiency as recommended in docs)
router.patch('/@me/settings-proto', authenticate, async (req, res) => {
  if (!Array.isArray(req.body) || req.body.length === 0) {
    return invalidFormBody(res, {
      _errors: [{ code: 'BASE_TYPE_INVALID', message: 'Request body must be a non-empty array of proto updates.' }],
    });
  }

  // Validate each update in the batch
  for (let i = 0; i < req.body.length; i++) {
    const update = req.body[i];

    if (!update.type || !update.settings) {
      return invalidFormBody(res, {
        [i]: {
          _errors: [{ code: 'BASE_TYPE_INVALID', message: 'Each update must have type and settings fields.' }],
        },
      });
    }

    const protoType = UserSettingsProto.normalizeType(update.type);
    if (protoType == null) {
      return invalidFormBody(res, {
        [i]: {
          type: {
            _errors: [{ code: 'BASE_TYPE_CHOICES', message: 'type must be one of 1 (PRELOADED), 2 (FRECENCY), or 3 (TEST_SETTINGS).' }],
          },
        },
      });
    }

    if (typeof update.settings !== 'string') {
      return invalidFormBody(res, {
        [i]: {
          settings: {
            _errors: [{ code: 'BASE_TYPE_REQUIRED', message: 'settings must be a base64 string.' }],
          },
        },
      });
    }

    if (update.settings.length > 5242880) {
      return invalidFormBody(res, {
        [i]: {
          settings: {
            _errors: [{ code: 'BASE_TYPE_MAX_LENGTH', message: 'settings exceeds maximum length of 5242880 characters.' }],
          },
        },
      });
    }

    if (update.required_data_version != null && !Number.isInteger(update.required_data_version)) {
      return invalidFormBody(res, {
        [i]: {
          required_data_version: {
            _errors: [{ code: 'BASE_TYPE_INTEGER', message: 'required_data_version must be an integer.' }],
          },
        },
      });
    }

    if (update.client_version != null && !Number.isInteger(update.client_version)) {
      return invalidFormBody(res, {
        [i]: {
          client_version: {
            _errors: [{ code: 'BASE_TYPE_INTEGER', message: 'client_version must be an integer.' }],
          },
        },
      });
    }
  }

  try {
    const results = await UserSettingsProto.batchUpdate(req.user.id, req.body);

    // Broadcast updates for each successful update
    for (const result of results) {
      if (!result.out_of_date) {
        await broadcastUserSettingsProtoUpdate(req.user.id, {
          settings: {
            type: result.proto_type,
            proto: result.settings_base64,
          },
          partial: false,
        });
      }
    }

    res.json(results);
  } catch (error) {
    console.error('Error batch updating user settings proto:', error);
    discordError(res, 500, 50000, 'Unknown Error');
  }
});

// Delete user settings proto (reset to defaults)
router.delete('/@me/settings-proto/:type', authenticate, async (req, res) => {
  const protoType = UserSettingsProto.normalizeType(req.params.type);
  if (protoType == null) {
    return invalidFormBody(res, {
      type: {
        _errors: [{ code: 'BASE_TYPE_CHOICES', message: 'type must be one of 1 (PRELOADED), 2 (FRECENCY), or 3 (TEST_SETTINGS).' }],
      },
    });
  }

  try {
    const deleted = await UserSettingsProto.delete(req.user.id, protoType);

    if (deleted) {
      await broadcastUserSettingsProtoUpdate(req.user.id, {
        settings: {
          type: protoType,
          proto: '', // Empty proto indicates reset to defaults
        },
        partial: false,
      });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting user settings proto:', error);
    discordError(res, 500, 50000, 'Unknown Error');
  }
});

// Modify current user
router.patch('/@me', authenticate, async (req, res) => {
  try {
    const updates = { ...req.body };
    if (updates.password) {
      updates.password_hash = await bcrypt.hash(updates.password, 10);
      delete updates.password;
    }

    if (Object.keys(updates).length === 0) {
      return invalidFormBody(res, {
        _errors: [{ code: 'BASE_TYPE_INVALID', message: 'No update fields provided.' }],
      });
    }

    const user = await User.update(req.user.id, updates);
    res.json(user);
  } catch (error) {
    const parsed = parseDbError(error);
    if (parsed) {
      return invalidFormBody(res, parsed.errors);
    }
    return discordError(res, 500, 50000, 'Unknown Error');
  }
});

// Get user by ID
router.get('/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return unknownUser(res);
    }
    res.json(buildUserResponse(user, {
      includeEmail: false,
      mfaEnabled: false,
      authenticatorTypes: [],
      bot: false,
    }));
  } catch (error) {
    return discordError(res, 500, 50000, 'Unknown Error');
  }
});

module.exports = router;