const WebSocket = require('ws');
const zlib = require('zlib');
const crypto = require('crypto');
const { SimpleZSTD, decompressBuffer } = require('simple-zstd');

const CLOSE_DECODE_ERROR = 1007;
const CLOSE_POLICY_VIOLATION = 1008;

const createZlibSession = () => {
  const stream = zlib.createDeflateRaw({
    flush: zlib.constants.Z_SYNC_FLUSH,
    finishFlush: zlib.constants.Z_SYNC_FLUSH,
  });
  stream.on('error', (err) => console.error('Zlib session error:', err));
  return stream;
};

const ensureZstdSession = (ws) => {
  if (!ws._zstdSession) {
    ws._zstdSession = SimpleZSTD.create();
  }
  return ws._zstdSession;
};

const closeWithCode = (conn, code, reason) => {
  if (!conn || conn.readyState !== WebSocket.OPEN) {
    return;
  }
  conn.close(code, reason);
};

const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');

const getOptionalParam = (req, key) => {
  const url = new URL(req.url || '', 'http://localhost');
  return url.searchParams.get(key) || null;
};

const createAcceptConfig = (req) => {
  const accepted = {
    version: 10,
    encoding: 'json',
    compress: null,
  };

  const versionParam = getOptionalParam(req, 'v');
  if (versionParam !== null) {
    const version = Number.parseInt(versionParam, 10);
    if (Number.isNaN(version)) return null;
    accepted.version = version;
  }

  if (accepted.version < 6 || accepted.version > 10) {
    return null;
  }

  const encoding = getOptionalParam(req, 'encoding');
  if (encoding !== null) {
    accepted.encoding = encoding;
  }
  if (accepted.encoding !== 'json') {
    return null;
  }

  const compress = getOptionalParam(req, 'compress');
  if (compress !== null) {
    if (compress !== 'zlib-stream' && compress !== 'zstd-stream') {
      return null;
    }
    accepted.compress = compress;
  }

  return accepted;
};

const compressZlibStream = (ws, payload) =>
  new Promise((resolve, reject) => {
    if (!ws._zlibSession) {
      ws._zlibSession = createZlibSession();
    }

    const stream = ws._zlibSession;
    const chunks = [];
    const onData = (chunk) => chunks.push(chunk);
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      stream.removeListener('data', onData);
      stream.removeListener('error', onError);
    };

    stream.on('data', onData);
    stream.on('error', onError);

    stream.write(Buffer.from(payload), (err) => {
      if (err) return onError(err);
      stream.flush(zlib.constants.Z_SYNC_FLUSH, (flushErr) => {
        cleanup();
        if (flushErr) return reject(flushErr);
        resolve(Buffer.concat(chunks));
      });
    });
  });

const compressZstdStream = async (ws, payload) => {
  const session = await ensureZstdSession(ws);
  return session.compressBuffer(Buffer.from(payload));
};

const encodeGatewayPayload = async (payload, compression, ws) => {
  const json = JSON.stringify(payload);
  if (!compression) return json;
  if (compression === 'zlib-stream') {
    return compressZlibStream(ws, json);
  }
  if (compression === 'zstd-stream') {
    return compressZstdStream(ws, json);
  }
  return json;
};

const decodeGatewayPayload = async (message) => {
  if (typeof message === 'string') {
    return JSON.parse(message);
  }

  const data = Buffer.isBuffer(message) ? message : Buffer.from(message);
  try {
    return JSON.parse(data.toString('utf8'));
  } catch (parseErr) {
    try {
      const inflated = zlib.inflateRawSync(data);
      return JSON.parse(inflated.toString('utf8'));
    } catch (zlibErr) {
      const decompressed = await decompressBuffer(data);
      return JSON.parse(decompressed.toString('utf8'));
    }
  }
};

const sendGateway = async (ws, payload) => {
  const encoded = await encodeGatewayPayload(payload, ws._compression, ws);
  ws.send(encoded, { binary: Buffer.isBuffer(encoded) });
};

const cleanupTransport = async (ws) => {
  if (ws._zlibSession) {
    try {
      ws._zlibSession.close();
    } catch (err) {
      console.error('Error closing zlib session:', err);
    }
    ws._zlibSession = null;
  }
  if (ws._zstdSession) {
    try {
      const session = await ws._zstdSession;
      await session.destroy();
    } catch (err) {
      console.error('Error destroying zstd session:', err);
    }
    ws._zstdSession = null;
  }
};

const createGatewayServer = (port = 8080) => {
  const wss = new WebSocket.Server({ port });
  console.log(`Gateway WebSocket listening on port ${port}`);

  wss.on('connection', (ws, req) => {
    const acceptConfig = createAcceptConfig(req);
    if (!acceptConfig) {
      closeWithCode(ws, CLOSE_POLICY_VIOLATION, 'invalid gateway parameters');
      return;
    }

    ws._session = {
      session_id: randomHex(16),
      version: acceptConfig.version,
      encoding: acceptConfig.encoding,
      compress: acceptConfig.compress,
      identified: false,
      last_heartbeat: Date.now(),
    };

    ws._compression = acceptConfig.compress;

    sendGateway(ws, {
      op: 10,
      d: {
        heartbeat_interval: 45000,
        _trace: ['verycord-js-gateway'],
      },
    }).catch((err) => console.error('Gateway send error:', err));

    ws.on('message', async (message, isBinary) => {
      if (isBinary) {
        closeWithCode(ws, CLOSE_DECODE_ERROR, 'binary payloads not supported');
        return;
      }

      if (typeof message !== 'string' && Buffer.byteLength(message) > 15 * 1024) {
        closeWithCode(ws, CLOSE_DECODE_ERROR, 'payload too large');
        return;
      }

      try {
        const data = await decodeGatewayPayload(message);
        console.log('Received:', data);

        if (data.op === 2) {
          const readyEvent = {
            op: 0,
            t: 'READY',
            s: 1,
            d: {
              v: 9,
              user: {
                id: '123456789',
                username: 'testuser',
                discriminator: '0000',
                global_name: 'Test User',
              },
              guilds: [],
              session_id: ws._session.session_id,
              resume_gateway_url: `ws://localhost:${port}/?v=${ws._session.version}&encoding=${ws._session.encoding}${ws._compression ? `&compress=${ws._compression}` : ''}`,
            },
          };
          await sendGateway(ws, readyEvent);
        } else if (data.op === 1) {
          await sendGateway(ws, { op: 11 });
        }
      } catch (error) {
        console.error('Error parsing message:', error);
        closeWithCode(ws, CLOSE_DECODE_ERROR, 'decode error');
      }
    });

    ws.on('close', async () => {
      await cleanupTransport(ws);
      console.log('WebSocket connection closed');
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });
};

module.exports = { createGatewayServer };
