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
