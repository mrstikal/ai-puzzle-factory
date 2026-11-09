# AI Puzzle Designer Protocol (P46)

Status: P46/P47 implement the offline designer contract, deterministic cohort
plan, selected-family proposal schema, pre-solver bounds, prompt adapter,
dry-run CLI, solver-feedback repair loop, diagnostics, and append-only attempt
ledger. They do not construct baseline candidates, run the structural
comparator, render presentation, evaluate humans, or make live calls.

## Cohort plan

`buildDesignerPlanManifest` produces a deterministic manifest for three plan
kinds:

| Plan kind | Root seed | Assignments | Candidate slots | Content calls | Probes | Total calls |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `design_primary` | `puzzle-designer-v1` | 100 | 300 | 400 | 0 | 400 |
| `design_pilot` | `puzzle-designer-pilot-v1` | 20 | 60 | 80 | 2 | 82 |
| `design_mock` | `puzzle-designer-mock-v1` | 100 | 300 | 400 | 0 | 400 |

The primary and mock plans contain ten assignments per family. Each family has
four level-1, three level-2, and three level-3 assignments. The pilot plan has
two assignments per family; the first difficulty is the family ordinal modulo
three and the second is the next difficulty. Text and SVG assignments split
50/50 in the 100-assignment plans and 10/10 in the pilot.

Every assignment has three arms: `baseline`, `ai_one_shot`, and `ai_feedback`.
The baseline arm is code-owned and makes zero AI calls. The AI call ceiling is
one one-shot call plus one feedback-first call plus two repair calls per
assignment, for 400 content calls in the primary plan. The maximum client
transport-attempt count is three times the total logical-call count; OpenRouter
internal provider fallback is excluded.

Assignment IDs are stable, for example `design-text-ranking-01`. Candidate
slot IDs append the arm, for example `design-text-ranking-01-ai_feedback`.
Candidate slots use `slotKind: "designer"` and `lane: null`; they are not legacy
lanes and do not use the legacy `approved` verdict.

Seeds use SHA-256 over the protocol version, root seed, assignment ID, arm
scope, and purpose. Purposes are `options`, `layout`, `baseline`,
`dispatch-order`, and `human-order`. Shared assignment-level decisions use the
`shared` scope. The assignment seed in the manifest is the shared `options`
stream. The AI design itself is not seeded.

## Design proposal contract

A proposal is one strict JSON object:

```json
{
  "family": "ranking",
  "difficulty": 1,
  "spec": { "size": 4, "clues": [] },
  "designIntent": null,
  "presentationSkin": null
}
```

Rules:

- `family` is an exact literal for the assignment.
- `difficulty` is an exact literal for the assignment.
- `spec` is the selected family's existing strict DSL schema.
- `designIntent` is required-null. It is bounded provenance, never shown to a
  solver, reviewer, renderer, or human evaluator.
- `presentationSkin` is required-null. When skin proposals are enabled it is
  either null or a strict closed-catalog object; when disabled it must be null.
- Extra properties, answers, options, visible question/clue/hint/explanation
  prose, SVG/XML, URLs, code-like strings, and arbitrary provider fields are
  rejected.
- Family and difficulty are checked before family-specific parsing so a
  mismatched proposal reports `WRONG_FAMILY` or `WRONG_DIFFICULTY` rather than a
  generic schema error.

The wire schema is compiled from the selected-family Zod schema. It is not a
generic runtime-only schema and is not the legacy spec envelope.

## Closed presentation-skin catalog

The catalog is code-owned in `src/domain/design.ts`.

- Themes: `garden`, `space`, `ocean`, `kitchen`.
- Each theme has twelve distinct labels, at most 32 characters each.
- Entity IDs are family-specific and bounded:
  - ranking `item-0..item-4`
  - matching `person-0..3`, `pet-0..3`, `color-0..3`
  - scheduling `event-0..3`, `resource-0..1`
  - truth `person-0..3`
  - arithmetic `var-x`, `var-y`, `var-z`
  - matrix `glyph-0..3`
  - transforms `tile`, `operation-0`, `operation-1`
  - paths `start`, `goal`
  - symmetry `tile`, `axis`
  - counting `shape-0..shape-2`
- The required entity set is derived from the parsed spec: ranking size, truth
  people count, transform operation count, and counting shape count narrow the
  set. The prompt and compiled wire schema advertise exactly that
  difficulty-specific set; they never advertise the larger family-level union.
- A non-null skin must label every required entity exactly once with a distinct
  label from the chosen theme. Missing, duplicate, extra, cross-family, and
  cross-theme labels are rejected.
- Null skin means the code-owned neutral presentation labels. A skin can never
  change conditions, numbers, relations, query, options, or answers.
- `buildDesignProposalRequest` enables skin proposals by default; callers can
  disable them, in which case the wire schema requires `presentationSkin: null`.

## Bounds

Global DSL bounds are enforced by the existing family schemas. P46 adds the
pre-solver level rules below.

| Family | Level 1 | Level 2 | Level 3 |
| --- | --- | --- | --- |
| ranking | size 4 | size 5 | size 5 |
| matching | no additional structural proxy | same | same |
| scheduling | no additional structural proxy | same | same |
| truth | 3 people; at most one binary statement; no xor | 4 people; and/or allowed; no xor | 4 people; and/or/xor allowed |
| arithmetic | max absolute coefficient 1 | max absolute coefficient 2 | max absolute coefficient 3; at least one inequality present |
| matrix | no additional structural proxy | same | same |
| transforms | exactly one nonidentity rotation | exactly one reflection | one quarter-turn rotation and one reflection, noncommuting |
| paths | active cells 6-12; route target checked after solving | active cells 6-12; route target checked after solving | active cells 6-12; route target checked after solving |
| symmetry | vertical axis | horizontal axis | either axis; at least two known occupied components |
| counting | two shapes; unionCount | two shapes; intersectionAll or exactlyOneShape | three shapes; intersectionAll or exactlyKShapes |

