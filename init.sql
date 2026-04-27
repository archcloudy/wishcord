-- Create users table
CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS guilds (
  id BIGINT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(300),
  icon TEXT,
  banner TEXT,
  splash TEXT,
  discovery_splash TEXT,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  afk_channel_id BIGINT,
  afk_timeout INTEGER NOT NULL DEFAULT 300,
  verification_level INTEGER NOT NULL DEFAULT 0,
  default_message_notifications INTEGER NOT NULL DEFAULT 0,
  explicit_content_filter INTEGER NOT NULL DEFAULT 0,
  preferred_locale VARCHAR(16) NOT NULL DEFAULT 'en-US',
  features JSONB NOT NULL DEFAULT '[]'::jsonb,
  system_channel_id BIGINT,
  system_channel_flags INTEGER NOT NULL DEFAULT 0,
  rules_channel_id BIGINT,
  public_updates_channel_id BIGINT,
  safety_alerts_channel_id BIGINT,
  mfa_level INTEGER NOT NULL DEFAULT 0,
  nsfw_level INTEGER NOT NULL DEFAULT 0,
  premium_tier INTEGER NOT NULL DEFAULT 0,
  premium_subscription_count INTEGER NOT NULL DEFAULT 0,
  vanity_url_code VARCHAR(32),
  premium_progress_bar_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  widget_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  widget_channel_id BIGINT,
  max_members INTEGER NOT NULL DEFAULT 500000,
  max_presences INTEGER,
  max_video_channel_users INTEGER NOT NULL DEFAULT 25,
  max_stage_video_channel_users INTEGER NOT NULL DEFAULT 50,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS guild_roles (
  id BIGINT PRIMARY KEY,
  guild_id BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(90),
  color INTEGER NOT NULL DEFAULT 0,
  colors JSONB NOT NULL DEFAULT '{"primary_color":0,"secondary_color":null,"tertiary_color":null}'::jsonb,
  hoist BOOLEAN NOT NULL DEFAULT FALSE,
  icon TEXT,
  unicode_emoji TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  permissions TEXT NOT NULL DEFAULT '0',
  managed BOOLEAN NOT NULL DEFAULT FALSE,
  mentionable BOOLEAN NOT NULL DEFAULT FALSE,
  flags INTEGER NOT NULL DEFAULT 0,
  tags JSONB,
  UNIQUE (guild_id, position, id)
);

CREATE TABLE IF NOT EXISTS guild_members (
  guild_id BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nick VARCHAR(32),
  avatar TEXT,
  banner TEXT,
  bio VARCHAR(190),
  role_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  premium_since TIMESTAMP,
  deaf BOOLEAN NOT NULL DEFAULT FALSE,
  mute BOOLEAN NOT NULL DEFAULT FALSE,
  pending BOOLEAN NOT NULL DEFAULT FALSE,
  communication_disabled_until TIMESTAMP,
  unusual_dm_activity_until TIMESTAMP,
  flags INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS guild_channels (
  id BIGINT PRIMARY KEY,
  guild_id BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  parent_id BIGINT,
  name VARCHAR(100) NOT NULL,
  type INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  topic TEXT,
  nsfw BOOLEAN NOT NULL DEFAULT FALSE,
  bitrate INTEGER,
  user_limit INTEGER,
  rate_limit_per_user INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE guild_channels ADD COLUMN IF NOT EXISTS last_message_id BIGINT;

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT PRIMARY KEY,
  channel_id BIGINT NOT NULL REFERENCES guild_channels(id) ON DELETE CASCADE,
  author_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  nonce TEXT,
  tts BOOLEAN NOT NULL DEFAULT FALSE,
  mention_everyone BOOLEAN NOT NULL DEFAULT FALSE,
  mentions JSONB NOT NULL DEFAULT '[]'::jsonb,
  mention_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
  mention_channels JSONB NOT NULL DEFAULT '[]'::jsonb,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  embeds JSONB NOT NULL DEFAULT '[]'::jsonb,
  reactions JSONB NOT NULL DEFAULT '[]'::jsonb,
  components JSONB NOT NULL DEFAULT '[]'::jsonb,
  sticker_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  type INTEGER NOT NULL DEFAULT 0,
  flags INTEGER NOT NULL DEFAULT 0,
  activity JSONB,
  application JSONB,
  application_id BIGINT,
  poll JSONB,
  message_reference JSONB,
  referenced_message_id BIGINT,
  interaction_metadata JSONB,
  thread JSONB,
  call JSONB,
  soundboard_sounds JSONB NOT NULL DEFAULT '[]'::jsonb,
  edited_timestamp TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_settings_proto (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proto_type SMALLINT NOT NULL,
  settings_base64 TEXT NOT NULL DEFAULT '',
  data_version INTEGER NOT NULL DEFAULT 0,
  client_version INTEGER NOT NULL DEFAULT 0,
  server_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, proto_type)
);

CREATE TABLE IF NOT EXISTS invites (
  code VARCHAR(16) PRIMARY KEY,
  guild_id BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id BIGINT NOT NULL REFERENCES guild_channels(id) ON DELETE CASCADE,
  inviter_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type INTEGER NOT NULL DEFAULT 0,
  flags INTEGER NOT NULL DEFAULT 0,
  max_age INTEGER NOT NULL DEFAULT 86400,
  max_uses INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0,
  temporary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channel_permission_overwrites (
  channel_id BIGINT NOT NULL REFERENCES guild_channels(id) ON DELETE CASCADE,
  target_id BIGINT NOT NULL,
  type INTEGER NOT NULL,
  allow TEXT NOT NULL DEFAULT '0',
  deny TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (channel_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_guild_members_user_id ON guild_members(user_id);
CREATE INDEX IF NOT EXISTS idx_guild_roles_guild_id ON guild_roles(guild_id);
CREATE INDEX IF NOT EXISTS idx_guild_channels_guild_id ON guild_channels(guild_id);
CREATE INDEX IF NOT EXISTS idx_messages_channel_id_created_at ON messages(channel_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_invites_guild_id ON invites(guild_id);
CREATE INDEX IF NOT EXISTS idx_invites_channel_id ON invites(channel_id);
CREATE INDEX IF NOT EXISTS idx_user_settings_proto_user_id ON user_settings_proto(user_id);