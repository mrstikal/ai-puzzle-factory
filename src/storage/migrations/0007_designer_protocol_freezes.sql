-- P50.2: append-only designer protocol freezes.
-- Freeze rows are immutable evidence; the decision evaluator and report can be
-- regenerated from SQLite even if exported protocol.json files are removed.

CREATE TABLE designer_protocol_freezes (
  freeze_hash TEXT PRIMARY KEY CHECK (length(freeze_hash) = 64),
  protocol_hash TEXT NOT NULL UNIQUE CHECK (length(protocol_hash) = 64),
  pilot_run_id TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  created_at TEXT NOT NULL,
  FOREIGN KEY (pilot_run_id) REFERENCES runs(run_id)
);

CREATE INDEX designer_protocol_freezes_pilot_idx
  ON designer_protocol_freezes (pilot_run_id);

CREATE TRIGGER designer_protocol_freezes_no_update
BEFORE UPDATE ON designer_protocol_freezes
BEGIN
  SELECT RAISE(ABORT, 'designer protocol freezes are append-only');
END;

CREATE TRIGGER designer_protocol_freezes_no_delete
BEFORE DELETE ON designer_protocol_freezes
BEGIN
  SELECT RAISE(ABORT, 'designer protocol freezes are append-only');
END;