Matching, scheduling, and matrix levels are requested difficulty targets
without an additional structural admission proxy. Paths route length and
arithmetic inequality nonredundancy are checked after solving by P47.

## Prompt and request identity

The prompt asset is `src/ai/prompts/designer-v1/design.txt` and starts with
`PUZZLE_DESIGN_PROMPT_VERSION: v1`.

The system message contains the designer instructions and proposal metadata.
The user message contains only:

- assignment ID, family, and difficulty;
- global bounds, level rules, and allowed operators;
- the selected family DSL schema;
- the selected response schema;
- the closed skin catalog when skin proposals are enabled, otherwise null.

The prompt never contains a baseline spec, witness, answer, options, or human
feedback. It asks for a complete DSL structure, not a fixed parameter template.

One-shot and feedback attempt 0 use the same serialized request, response
schema, and prompt hash. The arm is ledger metadata only and is not part of the
request. Changing family, difficulty, or skin mode changes the prompt hash;
changing family, difficulty, or skin mode also changes the schema hash.

## Configuration

`readDesignerLiveEnvironment` requires only:

- `OPENROUTER_API_KEY`
- `DESIGNER_MODEL`

Optional validated settings:

- `DESIGNER_TEMPERATURE` (0..2)
- `DESIGNER_SEED` (integer 0..2147483647)
- `DESIGNER_REASONING` (`true` or `false`)
- `DESIGNER_REASONING_EFFORT` (`low`, `medium`, `high`)
- `DESIGNER_MAX_OUTPUT_TOKENS` (positive integer, default 8192)

It does not call `readLiveEnvironment` and does not require generator or
reviewer models. Legacy `readLiveEnvironment` keeps its original reviewer
separation contract.

Shared request-builder seams support the designer roles `design`,
`design_repair_1`, and `design_repair_2`. The legacy `REQUEST_ROLES` array,
probe-role array, ledger role parser, mock scenario parser, and preflight probe
counts are unchanged. Designer ledger roles and designer mock scenarios arrive
with P47 and P50.1; until then the legacy parsers explicitly reject them rather
than relabeling a designer call.

## CLI

```sh
npm run designer -- --dry-run --seed puzzle-designer-v1
npm run designer -- --dry-run --pilot
npm run designer -- --dry-run --mock
```

The CLI prints the deterministic plan manifest and exits. Bare execution,
reviewer flags, calibration flags, live/paid flags, and non-fixed seeds are
rejected. P46 implements offline dry-run only.

## Verification

```sh
npx vitest run tests/ai/design-proposal.test.ts
npx tsc -p tsconfig.json --noEmit
npx eslint src/domain/design.ts src/design/assignments.ts src/design/bounds.ts src/ai/config.ts src/ai/schemas.ts src/ai/design-proposal.ts src/cli/design.ts tests/ai/design-proposal.test.ts
```

The test file covers every family and difficulty, wrong family/difficulty,
global schema bounds, pre-solver level boundaries, null and non-null decorative
fields, closed skin mappings, forbidden content, request/schema/prompt hashes,
strict-schema compilation failure, designer-only configuration, legacy role
seams, exact manifest counts, and the dry-run CLI.

## Out of scope

- Repair loop and repair prompts (P47)
- Attempt ledger and SQL migration for designer roles (P47)
- Solver diagnostics, route-length and inequality-essentiality checks (P47)
- Baseline comparison and structural comparator (P48)
- Presentation rendering and assets (P49)
- Human sampler, metrics, decision thresholds, and mock scenarios (P50)
- Live calls, capability preflight, and frozen protocol execution (P51)

## P47 solver-feedback repair loop and attempt ledger

Status: implemented offline. P47 adds the shared-schema migration, append-only
design attempt ledger, independent solver/level diagnostics, bounded repair
loop, repair prompt/adapter, and repository/ledger/budget integration. It does
not construct baseline candidates, run the structural comparator, render
presentation, or make live calls.

### Storage migration 0006

`0006_design_attempts.sql` rebuilds the affected shared tables with foreign
keys temporarily disabled, runs `PRAGMA foreign_key_check` before commit, and
restores the pragmas. It preserves legacy rows, indexes, immutable triggers,
payload hashes, artifacts, monetary reservations, and budget events.

New run kinds are `design_primary`, `design_pilot`, and `design_mock`. New
budget pools are `pilot` and `mock`; the pilot's two probes use the existing
`preflight` pool with the pilot `run_id`. Designer slots use
`slot_kind='designer'`, a nullable `lane`, `assignment_id`, and `arm`, with
ordinals 1-300. Legacy slots remain `slot_kind='legacy'`, lane-scoped, and
ordinals 1-200.

`design_attempts` is append-only and keyed by `(run_id, slot_id,
attempt_index)`. Each row stores role, arm, nullable logical-call/proposal
references, the strict diagnostic JSON, verdict, cost snapshot, timestamps, and
elapsed time. `design_attempt_artifacts` links content-addressed artifacts to
the attempt. Baseline attempt 0 has no logical call and zero AI cost; AI
attempts require a logical call and a known/unknown cost snapshot. A third
repair is rejected.

### Attempt diagnostics

Diagnostics are strict bounded objects with `errorCode`, `evidenceSource`,
`solutionCount`, at most two witnesses, observed `features`, schema path,
message, solver state/limit, option/render evidence, pending checks, and
code-owned `allowedFixKinds`.

