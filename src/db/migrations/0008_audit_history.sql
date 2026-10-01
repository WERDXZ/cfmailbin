-- Retain existing history. Event names evolve in application types rather than
-- requiring a table rebuild for every new audit event.
CREATE TABLE audit_events_next (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  alias_address TEXT,
  message_id TEXT,
  sender TEXT,
  subject_preview TEXT,
  status TEXT CHECK (status IS NULL OR status IN ('inbox', 'forwarded', 'trashed', 'blocked')),
  reason TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  correlation_id TEXT,
  actor TEXT
);
INSERT INTO audit_events_next (id, event_type, alias_address, message_id, sender,
  subject_preview, status, reason, metadata_json, created_at)
SELECT id, event_type, alias_address, message_id, sender, subject_preview, status,
  reason, metadata_json, created_at FROM audit_events;
DROP TABLE audit_events;
ALTER TABLE audit_events_next RENAME TO audit_events;
CREATE INDEX idx_audit_events_created_at ON audit_events(created_at DESC, id DESC);
CREATE INDEX idx_audit_events_alias_address ON audit_events(alias_address);
CREATE INDEX idx_audit_events_message_id ON audit_events(message_id, created_at DESC, id DESC);
CREATE INDEX idx_audit_events_type_created ON audit_events(event_type, created_at DESC, id DESC);
CREATE INDEX idx_audit_events_correlation ON audit_events(correlation_id, created_at DESC, id DESC);
