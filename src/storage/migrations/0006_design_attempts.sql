-- P47: preserve legacy rows and extend shared schema for the designer protocol.
-- The migrator disables foreign keys and legacy-alter rewrites for this file,
-- runs foreign_key_check before commit, then restores both pragmas.

CREATE TABLE runs_new (
  run_id TEXT PRIMARY KEY,
  protocol_version TEXT NOT NULL,
  run_kind TEXT NOT NULL CHECK (
    run_kind IN ('full', 'smoke', 'design_primary', 'design_pilot', 'design_mock')
  ),
  root_seed TEXT NOT NULL,
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('mock', 'live')),
  manifest_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
  control_state TEXT NOT NULL CHECK (
    control_state IN ('running', 'paused_budget', 'paused_operator', 'interrupted', 'completed', 'failed')
  ),
  created_at TEXT NOT NULL
);

INSERT INTO runs_new (
  run_id, protocol_version, run_kind, root_seed, evidence_kind,
  manifest_json, manifest_hash, control_state, created_at
)
SELECT
  run_id, protocol_version, run_kind, root_seed, evidence_kind,
  manifest_json, manifest_hash, control_state, created_at
FROM runs;

DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;

CREATE TABLE slots_new (
  run_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  slot_ordinal INTEGER NOT NULL CHECK (slot_ordinal BETWEEN 1 AND 300),
  family TEXT NOT NULL CHECK (
    family IN ('ranking', 'matching', 'scheduling', 'truth', 'arithmetic', 'matrix', 'transforms', 'paths', 'symmetry', 'counting')
  ),
  modality TEXT NOT NULL CHECK (modality IN ('text', 'svg')),
  slot_kind TEXT NOT NULL DEFAULT 'legacy' CHECK (slot_kind IN ('legacy', 'designer')),
  assignment_id TEXT,
  arm TEXT CHECK (arm IS NULL OR arm IN ('baseline', 'ai_one_shot', 'ai_feedback')),
  lane TEXT CHECK (lane IS NULL OR lane IN ('spec_first', 'ai_spec')),
  difficulty INTEGER NOT NULL CHECK (difficulty IN (1, 2, 3)),
  stage TEXT NOT NULL CHECK (
    stage IN (
      'planned', 'spec_ready', 'formal_checked', 'presentation_ready',
      'duplicate_checked', 'blind_reviewed', 'alignment_reviewed',
      'design_proposed', 'terminal'
    )
  ),
  verdict TEXT CHECK (
    verdict IS NULL OR verdict IN ('approved', 'accepted', 'rejected', 'inconclusive', 'generation_error')
  ),
  checkpoint_version INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, slot_id),
  UNIQUE (run_id, slot_ordinal),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
  CHECK ((stage = 'terminal') = (verdict IS NOT NULL)),
  CHECK (
    (slot_kind = 'legacy'
      AND slot_ordinal BETWEEN 1 AND 200
      AND lane IS NOT NULL
      AND assignment_id IS NULL
      AND arm IS NULL
      AND stage IN (
        'planned', 'spec_ready', 'formal_checked', 'presentation_ready',
        'duplicate_checked', 'blind_reviewed', 'alignment_reviewed', 'terminal'
      )
      AND (verdict IS NULL OR verdict IN ('approved', 'rejected', 'inconclusive', 'generation_error')))
    OR
    (slot_kind = 'designer'
      AND slot_ordinal BETWEEN 1 AND 300
      AND lane IS NULL
      AND assignment_id IS NOT NULL
      AND arm IN ('baseline', 'ai_one_shot', 'ai_feedback')
      AND slot_id = assignment_id || '-' || arm
      AND stage IN ('planned', 'design_proposed', 'formal_checked', 'presentation_ready', 'terminal')
      AND (verdict IS NULL OR verdict IN ('accepted', 'rejected', 'inconclusive', 'generation_error')))
  )
);

INSERT INTO slots_new (
  run_id, slot_id, slot_ordinal, family, modality, slot_kind,
  assignment_id, arm, lane, difficulty, stage, verdict,
  checkpoint_version, created_at, updated_at
)
SELECT
  run_id, slot_id, slot_ordinal, family, modality, 'legacy',
  NULL, NULL, lane, difficulty, stage, verdict,
  checkpoint_version, created_at, updated_at
FROM slots;

DROP TABLE slots;
ALTER TABLE slots_new RENAME TO slots;

CREATE INDEX idx_slots_run_stage ON slots(run_id, stage);
CREATE INDEX idx_slots_run_kind ON slots(run_id, slot_kind);