- Ambiguity witnesses come from bounded family enumeration and are independently
  verified with the family engine. They are not derived from a missing
  `correctAnswer` or an aggregate count.
- `MULTIPLE_SOLUTIONS` requires two distinct verified witnesses.
- `SOLVER_LIMIT` records the attempted state count and limit and is the only
  inconclusive result that authorizes a repair.
- Schema/bounds failures carry paths; path route length and arithmetic
  inequality nonredundancy are checked after solving.
- Option/render/presentation evidence is injected explicitly. P47 test doubles
  can pass all three; the real pipeline leaves presentation pending until P49.
- A pending check yields `PENDING_CHECKS` and an inconclusive candidate, never an
  accepted one.

### Bounded repair loop

The feedback arm accepts attempt 0 plus at most two repairs. One-shot and
baseline arms have exactly attempt 0. A repair is authorized only by a persisted
deterministic rejection or `SOLVER_LIMIT`, with a saved previous response. Any
diagnostic classified with `evidenceSource: "infrastructure"` (including
option/render/presentation codes) is terminal inconclusive evidence and never
authorizes a repair. An attempt with no usable design response is a generation
error unless the caller supplies an explicit `INFRASTRUCTURE_ERROR` diagnostic. An
accepted attempt must own a saved proposal artifact.

Stop rules are applied after every attempt:

- accepted -> stop accepted;
- generation error -> stop generation_error;
- infrastructure error -> stop infrastructure_inconclusive;
- pending checks -> stop pending_checks;
- solver limit at the repair cap -> stop solver_limit;
- rejected at the repair cap -> stop repair_cap;
- repairable attempt with no pause -> `repair_ready` and `repairPending=true`;
- budget/operator pause -> `*_paused` and `repairPending=true`;
- oversized repair input -> terminal `input_too_large`, preserving the last
  rejected or inconclusive verdict.

The pure reducer keeps the first-attempt summary immutable, even when a later
repair is accepted. A third repair, missing diagnostic, missing saved response,
or out-of-order attempt is rejected with a typed protocol error. The attempt arm
must match the referenced slot arm; the repository rejects a mismatch before
appending any row or artifact.

Repair requests contain the original assignment, the bounded previous proposal
or sanitized invalid object, the diagnostic, and allowed fix kinds. The repair
response must be a complete new proposal matching the same selected-family
schema. Patches, answers, options, visible prose, SVG/XML, code, extra fields,
and a replay of the same family/difficulty/spec are rejected. Repair inputs
larger than 16 KiB are terminal and are not dispatched.

### Repository, ledger, budget, and config

`createDesignerRun` persists a designer plan and its 300 (primary/mock) or 60
(pilot) candidate slots. `getDesignerRun`, `listDesignerSlots`,
`insertDesignerStageResult`, `getDesignerStageResult`, `getDesignerEvents`,
`insertDesignAttempt`, `getDesignAttempt`, and `listDesignAttempts` are
designer-only readers/writers. Legacy `getRun`, `listSlots`, `getSlot`,
`getStageResult`, `listStageResults`, and `getEvents` reject designer records
explicitly instead of relabeling them.

`LedgerRoleSchema` now includes the three designer roles; designer logical
calls use designer candidate slot IDs, designer run kinds, and the primary,
pilot, or mock pool. Pilot probes use `role='preflight'`, a unique probe key,
no slot, and the preflight pool scoped to the pilot run. Budget accounts accept
the matching designer pool and the explicit pilot/preflight probe pool.

The designer live configuration remains one `DESIGNER_MODEL` with the same
validated settings and 8192-token caps for design and repair roles. Legacy
reviewer separation is unchanged. Designer mock scenarios remain P50.1.

### Verification

```sh
npx vitest run tests/design/feedback.test.ts
npx vitest run tests/storage/design-migration.test.ts
npx vitest run tests/storage tests/runner
npm run lint
npm run typecheck
npm run build
```

`tests/design/feedback.test.ts` covers 0/1/2 repairs, solver limits, terminal
errors at every index, first-attempt immutability, third-repair rejection,
path/arithmetic level checks, verified two-witness ambiguity, no key leakage,
cost snapshots, saved-response recomputation, pending checks, pauses, replay,
and oversized repair inputs. `tests/storage/design-migration.test.ts` covers
populated legacy round-trip, hashes, artifacts, monetary evidence, foreign
keys, repeated migrations, the 300-slot designer run, pilot probes, designer
budget pools, append-only attempts, and legacy role/mock boundaries.

### P47 manual acceptance

Use a synthetic trajectory with a first ranking proposal that has multiple
solutions, a repair that returns a unique proposal, and test-double
options/render/presentation evidence. Inspect that the first diagnostic shows
two distinct verified solutions, the repair request contains the original
assignment and diagnostic, the final verdict is accepted, and
`firstAttempt.verdict` remains `rejected`.

### P47 out of scope

Baseline construction and reference corpus (P48), structural comparator (P48),
deterministic presentation and real option/render checks (P49), human sampler
and decision thresholds (P50), designer mock scenarios (P50.1), and live calls
or capability preflight (P51).

## P48 algorithmic baseline and structural originality

Status: implemented offline. P48 adds the code-owned baseline arm, the frozen
1,000-outcome fixture reference, the same-cohort baseline reference, structural
novelty annotation, per-family/modality/difficulty reporting, and a static
reference gallery. It makes zero AI calls and does not render presentation or
claim semantic novelty.

### Baseline arm

`src/design/baseline.ts` uses each family's existing bounded `construct*Spec`
function with the assignment seed. It records the construction trace and
`drawsUsed`, independently solves and verifies the spec, builds and verifies
four distinct A-D options with one key, and for SVG families builds/checks the
code-owned scene and records scene/SVG hashes. A constructed baseline outcome is
solver-verified but remains `presentation: "pending"` and
`verdict: "inconclusive"`; it is not marked accepted in P48.

