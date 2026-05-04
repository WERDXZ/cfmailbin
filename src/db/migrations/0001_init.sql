PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS aliases (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  description TEXT,
  default_action TEXT NOT NULL CHECK (
    default_action IN ('keep', 'forward', 'trash', 'block')
  ),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  forward_to TEXT,
  retention_days INTEGER NOT NULL CHECK (retention_days > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  alias_id TEXT REFERENCES aliases(id) ON DELETE CASCADE,
  field TEXT NOT NULL CHECK (field IN ('alias', 'from', 'subject')),
  pattern TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('keep', 'forward', 'trash', 'block')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  alias_id TEXT NOT NULL REFERENCES aliases(id) ON DELETE CASCADE,
  alias_address TEXT NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL,
  preview TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('inbox', 'forwarded', 'trashed', 'blocked')
  ),
  received_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  raw_key TEXT,
  forwarded_to TEXT,
  matched_rule_id TEXT REFERENCES rules(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_tags (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, tag_id)
);

CREATE TABLE IF NOT EXISTS alias_tags (
  alias_id TEXT NOT NULL REFERENCES aliases(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (alias_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_aliases_address ON aliases(address);
CREATE INDEX IF NOT EXISTS idx_alias_tags_alias_id ON alias_tags(alias_id);
CREATE INDEX IF NOT EXISTS idx_rules_alias_id ON rules(alias_id);
CREATE INDEX IF NOT EXISTS idx_messages_alias_id ON messages(alias_id);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_received_at ON messages(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON messages(expires_at);
