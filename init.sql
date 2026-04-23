-- Create users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(32) UNIQUE NOT NULL,
  discriminator VARCHAR(4) DEFAULT '0000',
  global_name VARCHAR(32),
  avatar TEXT,
  bio TEXT,
  email VARCHAR(255) UNIQUE,
  password_hash TEXT NOT NULL,
  verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add more fields as needed based on the user object