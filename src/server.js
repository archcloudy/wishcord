const express = require('express');
const { Pool } = require('pg');
require('dotenv').config();
const userRoutes = require('./routes/users');
const authRoutes = require('./routes/auth');
const uniqueUsernameRoutes = require('./routes/uniqueUsernames');
const { createGatewayServer } = require('./gateway');

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
app.use('/api/v9', uniqueUsernameRoutes);

const startServer = async () => {
  try {
    await pool.query('SELECT 1');
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

// Gateway URL
app.get('/api/v9/gateway', (req, res) => {
  res.json({ url: 'ws://localhost:8080' });
});

module.exports = app;