A bounded construction failure is stored as
`status: "construction_failed"`, `failureCode: "BASELINE_CONSTRUCTION_FAILED"`,
and `verdict: "inconclusive"`. An unexpected exception is a distinct
`BaselineInfrastructureError`, not a baseline construction failure. Failures
remain in the reference and are counted in coverage.

### Frozen and cohort references

The frozen reference has 100 outcomes per family (1,000 total) from the exact
existing fixture tuples: protocol `1.0.0`, root seed `puzzle-poc-v1`, slot IDs
`<family>-fixture-001` through `-100`, purpose `spec`, and the 34/33/33
difficulty pattern. Failed draws and repeated structures are preserved; at
least 95 independently verified specimens per family are required for coverage.
The reference hash covers the complete outcome list and coverage summary.

The cohort reference has the 100 primary baseline assignments and remains
separately identifiable. Both references are strict canonical JSON artifacts:

- `data/design/reference/frozen-reference.json`
- `data/design/reference/cohort-reference.json`
- `data/design/reference/reference-manifest.json`
- `data/design/reference/reference-gallery.html`

`npm run designer -- --build-reference` builds and writes them. Use
`--reference-dir <dir>` to choose another output directory.

### Structural comparator

`src/design/novelty.ts` reuses P21 canonical structures, feature multisets,
`evaluateNearPair`, and P37-style reporting. Comparisons are limited to the same
`(family, domainTokens, queryKind)` scope. Exact structural matches take
precedence (`baseline_duplicate`); otherwise any one-feature-edit pair with a
common feature and `editDistance=1` is `near_baseline`; otherwise `novel`.
Missing or insufficient frozen coverage, an incomplete reference, or failed
comparator evidence is `novelty_unknown`, never automatic novelty. A partial
cohort is reported provisionally, not silently promoted to a complete reference.

The comparator reports exact matches, near matches, feature Jaccard distances,
frozen/cohort membership separately, reference coverage, and per-family/
modality/difficulty tables. Near clusters are connected components of the direct
one-edit-pair graph, not transitive equivalence classes. Distinct counts use
exact canonical fingerprints; repeated novel outputs increase the candidate
count but not the distinct count. First, final, and repair-trajectory views stay
separate. The design representative for one `(assignmentId, arm, fingerprint)`
is chosen deterministically (first-view precedence, then candidate ID), so
first/final views of the same arm collapse without making the report hash
order-dependent. Different arms of one assignment remain separate accepted
candidates and can form an exact cross-arm cluster. `acceptedCandidateCount` is
the arm-aware design count, `acceptedViewCount` is the view count, and report
cells expose `accepted`/`acceptedViews` the same way. `distinctAcrossViews` is
the same arm-aware design count after first/final view collapse, not a separate
fingerprint count. Baseline diagnostics
compare against the frozen reference and exclude the candidate's own cohort
slot. Novelty never changes formal acceptance. Comparator/canonicalization
failures degrade to `novelty_unknown` with a bounded reason via
`annotateNoveltySpec`; empty features and identical canonical data with unequal
hashes remain implementation errors.

The canonical validator now permits reduced clue cores with fewer retained
relations than the original DSL clue floor for ranking, matching, and
scheduling. The original spec still enforces its 3-12/4-12 clue bounds; the
reduced fingerprint core is allowed to be smaller. Arithmetic retains its
2-5 constraint minimum.

The mandatory counting positive uses three shapes with row-major cell sets
`[1,6,7,8]`, `[2,6,7,8]`, `[3,6,7,8]` and otherwise identical level-3 specs
querying exactly two versus exactly three memberships. The comparator reports
`editDistance=1` and Jaccard `33/35`; this is a conservative geometry-reuse
signal, not a duplicate proof.

### Reporting and gallery

`src/reporting/design-metrics.ts` builds a strict novelty report with reference
coverage, baseline diversity/overlap rows, AI annotation rows, exact/near
cluster summaries, distinct accepted/novel counts, and a deterministic report
hash. The static reference gallery shows baseline/reference cards and explicitly
states that presentation is pending and novelty is not semantic or human
quality. The report/gallery escape all text and use no remote resources.

### Verification

```sh
npx vitest run tests/design/novelty.test.ts
npm run designer -- --build-reference
npm run check
```

The focused test builds the 100 primary baseline assignments, validates the
frozen 1,000-outcome reference, exact/one-edit/two-edit pairs, empty-feature
rejection, cross-family isolation, both reference memberships, incomplete/
insufficient reference evidence, AI-AI near clusters, repeated novel versus
distinct counts, first/final de-duplication, completion-order-independent
hashes, and the mandatory counting positive. It also checks bounded
construction failure versus infrastructure failure, zero AI calls, pending
presentation, and strict artifact round-trip.

### P48 manual acceptance

Run:

```sh
npx vitest run tests/design/novelty.test.ts -t "manual inspection" --reporter=verbose
```

The test prints one baseline and one synthetic AI candidate for the same
assignment. Expected: baseline `constructed` / `inconclusive` / presentation
`pending`, annotation `near_baseline`, one near match, Jaccard `0.5`, and
`editDistance=1`. The comparator reports structural distance only; it does not
claim semantic novelty or human quality.

### P48 out of scope

AI generation and repair (P46/P47), deterministic presentation/proof traces
(P49), human evaluation (P50.3+), live calls (P51), and any claim of complete
semantic novelty.

## P50 offline designer completion and mock release

P50 completes the offline designer protocol before any paid pilot:

