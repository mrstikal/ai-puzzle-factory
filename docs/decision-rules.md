# Protocol Freeze and Final Business Decision (P43)

P43 implements two separate pure gates. Freeze validates the **pre-run** evidence graph and never requires primary results or a future human audit. Final decision evaluates the **post-run** evidence, including the completed human audit, against the frozen protocol. Neither gate runs a live model or changes measured outcomes.

## Frozen thresholds

The values come from `src/domain/experiment.ts`:

- text approval >= 80/100 and SVG approval >= 80/100;
- every family >= 10/20 approvals;
- structural uniqueness >= 0.95 and fingerprint coverage >= 0.80;
- primary actual cost per approved <= USD 0.10, with known-complete costs;
- calibration sensitivity >= 0.90 and specificity >= 0.80 in each of text blind, text alignment, SVG blind, and SVG alignment;
- audit core >= 32 inspectable, >= 2 approved core per family and >= 20 approved core total;
- >= 80% of inspectable audited approvals clear and solved within 180 seconds;
- reject if text/SVG approval < 50%, any calibration sensitivity/specificity < 50%, or a repeatable audited correctness defect affects >= 2 distinct approved candidates in one family.

The USD 0.10 threshold and quotas/seeds are frozen. A cap amendment is an operational event and does not change the threshold.

## `canFreezeProtocol`

The evidence bundle contains:

- the immutable 200-slot full plan, plan hash, root seed, protocol version, quotas, and USD 0.10 threshold;
- a live preflight with supported routes, a positive known price for every `REQUEST_ROLES` entry, price-catalog hash, observation time, forecast at 680 potential calls and 160 approvals, maximum forecast, and conservative reserve;
- the human-verified 40-fixture pack hash and label hash, all 40 verified;
- a live calibration with 80 review calls, zero generations, four passing modality/role combinations with 10 defective/10 sound denominators, and the same config/pack/label hashes;
- an accepted completed live smoke with 20/20 terminal slots, 10 families, and all four review roles;
- a configuration hash, prompt/schema hashes, routes hash, source hash, and injected provenance evidence;
- the authorized primary cap.

It rejects mock/partial/stale/unverified evidence, configuration or plan drift, missing role prices, an understated 680-call forecast or insufficient cap/reserve, calibration gates below threshold or with fewer than ten cases per denominator, smoke coverage gaps, and provenance mismatch. On success it returns a hash-committed `FrozenProtocol`; `storeFrozenProtocol` appends it to `protocol_freezes`. The table is append-only (UPDATE/DELETE triggers).

P43's CLI accepts a JSON evidence bundle:

```bash
npm run freeze -- --evidence <bundle.json> [--max-run-cost 10]
```

The bundle shape is `{ "freeze": FreezeProtocolEvidence, "final": FinalDecisionEvidence }`. `--db <path>` optionally migrates, acquires the writer lock, and appends a successful frozen protocol; `--operator` records a cap-override identity. `--smoke`/`--calibration` IDs are accepted as future-facing options but P43 does not wire live DB/provenance collection; the CLI marks them non-authoritative and, without `--evidence`, refuses rather than inventing evidence. P44 supplies the real provenance archive, P48 the live calibration, and P49 the accepted live smoke.

## `decideFinal`

The final evidence contains the completed live 200-slot run, modality/family/family-lane approvals, uniqueness/coverage, known-complete cost, near-duplicate categories, same-config live calibration, completed audit sample/labels with independent total and approved inspectability denominators, unresolved-defect/disagreement counts, supported routes, and the frozen protocol.

Predicates are emitted explicitly with `pass|fail|not_evaluable`, required and actual values. Text/SVG denominators must be exactly 100; all ten families and all `${family}/${lane}` cells must be disclosed; audit core/approved counters must be mutually consistent (core inspectable <= core sampled, approved inspectable <= approved sampled, approved inspectable >= approved-core total, clarity pass <= clarity denominator, unresolved defects <= approved inspectable, clarity denominator = approved inspectable), and at least 20 approved slots must be inspectable. `approvedCoreByFamily` means approved core slots that are inspectable and genuinely audited. Near-duplicate categories must be present for every family and `${family}/${lane}` cell. The decision order is:

1. If the run is not a completed live 200-slot cohort, costs are unknown, calibration is missing/mock/drifted, routes are unsupported, the audit is incomplete, or the frozen protocol is missing/invalid → `revise` (incomplete evidence).
2. Else if any strong failure exists (modality approval < 50%, calibration sensitivity/specificity < 50%, or repeatable correctness defect >= 2 in one family) → `reject`.
3. Else if every proceed predicate passes → `proceed`.
4. Else → `revise` (borderline or failed non-strong predicate).

An incomplete run is never converted into a definitive business rejection. The report always lists failed predicates and caveats. Near-duplicate shortfalls are disclosed separately as novelty-only, additional-quality, or incomplete/failed-review evidence; they do not waive the frozen approval floor. The audit is stratified/enriched and is not an unbiased population estimate.

The P43 CLI prints the freeze result and, when a `final` bundle is present, the decision report. It does not approve expenditure, execute the primary cohort, or mutate measured outcomes. Near-duplicate breakdowns are emitted per family and family/lane alongside the approval denominators.

## Verification

```bash
npm exec -- vitest run tests/experiment/freeze.test.ts
npm run check
```

The focused suite hand-builds a complete pass and one-predicate failures for modality 79/80 vs 49/50, family 9/20 vs 10/20, calibration 8/10 vs 9/10, specificity 7/10 vs 8/10, reject 4/10 vs 5/10, cost/cap/forecast, missing/partial audit, sparse fingerprints, novelty-only vs quality/missing evidence, stale calibration/drift/mocks, route support, repeatable correctness, and incomplete-run precedence. No live network is needed.
