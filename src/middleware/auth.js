const jwt = require('jsonwebtoken');
const User = require('../models/user');
const { unauthorized, invalidAuthToken } = require('../utils/discordError');

const authenticate = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) {
    return unauthorized(res);
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) {
      return invalidAuthToken(res);
    }
    req.user = user;
    next();
  } catch (error) {
    return invalidAuthToken(res);
  }
};

module.exports = { authenticate };