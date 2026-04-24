const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const {
  invalidFormBody,
  unauthorized,
  invalidLogin,
  parseDbError,
} = require('../utils/discordError');
const { generateDiscordToken, parseDiscordToken, verifyDiscordToken } = require('../utils/discordAuth');

const router = express.Router();

const buildMissingFields = (body) => {
  const errors = {};
  if (!body.username) {
    errors.username = {
      _errors: [{ code: 'BASE_TYPE_REQUIRED', message: 'This field is required' }],
    };
  }
  if (!body.email) {
    errors.email = {
      _errors: [{ code: 'BASE_TYPE_REQUIRED', message: 'This field is required' }],
    };
  }
  if (!body.password) {
    errors.password = {
      _errors: [{ code: 'BASE_TYPE_REQUIRED', message: 'This field is required' }],
    };
  }
  return errors;
};

// Register
router.post('/register', async (req, res) => {
  const missing = buildMissingFields(req.body);
  if (Object.keys(missing).length) {
    return invalidFormBody(res, missing);
  }

  const authHeader = req.header('Authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (authHeader) {
    const parsed = parseDiscordToken(authHeader);
    if (parsed) {
      const existingUser = await User.findByIdWithPasswordHash(parsed.userId);
      if (existingUser) {
        return res.json({ token: authHeader, user_id: existingUser.id });
      }
    }
  }

  try {
    const { username, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ username, email, password: hashedPassword });
    const token = generateDiscordToken(user.id, hashedPassword);
    res.status(201).json({ token, user_id: user.id });
  } catch (error) {
    const parsed = parseDbError(error);
    if (parsed) {
      return invalidFormBody(res, parsed.errors);
    }
    return invalidFormBody(res, {
      _errors: [{ code: 'BASE_TYPE_INVALID', message: error.message }],
    });
  }
});

// Login
router.post('/login', async (req, res) => {
  const missing = {};
  if (!req.body.login) {
    missing.login = {
      _errors: [{ code: 'BASE_TYPE_REQUIRED', message: 'This field is required' }],
    };
  }
  if (!req.body.password) {
    missing.password = {
      _errors: [{ code: 'BASE_TYPE_REQUIRED', message: 'This field is required' }],
    };
  }
  if (Object.keys(missing).length) {
    return invalidFormBody(res, missing);
  }

  try {
    const authHeader = req.header('Authorization')?.replace(/^Bearer\s+/i, '').trim();
    if (authHeader) {
      const parsed = parseDiscordToken(authHeader);
      if (parsed) {
        const existingUser = await User.findByIdWithPasswordHash(parsed.userId);
        if (existingUser && verifyDiscordToken(authHeader, existingUser.password_hash)) {
          return res.json({ token: authHeader, user_id: existingUser.id });
        }
      }
    }

    const { login, password } = req.body;
    const user = await User.findByEmail(login);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return invalidLogin(res);
    }
    const token = generateDiscordToken(user.id, user.password_hash);
    res.json({ token, user_id: user.id });
  } catch (error) {
    return invalidFormBody(res, {
      _errors: [{ code: 'BASE_TYPE_INVALID', message: error.message }],
    });
  }
});

// Logout
router.post('/logout', (req, res) => {
  // Invalidate token, but for simplicity, just respond
  res.status(204).send();
});

module.exports = router;