CREATE TABLE stage_results_new (
  run_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (
    stage IN (
      'planned', 'spec_ready', 'formal_checked', 'presentation_ready',
      'duplicate_checked', 'blind_reviewed', 'alignment_reviewed',
      'design_proposed', 'terminal'
    )
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  elapsed_ms INTEGER CHECK (elapsed_ms IS NULL OR elapsed_ms >= 0),
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, slot_id, stage, version),
  FOREIGN KEY (run_id, slot_id) REFERENCES slots(run_id, slot_id) ON DELETE CASCADE,
  CHECK ((finished_at IS NULL) = (elapsed_ms IS NULL))
);

INSERT INTO stage_results_new (
  run_id, slot_id, stage, version, started_at, finished_at, elapsed_ms,
  payload_json, payload_hash, created_at
)
SELECT
  run_id, slot_id, stage, version, started_at, finished_at, elapsed_ms,
  payload_json, payload_hash, created_at
FROM stage_results;

DROP TABLE stage_results;
ALTER TABLE stage_results_new RENAME TO stage_results;

CREATE INDEX idx_stage_results_run_slot ON stage_results(run_id, slot_id);

CREATE TRIGGER stage_results_immutable_update
BEFORE UPDATE ON stage_results
BEGIN
  SELECT RAISE(ABORT, 'stage_results are immutable');
END;

CREATE TRIGGER stage_results_immutable_delete
BEFORE DELETE ON stage_results
BEGIN
  SELECT RAISE(ABORT, 'stage_results are immutable');
END;

CREATE TABLE logical_calls_new (
  logical_call_id TEXT PRIMARY KEY,
  run_id TEXT,
  slot_id TEXT,
  probe_key TEXT,
  role TEXT NOT NULL CHECK (
    role IN (
      'spec', 'wording', 'blind_text', 'blind_vision', 'alignment_text',
      'alignment_vision', 'preflight', 'design', 'design_repair_1', 'design_repair_2'
    )
  ),
  run_kind TEXT NOT NULL CHECK (
    run_kind IN (
      'full', 'smoke', 'calibration', 'preflight',
      'design_primary', 'design_pilot', 'design_mock'
    )
  ),
  pool TEXT NOT NULL CHECK (
    pool IN ('primary', 'smoke', 'calibration', 'preflight', 'pilot', 'mock')
  ),
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
  retry_not_before TEXT,
  routing_policy TEXT NOT NULL DEFAULT 'balanced',
  CHECK (
    (run_kind = 'full' AND pool = 'primary')
    OR (run_kind = 'smoke' AND pool = 'smoke')
    OR (run_kind = 'calibration' AND pool = 'calibration')
    OR (run_kind = 'preflight' AND pool = 'preflight')
    OR (run_kind = 'design_primary' AND pool = 'primary')
    OR (run_kind = 'design_pilot' AND pool IN ('pilot', 'preflight'))
    OR (run_kind = 'design_mock' AND pool = 'mock')
  ),
  CHECK (
    (run_kind IN ('full', 'smoke') AND run_id IS NOT NULL AND slot_id IS NOT NULL AND probe_key IS NULL)
    OR (run_kind = 'calibration' AND run_id IS NULL AND slot_id IS NULL AND probe_key IS NOT NULL)
    OR (run_kind = 'preflight' AND run_id IS NULL AND slot_id IS NULL AND probe_key IS NOT NULL)
    OR (
      run_kind IN ('design_primary', 'design_mock')
      AND run_id IS NOT NULL AND slot_id IS NOT NULL AND probe_key IS NULL
      AND role IN ('design', 'design_repair_1', 'design_repair_2')
    )
    OR (
      run_kind = 'design_pilot' AND run_id IS NOT NULL
      AND (
        (slot_id IS NOT NULL AND probe_key IS NULL AND role IN ('design', 'design_repair_1', 'design_repair_2'))
        OR (slot_id IS NULL AND probe_key IS NOT NULL AND role = 'preflight')
      )
    )
  ),
  CHECK (
    run_kind <> 'design_pilot'
    OR (role = 'preflight' AND pool = 'preflight')
    OR (role IN ('design', 'design_repair_1', 'design_repair_2') AND pool = 'pilot')
  ),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id, slot_id) REFERENCES slots(run_id, slot_id) ON DELETE RESTRICT
);

INSERT INTO logical_calls_new (
  logical_call_id, run_id, slot_id, probe_key, role, run_kind, pool, state,
  request_hash, request_body_json, expected_schema_hash, model, provider,
  output_cap_field, created_at, updated_at, retry_not_before, routing_policy
)
SELECT
  logical_call_id, run_id, slot_id, probe_key, role, run_kind, pool, state,
  request_hash, request_body_json, expected_schema_hash, model, provider,
  output_cap_field, created_at, updated_at, retry_not_before, routing_policy