- `src/design/run.ts` executes the real baseline/one-shot/feedback cohort through
  storage, the conservative ledger/transport, solver, deterministic
  presentation, and terminal verdicts. `--resume` reuses saved responses, never
  resends an ambiguous dispatch, keeps the first-attempt/repair identities, and
  settles a saved response's reservation. Budget-cap increases require an
  explicit acknowledgement.
- `src/design/mock.ts` registers deterministic mock scenarios outside request
  DTOs: first accepted, ambiguous/unsat/schema-invalid then repaired, all
  repairs fail, solver limit, input-level render failure, and generation error.
  Solver-limit and render-failure scenarios are explicitly synthetic
  simulations; implementation/storage/renderer exceptions are separate
  fault-injection runs that pause rather than becoming expected cohort rows.
- `src/reporting/design-metrics.ts` reports every section 9.1 count, planned
  denominator, Wilson interval, repair/novelty/latency/cost/error metric, and
  missing-cost/null-denominator status.
- `src/design/freeze.ts`, `src/reporting/design-decision.ts`, and migration
  `0007_designer_protocol_freezes.sql` implement the append-only pre-run freeze
  and the section 9.3 proceed/revise/reject evaluator. Freeze validation uses
  only pre-run evidence and rejects mock, partial, stale, mismatched,
  source/model/routing-drifted, over-budget, or threshold-edited pilots. DB
  commit precedes `protocol.json` export, and the freeze replays from SQLite.
- `src/audit/design-sample.ts`, `src/audit/design-labels.ts`, migration
  `0008_design_evaluations.sql`, and `npm run audit -- --design` implement the
  fixed family-blocked sampler, opaque public bundle, separate private reveal,
  pending/append-only CSV, provenance checks, and synthetic test-only labels.
  The public bundle contains only puzzle content and opaque evaluation IDs.
- `npm run designer -- --mock --seed puzzle-designer-mock-v1 --max-cost 0`
  runs 100 assignments / 300 candidates with at most 400 zero-cost mock calls
  and no legacy reviewer role. `npm run report` and `npm run export` support
  designer runs, including the static gallery, 300 cards, all families and both
  modalities, attempt evidence, and per-slot puzzle/SVG files.
- `src/design/preflight.ts` validates the designer model against a recorded
  public catalog with one text-family and one SVG-family strict schema. Live
  pilot execution additionally creates two `role=preflight`, `slot_id=null`
  probe calls in a separate preflight budget pool before the 20-assignment
  pilot. P50 does not execute paid traffic.

### P50 verification

```sh
npx vitest run tests/design/resume.test.ts tests/reporting/design-metrics.test.ts
npx vitest run tests/design/freeze.test.ts tests/reporting/design-decision.test.ts
npx vitest run tests/audit/design-sample.test.ts tests/design/preflight.test.ts
npx vitest run tests/design/mock-cohort.test.ts
npm run designer -- --mock --seed puzzle-designer-mock-v1 --max-cost 0
npm run report -- --run <mock-design-id>
npm run audit -- --design --run <mock-design-id> --prepare
npm run check
npm run test:browser
```

## P51 truth designer wire format (protocol revision)

The live P51 preflight revealed that Google AI Studio rejects the recursive truth response schema (`required ref loop` in `operand`). The designer wire format for the truth family is now a flat postfix (RPN) token list:

```json
{
  "family": "truth",
  "difficulty": 1,
  "spec": {
    "people": 3,
    "exactTruthful": 2,
    "statements": [
      { "rpn": [{"kind":"truthful","person":0},{"kind":"truthful","person":2},{"kind":"and"},{"kind":"truthful","person":2},{"kind":"or"}] },
      { "rpn": [{"kind":"truthful","person":2},{"kind":"not"}] },
      { "rpn": [{"kind":"truthful","person":0}] }
    ]
  },
  "designIntent": null,
  "presentationSkin": null
}
```

This example has the unique solution `T0=true, T1=false, T2=true`; it is a syntax and solver-acceptable illustration, not a template to copy.

- `truthful(person)` pushes a leaf; `not` consumes one expression; `and`/`or`/`xor` consume two expressions (left then right). The list must reduce to exactly one expression.
- `truthRpnSpecToCanonical` rejects stack underflow, missing operands, excess operands, out-of-range person IDs, wrong statement count, invalid `exactTruthful`, depth > 2, leaves > 3, and nodes > 7. It never repairs a malformed expression.
- The canonical truth AST, solver, evaluation semantics, canonicalization, and fingerprints are unchanged; RPN is only the provider-facing wire format. `truthSpecToRpn`/`truthAstToRpn` provide the inverse for tests and repair prompts.
- The designer truth schema is `puzzle_design_truth_d1_skin` with a new hash; the designer prompts are version v2. The text preflight probe now uses truth so this schema class is exercised before a pilot.
- Any P52 freeze must use the revised truth schema/prompt hashes and a pilot run executed under this protocol. The final hash-bound pilot is `2f59e287-1e4d-42bc-84e6-e5b575eb4326` (56 accepted, 2 schema-invalid rejects, 2 retained length generation errors, all ten families with at least one accepted AI candidate); the earlier `bfe18...` RPN pilot is retained as behavioral evidence but predates the truth-file hash coverage. The earlier recursive-truth pilot evidence is preserved but is not freeze-eligible.
- `src/families/truth/schema.ts`, `canonical.ts`, and `engine.ts` are included in the freeze `schemaHash`/`sourceHash` coverage, so a post-pilot change to the RPN wire format, parser, canonicalization, or solver changes the frozen configuration hash.

## P52 frozen designer protocol and authorized budget

> **Superseded by the P52 revision below.** Protocol `9cc7d206...` and freeze `67428bc5...` are historical evidence only; they are not valid for P53.

