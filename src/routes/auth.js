const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/user');
const {
  invalidFormBody,
  unauthorized,
  parseDbError,
} = require('../utils/discordError');

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

  try {
    const { username, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ username, email, password: hashedPassword });
    res.status(201).json(user);
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
    const { login, password } = req.body;
    const user = await User.findByEmail(login);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return invalidFormBody(res, {
		"login": {
			"_errors": [
				{
					"code": "INVALID_LOGIN",
					"message": "Login or password is invalid."
				}
			]
		},
		"password": {
			"_errors": [
				{
					"code": "INVALID_LOGIN",
					"message": "Login or password is invalid."
				}
			]
	}
      })
    }
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET);
    res.json({ token, user_id: user.id.toString() });
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