FROM logical_calls;

DROP TABLE logical_calls;
ALTER TABLE logical_calls_new RENAME TO logical_calls;

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

CREATE TRIGGER logical_calls_immutable_delete
BEFORE DELETE ON logical_calls
BEGIN
  SELECT RAISE(ABORT, 'logical_calls are immutable');
END;

CREATE TABLE request_attempts_new (
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
    role IN (
      'spec', 'wording', 'blind_text', 'blind_vision', 'alignment_text',
      'alignment_vision', 'preflight', 'design', 'design_repair_1', 'design_repair_2'
    )
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
  routing_policy TEXT NOT NULL DEFAULT 'balanced',
  observed_model TEXT,
  observed_provider TEXT,
  UNIQUE (logical_call_id, attempt_number),
  FOREIGN KEY (logical_call_id) REFERENCES logical_calls(logical_call_id) ON DELETE RESTRICT,
  FOREIGN KEY (raw_response_artifact_id) REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
  CHECK ((finished_at IS NULL) = (elapsed_ms IS NULL)),
  CHECK ((cost_status = 'known') = (actual_cost_usd IS NOT NULL))
);

INSERT INTO request_attempts_new (
  attempt_id, logical_call_id, attempt_number, state, request_hash,
  request_body_json, expected_schema_hash, role, model, provider, http_status,
  response_id, generation_id, raw_response_artifact_id, finish_reason,
  prompt_tokens, completion_tokens, total_tokens, cached_read_tokens,
  cached_write_tokens, reasoning_tokens, price_estimate_usd, actual_cost_usd,
  cost_status, error_classification, partial_completion, started_at, finished_at,
  elapsed_ms, created_at, updated_at, routing_policy, observed_model, observed_provider
)
SELECT
  attempt_id, logical_call_id, attempt_number, state, request_hash,
  request_body_json, expected_schema_hash, role, model, provider, http_status,
  response_id, generation_id, raw_response_artifact_id, finish_reason,
  prompt_tokens, completion_tokens, total_tokens, cached_read_tokens,
  cached_write_tokens, reasoning_tokens, price_estimate_usd, actual_cost_usd,
  cost_status, error_classification, partial_completion, started_at, finished_at,
  elapsed_ms, created_at, updated_at, routing_policy, observed_model, observed_provider
FROM request_attempts;

DROP TABLE request_attempts;
ALTER TABLE request_attempts_new RENAME TO request_attempts;

CREATE INDEX idx_request_attempts_call ON request_attempts(logical_call_id, attempt_number);
CREATE INDEX idx_request_attempts_state ON request_attempts(state);

CREATE TRIGGER request_attempts_immutable_delete
BEFORE DELETE ON request_attempts
BEGIN
  SELECT RAISE(ABORT, 'request_attempts are immutable');
END;

CREATE TABLE budget_accounts_new (
  account_id TEXT PRIMARY KEY,
  run_id TEXT,
  run_kind TEXT NOT NULL CHECK (
    run_kind IN (
      'full', 'smoke', 'calibration', 'preflight',
      'design_primary', 'design_pilot', 'design_mock'
    )
  ),
  pool TEXT NOT NULL CHECK (
    pool IN ('primary', 'smoke', 'calibration', 'preflight', 'pilot', 'mock')
  ),
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
    OR (run_kind = 'design_primary' AND pool = 'primary')
    OR (run_kind = 'design_pilot' AND pool IN ('pilot', 'preflight'))
    OR (run_kind = 'design_mock' AND pool = 'mock')
  ),
  CHECK (
    (run_kind IN ('full', 'smoke', 'design_primary', 'design_pilot', 'design_mock') AND run_id IS NOT NULL)
    OR (run_kind IN ('calibration', 'preflight') AND run_id IS NULL)
  ),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT
);

INSERT INTO budget_accounts_new (
  account_id, run_id, run_kind, pool, max_cost_usd, known_actual_usd,
  reserved_usd, unknown_exposure_usd, created_at, updated_at
)
SELECT
  account_id, run_id, run_kind, pool, max_cost_usd, known_actual_usd,
  reserved_usd, unknown_exposure_usd, created_at, updated_at
FROM budget_accounts;

DROP TABLE budget_accounts;
ALTER TABLE budget_accounts_new RENAME TO budget_accounts;

