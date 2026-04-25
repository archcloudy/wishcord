const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const UserSettingsProto = require('../models/userSettingsProto');
const { broadcastUserSettingsProtoUpdate } = require('../gateway');
const { authenticate } = require('../middleware/auth');
const {
  invalidFormBody,
  discordError,
  unknownUser,
  parseDbError,
} = require('../utils/discordError');

const router = express.Router();

// Get current user
router.get('/@me', authenticate, async (req, res) => {
  res.json(req.user);
});

router.get('/@me/settings-proto/:type', authenticate, async (req, res) => {
  const protoType = UserSettingsProto.normalizeType(req.params.type);
  if (protoType == null) {
    return invalidFormBody(res, {
      type: {
        _errors: [{ code: 'BASE_TYPE_CHOICES', message: 'type must be one of 1, 2, or 3.' }],
      },
    });
  }

  const settings = await UserSettingsProto.get(req.user.id, protoType);
  res.json({ settings: settings.settings_base64 || '' });
});

router.patch('/@me/settings-proto/:type', authenticate, async (req, res) => {
  const protoType = UserSettingsProto.normalizeType(req.params.type);
  if (protoType == null) {
    return invalidFormBody(res, {
      type: {
        _errors: [{ code: 'BASE_TYPE_CHOICES', message: 'type must be one of 1, 2, or 3.' }],
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

  const requiredDataVersion = req.body.required_data_version;
  if (requiredDataVersion != null && !Number.isInteger(requiredDataVersion)) {
    return invalidFormBody(res, {
      required_data_version: {
        _errors: [{ code: 'BASE_TYPE_INTEGER', message: 'required_data_version must be an integer.' }],
      },
    });
  }

  const result = await UserSettingsProto.update(req.user.id, protoType, req.body.settings, requiredDataVersion);
  if (!result) {
    return discordError(res, 500, 50000, 'Unknown Error');
  }

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
    out_of_date: result.out_of_date || undefined,
  });
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
    res.json(user);
  } catch (error) {
    return discordError(res, 500, 50000, 'Unknown Error');
  }
});

module.exports = router;