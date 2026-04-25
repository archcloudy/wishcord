const express = require('express');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();
const userRoutes = require('./routes/users');
const authRoutes = require('./routes/auth');
const uniqueUsernameRoutes = require('./routes/uniqueUsernames');
const guildRoutes = require('./routes/guilds');
const channelRoutes = require('./routes/channels');
const inviteRoutes = require('./routes/invites');
const { createGatewayServer, buildGatewayUrl } = require('./gateway');

const app = express();
const port = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const initSqlPath = path.join(__dirname, '..', 'init.sql');

const ensureSchema = async () => {
  const initSql = fs.readFileSync(initSqlPath, 'utf8');
  await pool.query(initSql);
};

const logDatabaseDiagnostics = async () => {
  const dbInfo = await pool.query(
    `
      SELECT current_database() AS database,
             current_schema() AS schema,
             inet_server_addr()::text AS server_addr,
             inet_server_port() AS server_port
    `,
  );
  const users = await pool.query('SELECT id::text AS id, username, email FROM users ORDER BY created_at DESC LIMIT 50');

  console.log('Database diagnostics:', dbInfo.rows[0]);
  console.log('Known users:', users.rows);
};

// Middleware
app.use(express.json());

// Routes
app.use('/api/v9/users', userRoutes);
app.use('/api/v9/auth', authRoutes);
app.use('/api/v9', uniqueUsernameRoutes);
app.use('/api/v9', guildRoutes);
app.use('/api/v9', channelRoutes);
app.use('/api/v9', inviteRoutes);

const getGatewayBaseUrl = (req) => {
  const gatewayPort = process.env.GATEWAY_PORT || 8080;
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol = forwardedProto === 'https' ? 'wss' : 'ws';
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const host = hostHeader.includes(':') ? hostHeader.split(':')[0] : hostHeader;

  return buildGatewayUrl({
    protocol,
    host,
    port: gatewayPort,
    version: 9,
    encoding: 'json',
  });
};

const startServer = async () => {
  try {
    await ensureSchema();
    await pool.query('SELECT 1');
    await logDatabaseDiagnostics();
    console.log('Database connection successful');
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
      createGatewayServer(process.env.GATEWAY_PORT || 8080);
    });
  } catch (err) {
    console.error('Database connection failed:', err);
    process.exit(1);
  }
};

// Global error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: 'Unknown Error', code: 50000 });
});

startServer();

app.get('/api/v9/gateway', (req, res) => {
  res.json({ url: getGatewayBaseUrl(req) });
});

app.get('/api/v9/gateway/bot', (req, res) => {
  res.json({
    url: getGatewayBaseUrl(req),
    shards: 1,
    session_start_limit: {
      total: 1000,
      remaining: 1000,
      reset_after: 0,
      max_concurrency: 1,
    },
  });
});

module.exports = app;