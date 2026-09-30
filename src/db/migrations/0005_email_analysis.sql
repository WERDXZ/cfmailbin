ALTER TABLE messages ADD COLUMN analysis_json TEXT;

CREATE TABLE ai_daily_usage (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL CHECK (calls >= 0)
);
