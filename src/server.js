const express = require('express');
const { Pool } = require('pg');
require('dotenv').config();
const userRoutes = require('./routes/users');
const authRoutes = require('./routes/auth');
const WebSocket = require('ws');

const app = express();
const port = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Middleware
app.use(express.json());

// Routes
app.use('/api/v9/users', userRoutes);
app.use('/api/v9/auth', authRoutes);

const startServer = async () => {
  try {
    await pool.query('SELECT 1');
    console.log('Database connection successful');
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

// Gateway URL
app.get('/api/v9/gateway', (req, res) => {
  res.json({ url: 'ws://localhost:8080' });
});

// Basic route
app.get('/', (req, res) => {
  res.send('Discord API Reimplementation');
});

// WebSocket Gateway
const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', (ws) => {
  console.log('New WebSocket connection');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received:', data);

      if (data.op === 2) { // Identify
        // Send Ready event
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
              global_name: 'Test User'
            },
            guilds: [],
            session_id: 'session123'
          }
        };
        ws.send(JSON.stringify(readyEvent));
      } else if (data.op === 1) { // Heartbeat
        // Respond with Heartbeat ACK
        ws.send(JSON.stringify({ op: 11 }));
      }
    } catch (error) {
      console.error('Error parsing message:', error);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
  });
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`WebSocket Gateway on port 8080`);
});

module.exports = app;