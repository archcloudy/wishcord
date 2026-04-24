const crypto = require('crypto');

const DISCORD_EPOCH = 1420070400000n;
let lastTimestamp = 0n;
let sequence = 0n;
const workerId = BigInt(parseInt(process.env.DISCORD_WORKER_ID || '0', 10) & 0x1f);
const processId = BigInt(parseInt(process.env.DISCORD_PROCESS_ID || '0', 10) & 0x1f);

const encode = (value) => {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};

const decode = (value) =>
  Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const generateDiscriminator = () => Math.floor(Math.random() * 10000).toString().padStart(4, '0');

const generateSnowflake = () => {
  const now = BigInt(Date.now());
  if (now === lastTimestamp) {
    sequence = (sequence + 1n) & 0xfffn;
    if (sequence === 0n) {
      while (BigInt(Date.now()) === lastTimestamp) {}
      return generateSnowflake();
    }
  } else {
    lastTimestamp = now;
    sequence = 0n;
  }

  const timestamp = now - DISCORD_EPOCH;
  return ((timestamp << 22n) | (workerId << 17n) | (processId << 12n) | sequence).toString();
};

const createTokenParts = (userId, passwordHash) => {
  const tokenSecret = process.env.TOKEN_SECRET;
  if (!tokenSecret) {
    throw new Error('TOKEN_SECRET must be set');
  }

  const key = `${tokenSecret}--${passwordHash}`;
  const timeStampBuffer = Buffer.allocUnsafe(4);
  timeStampBuffer.writeUInt32BE(Math.floor(Date.now() / 1000) - 1293840);

  const encodedTimeStamp = encode(timeStampBuffer);
  const encodedUserId = encode(userId);
  const partOne = `${encodedUserId}.${encodedTimeStamp}`;
  const encryptedAuth = crypto.createHmac('sha3-224', key).update(partOne).digest();
  const encodedEncryptedAuth = encode(encryptedAuth);

  return { encodedUserId, encodedTimeStamp, encodedEncryptedAuth };
};

const generateDiscordToken = (userId, passwordHash) => {
  const { encodedUserId, encodedTimeStamp, encodedEncryptedAuth } = createTokenParts(userId, passwordHash);
  return `${encodedUserId}.${encodedTimeStamp}.${encodedEncryptedAuth}`;
};

const parseDiscordToken = (token) => {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encodedUserId, encodedTimeStamp, encodedEncryptedAuth] = parts;

  try {
    const userId = decode(encodedUserId).toString('utf8');
    return { userId, encodedUserId, encodedTimeStamp, encodedEncryptedAuth };
  } catch (error) {
    return null;
  }
};

const verifyDiscordToken = (token, passwordHash) => {
  const parsed = parseDiscordToken(token);
  if (!parsed) return null;
  const tokenSecret = process.env.TOKEN_SECRET;
  if (!tokenSecret) return null;

  const key = `${tokenSecret}--${passwordHash}`;
  const expected = crypto
    .createHmac('sha3-224', key)
    .update(`${parsed.encodedUserId}.${parsed.encodedTimeStamp}`)
    .digest();
  const expectedToken = encode(expected);

  const receivedBuffer = decode(parsed.encodedEncryptedAuth);
  const expectedBuffer = decode(expectedToken);
  if (expectedBuffer.length !== receivedBuffer.length) return null;
  if (!crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) return null;

  return parsed.userId;
};

module.exports = {
  generateSnowflake,
  generateDiscriminator,
  generateDiscordToken,
  parseDiscordToken,
  verifyDiscordToken,
};
