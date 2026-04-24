const express = require('express');
const User = require('../models/user');
const { invalidFormBody } = require('../utils/discordError');

const router = express.Router();

const sanitizeUsername = (value) => {
  if (!value || typeof value !== 'string') return '';

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9_.]/g, '');

  return normalized.replace(/^\.+|\.+$/g, '');
};

const generateRandomUsername = () => {
  return `user.${Math.random().toString(36).slice(2, 8)}`;
};

const ensureLength = (username) => username.slice(0, 32);

const findSuggestedUsername = async (base) => {
  if (!base) {
    base = generateRandomUsername();
  }

  base = ensureLength(base);

  const exists = await User.findByUsername(base);
  if (!exists) return base;

  for (let index = 1; index <= 50; index += 1) {
    const candidate = ensureLength(`${base}.${index}`);
    if (!(await User.findByUsername(candidate))) {
      return candidate;
    }
  }

  for (let index = 1; index <= 50; index += 1) {
    const candidate = ensureLength(`${base}${index}`);
    if (!(await User.findByUsername(candidate))) {
      return candidate;
    }
  }

  return generateRandomUsername();
};

router.get('/unique-username/username-suggestions-unauthed', async (req, res) => {
  try {
    const requestedName = req.query.global_name || req.query.globalName || '';
    const sanitized = sanitizeUsername(requestedName);
    const username = await findSuggestedUsername(sanitized || generateRandomUsername());
    res.json({ username });
  } catch (error) {
    res.status(500).json({ message: 'Unable to generate username suggestion', code: 50000 });
  }
});

router.post('/unique-username/username-attempt-unauthed', async (req, res) => {
  const usernameValue = req.body?.username;
  if (!usernameValue || typeof usernameValue !== 'string') {
    return invalidFormBody(res, {
      username: {
        _errors: [
          {
            code: 'BASE_TYPE_REQUIRED',
            message: 'This field is required',
          },
        ],
      },
    });
  }

  const username = sanitizeUsername(usernameValue);
  if (!username) {
    return invalidFormBody(res, {
      username: {
        _errors: [
          {
            code: 'BASE_TYPE_INVALID',
            message: 'Invalid username',
          },
        ],
      },
    });
  }

  try {
    const taken = Boolean(await User.findByUsername(username));
    res.json({ taken });
  } catch (error) {
    res.status(500).json({ message: 'Unable to validate username', code: 50000 });
  }
});

module.exports = router;
