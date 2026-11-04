CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  protocol_version TEXT NOT NULL,
  run_kind TEXT NOT NULL CHECK (run_kind IN ('full', 'smoke')),
  root_seed TEXT NOT NULL,
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('mock', 'live')),
  manifest_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
  control_state TEXT NOT NULL CHECK (
    control_state IN ('running', 'paused_budget', 'paused_operator', 'interrupted', 'completed', 'failed')
  ),
  created_at TEXT NOT NULL
);

CREATE TABLE slots (
  run_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  slot_ordinal INTEGER NOT NULL CHECK (slot_ordinal BETWEEN 1 AND 200),
  family TEXT NOT NULL CHECK (
    family IN ('ranking', 'matching', 'scheduling', 'truth', 'arithmetic', 'matrix', 'transforms', 'paths', 'symmetry', 'counting')
  ),
  modality TEXT NOT NULL CHECK (modality IN ('text', 'svg')),
  lane TEXT NOT NULL CHECK (lane IN ('spec_first', 'ai_spec')),
  difficulty INTEGER NOT NULL CHECK (difficulty IN (1, 2, 3)),
  stage TEXT NOT NULL CHECK (
    stage IN ('planned', 'spec_ready', 'formal_checked', 'presentation_ready', 'duplicate_checked', 'blind_reviewed', 'alignment_reviewed', 'terminal')
  ),
  verdict TEXT CHECK (
    verdict IS NULL OR verdict IN ('approved', 'rejected', 'inconclusive', 'generation_error')
  ),
  checkpoint_version INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, slot_id),
  UNIQUE (run_id, slot_ordinal),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
  CHECK ((stage = 'terminal') = (verdict IS NOT NULL))
);

CREATE TABLE stage_results (
  run_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (
    stage IN ('planned', 'spec_ready', 'formal_checked', 'presentation_ready', 'duplicate_checked', 'blind_reviewed', 'alignment_reviewed', 'terminal')
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

CREATE TABLE artifacts (
  artifact_id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  kind TEXT NOT NULL CHECK (
    kind IN ('json', 'svg', 'png', 'raw_response', 'request_body', 'presentation')
  ),
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (content_hash, kind),
  CHECK (length(bytes) = byte_length),
  CHECK (
    (kind IN ('json', 'raw_response', 'request_body', 'presentation') AND byte_length <= 2097152)
    OR (kind = 'svg' AND byte_length <= 262144)
    OR (kind = 'png' AND byte_length <= 1048576)
  )
);

CREATE TABLE stage_artifacts (
  run_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  version INTEGER NOT NULL,
  artifact_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (run_id, slot_id, stage, version, artifact_id),
  FOREIGN KEY (run_id, slot_id, stage, version)
    REFERENCES stage_results(run_id, slot_id, stage, version) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE RESTRICT
);

CREATE TABLE events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  slot_id TEXT,
  event_type TEXT NOT NULL,
  stage TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, slot_id) REFERENCES slots(run_id, slot_id) ON DELETE CASCADE,
  CHECK (slot_id IS NULL OR stage IS NOT NULL)
);

CREATE INDEX idx_slots_run_stage ON slots(run_id, stage);
CREATE INDEX idx_stage_results_run_slot ON stage_results(run_id, slot_id);
CREATE INDEX idx_stage_artifacts_artifact ON stage_artifacts(artifact_id);
CREATE INDEX idx_events_run ON events(run_id, event_id);
CREATE INDEX idx_artifacts_hash ON artifacts(content_hash);

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
