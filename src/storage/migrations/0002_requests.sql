CREATE TABLE logical_calls (
  logical_call_id TEXT PRIMARY KEY,
  run_id TEXT,
  slot_id TEXT,
  probe_key TEXT,
  role TEXT NOT NULL CHECK (
    role IN ('spec', 'wording', 'blind_text', 'blind_vision', 'alignment_text', 'alignment_vision', 'preflight')
  ),
  run_kind TEXT NOT NULL CHECK (run_kind IN ('full', 'smoke', 'calibration', 'preflight')),
  pool TEXT NOT NULL CHECK (pool IN ('primary', 'smoke', 'calibration', 'preflight')),
  state TEXT NOT NULL CHECK (
    state IN ('prepared', 'dispatching', 'response_saved', 'validated', 'refused_unprocessed', 'failed_known', 'uncertain')
  ),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  request_body_json TEXT NOT NULL CHECK (length(request_body_json) <= 2097152),
  expected_schema_hash TEXT NOT NULL CHECK (length(expected_schema_hash) = 64),
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  output_cap_field TEXT CHECK (
    output_cap_field IS NULL OR output_cap_field IN ('max_tokens', 'max_completion_tokens')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (run_kind = 'full' AND pool = 'primary')
    OR (run_kind = 'smoke' AND pool = 'smoke')
    OR (run_kind = 'calibration' AND pool = 'calibration')
    OR (run_kind = 'preflight' AND pool = 'preflight')
  ),
  CHECK (
    (run_kind IN ('full', 'smoke') AND run_id IS NOT NULL AND slot_id IS NOT NULL AND probe_key IS NULL)
    OR (run_kind = 'calibration' AND run_id IS NULL AND slot_id IS NULL AND probe_key IS NOT NULL)
    OR (run_kind = 'preflight' AND run_id IS NULL AND slot_id IS NULL AND probe_key IS NOT NULL)
  ),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id, slot_id) REFERENCES slots(run_id, slot_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX ux_logical_calls_run_slot_role
  ON logical_calls(run_id, slot_id, role)
  WHERE slot_id IS NOT NULL;

CREATE UNIQUE INDEX ux_logical_calls_run_probe_role
  ON logical_calls(run_id, probe_key, role)
  WHERE run_id IS NOT NULL AND slot_id IS NULL;

CREATE UNIQUE INDEX ux_logical_calls_global_probe_role
  ON logical_calls(probe_key, role)
  WHERE run_id IS NULL;

CREATE INDEX idx_logical_calls_run ON logical_calls(run_id, state);
CREATE INDEX idx_logical_calls_pool ON logical_calls(pool, role);

CREATE TABLE request_attempts (
  attempt_id TEXT PRIMARY KEY,
  logical_call_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  state TEXT NOT NULL CHECK (
    state IN ('prepared', 'dispatching', 'response_saved', 'validated', 'refused_unprocessed', 'failed_known', 'uncertain')
  ),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  request_body_json TEXT NOT NULL CHECK (length(request_body_json) <= 2097152),
  expected_schema_hash TEXT NOT NULL CHECK (length(expected_schema_hash) = 64),
  role TEXT NOT NULL CHECK (
    role IN ('spec', 'wording', 'blind_text', 'blind_vision', 'alignment_text', 'alignment_vision', 'preflight')
  ),
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  response_id TEXT,
  generation_id TEXT,
  raw_response_artifact_id INTEGER,
  finish_reason TEXT,
  prompt_tokens INTEGER CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  completion_tokens INTEGER CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  cached_read_tokens INTEGER CHECK (cached_read_tokens IS NULL OR cached_read_tokens >= 0),
  cached_write_tokens INTEGER CHECK (cached_write_tokens IS NULL OR cached_write_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  price_estimate_usd TEXT,
  actual_cost_usd TEXT,
  cost_status TEXT NOT NULL CHECK (cost_status IN ('known', 'unknown')),
  error_classification TEXT,
  partial_completion INTEGER NOT NULL DEFAULT 0 CHECK (partial_completion IN (0, 1)),
  started_at TEXT,
  finished_at TEXT,
  elapsed_ms INTEGER CHECK (elapsed_ms IS NULL OR elapsed_ms >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (logical_call_id, attempt_number),
  FOREIGN KEY (logical_call_id) REFERENCES logical_calls(logical_call_id) ON DELETE RESTRICT,
  FOREIGN KEY (raw_response_artifact_id) REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
  CHECK ((finished_at IS NULL) = (elapsed_ms IS NULL)),
  CHECK ((cost_status = 'known') = (actual_cost_usd IS NOT NULL))
);

CREATE INDEX idx_request_attempts_call ON request_attempts(logical_call_id, attempt_number);
CREATE INDEX idx_request_attempts_state ON request_attempts(state);

CREATE TABLE request_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  logical_call_id TEXT NOT NULL,
  attempt_id TEXT,
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 64),
  from_state TEXT,
  to_state TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (logical_call_id) REFERENCES logical_calls(logical_call_id) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id) REFERENCES request_attempts(attempt_id) ON DELETE RESTRICT
);

