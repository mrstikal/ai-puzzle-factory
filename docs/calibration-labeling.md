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

## P47 human verification gate (completed and accepted 2026-11-06)

P47 is a human-only gate. The auditor Lexa completed the review and `--verify-labels` accepted the file on 2026-11-06. The agent prepared the workspace and validated structure/hashes; it did not fill the observations.

Current pack:

- Pack hash: `b2de95516799894e5fe5c5b4e6eb1376c772efb14981146797004ab99877eb5f`
- Pack: `data/calibration/b2de95516799894e5fe5c5b4e6eb1376c772efb14981146797004ab99877eb5f/pack.json`
- Pending template (unchanged): `data/calibration/b2de95516799894e5fe5c5b4e6eb1376c772efb14981146797004ab99877eb5f/labels.pending.csv`
- Human-completed file: `data/calibration/b2de95516799894e5fe5c5b4e6eb1376c772efb14981146797004ab99877eb5f/labels.human.csv` (40/40 verified, labels hash `be359e39350c6e79dc4aeea36651c512726151d569f39a6b35f5ce935730948b`, auditor `Lexa`, time `2026-11-06T21:01:19.685Z`)
- Visible gallery: `data/calibration/b2de95516799894e5fe5c5b4e6eb1376c772efb14981146797004ab99877eb5f/gallery.html`

The human auditor must:

1. Open the gallery and inspect/solve all 40 presentations, including every rasterized PNG.
2. Compare the visible presentation and mutation evidence with the proposed blind/alignment outcome. `proposed_*` fields are agent evidence, not approval.
3. Do **not** type 240 observed cells by hand. After reviewing each fixture, fill its `observed_blind_result` (`correct`, `defect`, or `no_unique`) in `labels.human.csv`; that is the per-row human review attestation. The helper refuses any row whose blind result is blank.
4. Run the explicit acceptance helper below. It fills only the remaining blank dependent `observed_*` cells from the proposed evidence, preserves non-empty values, sets `provenance=human`, `human_verified=true`, `auditor=Lexa`, and the current/non-future `auditor_time` (per-row times are preserved).
5. If you disagree with the proposed blind/alignment outcome, do not edit the file to force acceptance: `--verify-labels` rejects any observed value that differs from the pack. Stop and report the fixture; P40 must be corrected, a new pack hash generated, offline tests rerun, and human verification repeated.
6. Reject any negative that only corrupts a hidden answer or still leaves one clear valid visible question. Do not edit `pack.json` or `labels.pending.csv` to make a fixture pass.

The helper records the human's explicit per-row acceptance via `observed_blind_result`; it is not a substitute for the review. It refuses the pending template, mock label fixtures, already-attested files, and any row without a human blind result. The coding agent must not run it on the real file.

Acceptance helper (run only after the human review):

```bash
npm run calibration -- --accept-proposed \
  --labels data/calibration/b2de95516799894e5fe5c5b4e6eb1376c772efb14981146797004ab99877eb5f/labels.human.csv \
  --auditor Lexa
```

Validation command after filling:

```bash
npm run calibration -- --verify-labels \
  data/calibration/b2de95516799894e5fe5c5b4e6eb1376c772efb14981146797004ab99877eb5f/labels.human.csv \
  --auditor Lexa
npm exec -- vitest run tests/calibration/fixtures.test.ts tests/calibration/score.test.ts
```

`--verify-labels` accepted exactly 40 verified, version-matching rows with matching pack/fixture/content/PNG/SVG hashes, complete observed labels, human provenance, auditor `Lexa`, and a non-future timestamp. All 40 observed blind/alignment results match the proposed evidence; no disagreement required a P40 pack revision. P47 is accepted; live calibration may now proceed to P48 after explicit budget authorization.

## P48 authorized live calibration

The live path uses the same frozen prompt/schema builders, model IDs, Balanced routing policy, and primary review limits as the mock/primary path. It runs exactly one blind and one alignment request per fixture (80 logical review calls, zero generation calls) and refuses to start unless the labels are human-verified, the pack/label hashes match, every route resolves, and `--allow-paid` plus a positive `--max-cost` are supplied.

```bash
npm run calibration -- --live --allow-paid \
  --labels data/calibration/b2de95516799894e5fe5c5b4e6eb1376c772efb14981146797004ab99877eb5f/labels.human.csv \
  --max-cost 2
```

The run writes an immutable directory under `data/calibration/<pack-hash>/live/<calibration-id>/`:

