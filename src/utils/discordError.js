const DUPLICATE_KEY_CODE = '23505';

const createFieldError = (field, message, code = 'BASE_TYPE_DUPLICATE') => ({
  [field]: {
    _errors: [
      {
        code,
        message,
      },
    ],
  },
});

const discordError = (res, status, code, message, errors) => {
  const payload = { message, code };
  if (errors) {
    payload.errors = errors;
  }
  return res.status(status).json(payload);
};

const invalidFormBody = (res, errors = null) => {
  const payload = errors
    ? errors
    : { _errors: [{ code: 'BASE_TYPE_INVALID', message: 'Invalid request body.' }] };
  return discordError(res, 400, 50035, 'Invalid Form Body', payload);
};

const unauthorized = (res, message = 'Unauthorized', code = 40001) =>
  discordError(res, 401, code, message);

const invalidLogin = (res) =>
  invalidFormBody(res, {
    login: {
      _errors: [
        {
          code: 'INVALID_LOGIN',
          message: 'Login or password is invalid.',
        },
      ],
    },
    password: {
      _errors: [
        {
          code: 'INVALID_LOGIN',
          message: 'Login or password is invalid.',
        },
      ],
    },
  });

const invalidAuthToken = (res) =>
  discordError(res, 401, 50014, 'Invalid authentication token');

const unknownUser = (res) =>
  discordError(res, 404, 10013, 'Unknown User');

const unknownGuild = (res) =>
  discordError(res, 404, 10004, 'Unknown Guild');

const unknownMember = (res) =>
  discordError(res, 404, 10007, 'Unknown Member');

const unknownRole = (res) =>
  discordError(res, 404, 10011, 'Unknown Role');

const unknownMessage = (res) =>
  discordError(res, 404, 10008, 'Unknown Message');

const unknownInvite = (res) =>
  discordError(res, 404, 10006, 'Unknown Invite');

const missingPermissions = (res) =>
  discordError(res, 403, 50013, 'Missing Permissions');

const parseDbError = (error) => {
  if (error?.code === DUPLICATE_KEY_CODE) {
    const detail = error.detail || '';
    const match = detail.match(/\(([^)]+)\)=\(([^)]+)\) already exists/);
    if (match) {
      const field = match[1];
      return {
        errors: createFieldError(field, `${field} already exists.`),
      };
    }
  }
  return null;
};

module.exports = {
  discordError,
  invalidFormBody,
  unauthorized,
  invalidLogin,
  invalidAuthToken,
  unknownUser,
  unknownGuild,
  unknownMember,
  unknownRole,
  unknownMessage,
  unknownInvite,
  missingPermissions,
  parseDbError,
};