P52 executed the existing P50.2 freeze gate against the accepted P51 hash-bound pilot. It introduced no source, schema, prompt, model, threshold, or test change and made no paid call. The primary cohort has not started.

The first freeze (`7cdf1243...`, cap USD 10, default per-role reserve USD 0.50) is retained as append-only evidence but is superseded and not accepted. The decision-reviewer High finding showed that the P50.2 forecast schema has no projected 400-call total and that the 2x observed projection is USD 10.917, above the then-authorized USD 10. The user authorized a USD 12 cap; the final freeze is `9cc7d206...`. The first record must not be used for P53.

### Frozen identity

| Field | Value |
| --- | --- |
| Protocol hash | `9cc7d206f37ffc00c8f8caaa17e0a33d85b2041d520c9002fcf7482299aa422f` |
| Freeze hash | `67428bc5d8334d19672f4bf0185b66f8b7003b7ca36dd0ecc230c11bd3dfdd76` |
| Frozen at | `2026-11-08T21:03:11.049Z` |
| Pilot run | `2f59e287-1e4d-42bc-84e6-e5b575eb4326` |
| Pilot manifest hash | `56bad92069d4ca7d96d1c2e909cc5ffb7d67c527feafe85981d25ca4a8bf9314` |
| Configuration hash | `83cfb7ee2bae17c5342e7cb6cb56f5b37a390f0fedd72c90db199596e8b80282` |
| Pilot configuration hash | `83cfb7ee2bae17c5342e7cb6cb56f5b37a390f0fedd72c90db199596e8b80282` |
| Primary plan hash | `0e640131fc212612e6aa3661421c1ca4ee845316a22522ead3385a8e7f0a7c0b` |
| Root seed | `puzzle-designer-v1` |
| Protocol version | `2.0.0` |

The pilot and current configuration hashes are equal at freeze time.

The automated configuration hash binds the files listed in `DESIGNER_CONFIGURATION_HASH_FIELDS` (prompts, the truth schema/solver/canonicalization, the designer/domain/ai adapters, presentation, renderer, font, references, lockfile, templates, comparator, metrics, decision evaluator, and human rubric). It does not cover every family engine, family schema, family renderer, or validation/fingerprint module. The 168-file provenance archive covers those files. Before P53, run `npm run freeze -- --verify-provenance data/protocols/9cc7d206.../provenance`; any mismatch is a protocol change and blocks P53. A change to the frozen hashes, provenance archive, model, prompt, schema, or threshold requires a new protocol plus affected pilot evidence; provider churn under the unchanged Balanced policy is not such a change.

### Frozen plan and model

- 100 assignments, 300 candidates, 50 text / 50 SVG, 10 assignments per family, per-family difficulty `(4,3,3)`; 100 candidates per arm.
- 400 logical calls: `design` 200 (100 one-shot first + 100 feedback first), `design_repair_1` 100, `design_repair_2` 100. Baseline AI calls are zero. Maximum client transport attempts are 1,200.
- Model `google/gemini-3.8-flash`; Balanced routing with `providerSort=default`; no BYOK provider keys; `max_tokens=8192`; concurrency 2; default model settings.
- Frozen hashes: prompts `03ab04a7cef34734d3a3d98cf80ea657ace6065f009ae1f5305f06a589757808`; schema `ba7ec7cc9c74c154fe1878ce0e245e9b06636c662caca5c3623957aa0f84643f`; source `446f4ba1c597ffd69cf712b4cf0af0ca72273db1093baefb4c72740841a551f4`; font `7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954`; frozen reference `9412fef5101df4860945adcb3f47b8a16642f78d4a323a4ed0c80b536daed408`; cohort reference `87cbefaff79937b92e3a49acecf1fbf463d44f049cc3f750dc65141558201ba3`; dependency lock `cc544e9e7a6f4c174467c14086904ef0d72d018a75340dab37a96d1fa0d25873`; templates `8e5e130d92162726748a9e73bb73a081dfa023a70a1f4dbe59c42436ab300d67`; comparator `b981d662a22af57f4cee66f7feacd1c629dc28f17f71133735839830c5079f2b`; metrics `010d385d32215f132dcbe5b722ed800c57e15511dfc124132ebe3ea09b4a2eb2`; decision evaluator `df9ef358759acdf306e600bfec4fcf02f364099ea2d7167ce5f10b381b36665c`; human rubric `a62fde6fc86d78264b222b876e5e64a18ac34fb50c7177d300a2f6efca2dd5bf`.

### Frozen thresholds and human plan

The section 9.3 predicates are frozen as `feedbackFinalAcceptanceOverall=0.60`, `feedbackFinalAcceptancePerModality=0.50`, `oneShotFirstAcceptanceOverall=0.40`, `repairSuccessRate=0.20`, `repairLift=0.05`, `feedbackFirstAcceptanceForRepairEvidence=0.80`, `novelAcceptance=0.30`, `novelPerFamily=3`, `distinctNovelStructures=50`, `costPerNovelAcceptedUsd=0.50`, `humanCoreInspected=30`, `humanAiCorePlanned=20`, `humanClearSolved=16`, `humanSolveTimeMaxSeconds=180`, `pairedInterestWinsOrTies=7`, `pairedClarityWinsOrTies=8`, `rejectFeedbackFinalOverall=0.30`, `rejectFeedbackFinalPerModality=0.25`, `rejectOneShotFirstAcceptance=20`, `rejectRepairSuccessRate=0.10`, `rejectCostMultiplier=2`, and `rejectAiGenerationErrors=100`.

The human evaluation plan is frozen as sampler `p50.3-design-sample-v1`, rubric `p50.3-rubric-v1`, at most 30 core candidates, 10 additions, and 40 candidates total. Threshold or rubric changes require a new protocol and new pilot evidence; they cannot be tuned after primary observation.

