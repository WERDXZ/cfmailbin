-- Early installations recorded 0001 before alias_tags was added to that file.
-- An additional migration repairs those installations without changing data.
CREATE TABLE IF NOT EXISTS alias_tags (
  alias_id TEXT NOT NULL REFERENCES aliases(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (alias_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_alias_tags_alias_id ON alias_tags(alias_id);
