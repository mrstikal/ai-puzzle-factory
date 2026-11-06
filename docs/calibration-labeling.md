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
fixture_id,slot_id,source_fixture_id,family,modality,difficulty,sound_or_defective,
seed,content_hash,png_hash,svg_hash,fixture_hash,proposed_blind_result,
proposed_correct_label,accepted_defect_codes,proposed_alignment_result,
accepted_failing_fields,accepted_fact_ids,corruption_explanation,human_verified,
auditor,auditor_time,notes
```

`proposed_*` fields are agent-prepared evidence, not human judgments. Every `human_verified` value is `false`; `auditor`, `auditor_time`, and `notes` are empty. Do not treat the proposed fields as approved ground truth.

## Human audit gate

P47 is the manual gate. A human must inspect and solve all 40 actual presentations, including the rasterized PNGs, verify or correct every proposed outcome and mutation explanation, and fill the auditor identity/time and verification flags in a separate label file. The coding agent may validate completeness, hashes, and structural consistency, but must not impersonate the auditor or mark labels approved. If a fixture is wrong or ambiguous, fix P40, create a new pack hash, rerun the offline checks, and obtain human verification again.

## Commands

```bash
npm run calibration -- --prepare
npm exec -- vitest run tests/calibration/fixtures.test.ts
npm run check
```

The focused suite checks composition, family/modality balance, seed disjointness, deterministic hashes, pending human fields, duplicate/option consequences, the family-specific corruption evidence, local artifact hashes, gallery/label generation, and rejection of a defective mutation that still leaves one clear valid offered answer.
