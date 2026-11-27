-- Decisions / fixes / preferences noticed in AI sessions, waiting for the user's review.
CREATE TABLE memory_proposals (
  id           TEXT PRIMARY KEY NOT NULL,
  project_id   TEXT NULL REFERENCES projects(id) ON DELETE CASCADE,
  client_name  TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('decision','fix','preference')),
  content      TEXT NOT NULL,          -- scrubbed, ≤ 320 chars
  content_key  TEXT NOT NULL,          -- normalized (lowercase, collapsed spaces) for de-dup
  evidence     TEXT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  memory_id    TEXT NULL REFERENCES memories(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  reviewed_at  TEXT NULL,
  UNIQUE (content_key, project_id)
);
CREATE INDEX idx_memory_proposals_status ON memory_proposals(status, created_at);

-- NULL project IDs are distinct under the table's UNIQUE constraint.
CREATE UNIQUE INDEX idx_memory_proposals_global_key
  ON memory_proposals(content_key) WHERE project_id IS NULL;
