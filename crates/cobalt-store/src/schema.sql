-- 1. projects
CREATE TABLE projects (
  id          TEXT PRIMARY KEY NOT NULL,
  name        TEXT NOT NULL UNIQUE,
  root_path   TEXT NULL UNIQUE,
  color_hex   TEXT NOT NULL CHECK (length(color_hex) = 7 AND substr(color_hex, 1, 1) = '#'),
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 2. branches
CREATE TABLE branches (
  id               TEXT PRIMARY KEY NOT NULL,
  name             TEXT NOT NULL UNIQUE,
  parent_branch_id TEXT NULL REFERENCES branches(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  is_active        INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1))
);
CREATE UNIQUE INDEX idx_branches_single_active ON branches(is_active) WHERE is_active = 1;
-- Seed: ('00000000-0000-7000-8000-000000000001', 'main', NULL, <now>, 1)

-- 3. source_documents
CREATE TABLE source_documents (
  id           TEXT PRIMARY KEY NOT NULL,
  project_id   TEXT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_path    TEXT NOT NULL UNIQUE,
  is_dir       INTEGER NOT NULL DEFAULT 0 CHECK (is_dir IN (0, 1)),
  source_type  TEXT NOT NULL DEFAULT 'note' CHECK (source_type IN
                ('md','sql','bash','rs','ts','js','py','java','json','yaml','toml',
                 'html','css','dockerfile','pdf','image','note','other')),
  file_hash    TEXT NULL,
  total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  is_watched   INTEGER NOT NULL DEFAULT 0 CHECK (is_watched IN (0, 1)),
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_source_documents_project ON source_documents(project_id);
CREATE INDEX idx_source_documents_type    ON source_documents(source_type);
CREATE INDEX idx_source_documents_watched ON source_documents(is_watched) WHERE is_watched = 1;

-- 4. memories (canonical)
CREATE TABLE memories (
  id               TEXT PRIMARY KEY NOT NULL,
  branch_id        TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  project_id       TEXT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_doc_id    TEXT NULL REFERENCES source_documents(id) ON DELETE SET NULL,
  content          TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  source_type      TEXT NOT NULL DEFAULT 'note' CHECK (source_type IN
                    ('md','sql','bash','rs','ts','js','py','java','json','yaml','toml',
                     'html','css','dockerfile','pdf','image','note','other')),
  category         TEXT NOT NULL CHECK (category IN
                    ('preference','decision','code','doc','note','ocr')),
  confidence       REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','archived')),
  superseded_by    TEXT NULL REFERENCES memories(id) ON DELETE SET NULL,
  version_reason   TEXT NULL,
  is_core_pin      INTEGER NOT NULL DEFAULT 0 CHECK (is_core_pin IN (0, 1)),
  is_reusable      INTEGER NOT NULL DEFAULT 0 CHECK (is_reusable IN (0, 1)),
  reusable_snippet TEXT NULL,
  reuse_count      INTEGER NOT NULL DEFAULT 0 CHECK (reuse_count >= 0),
  is_encrypted     INTEGER NOT NULL DEFAULT 0 CHECK (is_encrypted IN (0, 1)),
  ciphertext       BLOB NULL,
  nonce            BLOB NULL,
  chunk_tokens     INTEGER NOT NULL CHECK (chunk_tokens >= 0),
  hit_count        INTEGER NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
  relevance_score  REAL NOT NULL DEFAULT 1.0,
  pos_x            REAL NULL,
  pos_y            REAL NULL,
  pos_z            REAL NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_accessed_at TEXT NULL,
  source_client    TEXT NULL,
  CHECK (is_encrypted = 0 OR (ciphertext IS NOT NULL AND nonce IS NOT NULL AND content = ''))
);
CREATE INDEX idx_memories_scope       ON memories(branch_id, project_id, status);
CREATE INDEX idx_memories_source_type ON memories(source_type);
CREATE INDEX idx_memories_reusable    ON memories(is_reusable) WHERE is_reusable = 1;
CREATE INDEX idx_memories_core_pin    ON memories(is_core_pin) WHERE is_core_pin = 1;
CREATE INDEX idx_memories_hash        ON memories(content_hash);
CREATE INDEX idx_memories_source_doc  ON memories(source_doc_id);
CREATE INDEX idx_memories_accessed    ON memories(last_accessed_at);

-- 5. memories_fts (external content, BM25)
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, source_type, category,
  content = 'memories', content_rowid = 'rowid',
  tokenize = "unicode61 remove_diacritics 2 tokenchars '_'"
);
CREATE TRIGGER memories_ai AFTER INSERT ON memories WHEN NEW.is_encrypted = 0 BEGIN
  INSERT INTO memories_fts(rowid, content, source_type, category)
  VALUES (NEW.rowid, NEW.content, NEW.source_type, NEW.category);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories WHEN OLD.is_encrypted = 0 BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, source_type, category)
  VALUES ('delete', OLD.rowid, OLD.content, OLD.source_type, OLD.category);
