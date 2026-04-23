const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
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