### Frozen budget and authorization

- Forecast: 400 logical calls, 1,200 transport attempts, per-role reserve USD 4.00 for `design`, `design_repair_1`, and `design_repair_2` (sum USD 12.00), conservative reserve USD 4.00, observed pilot cost USD 0.592451.
- Operator-recorded projection in `budget-forecast-addendum.json`: USD 5.4585955 for 400 calls at observed pilot role costs, USD 10.917191 with the plan's 2x safety margin. The 2x scenario fits the USD 12 cap. The public price snapshot's max-output upper bounds are USD 6.8501775 (flex), USD 13.700355 (standard), USD 15.0703905 (Vertex US standard), and USD 24.660639 (priority); the standard/Vertex US/priority upper bounds exceed the cap and must pause safely rather than overspend. The P50.2 freeze payload has no projected-total field; the freeze gate compares only the conservative reserve (USD 4.00) and the per-role reserve sum (USD 12.00) against the authorized cap. The 400-call projection is validated only by the operator-recorded `budget-forecast-addendum.json`, not by the freeze gate. The cap is a spending limit, not a guarantee that 400 calls complete at the most expensive tier.
- P53 admission reservation: `--reservation 0.03` per call (2x the maximum observed per-call rate), not the CLI default 0.01. The frozen forecast does not override the runtime reservation flag.
- Authorized primary cap: USD 12. The independent operator authorization is `data/p52-primary-authorization.json` (operator `Lexa`, authorized at `2026-11-08T21:03:00.000Z`, SHA-256 `866a6c2a4cfa3b4785d031e65cbb4110227bcb4a6cdd17ea336e14d2b8766ba0`). The freeze payload's own `authorization` block is the P50.2 CLI record (operator `Lexa`, `authorizedAt=2026-11-08T21:03:11.049Z`, `acknowledged=true`); it is not independent proof of the operator's act. P51 authorization does not carry over, and the freeze does not authorize P53 execution without separate user acceptance.
- Routing confirmation: operator `Lexa`, checked at `2026-11-08T20:54:54.000Z`, Balanced/default, no BYOK; freeze payload `routingConfirmationHash` `94d709f04bc8cbbe40059fc7daf46efc1835dd82c002f9aae292beda021f6a8f` (the file SHA-256 is recorded in `docs/PROGRESS.md`).

### Stored evidence and provenance

- The append-only SQLite row is in `designer_protocol_freezes`; its stored payload hash is `40477586f3a4097e0f7e89e30dd4d5239fe5a1f395b8836f783e3e4be04f5764`.
- `data/protocols/9cc7d206f37ffc00c8f8caaa17e0a33d85b2041d520c9002fcf7482299aa422f/protocol.json` is the canonical freeze export and equals the DB payload.
- `data/protocols/9cc7d206f37ffc00c8f8caaa17e0a33d85b2041d520c9002fcf7482299aa422f/provenance/` contains 168 files (145 source, 13 prompt, 8 config, 1 font, 1 license), `manifest.json`, and `schemas.json`. Archive hash `1c4cde088eb654f64d8957f97436e53a32fa08b9f99f00b86ef61439b1b0f4a1`; source hash `8c15e4bc6a3ae5a9d379199e0cb64753af4dcd60c2ea5de9aece58966e4c898d`; configuration hash `406b8ed0c681a1ac4014cc598657aec7206049cd4481bd2a6bcf65ef8a98440e`; Node 24.22.2 / npm 11.19.1; git `a5ee7e4` with dirty true only from uncommitted P52 documentation.
- `price-snapshot.json` is the public OpenRouter endpoints response for `google/gemini-3.8-flash` (7 endpoints, SHA-256 `c48c3d74cc4c26c28e43d4ff02d2fec4f7c7c02b6c16e1e2a3b40aa67386d042`).
- `budget-forecast-addendum.json` is the operator-recorded projected-total/2x scenario (SHA-256 `4a42620f4b7964a50288da23fb2bc6eb1630ac5232e5a56d888d4a7d10d148c5`).
- The freeze, addendum, price snapshot, authorization artifact, and provenance contain no API key, authorization header, `.env`, or environment dump.

### P52 verification

```sh
npm run freeze -- --design 2f59e287-1e4d-42bc-84e6-e5b575eb4326 \
  --max-run-cost 12 \
  --routing-confirmation data/p52-routing-confirmation.json \
  --operator Lexa \
  --reserve-usd 4.00
npm run freeze -- --archive-provenance \
  data/protocols/9cc7d206f37ffc00c8f8caaa17e0a33d85b2041d520c9002fcf7482299aa422f/provenance
npm run freeze -- --verify-provenance \
  data/protocols/9cc7d206f37ffc00c8f8caaa17e0a33d85b2041d520c9002fcf7482299aa422f/provenance
npm run designer -- --dry-run --seed puzzle-designer-v1
npx vitest run tests/design/freeze.test.ts
```

The freeze command returned `ok: true`; the provenance verification returned `ok: true` with no failures; the dry-run returned the same plan hash; the boundary suite passed 7/7. The exact DB/export replay script is recorded in `docs/PROGRESS.md` under P52.

### P52 boundary

P53 was unblocked by the user's acceptance of this named final protocol, thresholds, human-evaluation plan, and authorized USD 12 cap on 2026-11-08, but this protocol was later superseded before the revised primary run. The actual P53 run used the revised protocol `f1f20d4c...`; see the P52 revision and P53 sections below. The freeze did not start the cohort, did not spend money, and did not decide the experiment outcome. Any post-freeze change to the frozen hashes or provenance archive requires a new protocol and affected pilot evidence.

## P52 revision — resume fix and revised freeze

