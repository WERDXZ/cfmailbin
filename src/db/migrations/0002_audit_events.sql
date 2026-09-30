CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'received',
      'auto_alias_created',
      'rejected_unknown',
      'rejected_disabled',
      'blocked_by_rule',
      'forwarded',
      'expired_deleted',
      'manual_deleted'
    )
  ),
  alias_address TEXT,
  message_id TEXT,
  sender TEXT,
  subject_preview TEXT,
  status TEXT CHECK (
    status IS NULL OR status IN ('inbox', 'forwarded', 'trashed', 'blocked')
  ),
  reason TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_created_at
  ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_alias_address
  ON audit_events(alias_address);
CREATE INDEX IF NOT EXISTS idx_audit_events_message_id
  ON audit_events(message_id);
