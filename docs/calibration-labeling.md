# Calibration Fixture Pack and Pending Ground Truth (P40)

P40 prepares a reproducible offline pack of 40 held-out calibration presentations and a pending human-label template. It makes no reviewer calls, no provider calls, and no network requests. No label in this pack is human-verified.

## Composition

- Exactly 40 fixtures: 20 sound and 20 visibly defective.
- Every family has two sound and two defective fixtures.
- Modality is balanced: 20 text (ranking, matching, scheduling, truth, arithmetic) and 20 SVG (matrix, transforms, paths, symmetry, counting).
- Fixture IDs are `cal-<family>-01` through `cal-<family>-04`; calibration slot IDs use ordinals 91-94 (`<modality>-<family>-91` ... `-94`) so they never collide with smoke/full slot IDs.
- Seeds are derived from `puzzle-calibration-v1` with fixed per-fixture descriptors and are disjoint from the smoke/full plans. The pack and all per-fixture hashes are deterministic.
- Wording is the deterministic fixture template from the accepted family engines. Sound fixtures use the normal assembly path; intentionally invalid presentations bypass primary eligibility only inside this calibration pack.

## Pack layout

`npm run calibration -- --prepare` writes:

```text
data/calibration/<pack-hash>/
  pack.json
  labels.pending.csv
  gallery.html
  images/<fixture-id>.png
  images/<fixture-id>.svg
  images/<fixture-id>-original.png   # defective SVG only
  images/<fixture-id>-original.svg   # defective SVG only
```

`gallery.html` shows only the visible presentation, options, and local diagram. It intentionally does **not** show the sound/defective label, expected outcomes, mutation evidence, original proof, or answer key.

## Ground-truth record

Each fixture in `pack.json` contains:

- `fixtureId`, `slotId`, `family`, `modality`, `difficulty`, `variant`, `seed`, `optionsSeed`, `sourceFixtureId`.
- `visible`: the exact `VisiblePresentation` a blind reviewer should see.
- `original`: original spec, solve result/proof, original choices, original visible presentation/reveal, and original content/PNG/SVG hashes.
- `mutation`: `null` for sound fixtures; for defective fixtures a precise record with `kind`, description, changed fields, affected fact IDs, and machine-readable details.
- `expected.blind`: `correct` with a correct label for sound fixtures; `defect` or `no_unique` with accepted defect codes for defective fixtures.
- `expected.alignment`: `pass` for sound; `fail` with accepted failing fields and fact IDs for defective.
- `contentHash`, `originalContentHash`, `pngHash`, `svgHash`, `originalPngHash`, `originalSvgHash`, `fixtureHash`.
- `humanVerified: false`, `auditor: null`, `auditorTime: null` in the pending pack.

## Defect codes

- `DUPLICATE_CORRECT_OPTION` — every family: the visible correct option/value appears under a second label. Text families duplicate option text; SVG families duplicate the rendered tile.
- `NO_VALID_OFFERED_SOLUTION` / `MULTIPLE_OFFERED_SOLUTIONS` — ranking, matching, scheduling, truth, arithmetic: a selected visible primitive is changed using an accepted family test mutation, and the independent visible-domain check proves that none or at least two of the offered options solve the visible puzzle.
- `CONTRADICTORY_XOR_EXAMPLE` — matrix: one visible XOR row is contradicted; the solution check returns zero completions and no offered mask can fix the displayed rows/columns.
- `CONTRADICTORY_TRANSFORM_INSTRUCTIONS` — transforms: the visible rules allow both clockwise and counterclockwise reading of the displayed quarter-turn; both different resulting patterns are offered.
- `CLOSED_ROUTE_EDGE` — paths: a wall is added to an edge of the unique correct route in the shared maze and every option tile; no offered route remains valid against the visible graph.
- `CONTRADICTORY_SYMMETRY_AXIS` — symmetry: the public rule says the marked horizontal/vertical axis is the other direction; the displayed marked axis is unchanged.
- `CONFLICTING_COUNTING_CONVENTIONS` — counting: the visible rules require both union-once and overlap-once-per-shape counting, and both distinct totals are offered.