- `calibration.json` — run identity, pack/label hashes, models, routes, Balanced policy, catalog snapshot, configuration/provenance, authorized cap, budget/cost, provider mix, coverage, gates, observations, limitations;
- `score.json` — the full conservative score report, matrices, Wilson intervals, abstentions/errors, and fixed gates;
- `requests.jsonl` / `responses.jsonl` — 80 rows each, with logical-call IDs, request hashes, request bodies (PNG base64 redacted to a placeholder), validated responses, errors, attempts, provider identities, and costs;
- `labels.csv` — the verified human labels used for scoring;
- `calibration.sqlite` — the raw ledger, budget, attempts, raw response artifacts, and request events;
- `images/` — the 20 actual PNGs and 20 SVGs sent for SVG fixtures;
- `manifest.json` — SHA-256 and byte count for every file, plus a manifest hash.

Use `npm run report -- --run <calibration-id>` to print the artifact. If the run used a custom `--out`, the live stdout includes the matching `reportCommand` with `--calibration-root`.

A completed run is `liveEligible` only when it has 80 review calls, 40/40 blind and 40/40 alignment outcomes, human provenance, no fatal error, and no budget breach. Freeze eligibility additionally requires all four conservative sensitivity/specificity gates to pass. A budget pause, admission refusal, post-loop overshoot/pause event, incomplete run, missing outcome, or failed gate is never converted into a pass.

The first authorized run (`962b114c-b685-4d29-b846-606fc13fbabf`) completed all 80 calls with known cost USD 1.3060874628 and 2 unknown-cost timeouts, but 40 calls ended with `finish_reason:"length"` at the primary 4096-token review cap. All four gates failed; the full evidence is preserved and P48 is not accepted. A revised reviewer/configuration (for example, a higher primary review output cap or a different reviewer model) requires a new explicit authorization and a new calibration; do not overwrite the prior result or relabel fixtures to obtain a pass.

## V2 validation pack

`npm run calibration -- --prepare-v2` builds the version-2 40-fixture validation pack offline, without any paid call:

```bash
npm run calibration -- --prepare-v2
```

The default output is `data/calibration-v2/<pack-hash>/` with `pack.json`, `gallery.html`, `images/`, and `labels.pending.csv`. The current pack hash is `c8bacdf030974d1c4c56fc3ec79cf2d43e19c8c21514da63bd26eb01cf1442dc`; it uses slots 101-104 / fixture IDs 05-08, is disjoint from the v1 pack (slots 91-94) and the 95-99 development pilot, and contains 20 sound / 20 defective and 20 text / 20 SVG fixtures. The pending labels require the same human verification as P47 (complete observed labels/codes/fields/fact IDs, auditor, timestamp) before a v2 P48 calibration; the v1 pack and all prior artifacts remain preserved.

Copy `labels.pending.csv` to a human workspace file, review/fill the observed fields, then use the version-2 selector for every label-consuming mode:

```bash
cp data/calibration-v2/<pack-hash>/labels.pending.csv \
   data/calibration-v2/<pack-hash>/labels.human.csv
# human review/fill observed_* in labels.human.csv
npm run calibration -- --accept-proposed --pack-version 2 \
  --labels data/calibration-v2/<pack-hash>/labels.human.csv --auditor <name>
npm run calibration -- --verify-labels \
  data/calibration-v2/<pack-hash>/labels.human.csv --pack-version 2 --auditor <name>
npm run calibration -- --live --allow-paid --pack-version 2 \
  --labels data/calibration-v2/<pack-hash>/labels.human.csv --max-cost 2
```

`--accept-proposed` refuses the pending template itself, so use the human workspace copy. `--pack-version 2` selects the v2 pack for `--accept-proposed`, `--verify-labels`, `--mock`, and `--live`; the default remains version 1.

The current v2 `labels.human.csv` was reviewed by Kilo on the operator's explicit delegation, audited against the pack truth and visible artifacts, accepted with `--accept-proposed --pack-version 2 --auditor "Lexa (delegated to Kilo)"`, and verified. It has 40 rows, pack hash `c8bacdf...`, labels hash `2c4e2e45728a0d48492e905137ab9de2be76509f3c8dff0e4726e9ec0237fec5`, provenance `human`, `human_verified:true`, and per-row notes disclosing that this was not independent human inspection. The calibration artifact labels block records `reviewMethod` (`independent_human`, `operator_delegated_ai`, or `code_derived`; the v2 labels are `operator_delegated_ai`, the pilot labels are `code_derived`) and the unique notes. A freeze that requires independent human verification must reject or explicitly caveat a non-`independent_human` method and re-review these labels; the provenance limitation is recorded in the notes, the artifact, and the P48 progress entry.
