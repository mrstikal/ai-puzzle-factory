CREATE TABLE protocol_freezes (
  freeze_id INTEGER PRIMARY KEY AUTOINCREMENT,
  freeze_hash TEXT NOT NULL UNIQUE CHECK (length(freeze_hash) = 64),
  protocol_version TEXT NOT NULL,
  root_seed TEXT NOT NULL,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64),
  config_hash TEXT NOT NULL CHECK (length(config_hash) = 64),
  routes_hash TEXT NOT NULL CHECK (length(routes_hash) = 64),
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
  fixture_pack_hash TEXT NOT NULL CHECK (length(fixture_pack_hash) = 64),
  labels_hash TEXT NOT NULL CHECK (length(labels_hash) = 64),
  calibration_id TEXT NOT NULL,
  calibration_completed_at TEXT NOT NULL,
  cost_per_approved_threshold_usd TEXT NOT NULL CHECK (
    cost_per_approved_threshold_usd = '0.10'
  ),
  authorized_cap_usd TEXT NOT NULL,
  forecast_json TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (
    protocol_version,
    plan_hash,
    config_hash,
    fixture_pack_hash,
    calibration_id
  )
);

CREATE INDEX protocol_freezes_frozen_at_idx
  ON protocol_freezes (frozen_at);

CREATE TRIGGER protocol_freezes_no_update
BEFORE UPDATE ON protocol_freezes
BEGIN
  SELECT RAISE(ABORT, 'protocol_freezes is append-only');
END;

CREATE TRIGGER protocol_freezes_no_delete
BEFORE DELETE ON protocol_freezes
BEGIN
  SELECT RAISE(ABORT, 'protocol_freezes is append-only');
END;