CREATE INDEX idx_request_events_call ON request_events(logical_call_id, event_id);

CREATE TABLE budget_accounts (
  account_id TEXT PRIMARY KEY,
  run_id TEXT,
  run_kind TEXT NOT NULL CHECK (run_kind IN ('full', 'smoke', 'calibration', 'preflight')),
  pool TEXT NOT NULL CHECK (pool IN ('primary', 'smoke', 'calibration', 'preflight')),
  max_cost_usd TEXT NOT NULL CHECK (length(max_cost_usd) BETWEEN 1 AND 40),
  known_actual_usd TEXT NOT NULL DEFAULT '0' CHECK (length(known_actual_usd) BETWEEN 1 AND 40),
  reserved_usd TEXT NOT NULL DEFAULT '0' CHECK (length(reserved_usd) BETWEEN 1 AND 40),
  unknown_exposure_usd TEXT NOT NULL DEFAULT '0' CHECK (length(unknown_exposure_usd) BETWEEN 1 AND 40),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (run_kind = 'full' AND pool = 'primary')
    OR (run_kind = 'smoke' AND pool = 'smoke')
    OR (run_kind = 'calibration' AND pool = 'calibration')
    OR (run_kind = 'preflight' AND pool = 'preflight')
  ),
  CHECK (
    (run_kind IN ('full', 'smoke') AND run_id IS NOT NULL)
    OR (run_kind IN ('calibration', 'preflight') AND run_id IS NULL)
  ),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX ux_budget_accounts_run_pool
  ON budget_accounts(run_id, pool)
  WHERE run_id IS NOT NULL;

CREATE UNIQUE INDEX ux_budget_accounts_global_pool
  ON budget_accounts(pool)
  WHERE run_id IS NULL;

CREATE TABLE budget_reservations (
  reservation_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  logical_call_id TEXT,
  attempt_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('attempt', 'unknown', 'nonbilling')),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'unknown', 'settled', 'released')),
  amount_usd TEXT NOT NULL CHECK (length(amount_usd) BETWEEN 1 AND 40),
  actual_cost_usd TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES budget_accounts(account_id) ON DELETE RESTRICT,
  FOREIGN KEY (logical_call_id) REFERENCES logical_calls(logical_call_id) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id) REFERENCES request_attempts(attempt_id) ON DELETE RESTRICT,
  CHECK ((state = 'settled') = (actual_cost_usd IS NOT NULL))
);

CREATE UNIQUE INDEX ux_budget_reservations_attempt
  ON budget_reservations(attempt_id)
  WHERE attempt_id IS NOT NULL;

CREATE INDEX idx_budget_reservations_account ON budget_reservations(account_id, state);
CREATE INDEX idx_budget_reservations_call ON budget_reservations(logical_call_id);

CREATE TABLE budget_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  logical_call_id TEXT,
  attempt_id TEXT,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'account_created',
      'admission',
      'nonbilling_admission',
      'reservation_created',
      'reservation_released',
      'reservation_settled',
      'unknown_exposure',
      'overshoot',
      'pause',
      'cap_change'
    )
  ),
  amount_usd TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES budget_accounts(account_id) ON DELETE RESTRICT,
  FOREIGN KEY (logical_call_id) REFERENCES logical_calls(logical_call_id) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id) REFERENCES request_attempts(attempt_id) ON DELETE RESTRICT
);

CREATE INDEX idx_budget_events_account ON budget_events(account_id, event_id);

CREATE TRIGGER logical_calls_immutable_delete
BEFORE DELETE ON logical_calls
BEGIN
  SELECT RAISE(ABORT, 'logical_calls are immutable');
END;

CREATE TRIGGER request_attempts_immutable_delete
BEFORE DELETE ON request_attempts
BEGIN
  SELECT RAISE(ABORT, 'request_attempts are immutable');
END;

CREATE TRIGGER request_events_immutable_update
BEFORE UPDATE ON request_events
BEGIN
  SELECT RAISE(ABORT, 'request_events are append-only');
END;

CREATE TRIGGER request_events_immutable_delete
BEFORE DELETE ON request_events
BEGIN
  SELECT RAISE(ABORT, 'request_events are append-only');
END;

CREATE TRIGGER budget_accounts_immutable_delete
BEFORE DELETE ON budget_accounts
BEGIN
  SELECT RAISE(ABORT, 'budget_accounts are immutable');
END;

CREATE TRIGGER budget_reservations_immutable_delete
BEFORE DELETE ON budget_reservations
BEGIN
  SELECT RAISE(ABORT, 'budget_reservations are immutable');
END;

CREATE TRIGGER budget_events_immutable_update
BEFORE UPDATE ON budget_events
BEGIN
  SELECT RAISE(ABORT, 'budget_events are append-only');
END;

CREATE TRIGGER budget_events_immutable_delete
BEFORE DELETE ON budget_events
BEGIN
  SELECT RAISE(ABORT, 'budget_events are append-only');
END;
