# Deterministic Human-Audit Sample and Append-Only Imports (P42)

P42 prepares the primary human-audit evidence without generating candidates, changing primary verdicts, or pretending that an agent is a human auditor. The sample is selected from a committed run after automatic verdicts are stored.

## Production sample versus smoke preview

`npm run audit -- --run <run-id> --prepare` reads the run and its committed candidates. Production sampling requires a completed run; a non-completed full run is refused rather than producing a production-flagged sample.

- A **full** run produces `data/runs/<run-id>/audit/sample.json`, `labels.csv`, `gallery.html`, and `images/`.
- A **smoke** run never produces a production 40-slot audit. It writes only `audit/preview.json`, `preview-labels.csv`, `preview-gallery.html`, and `images/`, with `production: false`, `preview: true`, and an explicit preview message. Importing a preview as production evidence is rejected.
- `gallery.html` is read-only and shows only the public presentation: question, code-owned rules, clue text, options, and the local PNG/SVG. It does not show the automatic verdict, reveal key, proof, hint, explanation, or mutation/answer metadata. Missing presentations are shown as not inspectable.

## Selection algorithm

For a production sample the selector follows section 9.3 literally:

1. Iterate families in the fixed family order, then the family-by-lane cells.
2. Each family has four core slots, exactly two from each lane when enough terminal slots exist.
3. Reserve two approved slots per family: one from each lane when both have approvals; otherwise two from the sole approving lane when available.
4. Fill each family/lane cell to two slots by priority: reviewer disagreement/model-only concern, other non-approved presentation, remaining approval, then no-presentation failure.
5. Break every tie by `sha256(rootSeed + ':' + slotId)` and then by slot ID. An injected hash function is used in tests to prove hash-tie determinism.
6. If fewer than two approvals exist in a family or fewer than two terminal slots exist in a lane, record a shortfall. Never substitute another family or lane. One-lane-only approvals are disclosed separately.
7. Append at most one representative for each globally available but unsampled major verdict category (`approved`, `rejected`, `inconclusive`, `generation_error`), at most four additions and 44 total. The core sample and every shortfall remain in the manifest.

The manifest records the core entries, category additions, shortfalls, family approval-lane counts, available/core/addition categories, total/approved sample denominators, and `sampleHash`. `sampleHash` is the canonical hash of the manifest without the hash field.

## Pending labels

`labels.csv` has one row per sampled slot and these columns:

```text
sample_hash,run_id,slot_id,slot_hash,family,lane,modality,difficulty,
inspectable,correctness,clarity,hint_support,explanation_support,
image_readability,novelty_concern,enjoyment,perceived_difficulty,solve_time,
notes,auditor,auditor_time
```

The per-slot automatic verdict is not included in the pending CSV or public sample entries; only aggregate category/approval counts are disclosed. Import recomputes the sample from the database and derives verdicts from the authoritative candidates. Pending rows have empty label/auditor/time fields. The human must fill:

- `correctness`: `correct|incorrect|unresolved|not_inspectable`
- `clarity`: `clear|unclear|not_inspectable`
- `hint_support` / `explanation_support`: `supported|unsupported|unresolved|not_inspectable`
- `image_readability`: `readable|unreadable|not_applicable|not_inspectable` (text uses `not_applicable` when inspectable)
- `novelty_concern`: `none|concern|unresolved|not_inspectable`
- `enjoyment` / `perceived_difficulty`: explicit 1-5, or empty when not inspectable
- `solve_time`: `<=60s|61-180s|>180s|not_solved|not_inspectable`
- `auditor`, `auditor_time`, and optional `notes`

No label is inferred. A noninspectable slot must use `not_inspectable` for all inspection fields, no ratings, and a note explaining why. A presentable slot must have explicit correctness/clarity/support/novelty/solve-time labels; text image readability must be `not_applicable`, SVG must be readable/unreadable. Enjoyment and perceived difficulty are exploratory and never claim population preference.

## Append-only import

`npm run audit -- --run <run-id> --import <labels.csv>` recomputes the deterministic sample from the database, rejects a stale/tampered manifest, then validates the sample hash, run ID, exact sampled-slot set, slot hashes, metadata, auditor identity/time, and every label rule before writing. It then inserts all rows in one transaction with the next per-slot revision. `human_labels` is append-only: database triggers reject UPDATE and DELETE, and a later import creates revision 2, 3, ... rather than editing prior evidence. Primary runs, slots, stage results, artifacts, events, and verdicts are never modified.

`audit/summary.json` reports total and approved denominators independently:

- total sampled / labelled / inspectable;
- approved sampled / labelled / inspectable;
- label row count, max revision, and auditors.

An approval-based denominator and a total-inspectability denominator are not interchangeable. The diagnostic sample is stratified and enriched for problems; its defect fraction is not an unbiased population accuracy estimate. Unresolved disagreement is preserved as `unresolved` and blocks `proceed` in later decision logic rather than being forced to an answer.

## Commands

```bash
npm run audit -- --run <mock-smoke-id> --prepare
npm run audit -- --run <full-run-id> --prepare
npm run audit -- --run <full-run-id> --import <labels.csv>
npm exec -- vitest run tests/audit/sample.test.ts
npm run check
```

A smoke prepare must print `mode: preview`, `production_audit: false`, and only write preview files. A production import requires a full-run sample; preview, incomplete, duplicate, unknown-slot, mock-auditor, future-time, noninspectable-with-ratings, and text/SVG image-rule violations are rejected.

## Out of scope

Final decision logic, automatic human approval, agent-generated observations, new candidate generation, and treating the audit as an unbiased population rate. P43 consumes the audit evidence; P53 performs the real human primary audit.
