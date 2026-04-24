const User = require('../models/user');
const { unauthorized, invalidAuthToken } = require('../utils/discordError');
const { parseDiscordToken, verifyDiscordToken } = require('../utils/discordAuth');

const authenticate = async (req, res, next) => {
  const token = req.header('Authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return unauthorized(res);
  }

  const parsed = parseDiscordToken(token);
  if (!parsed) {
    return invalidAuthToken(res);
  }

  try {
    const user = await User.findByIdWithPasswordHash(parsed.userId);
    if (!user || !verifyDiscordToken(token, user.password_hash)) {
      return invalidAuthToken(res);
    }
    req.user = user;
    next();
  } catch (error) {
    return invalidAuthToken(res);
  }
};

module.exports = { authenticate };