The first P53 primary run `a3925bcd-7550-4c75-9f2f-1fa5a8a185b8` paused after 10 AI calls because actual costs `0.03294975` and `0.034272` exceeded the `0.03` reservation while known cost was only `0.1582533` against the USD 12 cap. Same-run resume was blocked by a P50 admission bug: `src/ai/openrouter.ts` and `src/ai/budget.ts` permanently rejected any run-scoped budget account with a historical `pause` event. A CLI-only workaround changed `src/cli/design.ts` and failed `--verify-provenance` with `MODIFIED_FILE`/`SOURCE_MISMATCH`, so it was rejected. The user chose a protocol revision.

The fix restricts the historical pause-event block to global accounts (`run_id IS NULL`); run-scoped accounts use the run control state, so a resumed run can admit again. The regression test is in `tests/design/resume.test.ts` (“admits a run-scoped account again after a cap increase and resume”). The fix changes the frozen `sourceHash`, so a new protocol is required.

### Revised frozen identity

| Field | Value |
| --- | --- |
| Protocol hash | `f1f20d4c2d9cc61bdd2d8f87920dd788b72ac692a8d0205ae0bc0c97cab8bcce` |
| Freeze hash | `e7d2c9de7e56dcd07a77e2da843515c2e2a74f9d3c7eceb21e31ba5610363485` |
| Frozen at | `2026-11-08T23:59:02.076Z` |
| Pilot run | `b333fd5d-7552-4be6-b976-9bfa35b30bce` |
| Pilot manifest hash | `56bad92069d4ca7d96d1c2e909cc5ffb7d67c527feafe85981d25ca4a8bf9314` |
| Configuration hash | `2438f5100955d26d35a1e0625383adfd9bb2af1f27fbff835f4e1cd5b6443741` |
| Primary plan hash | `0e640131fc212612e6aa3661421c1ca4ee845316a22522ead3385a8e7f0a7c0b` |
| Source hash | `aad1d104b84c83096c0fbd1ed84c1f0896bec647e138481d10ded61cf938e989` |
| Authorized cap | USD 12 |
| Per-role reserve | USD 4.00 each; sum USD 12.00 |
| Observed pilot cost | USD 0.513512 |
| Projected 400-call total | USD 5.063163 |
| 2x conservative projection | USD 10.126326 (fits USD 12) |

The revised pilot `b333fd5d...` completed 60/60 candidates (57 accepted, 2 rejected, 1 generation error), 42 primary pilot AI calls (40 `design` + 2 `design_repair_1`), 42 primary transport attempts, 62 design attempts, cost `0.5135121`; the run additionally holds 2 preflight probe calls charged to the separate USD 0.50 preflight pool (44 run-scoped logical calls in total), with known cost `0.02339775`. The revised provenance archive has 168 files and archive hash `937ececb...`; `--verify-provenance` returned `ok: true`. The budget addendum is `data/protocols/f1f20d4c.../budget-forecast-addendum.json` (SHA-256 `c4d9c351...`), the price snapshot is `.../price-snapshot.json` (SHA-256 `511ce94f...`), and the operator authorization is `data/p52r-primary-authorization.json` (SHA-256 `ddb99d86...`). The user accepted the revised freeze and cap on 2026-11-09.

The old protocol `9cc7d206...`, its `67428bc5...` freeze, and the old primary run `a3925bcd...` are superseded. The old run is marked `failed` with a `run_failed` event and must not be combined with the revised cohort.

## P53 frozen designer cohort

The revised primary cohort ran once against `f1f20d4c...` with `--max-cost 12 --reservation 0.08` and a fresh routing confirmation. Run `e76aa924-ca3f-44c2-855d-edfc229d83a1` is `completed`: 100 assignments, 300 candidates, 300 terminal, 292 accepted, 7 rejected, 0 inconclusive, 1 generation error; 211 AI logical calls (200 `design`, 11 `design_repair_1`, zero `design_repair_2`); 211 transport attempts; 311 design attempts; known cost `2.566611225`; unknown exposure `0`; reserved `0`; cap USD 12; no pause or overshoot; provider Google for all 211 calls; no reviewer or vision role; wall time about 27.4 minutes.

Formal metrics: baseline 100/100; one-shot 93/100 (7 schema-invalid rejects); feedback first 88/100, final 99/100; 11/11 repairable failures repaired with 11 percentage-point lift; feedback novel 81/100; 87 distinct feedback structures; all families have at least 3 novel final accepted; cost per feedback novel accepted USD `0.016547`; text final 149/150; SVG final 143/150; reference coverage complete. All formal section 9.3 predicates pass.

The decision is `revise` (hash `0f82f320e698a05de51b22b57c128ca577be4b0b2fc8985d48cb7c4111e793e6`) because the four human predicates are `incomplete`; `failedPredicates=[]`, `protocolMatch=true`, `knownPrimaryCosts=true`, `genuineHumanLabels=false`, `mockEvidence=false`. This is the expected P53 boundary before P54, not a formal failure. The run is exported under `data/runs/e76aa924-ca3f-44c2-855d-edfc229d83a1/` with candidates, attempts, requests, results, summary, manifest, HTML report, and decision.

The plan's P53 example command shows `--max-cost 10`; the accepted revised freeze authorizes USD 12, so the executed command used `--max-cost 12`. The plan's example also uses `--full`; the CLI exposes the primary plan as `--primary` (and defaults to it), so the executed command uses `--primary`. The revised addendum and this run use `--reservation 0.08`, not the superseded `0.03`.

P54 must import genuine blinded human evaluation before any `proceed` recommendation. P53 was accepted by the user on 2026-11-09; the cohort must not be rerun or retuned after observing these results, and P53 alone cannot decide the experiment outcome.
