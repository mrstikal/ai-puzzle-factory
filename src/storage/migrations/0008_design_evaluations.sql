-- P50.3: append-only designer human-evaluation samples and labels.

CREATE TABLE design_evaluation_samples (
  sample_hash TEXT PRIMARY KEY CHECK (length(sample_hash) = 64),
  run_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64),
  payload_json TEXT NOT NULL,
  public_payload_json TEXT NOT NULL,
  private_payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);

CREATE INDEX design_evaluation_samples_run_idx
  ON design_evaluation_samples (run_id);

CREATE TABLE design_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  sample_hash TEXT NOT NULL CHECK (length(sample_hash) = 64),
  unit_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  previous_revision INTEGER,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (sample_hash, unit_key, revision),
  FOREIGN KEY (sample_hash) REFERENCES design_evaluation_samples(sample_hash)
);

CREATE INDEX design_evaluations_sample_unit_idx
  ON design_evaluations (sample_hash, unit_key, revision);

CREATE TRIGGER design_evaluation_samples_no_update
BEFORE UPDATE ON design_evaluation_samples
BEGIN
  SELECT RAISE(ABORT, 'design evaluation samples are append-only');
END;

CREATE TRIGGER design_evaluation_samples_no_delete
BEFORE DELETE ON design_evaluation_samples
BEGIN
  SELECT RAISE(ABORT, 'design evaluation samples are append-only');
END;

CREATE TRIGGER design_evaluations_no_update
BEFORE UPDATE ON design_evaluations
BEGIN
  SELECT RAISE(ABORT, 'design evaluations are append-only');
END;

CREATE TRIGGER design_evaluations_no_delete
BEFORE DELETE ON design_evaluations
BEGIN
  SELECT RAISE(ABORT, 'design evaluations are append-only');
END;
