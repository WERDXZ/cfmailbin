ALTER TABLE rules ADD COLUMN name TEXT;
ALTER TABLE rules ADD COLUMN condition_json TEXT;
ALTER TABLE rules ADD COLUMN actions_json TEXT;
ALTER TABLE rules ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rules ADD COLUMN stop_processing INTEGER NOT NULL DEFAULT 1;
ALTER TABLE messages ADD COLUMN rule_trace TEXT;

-- Preserve the effective legacy order for every recipient.
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (
    ORDER BY CASE WHEN alias_id IS NULL THEN 1 ELSE 0 END, created_at, id
  ) * 10 AS position FROM rules
)
UPDATE rules SET priority = (SELECT position FROM ordered WHERE ordered.id = rules.id);

CREATE INDEX idx_rules_priority ON rules(priority, created_at, id);