CREATE UNIQUE INDEX ux_budget_accounts_run_pool
  ON budget_accounts(run_id, pool)
  WHERE run_id IS NOT NULL;

CREATE UNIQUE INDEX ux_budget_accounts_global_pool
  ON budget_accounts(pool)
  WHERE run_id IS NULL;

CREATE TRIGGER budget_accounts_immutable_delete
BEFORE DELETE ON budget_accounts
BEGIN
  SELECT RAISE(ABORT, 'budget_accounts are immutable');
END;

CREATE TABLE design_attempts (
  run_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  attempt_index INTEGER NOT NULL CHECK (attempt_index BETWEEN 0 AND 2),
  role TEXT NOT NULL CHECK (
    role IN ('baseline', 'design', 'design_repair_1', 'design_repair_2')
  ),
  arm TEXT NOT NULL CHECK (arm IN ('baseline', 'ai_one_shot', 'ai_feedback')),
  logical_call_id TEXT,
  proposal_artifact_id INTEGER,
  diagnostic_json TEXT CHECK (
    diagnostic_json IS NULL
    OR (length(diagnostic_json) <= 2097152 AND json_valid(diagnostic_json))
  ),
  verdict TEXT NOT NULL CHECK (
    verdict IN ('accepted', 'rejected', 'inconclusive', 'generation_error')
  ),
  cost_status TEXT NOT NULL CHECK (cost_status IN ('none', 'known', 'unknown')),
  cost_usd TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, slot_id, attempt_index),
  FOREIGN KEY (run_id, slot_id) REFERENCES slots(run_id, slot_id) ON DELETE CASCADE,
  FOREIGN KEY (logical_call_id) REFERENCES logical_calls(logical_call_id) ON DELETE RESTRICT,
  FOREIGN KEY (proposal_artifact_id) REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
  CHECK (cost_status <> 'known' OR cost_usd IS NOT NULL),
  CHECK (cost_status <> 'unknown' OR cost_usd IS NULL),
  CHECK (
    (arm = 'baseline' AND attempt_index = 0 AND role = 'baseline'
      AND logical_call_id IS NULL AND cost_status = 'none' AND cost_usd = '0')
    OR (arm IN ('ai_one_shot', 'ai_feedback') AND attempt_index = 0 AND role = 'design'
      AND logical_call_id IS NOT NULL AND cost_status IN ('known', 'unknown'))
    OR (arm = 'ai_feedback' AND attempt_index = 1 AND role = 'design_repair_1'
      AND logical_call_id IS NOT NULL AND cost_status IN ('known', 'unknown'))
    OR (arm = 'ai_feedback' AND attempt_index = 2 AND role = 'design_repair_2'
      AND logical_call_id IS NOT NULL AND cost_status IN ('known', 'unknown'))
  )
);

CREATE UNIQUE INDEX ux_design_attempts_logical_call
  ON design_attempts(logical_call_id)
  WHERE logical_call_id IS NOT NULL;

CREATE INDEX idx_design_attempts_slot
  ON design_attempts(run_id, slot_id, attempt_index);

CREATE TRIGGER design_attempts_no_update
BEFORE UPDATE ON design_attempts
BEGIN
  SELECT RAISE(ABORT, 'design_attempts are append-only');
END;

CREATE TRIGGER design_attempts_no_delete
BEFORE DELETE ON design_attempts
BEGIN
  SELECT RAISE(ABORT, 'design_attempts are append-only');
END;

CREATE TABLE design_attempt_artifacts (
  run_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  attempt_index INTEGER NOT NULL CHECK (attempt_index BETWEEN 0 AND 2),
  role TEXT NOT NULL CHECK (
    role IN ('proposal', 'diagnostic', 'raw_response', 'request_body', 'solver_result', 'other')
  ),
  artifact_id INTEGER NOT NULL,
  PRIMARY KEY (run_id, slot_id, attempt_index, role, artifact_id),
  FOREIGN KEY (run_id, slot_id, attempt_index)
    REFERENCES design_attempts(run_id, slot_id, attempt_index) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE RESTRICT
);

CREATE INDEX idx_design_attempt_artifacts_artifact
  ON design_attempt_artifacts(artifact_id);

CREATE TRIGGER design_attempt_artifacts_no_update
BEFORE UPDATE ON design_attempt_artifacts
BEGIN
  SELECT RAISE(ABORT, 'design_attempt_artifacts are append-only');
END;

CREATE TRIGGER design_attempt_artifacts_no_delete
BEFORE DELETE ON design_attempt_artifacts
BEGIN
  SELECT RAISE(ABORT, 'design_attempt_artifacts are append-only');
END;
