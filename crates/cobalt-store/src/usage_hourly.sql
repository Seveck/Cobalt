CREATE TABLE usage_hourly (
  hour_utc     TEXT    NOT NULL,
  client_name  TEXT    NOT NULL,
  operation    TEXT    NOT NULL,
  project_id   TEXT    NOT NULL DEFAULT '',
  requests     INTEGER NOT NULL DEFAULT 0 CHECK (requests >= 0),
  saved_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour_utc, client_name, operation, project_id)
);

INSERT INTO usage_hourly (hour_utc, client_name, operation, project_id, requests, saved_tokens)
SELECT substr(timestamp, 1, 13), client_name, operation, coalesce(project_id, ''),
       count(*), sum(saved_tokens)
FROM telemetry_logs
GROUP BY 1, 2, 3, 4;

CREATE INDEX idx_usage_hour_totals ON usage_hourly(hour_utc, requests, saved_tokens);
CREATE INDEX idx_usage_client_operation
  ON usage_hourly(client_name, operation, hour_utc, requests, saved_tokens);
CREATE INDEX idx_usage_project
  ON usage_hourly(project_id, hour_utc, requests) WHERE project_id <> '';
CREATE INDEX idx_memories_created_at ON memories(created_at);

-- Record each successful insert, including restored portable history.
CREATE TRIGGER telemetry_usage_hourly AFTER INSERT ON telemetry_logs
BEGIN
  INSERT INTO usage_hourly (hour_utc, client_name, operation, project_id, requests, saved_tokens)
  VALUES (substr(NEW.timestamp, 1, 13), NEW.client_name, NEW.operation,
          coalesce(NEW.project_id, ''), 1, NEW.saved_tokens)
  ON CONFLICT (hour_utc, client_name, operation, project_id) DO UPDATE SET
    requests = usage_hourly.requests + excluded.requests,
    saved_tokens = usage_hourly.saved_tokens + excluded.saved_tokens;
END;
