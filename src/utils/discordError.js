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

const invalidAuthToken = (res) =>
  discordError(res, 401, 50014, 'Invalid authentication token');

const unknownUser = (res) =>
  discordError(res, 404, 10013, 'Unknown User');

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
  invalidAuthToken,
  unknownUser,
  parseDbError,
};