END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories
WHEN OLD.rowid IS NOT NEW.rowid OR OLD.content IS NOT NEW.content
  OR OLD.source_type IS NOT NEW.source_type OR OLD.category IS NOT NEW.category
  OR OLD.is_encrypted IS NOT NEW.is_encrypted
BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, source_type, category)
  SELECT 'delete', OLD.rowid, OLD.content, OLD.source_type, OLD.category WHERE OLD.is_encrypted = 0;
  INSERT INTO memories_fts(rowid, content, source_type, category)
  SELECT NEW.rowid, NEW.content, NEW.source_type, NEW.category WHERE NEW.is_encrypted = 0;
END;
-- RULE: never run plain VACUUM without `INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`
-- right after (VACUUM may renumber implicit rowids). Snapshots use the online backup API.

-- 6. vec_memories (sqlite-vec, created at runtime once the model dimension is known)
-- CREATE VIRTUAL TABLE vec_memories USING vec0(
--   memory_id TEXT PRIMARY KEY, embedding float[<dims>] distance_metric=cosine);
-- Keyed by memories.id (never rowid). Dropped/recreated by the engine swap when dims change.
-- USearch / Qdrant / external engines replace it behind the VectorStore trait; their indexes
-- live in ~/.cobalt/index/<engine>-<model>/ and are always rebuildable from `memories`.

-- 7. memory_edges
CREATE TABLE memory_edges (
  source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL CHECK (edge_type IN ('semantic','supersedes','same_project')),
  weight    REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (source_id, target_id, edge_type),
  CHECK (source_id <> target_id)
);
CREATE INDEX idx_memory_edges_target ON memory_edges(target_id);

-- 8. handoffs
CREATE TABLE handoffs (
  id              TEXT PRIMARY KEY NOT NULL,
  project_id      TEXT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_client   TEXT NOT NULL,
  summary         TEXT NOT NULL,
  last_error      TEXT NULL,
  open_files_json TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  consumed_by     TEXT NULL
);
CREATE INDEX idx_handoffs_project ON handoffs(project_id, expires_at);

-- 9. telemetry_logs
CREATE TABLE telemetry_logs (
  id                  TEXT PRIMARY KEY NOT NULL,
  timestamp           TEXT NOT NULL,
  client_name         TEXT NOT NULL,
  operation           TEXT NOT NULL CHECK (operation IN
                       ('read','write','update','reuse','handoff','blocked_firewall')),
  query_text          TEXT NULL,
  returned_items_json TEXT NULL,
  injected_tokens     INTEGER NOT NULL DEFAULT 0,
  avoided_full_tokens INTEGER NOT NULL DEFAULT 0,
  saved_tokens        INTEGER NOT NULL DEFAULT 0,
  latency_ms          INTEGER NOT NULL DEFAULT 0,
  project_id          TEXT NULL REFERENCES projects(id) ON DELETE SET NULL
);
CREATE INDEX idx_telemetry_time      ON telemetry_logs(timestamp);
CREATE INDEX idx_telemetry_client    ON telemetry_logs(client_name, timestamp);
CREATE INDEX idx_telemetry_operation ON telemetry_logs(operation, timestamp);
CREATE INDEX idx_telemetry_project   ON telemetry_logs(project_id);

-- 10. snapshots
CREATE TABLE snapshots (
  id           TEXT PRIMARY KEY NOT NULL,
  label        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  memory_count INTEGER NOT NULL DEFAULT 0,
  file_path    TEXT NOT NULL UNIQUE
);

-- 11. installed_themes
CREATE TABLE installed_themes (
  id            TEXT PRIMARY KEY NOT NULL,
  name          TEXT NOT NULL,
  author        TEXT NOT NULL,
  version       TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  hardware_tier TEXT NOT NULL CHECK (hardware_tier IN ('eco','balanced','ultra')),
  local_path    TEXT NOT NULL,
  installed_at  TEXT NOT NULL
);

-- 12. app_config (one row per top-level AppSettings field; see config.rs)
CREATE TABLE app_config (
  key        TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
