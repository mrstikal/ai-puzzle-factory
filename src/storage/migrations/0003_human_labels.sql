CREATE TABLE human_labels (
  label_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  sample_hash TEXT NOT NULL CHECK (length(sample_hash) = 64),
  slot_hash TEXT NOT NULL CHECK (length(slot_hash) = 64),
  auditor TEXT NOT NULL CHECK (length(auditor) BETWEEN 1 AND 200),
  auditor_time TEXT NOT NULL,
  correctness TEXT NOT NULL CHECK (
    correctness IN ('correct', 'incorrect', 'unresolved', 'not_inspectable')
  ),
  clarity TEXT NOT NULL CHECK (
    clarity IN ('clear', 'unclear', 'not_inspectable')
  ),
  hint_support TEXT NOT NULL CHECK (
    hint_support IN ('supported', 'unsupported', 'unresolved', 'not_inspectable')
  ),
  explanation_support TEXT NOT NULL CHECK (
    explanation_support IN ('supported', 'unsupported', 'unresolved', 'not_inspectable')
  ),
  image_readability TEXT NOT NULL CHECK (
    image_readability IN ('readable', 'unreadable', 'not_applicable', 'not_inspectable')
  ),
  novelty_concern TEXT NOT NULL CHECK (
    novelty_concern IN ('none', 'concern', 'unresolved', 'not_inspectable')
  ),
  enjoyment INTEGER CHECK (enjoyment IS NULL OR enjoyment BETWEEN 1 AND 5),
  perceived_difficulty INTEGER CHECK (
    perceived_difficulty IS NULL OR perceived_difficulty BETWEEN 1 AND 5
  ),
  solve_time TEXT NOT NULL CHECK (
    solve_time IN ('<=60s', '61-180s', '>180s', 'not_solved', 'not_inspectable')
  ),
  notes TEXT NOT NULL DEFAULT '',
  label_hash TEXT NOT NULL CHECK (length(label_hash) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (run_id, slot_id, revision),
  FOREIGN KEY (run_id, slot_id) REFERENCES slots(run_id, slot_id) ON DELETE CASCADE
);

CREATE INDEX human_labels_run_slot_idx
  ON human_labels (run_id, slot_id, revision);

CREATE TRIGGER human_labels_no_update
BEFORE UPDATE ON human_labels
BEGIN
  SELECT RAISE(ABORT, 'human_labels is append-only');
END;

CREATE TRIGGER human_labels_no_delete
BEFORE DELETE ON human_labels
BEGIN
  SELECT RAISE(ABORT, 'human_labels is append-only');
END;