A fixture whose mutation still leaves one clear valid offered answer must fail construction; it must not be labeled defective anyway.

## Pending label template

`labels.pending.csv` has one row per fixture and these columns:

```text
pack_hash,fixture_id,slot_id,source_fixture_id,family,modality,difficulty,
sound_or_defective,seed,content_hash,png_hash,svg_hash,fixture_hash,
proposed_blind_result,proposed_correct_label,accepted_defect_codes,
proposed_alignment_result,accepted_failing_fields,accepted_fact_ids,
corruption_explanation,observed_blind_result,observed_correct_label,
observed_defect_codes,observed_alignment_result,observed_failing_fields,
observed_fact_ids,provenance,human_verified,auditor,auditor_time,notes
```

`proposed_*` fields are agent-prepared evidence, not human judgments. In the pending template, the `observed_*` fields, `provenance`, `auditor`, `auditor_time`, and `notes` are empty, and every `human_verified` value is `false`. Do not treat the proposed fields as approved ground truth.

## P41 mock calibration and label import

P41 adds `src/calibration/labels.ts`, `run.ts`, `score.ts`, `tests/calibration/score.test.ts`, and `tests/fixtures/calibration/mock-labels.csv`. `npm run calibration -- --mock --labels <path>` validates the label file, runs exactly one blind and one alignment review per fixture (80 review calls, zero generation calls) through the same frozen prompt/schema/model-route/payload builders as primary, and scores four separate combinations: text blind, text alignment, SVG blind, SVG alignment.

Each combination reports a decisive-only 2x2 confusion matrix and a conservative all-ten matrix. The conservative numerator counts only a compatible defect/no-unique blind issue code with non-selected status and `ambiguity=present`, or a failing alignment field with an accepted fact ID when one is specified. A blind abstention, wrong clean answer, unrelated issue code, parse/API error, or missing call never counts. An alignment detection is credited when at least one accepted field fails with an accepted fact ID and at least one applicable field outside the accepted set passes; an additional unrelated failing field does not erase that credit, while a reject-all response does not earn it. The report includes a stable `labelsHash` over the label rows; `--verify-labels` prints the same hash. Gates are fixed at 9/10 conservative sensitivity and 8/10 conservative specificity per combination. Wilson intervals, coverage, abstentions, errors, and partial-run denominators are reported. A mock/test-only label file must use `provenance=mock_test_only` and auditor `mock-test-only`; mock results are marked `evidenceKind=mock`, `liveEligible=false`, and never qualify a live freeze.

`npm run calibration -- --verify-labels <path> --auditor <name>` validates a human label file without filling observations or claiming an actual review. It requires 40 rows, the matching pack hash, matching fixture/content/PNG/SVG/fixture hashes, complete proposed and observed labels, known defect codes/fields/fact IDs, `provenance=human`, `human_verified=true`, the exact `--auditor` identity, and a valid non-future auditor time. A human observation that disagrees with the pack is rejected; correct P40 and create a new pack hash instead of overwriting truth.

## Human audit gate

P47 is the manual gate. A human must inspect and solve all 40 actual presentations, including the rasterized PNGs, verify or correct every proposed outcome and mutation explanation, and fill the auditor identity/time and verification flags in a separate label file. The coding agent may validate completeness, hashes, and structural consistency, but must not impersonate the auditor or mark labels approved. If a fixture is wrong or ambiguous, fix P40, create a new pack hash, rerun the offline checks, and obtain human verification again.

## Commands

```bash
npm run calibration -- --prepare
npm run calibration -- --mock --labels tests/fixtures/calibration/mock-labels.csv
npm run calibration -- --verify-labels <human-labels.csv> --auditor <name>
npm exec -- vitest run tests/calibration/fixtures.test.ts
npm exec -- vitest run tests/calibration/score.test.ts
npm run check
```

The focused suite checks composition, family/modality balance, seed disjointness, deterministic hashes, pending human fields, duplicate/option consequences, the family-specific corruption evidence, local artifact hashes, gallery/label generation, and rejection of a defective mutation that still leaves one clear valid offered answer.
