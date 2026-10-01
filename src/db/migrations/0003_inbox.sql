ALTER TABLE messages ADD COLUMN verification_codes TEXT;
ALTER TABLE aliases ADD COLUMN last_received_at TEXT;

UPDATE aliases SET last_received_at = (
  SELECT MAX(received_at) FROM messages WHERE messages.alias_id = aliases.id
);

-- Delivery evidence survives removal of the corresponding email.
UPDATE aliases SET last_received_at = (
  SELECT MAX(created_at) FROM audit_events
  WHERE event_type = 'received' AND alias_address = aliases.address
) WHERE EXISTS (
  SELECT 1 FROM audit_events
  WHERE event_type = 'received' AND alias_address = aliases.address
    AND created_at > COALESCE(aliases.last_received_at, '')
);

CREATE INDEX idx_audit_events_type_created
  ON audit_events(event_type, created_at DESC);
