# Discord API Reimplementation

A reimplementation of the Discord API using Node.js, Express, and PostgreSQL, based on the unofficial Discord User API Documentation from https://docs.discord.food.

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Set up PostgreSQL database:
   - Create a database named `discord_db`
   - Run the SQL in `init.sql` to create tables
   - Update `.env` with your DATABASE_URL and JWT_SECRET

3. Run the server:
   ```
   npm start
   ```

   For development:
   ```
   npm run dev
   ```

## API Endpoints

### Authentication
- POST /api/v9/auth/register - Register a new user
- POST /api/v9/auth/login - Login and get JWT token
- POST /api/v9/auth/logout - Logout

### Users
- GET /api/v9/users/@me - Get current user (requires auth)
- PATCH /api/v9/users/@me - Modify current user (requires auth)
- GET /api/v9/users/:id - Get user by ID

### Gateway
- GET /api/v9/gateway - Get WebSocket gateway URL
- WebSocket on port 8080 for real-time events

## Features

- User registration and authentication with JWT
- Basic user management
- WebSocket Gateway for real-time communication (basic heartbeat and ready events)
- PostgreSQL database

This is a basic reimplementation. More endpoints and events can be added based on the API docs.

## API Endpoints

Refer to https://docs.discord.food for the API reference.