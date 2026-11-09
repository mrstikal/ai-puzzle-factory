# AI Puzzle Factory: Auditable Proof-of-Concept Implementation Plan

Version: 2.0, 2026-11-07. Language of code, prompts, puzzle content, and documentation: English. Communication with the user: Czech.

This document replaces the implementation instructions in `AI_PUZZLE_FACTORY_EXPERIMENT_PLAN_base.md` and `AI_PUZZLE_FACTORY_EXPERIMENT_PLAN_old.md` (v1.1). Those documents and `EXAMPLE_ONLY_AI_VOICE_NOTES_IMPLEMENTATION_PLAN.md` are historical/reference material, not additional requirements to execute. This is a plan, not evidence that the application, tests, paid experiment, or human evaluation have already been performed.

Version 2.0 direction: **AI designs, the algorithm proves.** The AI Puzzle Designer becomes the primary technology. The deterministic family DSL, solvers, option builders, renderers, storage, ledger, runner, and reporting infrastructure from P01-P45 are retained. The AI reviewer, alignment reviewer, and vision reviewer roles are removed from the primary protocol; they remain only as legacy, non-gating code from the accepted offline baseline. The live/human sequence P46-P53 of version 1.1 is superseded by the designer sequence P46-P55 below.

Historical note: version 1.1's P46 live compatibility probes and P47 human calibration-label verification were executed and accepted as historical evidence. The exploratory P48 reviewer calibration and paths diagnostics did not produce an accepted reviewer contract. Version 2.0 does not treat that evidence as a gate and does not authorize further reviewer calibration. No v2.0 code from P46-P55 below is implemented yet.

## 1. Objective and Fixed Scope

Test whether an AI designer can create original, formally verifiable logic puzzles inside ten bounded DSLs, and measure first-shot output and bounded solver-feedback repair against the existing algorithmic generator. The AI's creative act is design of logical structures, relations, rules, combinations, and target difficulty within a family DSL. The independent solver proves existence, uniqueness, and answer/option correctness. Separate deterministic validators check spec-to-scene/template correspondence and rendering invariants; approved code-owned renderers/templates are the trusted presentation boundary, not a solver proof of English meaning or human perception. AI reviewers are not part of the primary protocol.

The experiment has five pre-registered questions:

- **H1 First-shot design:** can the AI produce formally accepted designs at a useful rate without repair?
- **H2 Feedback repair:** can the AI use structured solver diagnostics to repair its own rejected designs, and how much does final acceptance improve over the first attempt?
- **H3 Originality:** are AI designs structurally distinct from the algorithmic baseline and from each other, and how many different structures does the AI produce?
- **H4 Human quality:** in a blinded human evaluation, are AI designs at least as clear, correct, and interesting as the algorithmic baseline?
- **H5 Cost and reliability:** what do calls, repairs, tokens, latency, and unknown exposure cost per accepted and per novel accepted puzzle?

The primary designer cohort contains exactly 100 fixed design assignments: 50 text and 50 SVG, ten per family, with per-family difficulty counts `(4,3,3)`. Every assignment is attempted by three arms: the existing algorithmic generator (`baseline`), one AI design call (`ai_one_shot`), and one AI design call followed by at most two solver-feedback repairs (`ai_feedback`). The cohort therefore contains 300 candidate slots. The first AI attempt is always recorded separately from repairs, so repair success cannot hide first-shot quality.

In scope: a local TypeScript CLI; bounded family DSLs; independent enumeration/checking; deterministic options and SVG/PNG rendering; an AI design adapter and solver-feedback repair loop; an algorithmic baseline; structural novelty/diversity comparison; code-owned presentation templates and proof-derived hints/explanations; durable attempt/cost accounting; offline reports; a deterministic blinded human evaluation; and an explicit proceed/revise/reject decision.

Out of scope: AI text/vision/alignment reviewers; reviewer calibration; free-form model prose in the visible puzzle, raw SVG/XML, executable code, answers, or options supplied by the model; arbitrary puzzle invention outside the ten DSLs; unbounded theorem proving; image-generation models; semantic repair by a second model; paid adjudication; automatic replacement of failed assignments; remediation; and any claim that a solver proves human readability or general intelligence. The AI may choose decorative story themes and entity labels only through a closed catalog and approved templates; it cannot change the verified conditions. The primary human comparison holds the presentation skin constant so that it measures puzzle structure, not naming.

The repository currently contains the implemented P01-P45 offline baseline and the legacy reviewer/calibration code. Do not assume that P46-P55 exist. Do not reintroduce reviewer roles into the designer protocol.

## 2. Execution Rules for the Coding Agent

- Execute P01 through P55 in order. P01-P45 are implemented and accepted; do not re-run them unless a change affects their contracts. P46-P50 are offline implementation assignments; P51 and P53 are explicitly authorized live assignments; P52 is a pre-run freeze; P54 is a genuine human evaluation; P55 is final synthesis. Do not implement several phases silently in one assignment.
- Each phase inherits all previously accepted phases. Its explicit prerequisites identify the capabilities it actually consumes; all prerequisite numbers must be lower than the phase number.
- A normal implementation assignment is one bounded capability, normally three to six code/test files plus small registry or documentation edits. Family engines and visual rendering are separated where their combined workload would be excessive. If an assignment cannot fit one focused session, split it before implementation and preserve the dependency ordering; never silently omit its negative tests.
- Before editing, read `agent-memory/index.md` and applicable baseline notes, state which notes and invariants are active, and inspect the existing worktree. Do not overwrite unrelated changes. Do not update project memory without an explicit request; list numbered memory proposals instead.
- Use English in new files. Preserve existing documents, `.gitignore` entries, and unrelated configuration. Do not create Agent Manager sessions/worktrees, commit, or push unless separately requested.
- `npm run check` must never contact OpenRouter. Mock tests deny unexpected network calls and run without an API key. Native dependencies and browser binaries are local tooling, not a reason to silently switch the chosen architecture.
- The phase report must state phase ID, `implemented/offline-verified/live-unverified/blocked` state, changed files, observable behavior, exact commands and results, and manual acceptance steps. A command not executed must be marked `NOT RUN`, not passed. Update `docs/PROGRESS.md` with the same facts.
- Request acceptance explicitly after a future implementation phase. End that report with the exact Czech call-to-action prefix `Otestujte nyní, zda…` and the concrete manual observation specified by the phase. Wait for acceptance before the next phase. A phase blocked on authorization or human labels is not accepted by agent assertion.
- This document does not authorize API expenditure or a full experiment. Live work requires the user's explicit budget authorization as well as the CLI's `--live --allow-paid --max-cost` flags. Flags alone are not authorization. Do not read, print, or transmit `.env` or API keys in reports.
- The v2.0 primary protocol must not call `blind_text`, `blind_vision`, `alignment_text`, or `alignment_vision` roles. The legacy code may remain for historical tests, but it is not a gate. A phase that reintroduces an AI reviewer into the designer acceptance path fails its scope.
- P01-P45 below describe historical ownership, commands, and accepted behavior under v1.1; references from those phases to sections replaced by v2.0 are not instructions to retrofit designer quotas or remove historical tests. Sections 1-10 and P46-P55 govern new designer work. P50 has separately accepted offline subphases; every designer code path, migration, evaluator, and CLI needed by P51-P55 must exist before the first paid pilot. P51-P55 consume that implementation and record evidence only, with no source edits that would invalidate the pilot/freeze hashes.

## 3. Locked Architecture and Decisions

| Area | Fixed decision | Reason and boundary |
| --- | --- | --- |
| Runtime | Node.js 24.22.2 LTS, TypeScript strict ESM, npm | A supported LTS line with a fixed patch, not the moving `latest` alias. Record OS, Node, and npm versions. |
| Dependencies | Exact installed versions in `package.json` and `package-lock.json`; `npm ci` thereafter | Resolve compatible releases during P01/P03/P10/P23/P39, record them, and freeze before live evidence. No caret ranges. |
| Core validation | Zod 4 strict objects and `z.toJSONSchema()` | One runtime schema source; do not add the incompatible Zod-3-only schema converter. Unsupported provider schema features fail preflight, not silently weaken validation. |
| Formal solving | Pure TypeScript finite enumeration and separately implemented predicates | The domains below fit explicit search caps. No Z3, remote solver, `eval`, or generated executable code. |
| Persistence | `better-sqlite3`, WAL, foreign keys, SQL migrations | SQLite is the source of truth; JSON/CSV/HTML are regenerable exports, not recovery state. |
| Writer exclusion | `proper-lockfile` on the database, 30-second stale timeout, 10-second update | Only one mutating CLI process at a time. The two worker tasks belong to that process. Read-only reports use a consistent SQLite read transaction. |
| Money | `decimal.js`, nonnegative decimal USD strings in SQLite/JSON | Never sum money with binary floating point. Unknown actual cost is `null`, never zero. |
| Provider | Native `fetch` to non-streaming OpenRouter Chat Completions with Balanced (Standard) routing | OpenRouter selects providers dynamically and provider fallback stays enabled. No fixed provider, SDK retries, router plugins, tools, web search, automatic model substitution, or response healing. |
| SVG/PNG | Typed code-owned scene, safe serializer/parser using `saxes`, `@resvg/resvg-js`, `pngjs` | Models never supply XML. Use a pinned vendored DejaVu Sans TTF with its license; disable system fonts. |
| CLI | `commander`, `dotenv` loaded only by live CLI entry points | Library imports and tests cannot implicitly load credentials or start work. |
| Tests | Vitest; ESLint flat config; TypeScript; Playwright Chromium for the offline gallery | Designer tests arrive in P46-P55. Legacy reviewer/calibration tests remain historical and must not gate the designer protocol. Browser tests stay outside Vitest. |
| Reports | Static escaped HTML/CSS/vanilla JS, local PNG files, JSON/JSONL/CSV | Must work from `file://` without a server or external CDN. No raw model HTML or raw untrusted SVG embedded in HTML. |
| Experiment language | English with fixed code-owned entity labels | Natural-language aliases cannot change entity identity. Difficulty 1-3 is a generation target, not a validated psychometric score. |
| AI design | One `DESIGNER_MODEL` per designer run; no reviewer/vision/alignment roles in the primary protocol | The experiment tests one designer model against a deterministic judge and an algorithmic baseline. Model comparison is a separate protocol. |
| Designer cohort | 100 assignments × 3 arms = 300 candidates; 400 AI calls maximum; first-attempt and final metrics separate | Assignment-blocked comparison with two separate AI first responses; repair cannot mask first-shot quality. |
| Primary runs | One immutable first attempt per AI arm/assignment; feedback up to two repairs; baseline one standard construction; no replacement | Failed attempts remain in the cohort. The first-attempt verdict is never overwritten. |
| Semantic boundary | AI design proposal → strict schema → deterministic solver proof → code-owned options/renderer/presentation → blinded human evaluation | No AI reviewer decides acceptance. A solver proves formal correctness, not human readability. |
| Human evaluation | Deterministic 10 family triplets (30 core candidates) + up to 10 additions; blind to arm | Measures correctness, clarity, interest, difficulty, and solve time on a bounded sample; not a population guarantee. |

No coding phase may choose a different solver, database, design protocol, or quota. Role model IDs, the Balanced routing policy, request limits, and authorized budgets are operational inputs selected and frozen in P51-P52. Serving provider IDs are observed request metadata, not frozen inputs. The designer protocol has one model role; the legacy generator/reviewer separation is not a v2.0 requirement. If the model/capability/budget gates cannot be satisfied, live execution is blocked; mocks do not waive those gates.

## 4. Experiment Manifest and State Contracts

### 4.1 Immutable Designer Plan

Families in stable order: `ranking`, `matching`, `scheduling`, `truth`, `arithmetic`, `matrix`, `transforms`, `paths`, `symmetry`, `counting`.

| Modality | Families | Assignments/family | Difficulty per family | Total assignments |
| --- | --- | ---: | ---: | ---: |
| Text | First five | 10 | `(4,3,3)` | 50 |
| SVG | Last five | 10 | `(4,3,3)` | 50 |
| All | Ten | 10 | 40/30/30 overall | 100 |

Each assignment is attempted in three arms: `baseline`, `ai_one_shot`, and `ai_feedback`. The cohort has 300 candidate slots: 100 per arm. The baseline and AI arms share the same assignment ID, family, difficulty, and assignment seed. The AI receives a design brief with family, difficulty, and a structural-originality instruction; it does not receive the baseline spec, a hidden witness, the answer, options, or human feedback. The baseline arm calls the existing family `generateSpec(seed, difficulty)` once with its normal bounded internal construction (at most 64 draws); it receives no AI feedback. The one-shot arm gets exactly one design call. The feedback arm gets one design call plus at most two repair calls with structured solver diagnostics. The first attempt is always stored and counted separately.

Fixed root seeds: `puzzle-designer-v1` for the primary cohort, `puzzle-designer-pilot-v1` for the pilot, and `puzzle-designer-mock-v1` for the offline mock cohort. Assignment IDs are stable, for example `design-text-ranking-01`; the three candidate slot IDs append their exact arm, for example `design-text-ranking-01-ai_feedback`. `assignmentOrdinal` is 1-100. Derive independent SHA-256 streams over protocol version, root seed, assignment ID, arm, and purpose (`options`, `layout`, `baseline`, `dispatch-order`, `human-order`). For shared assignment-level decisions use a fixed `shared` scope instead of an arm. A hash-counter PRNG with tested golden vectors and unbiased bounded integers drives all local randomness. Do not use `Math.random()` or consume a shared RNG from asynchronous workers. The AI design itself is not seeded; the model's response is the creative input. Local seeds never make the remote design deterministic. The reference corpus uses its own already fixed fixture seed tuples, disjoint from pilot/primary assignments.

`--dry-run` prints a deterministic `DesignerPlanManifest` (protocol version, run kind, assignment tuples, seeds, quotas/difficulties, arm counts, logical request count estimate by role, and maximum client HTTP transport-attempt count) and performs no generation, database write, model call, or image rendering; it requires no model configuration or API key. The attempt ceiling excludes OpenRouter's internal provider fallback operations. Use the no-early-failure ceilings in section 8.3, not a promise of observed success. A pilot has exactly 20 assignments: two per family, ten text and ten SVG. Its purpose is integration and cost evidence, not a substitute for the primary cohort. Assign pilot difficulty by family ordinal modulo three and the next difficulty for the second assignment.

The designer run manifest extends that plan with evidence kind (`mock|live`), run UUID, arm/model/routing-policy configuration, operator routing-settings confirmation, output limits, concurrency, budget, timestamped capability/price snapshots and reservation method, prompts/schema/source/font hashes, baseline generator version, frozen reference-corpus hash, structural-comparator version, presentation/proof-template version, human sampler/order/rubric version, metrics and decision-evaluator versions/source hashes, thresholds, dependency lock hash, runtime versions, and creation time. Record actual serving providers in the request ledger; catalog membership and observed provider identities are evidence, not immutable role configuration. Compare `DesignerPlanManifest` hashes for deterministic assignment plans; hash the entire redacted run manifest for evidence integrity. Mock configuration is explicitly synthetic. Preflight has two design probes; the legacy 40-fixture calibration pack is not part of the designer cohort.

Pilot/primary compatibility compares a named common-protocol projection (source, schemas, prompts, model/settings, routing policy, caps, reference, templates, metrics/evaluator, and rubric), not equality of whole run manifests: their IDs, seeds, timestamps, quotas, and authorized run budgets necessarily differ. Freeze both manifests and the common projection so permitted operational differences cannot hide semantic drift.

### 4.2 Family and Candidate Types

Use a strict discriminated union on `family`; do not accept a free-form `constraints: string[]`. Each family owns its bounded specification and answer type. A `FamilyEngine<S,A>` provides `schema`, `generateSpec(seed,difficulty)`, `enumerateSolutions(spec)`, `verifyAnswer(spec,answer)`, `makeOptions(spec,answer,seed)`, `visibleRules(spec): VisibleRules`, `facts(spec)`, `canonicalData(spec)`, and deterministic test mutations. Implement these methods in the family's `engine.ts`; no agent chooses a new rules-file architecture. `VisibleRules` has `domain`, `closedWorld`, `target`, `operations`, and `conventions`; the first four are nonempty code-owned strings/arrays, and conventions may be empty only when no coordinate/counting convention applies. Visual renderers register separately only after their rendering phase is complete. Registration must not import a future or placeholder renderer.

The AI designer returns a `DesignProposal` with `family`, `difficulty`, `spec` (the existing strict family union), an optional bounded `designIntent` (provenance only, never shown), and an optional `presentationSkin` from a code-owned closed catalog. The proposal never contains answers, options, free-form visible prose (question/clue/hint/explanation), SVG/XML, or code; the optional skin may contain only bounded decorative entity labels from the closed catalog. The spec may use any combination of the family's allowed fields within its bounds; it is not limited to the baseline constructor's templates. Code validates the schema and bounds, independently solves/checks, constructs exactly four options and the key, renders, and assembles the deterministic presentation. The first attempt and every repair are append-only `design_attempts` records.

Provider wire schemas make every declared property required: optional `designIntent` (maximum 400 characters) and `presentationSkin` use explicit `null`, not omitted properties. Compile a selected-family/difficulty schema rather than ship unsupported refinements and hope the provider enforces them; runtime validation still checks the outer assignment identity, nested spec family, all bounds, and catalog membership independently. Represent a non-null skin as a strict `{theme, labels:[{entityId,label}]}` object with bounded arrays, not a dynamic `record`/schema-valued `additionalProperties`; every nested property is required too. Skin IDs/labels come only from the closed catalog, map required entity IDs one-to-one with distinct labels, and use at most 32 characters per label; arbitrary safe-looking strings are not catalog members. Null skin uses neutral labels. Keep the same wire contract for design and repair.

`SolveResult` contains `solutionCount` (exact within the bounded domain), `answerCount`, `correctAnswer`, proof facts/witness, enumerated-state count, and checker version. Construction and checking must not share the generator's hidden witness as their result. Constraint families require an exhaustive domain scan. Functional visual families require exhaustive checking of their finite input cells/operations and a constructive uniqueness proof; they must not enumerate an exponential set of unconstrained images. Each family section defines the required result. Reaching a state/time cap is `SOLVER_LIMIT`, not proof of uniqueness.

Candidate snapshots are append-only: `assignmentPlan`, arm, optional `designProposal`, first-attempt verdict, every repair attempt, final spec, formal proof, deterministic option values/order, visible presentation, SVG/PNG assets and hashes, deterministic checks, structural fingerprint, novelty annotation, final design verdict, and timestamps. Missing stages remain explicit `null` with a reason, not invented successful records. Keep full sanitized raw model responses and parsing errors even when a usable puzzle never exists.

Options are always constructed by code, exactly four, labeled A-D after a seeded permutation. The option order is stored before evaluation; the correct label is computed from value equality after shuffling. Check both semantic distinctness and rendered distinctness; compare normalized option content with the A-D label layer excluded, otherwise identical values under different letters would appear visually distinct. No model supplies options or a trusted answer key. The AI may supply only a formal spec and an optional decorative skin; the skin cannot alter entity identity, conditions, numbers, relations, the query, or the options.

### 4.3 Checkpoints and Design Verdicts

Workflow stages for a designer candidate: `planned -> design_proposed -> formal_checked -> presentation_ready -> terminal`. A failure can terminate earlier. The baseline arm skips `design_proposed` and goes `planned -> formal_checked -> presentation_ready -> terminal`. Repairs add `design_attempts` rows; they do not create a new workflow stage or overwrite attempt 0. Run control states (`running|paused_budget|paused_operator|interrupted|completed|failed`) are separate from candidate quality verdicts. Unstarted or paused slots are not `generation_error` merely to make a run look complete.

Each attempt owns its own schema/solve/options/render/presentation evidence. Candidate-level stages are committed only once for the selected final attempt; earlier failed or repaired attempts remain in the attempt ledger, never reinsert `formal_checked`/`presentation_ready` at the same candidate stage/version, and never advance a candidate to terminal while an eligible repair is pending. Persist intent in `logical_calls` and raw response through `request_attempts.raw_response_artifact_id` before evaluation; these are the pre-verdict checkpoints. Do not promise persisted intermediate solver/options/render state: after a crash, recompute that bounded deterministic work from the saved response under the same source/settings, with no new model call. Baseline pre-verdict work recomputes from its saved assignment seed. Insert the immutable assessed `design_attempts` row and its `design_attempt_artifacts` links atomically only after the verdict/evidence is known. Resume uses that same attempt identity, never updates an immutable row or invents a new call.

| Verdict | Exact meaning |
| --- | --- |
| `accepted` | Strict schema and bounds pass; the independent solver proves exactly one full solution; code constructs four semantically/visually distinct options with one correct answer; renderer/scene validation and deterministic presentation checks pass. No AI reviewer is involved. |
| `rejected` | A declared design-admissibility invariant is disproved: schema/bounds invalid, unsatisfiable, nonunique solution/answer, or a proven input-level option/renderability violation. Store the proof/evidence. Code-generated wrong keys, scene mappings, and template contradictions are infrastructure-inconclusive, not repairable AI mistakes. |
| `inconclusive` | Solver limit, infrastructure uncertainty, or incomplete evidence; not a formal rejection. |
| `generation_error` | No usable design response due to model refusal, malformed/truncated JSON, timeout, or provider failure. Preserve every request and cost. |

`novel`, `near_baseline`, `baseline_duplicate`, and `novelty_unknown` are annotations, not verdicts. A formally accepted candidate can be novel or a baseline duplicate; the metrics report both. The design verdict reducer is pure and stores the first-attempt verdict separately from the final verdict. Precedence for each attempt is: no usable complete JSON response -> `generation_error`; parsed but schema/bounds-invalid proposal or a proven input-admissibility violation -> `rejected`; otherwise incomplete/limit/infrastructure evidence -> `inconclusive`; all required checks passed -> `accepted`. A valid JSON object outside the schema is therefore repairable, while malformed/truncated JSON is not. Unknown cost is recorded independently and does not reverse a quality verdict. The final verdict is the last assessed attempt under the stop rules, retaining every previous failure code with its attempt index. The legacy `approved/rejected/inconclusive/generation_error` reducer P31 is not used for designer candidates.

Persist failure codes with stage, severity, and evidence source (`deterministic|model|human|infrastructure`). Codes include `DESIGN_SCHEMA_INVALID`, `DESIGN_OUT_OF_BOUNDS`, `UNSAT`, `MULTIPLE_SOLUTIONS`, `MULTIPLE_ANSWERS`, `SOLVER_LIMIT`, `DUPLICATE_OPTION`, `OPTION_KEY_MISMATCH`, `SVG_RENDER_INVALID`, `PRESENTATION_INVALID`, `DESIGN_REFUSED`, `DESIGN_TRUNCATED`, `API_ERROR`, `BASELINE_CONSTRUCTION_FAILED`, and `COST_UNKNOWN`. Multiple codes may coexist; a deterministic precedence table in P47 chooses the one primary verdict. The first-attempt verdict is immutable even when a repair succeeds.

Also distinguish `DESIGN_JSON_INVALID`, `REPAIR_INPUT_LIMIT`, `CHECKER_ERROR`, and `RENDERER_ERROR` so parse/input/implementation failures do not silently become schema or solver disproofs. `REPAIR_INPUT_LIMIT` prevents the next dispatch and ends that repair opportunity with an explicit stop reason; the last assessed attempt's quality verdict remains unchanged. It is not a fabricated new model attempt or permission for another content call.

A baseline construction failure after its bounded 64 draws is recorded as `inconclusive` with `BASELINE_CONSTRUCTION_FAILED`, not as a model `generation_error`; it remains a baseline non-acceptance in the planned denominator.

Human evaluation labels and final decision records are append-only evidence, not edits of primary snapshots. A later human discovery can block `proceed`; it cannot rewrite first-attempt acceptance statistics. There is no automatic upgrade from a repaired candidate's final verdict to its first-attempt verdict.

### 4.4 Persistence Layout and Ownership

Use `data/experiment.sqlite` with migrations in `src/storage/migrations/`. Core tables are `runs`, `slots`, `stage_results`, `artifacts`, and `events` (P03); request tables `logical_calls`, `request_attempts`, and `budget_events` arrive in P23; `human_labels` arrives in P42, `protocol_freezes` in P43, and the legacy reviewer/calibration tables remain historical. P47's `0006_design_attempts.sql` preserves/migrates the shared schema and adds append-only `design_attempts` plus `design_attempt_artifacts` keyed by `(run_id,slot_id,attempt_index,role)`, with foreign keys to the assessed attempt and content-addressed artifact. A baseline attempt-0 row has `logical_call_id=null` and zero AI cost. P50.2 adds `0007_designer_protocol_freezes.sql`; P50.3 adds `0008_design_evaluations.sql`. P52/P54 only consume these tables, never add post-pilot/freeze migrations or overload legacy calibration/audit tables.

The preserving migration is not just a new attempt table. Existing SQL/types cap ordinals at 200, require `spec_first|ai_spec`, reject `accepted`/`design_proposed`, and restrict run kinds, roles, and pools. Keep legacy plan/run validators intact and add strict tagged designer plan/run/slot/candidate validators in `src/domain/design.ts`; repository reads dispatch by persisted run kind, with no unchecked casts or fake reviewer records. Add `slot_kind=legacy|designer` (default legacy for existing rows), `assignment_id`, and `arm` to shared slots; `lane` becomes nullable only for designer slots. Conditional checks keep legacy ordinals <= 200 and original lanes, while designer candidate ordinals are 1-300 with exact arm/assignment identity and `lane=null`. Add `design_proposed` and `accepted` only to applicable designer records; preserve legacy stages/verdicts. Check that every designer assignment has exactly its three unique arm slots. The 1,000 reference outcomes are artifact records, not 1,000 candidate slots.

Use `design_primary`, `design_pilot`, and `design_mock` run kinds (evidence kind remains separately `live|mock`). Content-call pools are respectively `primary`, new `pilot`, and new zero-cost `mock`. The two P51 probes belong to the pilot run with `role=preflight`, `slot_id=null`, a unique probe key, and its separate `preflight` pool; content calls keep non-null slots and no probe key. Budget accounts are scoped by run/pool, so one pilot's probe authorization is not silently pooled with another run. Extend the run-kind/pool checks and budgeting mapper for this explicit probe exception, not by calling a pilot `full` or `smoke`. Rebuild affected `runs`, `slots`, `stage_results`, `logical_calls`, `request_attempts`, and `budget_accounts` CHECK constraints safely through the migrator as needed; preserve all rows, foreign keys, indexes, immutable triggers, payload hashes, and monetary evidence. Update repository/ledger/event parsers alongside SQL. Migration tests must open a populated legacy database, migrate twice, round-trip a full 300-slot designer run plus pilot/probes, and pass foreign-key validation without changing historical hashes.

Unique keys: `(run_id,slot_id)` for a design candidate, where the slot ID encodes assignment and arm; `(run_id,slot_id,stage,version=1)`; `(run_id,slot_id,role)` for logical calls, where designer roles are `design`, `design_repair_1`, and `design_repair_2`; `(logical_call_id,attempt_index)` for transport attempts; `(run_id,slot_id,attempt_index)` for design attempts; and content hashes for artifacts. Calibration/preflight calls may have a nullable slot ID and a separate unique fixture/probe key. Include an explicit `CHECK` constraint for this distinction; SQLite `NULL` uniqueness alone is insufficient. Extend the logical-call and request-attempt role enums with the designer roles through a migration that preserves existing rows; keep the legacy roles for historical runs.

Commit a complete stage result, its artifact bytes, and the next checkpoint in one transaction. Persist stage `started_at`, `finished_at`, and measured `elapsed_ms`; incomplete durations are null. Store source SVG, PNG, presentation JSON, raw responses, design attempts, solver diagnostics, and request bodies in the database before exporting files. Bound individual JSON/response artifacts to 2 MiB, SVG to 256 KiB, and PNG to 1 MiB. Restrict exports to safe run UUIDs and controlled filenames beneath `data/runs/<run-id>/`; never derive a path from model text. Atomic file replacement is sufficient for regenerable exports.

The attempt row stores a cost snapshot and its logical-call/transport references, not mutable billing truth. Later reconciliation appends monetary evidence in the existing ledger; current totals are derived from that ledger, never from summing stale attempt snapshots or counting both snapshot and request charges. Unknown cost remains nullable and cannot require updating an immutable first-attempt row. Novelty annotations are separate append-only derived evidence after reference completion, not edits of earlier quality verdicts.

Store the frozen reference manifest and its outcome/spec/structure artifacts in SQLite's content-addressed `artifacts` table, with strict hash-resolved references; the manifest contains hashes/statuses rather than an unbounded embedded 1,000-spec blob. `--build-reference` exports a regenerable copy, not a file-only source of truth. Store designer freezes in a new append-only `designer_protocol_freezes` table, keyed by freeze hash, with pilot run FK, protocol/plan/common-configuration/source/reference/evaluator/rubric hashes, thresholds, authorized cap, forecast, timestamp, and full strict payload. Do not fabricate legacy `calibration_id`, fixture-label hashes, or its fixed USD 0.10 threshold. `protocol.json` and provenance files are exports of this committed designer record.

P50.3 stores an immutable `design_evaluation_samples` manifest keyed by sample hash/run, with triplet IDs, family/difficulty, matched/fallback kind, candidate members, opaque IDs, seeded order, addition reasons, shortfalls, and public/reveal content hashes. Append-only `design_evaluations` records use `(sample_hash,evaluation_unit_id,revision)` with previous-revision linkage; their strict tagged payload distinguishes a triplet (rankings/pairwise preferences plus member ratings) from a single addition (ratings only). Include auditor identity, pre/post-reveal timestamps, observed choices/time/ratings/defects, and content hashes; revisions cannot change sample membership. FK/hash validation prevents cross-run or unknown members, conflicting ranks/preferences, duplicated core/addition members, or imported labels without actual sample provenance. Add no-update/no-delete triggers to samples, evaluations, and designer freezes.

Export layout: `manifest.json`, `candidates.jsonl`, `requests.jsonl`, `design-attempts.jsonl`, `summary.json`, `results.csv`, `report.html`, `puzzles/<slot-id>.json`, `images/<slot-id>.svg`, `images/<slot-id>.png`, `design-evaluation/sample.json`, `design-evaluation/labels.csv`, and `provenance/`. Request exports contain sanitized request/response metadata, raw bodies, and monetary evidence. Failed candidates still have JSON records and gallery cards, with unavailable assets explicitly marked. Do not put an API key, authorization header, full environment, or `.env` in any artifact.

## 5. Bounded AI Design, Formal Verification, and Presentation

### 5.1 Design Arms and Assignment Protocol

The three arms are blocked by assignment. The baseline arm is the existing algorithmic constructor; the AI arms receive the same family, difficulty, and answer-free assignment brief but not the baseline spec. The two AI first calls are independent draws with identical prompt/schema/settings (arm identity is ledger metadata, not a prompt difference); neither shares or reuses the other's response. Within each assignment, deterministically shuffle their dispatch order and persist the schedule; never systematically run all one-shot calls before all feedback first calls. Repairs follow only their own saved first attempt. H1's primary first-shot estimate is `ai_one_shot`; report feedback attempt 0 separately, not as a paired identical first response or an additional independent confirmation. The maximum remains 400 AI calls.

The assignment seed is used for deterministic options/layout and baseline construction, not as an AI design seed. The brief asks for a complete DSL specification structurally distinct from common patterns; it includes no baseline specs, reference answers, or hidden witnesses. The model may use any valid combination of allowed fields, not a fixed parameter template. Requests are stateless across assignments; this protocol measures observed structural diversity, not a designer remembering or optimizing against its past accepted work.

The one-shot arm accepts exactly one design response. If the proposal fails schema, bounds, solver, option, renderer, or presentation checks, the candidate is terminal. Do not ask the model to fix it, switch to another arm, or replace the assignment.

The feedback arm accepts one first design response and, if it is rejected or inconclusive due to `SOLVER_LIMIT`, at most two repair responses. A `generation_error` or infrastructure-inconclusive first attempt is terminal; do not retry content. The first attempt is always stored and counted separately. A repair is a new logical call with the original assignment, the previous complete proposal, and a structured solver diagnostic. The model must return a complete new proposal, not a patch, answer, option list, or prose. The feedback arm's final verdict is the verdict of the last attempt; its first-attempt verdict remains unchanged for metrics.

Apply the same stop rule after each repair: stop on acceptance, generation error, infrastructure uncertainty, or the second repair. Only an evidenced deterministic rejection or `SOLVER_LIMIT` can authorize the next bounded repair. Budget/operator pauses leave an eligible repair pending, not completed or replaced. A missing last response has no usable new proposal; retain the earlier rejected proposal as history, not as a newly accepted final candidate.

The design pipeline is: strict schema and bounds → independent solver (unique full solution) → code-owned four options and key → renderer/scene validation → deterministic presentation checks → structural fingerprint and novelty annotation. The deterministic solver is the acceptance judge. There is no blind review, alignment review, vision review, reviewer calibration, or AI adjudication in this pipeline.

Every AI attempt is a logical call with its own cost, usage, latency, raw response, parsed proposal, solver diagnostic, and verdict; a baseline attempt has no AI call. The runner may checkpoint and yield between attempts and between assignments. It must not use review scores, novelty results, or human ratings to choose a prettier first version. Failed attempts and their costs remain in the ledger.

If a parsed JSON object fails the schema, send the bounded sanitized parsed value and validation path in the repair request; do not pretend a valid complete proposal exists. The raw response stays in the ledger. Treat prior proposal/design-intent strings and diagnostics as untrusted data, never new prompt instructions. A proposal too large for the fixed repair-input bound is recorded as a terminal typed input-limit failure, not silently truncated or repaired via an oversized call.

### 5.2 Formal Verification and Solver Diagnostics

The family engine remains the only authority on formal meaning. For a design proposal, code parses the spec with the family schema, checks every bound, and calls `enumerateSolutions`/`verifyAnswer` independently of the model. Constraint families require exactly one complete assignment; functional visual families require the contract's constructive uniqueness proof. The solver must not reuse a hidden generator witness as its result. Retain the existing limit of 200,000 enumerated states and a two-second solver guard per bounded job, including option enumeration; canonicalization/proof building must also have explicit frozen work caps. Unit tests assert state/work counts rather than fragile wall-clock timings. Reaching a state/time cap is `SOLVER_LIMIT` and makes the candidate `inconclusive`, not accepted or rejected. An unexpected checker, renderer, or storage exception is an infrastructure defect, not proof that the AI's design is invalid; preserve it and pause affected execution rather than spending repairs to work around broken code.

Only declared input-admissibility failures can be repaired as design defects, for example an illegal relation, nonunique constraints, or a source geometry lacking the required four distinct options. A code-generated wrong key, incorrect spec-to-scene mapping, or template contradiction for an otherwise admissible spec is an infrastructure-inconclusive protocol defect even when a deterministic validator detects it. Pause and fix the owning implementation under a new affected pilot/protocol, not by asking the designer to avoid that valid input. Store all diagnostic codes and their evidence-source classification; a failed deterministic check alone does not establish that the AI is at fault.

The repair diagnostic is a strict, bounded object:

- `errorCode`: one of the deterministic failure codes;
- `solutionCount`: exact within the bounded domain when known;
- `witnesses`: up to two distinct complete solutions when `solutionCount > 1`, to show ambiguity;
- `schemaPath`/`message`: for schema or bounds failures;
- `stateCount`/`limit`: for solver-limit failures;
- `optionDiagnostic`: for input-level insufficient/non-distinct options; a code-generated key mismatch is separate infrastructure evidence, not repair feedback;
- `renderDiagnostic`: for declared input-level renderability failures, not an implementation fault disguised as model feedback;
- `allowedFixKinds`: a code-owned list such as `add_relation`, `remove_relation`, `replace_relation`, `change_parameter`, `change_geometry`, `change_query`, without prescribing the exact answer.

The diagnostic may include two counterexample solutions for ambiguity, because the designer is allowed to see the solution space; it never includes the final visible option key, option text, or human feedback. The repair prompt is designer-facing and is never shown to a human evaluator. The model's repair response must validate against the same `DesignProposal` schema. The repair loop does not reveal the baseline spec or any reviewer/calibration output.

If the first proposal is schema-invalid, the diagnostic is the validation path and a bounded message, not a hidden answer. If the proposal is unsatisfiable, the diagnostic may include the normalized constraint set and the fact that no complete assignment exists; it does not fabricate a minimal unsat core unless the family engine can prove one within its caps. If the proposal has multiple solutions, the two witnesses are sufficient to explain ambiguity without claiming a complete characterization of the solution space.

### 5.3 Deterministic Presentation and Verified Explanations

The primary protocol uses code-owned presentation templates. For each family, templates generate the question, rules, clue text, option text, and title from the verified spec, the code-owned visible rules/facts, and a neutral entity-label set. The AI does not write the visible question, clues, hint, or explanation in the primary protocol. This prevents semantic drift between the verified DSL and the displayed puzzle.

The optional `presentationSkin` may choose a theme from a closed catalog and supply safe entity labels for decorative use. The code validates that every required entity ID is mapped, labels are bounded safe strings with no markup/URLs/instructions, and the template uses them only in approved slots. The skin cannot change conditions, numbers, relations, the query, the options, or the answer. The primary human evaluation holds the skin constant (neutral) for all arms so that the comparison measures puzzle structure, not naming. The AI skin is stored and validated as a secondary creative artifact; it is not part of the primary formal or human comparison.

Hints and explanations are derived deterministically from verified solution steps, not merely from the final witness or reduced fingerprint core. Each step carries `factIds`, a typed bounded deduction, and a code-owned justification. Check entailment, not just consistency with the final answer: all states satisfying the cited rules/facts and previously verified steps must satisfy the deduction; reject an empty premise set of satisfying states, circular/forward references, and deductions supported only by an uncited hidden answer. Functional visual steps use the independently checked cell/operation identities. A witness or a list of true facts alone is not a pedagogical proof trace. If no short local deduction is available, use an explicitly labeled bounded exhaustive-elimination step with its checked domain and survivor counts rather than invent a human-style derivation. The final step establishes the unique complete answer.

The hint exposes at most one verified non-final deduction and must leave at least two possible complete answers under the rules/facts it cites; otherwise use a code-owned strategy hint with no answer information. Both hint and explanation are reveal-only data, never part of the public solving DTO. Visual explanations may refer to observations actually shown in the diagram but cannot introduce hidden observations. P22's assembly, escaping, and fact/reference checks are reused; its legacy `semantic_alignment_pending` state is not changed into an AI-review pass. A separate designer presentation certificate binds the spec, template version, proof trace, choices, and asset hashes. Accept only code-owned template output with valid deterministic checks, while retaining the explicit limitation that this is not proof of human readability.

Human readability is not proven by the solver. The protocol uses fixed renderers, fixed dimensions, contrast/bounds/overlap checks, pinned fonts, and a bounded human evaluation. It does not claim that every accepted puzzle is clear to every person.

### 5.4 Rendering Rules

All visual specs pass a typed scene builder. Serialize only SVG, `g`, `rect`, `circle`, `line`, `polyline`, `polygon`, `path`, `text`, `title`, and `desc` with an explicit attribute allowlist. Disallow scripts, event handlers, `foreignObject`, links, URLs, CSS, external resources, entities/DOCTYPE, processing instructions, animation, filters, and arbitrary model-supplied paths. Escape all text. The serializer is not allowed to pass through an XML fragment.

The AI may propose puzzle geometry and rules within the family DSL, but page layout, colors, fonts, drawing primitives, and option regions remain code-owned. The renderer must handle every valid spec within the family bounds, not only the baseline constructor's outputs. A model never supplies SVG/XML, coordinates as free text, or executable code.

Deterministic scene checks compare critical observed geometry, membership/operation markers, missing/known states, and option identities/order against the validated spec and code-owned choices; bounding boxes and nonempty pixels alone are insufficient. Store this evidence with spec/scene/SVG/PNG hashes. Template tests cover each DSL operator, polarity, operand order, and nesting (especially truth AST parentheses and arithmetic signs), including admissible AI specs outside baseline construction patterns. This is assurance about the trusted renderer/template implementation, not an unbounded theorem about all rendered pixels or natural-language interpretation.

Use a 1024 x 1024 viewBox with four labeled answer regions, fixed layout/padding, stroke width at least 4 source pixels, essential marks at least 12 source pixels, and label font at least 32 source pixels. Renderer-specific layouts reserve disjoint boxes for stem, legend, and choices. Code checks bounds, overlap rules, positive feature contrast, option equivalence after rasterization, and the presence of every critical scene group. Treat parser/rasterizer errors as failures, not blank images.

Render the full PNG and a 512-pixel preview using the pinned font/configuration; record both hashes. For critical groups, require at least eight changed nonbackground pixels between full/removed-group previews on the designated test subset to catch invisible/occluded marks, rather than accepting scene metadata alone. Production checks inspect raster non-emptiness and minimum contrast (4.5:1 labels, 3:1 essential graphics against their background); they are explicitly not proof of human perception. The gallery offers a 1:1 zoom and must not overflow a 360-pixel mobile viewport. No family may depend on color alone or count outline thickness as an extra object.

## 6. Novelty and Duplicate Policy

Store distinct values: `content_hash` over the actual visible presentation/options, `canonical_spec_hash` over the complete normalized parsed DSL (all original constraints, stable IDs, no run metadata), `structural_fingerprint` over the reduced canonical structure below, and separate SVG/PNG render hashes. The request ledger separately hashes raw response bytes. Never call a raw JSON/text hash a structural fingerprint.

Family `canonicalData` removes entity names/IDs through bounded canonical relabeling, sorts commutative constraints, normalizes equivalent orientations/operations where the family contract allows them, and excludes seed, arm, difficulty label, clue order, option order, colors used only decoratively, and prose. Preserve graph relations, mathematical constants, geometry/topology, marked target roles, and admissible-rule class. Do not reduce a fingerprint to the answer or the solved arrangement alone. Each family must pass an equivalent-renaming test and a genuinely different-structure test before it is registered.

For clue-based constraint families, retain the actual complete clue list for presentation, but fingerprint a deterministic reduced core so repeated/easy redundant hints do not automatically buy novelty. First canonicalize the complete typed clue list over the family's allowed relabelings, then visit that normalized list in reverse lexicographic order, removing a clue only if the independent domain truth table still gives the same single complete solution. Use cached per-clue bitsets, not a new 200,000-state search per relabeling. Canonicalize the retained core again, store removed indices, and preserve domain/global rules. This is an irredundant-core proxy, not a claim of complete logical-equivalence canonicalization; different sufficient cores may still need near-duplicate/human inspection. Required tests include exact duplicate, known transitively redundant, and nonredundant added clues. Functional visual specs instead normalize equivalent operations as defined below.

The design cohort uses structural comparison as a measurement, not as a formal acceptance gate. Build a frozen reference corpus in P48 from the existing 100-seed construction fixtures per family (34/33/33 difficulty tuples), using their exact recorded seed tuples and baseline version, not a seed search for diverse outputs. Store all 1,000 construction outcomes and canonical structures; failures remain explicit, repetitions are not replaced, and at least 95 independently verified specimens per family are required for reference coverage. These are separate offline reference artifacts, not extra cohort candidates or AI calls. Freeze their spec/structure hashes before the pilot. Also compare against the accepted baseline candidates in the same cohort (up to 100) as the paired reference; keep frozen-reference and cohort-reference results separately identifiable.

For each family, compare every accepted AI candidate with the union of those references. With exact structural-match precedence, annotate it `baseline_duplicate`, otherwise `near_baseline` for any one-feature-edit baseline pair, otherwise `novel`. A missing/insufficient reference or failed comparator produces `novelty_unknown`, never automatic novelty; a partial cohort's cohort-reference annotation remains provisional until all baseline outcomes exist. Report reference size, successful constructions, distinct fingerprints, difficulty coverage, exact/structural/one-edit counts, feature Jaccard distances, and heuristic limitations. No match against this finite corpus proves invention outside the baseline generator's support.

Compare all accepted AI candidates within each family with each other as well, both within and across arms, and report exact/structural/near clusters and distinct novel fingerprints. First-attempt, final, and repair-trajectory views stay separate; the same accepted proposal present in first/final views is not two independent designs. Repeated novel-to-baseline outputs can increase the candidate-based novelty count but not the distinct count; show both. Do not reject a formally accepted AI candidate solely for novelty. The legacy duplicate barrier remains for legacy runs and is not the designer acceptance gate.

Near clusters are connected components of the reported direct one-edit-pair graph, not equivalence classes: A-near-B and B-near-C do not prove A-near-C. Distinct counts use exact canonical fingerprints, not a transitive collapse of those heuristic clusters.

For baseline novelty diagnostics, compare the baseline arm against the frozen fixture reference only (or explicitly exclude the candidate itself in cohort pair diagnostics); including its own cohort slot as a reference must not manufacture a 100% duplicate rate. Baseline diversity and AI-versus-baseline overlap remain separately reported metrics.

Near-duplicate detection is a declared one-feature-edit heuristic, not semantic equivalence. Section 7.11 fixes features/grouping. Let `removed=sum(max(countA-countB,0))`, `added=sum(max(countB-countA,0))`, and `editDistance=max(removed,added)` so substitution costs one. With unequal structural hashes, at least one common feature, and editDistance exactly one, flag a near pair. Record unit-weight multiset Jaccard `sum(min(countA,countB))/sum(max(countA,countB))` as a diagnostic, not a 0.95 gate: for small token sets that cutoff is unreachable even for one change. Empty features or unequal hashes with identical complete canonical data are implementation errors. Report near pairs and their human false-positive concerns; do not claim complete semantic novelty.

At least the following valid counting positive is mandatory, so the comparator cannot be inert: three shapes on the 5x5 grid have row-major cell sets `[1,6,7,8]`, `[2,6,7,8]`, `[3,6,7,8]`. Compare otherwise identical level-3 specs querying exactly two versus exactly three memberships. They have answers 0 and 3, identical geometry/region tokens, and only `k=2` versus `k=3` differs: editDistance=1 and Jaccard=33/35 when all seven region and 25 cell tokens plus two query tokens are emitted. Both are near-suspect, not proven duplicates. This intentionally conservative geometry-reuse concern can be a human false positive; report it as such.

## 7. Family Contracts

**Designer boundary.** The AI designer may propose any specification that validates against the family schema and the bounds below. It is not limited to the construction templates used by the algorithmic baseline. It may vary the number/type/order of clues, the chosen relations, the geometry, and the query where the DSL allows, but it may not invent operators, entity types, rules, or coordinate conventions outside the schema. The deterministic solver and renderer are the judges; the family construction paragraphs describe the baseline arm, not the only admissible AI designs. Every accepted AI spec must pass the same independent checks as a baseline spec.

The creative freedom is family-dependent: clue-based DSLs allow new relation/constraint combinations, whereas matrix XOR, fixed-axis symmetry, and other functional DSLs chiefly allow new geometries, observations, or operation combinations under a fixed rule class. Report these separately; a high aggregate rate must not be described as invention of new rule systems. Expanding a DSL is a later protocol, not a hidden escape hatch for a failing family.

The following contracts are normative. Each named family phase must implement its own positive, unsatisfiable, ambiguous, wrong-key, equivalent-renaming, genuinely-different, and distractor tests, plus at least 100 deterministic generation seeds spread across all difficulties. A generated specimen must obey bounds and have the required unique result; a failure must be explicit, not silently repaired. Visual formal phases do not require a future renderer or gallery. These 100 seeds per family are baseline engine-construction fixtures, not the v2.0 designer cohort; the designer cohort uses 10 assignments per family and reports its own denominators in sections 4 and 9.

All fact identifiers are code-owned. P04 supplies the common helper: text local clues use `f001` onward in the accepted stored clue order; truth uses speaker order and arithmetic uses constraint-row order. IDs are not part of structural fingerprints or derived from a reduced core. Code-owned rules use fixed `r-domain`, `r-closed`, `r-target`, `r-operations`, and `r-conventions` IDs. SVG observations use `p001` onward in deterministic row/column/operation order. Derived proof facts use a separate `s001` namespace. `facts(spec)` returns local/observation facts; the proof adds derived facts. Explainable references are their merged inventory; model-supplied IDs never define new facts.

For constraint families, require exactly one complete assignment, not merely a unique answer projection over several possible worlds. For functional families, the explicit visible operation determines one complete output; test omitted/contradictory operation metadata as ambiguity/schema failures. Across 100 fixed baseline construction seeds per family (34 level 1, 33 level 2, 33 level 3), require at least 95 successful constructions in aggregate, with every success independently verified and every failure counted; report all three subcounts. This includes truth's two population sizes in the same 100, not an additional 100 per size. An implementation that always returns a bounded failure does not pass. This engineering fixture gate is not the main cohort's quality rate.

**Designer difficulty admission.** Global DSL/schema bounds, unique solution, and four-option requirements always apply. The following are the only additional AI level-admission rules; baseline construction distributions/anchor recipes below are not admission rules. Implement them in `src/design/bounds.ts`, not by wholesale reuse of private legacy `assertDifficultyBounds` in `src/ai/propose-spec.ts`, which includes baseline-specific clue floors, active-cell ranges, and seed-mask populations. Share genuinely identical pure checks without changing legacy semantics. `difficulty` is a target proxy, not demonstrated human difficulty.

| Family | Designer levels 1 / 2 / 3 |
| --- | --- |
| ranking | 4 entities / 5 entities / 5 entities; no anchor recipe or clue-count floor beyond the global 3-12. |
| matching | All levels use the same four-item categories and global 4-12 clue bound; no baseline level-specific clue floor. |
| scheduling | All levels use the same four events/resources and global 4-12 clue bound; no baseline resource/anchor recipe or level-specific clue floor. |
| truth | 3 people and at most one statement containing a binary operator / 4 people with `and` and `or` allowed / 4 people with `xor` also allowed; no `xor` in levels 1-2; global AST caps always apply. |
| arithmetic | Maximum absolute coefficient 1 / 2 / 3; level 3 requires a nonredundant inequality, checked after solving, not the baseline's equality-splitting recipe. |
| matrix | Global XOR/mask/observation bounds at every level; seed-mask population distributions belong only to baseline construction. |
| transforms | One nonidentity rotation / one reflection / a noncommuting ordered quarter-turn-plus-reflection pair; no prescribed source bitmap beyond global bounds. |
| paths | Active cells remain 6-12 at every level; independently solved route has 3-5 / 5-7 / 7-11 edges, not the legacy per-level active-cell distribution. |
| symmetry | Vertical axis / horizontal axis / either allowed axis with at least two distinct orthogonal-connectivity components in the known occupied cells; global 4-10 known occupied cells apply, not baseline per-level populations. |
| counting | Two shapes, `unionCount` / two shapes, `intersectionAll` or `exactlyOneShape` / three shapes, `intersectionAll` or `exactlyKShapes`; each shape may use any globally valid 3-8 cells, not baseline density ranges. |

P46 performs identity/schema and pre-solver level checks; P47 performs route-length and inequality-essentiality checks against independently computed results with the same bounded work policy. Store observed structural features and every level-rule failure. Include valid non-baseline examples and level-boundary negatives so the designer is neither reduced to baseline templates nor silently downgraded. Matching, scheduling, and matrix levels are requested difficulty targets without an additional structural admission proxy; say so in reports and measure perceived difficulty honestly.

An inequality is nonredundant only if removing it and re-enumerating the remaining predicates in the original bounded domain admits at least two assignments. A checker error, work cap, or a reduced predicate set below the serialized DSL's minimum constraint count is not evidence of nonredundancy; evaluate that internal subset directly without changing domain semantics.

### 7.1 Ranking (`text`, P05)

- **DSL:** `size` 4 or 5, and 3-12 clues from `before(a,b)`, `immediatelyBefore(a,b)`, `at(a,position)`, `notAt(a,position)`. Distinct integer item IDs 0..size-1; positions 1..size; no self-relations. Fact IDs are derived from clue indices, not supplied as arbitrary strings.
- **Meaning:** every item occurs once in a strict total order, positions increase left to right, no ties; `immediatelyBefore` means the next position. Ask for the entire order. Enumerate at most 5! = 120 permutations and re-evaluate every clue. Require one full ordering and one valid option.
- **Construction/difficulty:** size 4 for level 1, size 5 for levels 2-3. Choose a witness permutation; build the finite pool of true clues. Add a seeded selection of at most seven non-anchor clues, then at most five true `at` anchors if needed to obtain uniqueness within the 12-clue cap. At levels 2-3, try deleting respectively half/all redundant clues in seeded order while retaining at least three clues and uniqueness. Record anchor/pruning counts; do not always emit the same chain template.
- **Choices/checker:** enumerate all other permutations, favor three violating one or two clues, then independently validate all four. The visible option is a sequence of fixed labels A-E.
- **Fingerprint:** apply section 6's reduced-core procedure, then take the lexicographically smallest retained typed clue list over item relabelings, preserving position constants, direction, adjacency, and size. Do not hash only the final permutation.

### 7.2 Attribute Matching (`text`, P06)

- **DSL:** three typed categories of four items each; 4-12 `same(categoryA,itemA,categoryB,itemB)` or `different(...)` clues between different categories. Categories remain typed; item names are code-owned. Duplicate/contradictory facts are diagnosed explicitly.
- **Meaning:** each base-category item has exactly one item from each other category, with bijections in both categories. Ask for the complete four-row table. Enumerate 4! squared = 576 assignments, including cross-category B-C facts, with one full solution required.
- **Construction/difficulty:** choose two witness permutations. A six-fact anchor set fixing the first three base-to-B and first three base-to-C pairs implies the fourth pairs. Add seeded true positive/negative/cross-category clues up to 12, then remove redundant clues in seeded order. Level 1 retains at least eight clues, level 2 at least six, level 3 may prune to four; all must remain unique. Retain real failures rather than exceeding 12 clues.
- **Choices/checker:** four complete tables; false tables arise from one/two bijection swaps, not invalid repeated category values. Scan the 576-table domain for alternatives if needed. Visible rules explicitly say each category item is used once.
- **Fingerprint:** apply section 6's reduced-core procedure, then minimize the retained signed, category-typed relation graph over independent permutations of the four IDs in each category (24 cubed = 13,824 finite relabelings). Preserve signs and category roles; remove textual labels and table row order. Redundant clues remain visible but do not automatically create novelty.

### 7.3 Scheduling and Placement (`text`, P07)

- **DSL:** four events, four ordered consecutive time slots, two resources used exactly twice each; 4-12 clues using `at`, `notAt`, `before`, `immediatelyBefore`, `usesResource`, `notResource`. Events/resources are fixed IDs; a resource assignment belongs to an event, not to an untyped string.
- **Meaning:** one event per slot, no overlap, exactly two events per resource, adjacency means consecutive listed slots. Ask for the full event/time/resource table. Enumerate 4! times C(4,2) = 144 assignments and require one.
- **Construction/difficulty:** witness order plus two-of-four resource choice. A before-chain of three facts and three resource facts supplies a unique anchor. Add seeded true clues up to 12 and prune redundancy without losing uniqueness; levels 1/2/3 retain at least 8/6/4 clues respectively. No durations, calendars, time zones, or additional resource capacity rule.
- **Choices/checker:** legal full schedules with the same capacities; three false choices from the remaining 143 possibilities. Independent predicates check both time and resource constraints, not only the displayed order.
- **Fingerprint:** apply section 6's reduced-core procedure, then minimize the retained typed event/slot/resource constraint graph over 4! event and 2! resource relabelings; preserve ordered slot positions and capacity vector. Do not fingerprint the unpruned clue list instead.

### 7.4 Truth Values (`text`, P08)

- **DSL:** three people at level 1, four at levels 2-3; one statement AST per person plus a visible `exactTruthful` integer 1..N-1. AST leaves are `truthful(personId)`; operators `not`, `and`, `or`, `xor`; maximum depth two, three leaves, and seven nodes per statement. No arbitrary English statements, quoted statements, temporal claims, or extra person types. Excluding counts zero/N avoids giving the entire answer in the count alone.
- **Meaning:** a truth teller's one statement is true and a liar's one statement is false, so each assignment must satisfy `T[i] === evaluate(statement[i], T)` and the exact truthful count. XOR means exactly one operand is true. Self-reference is allowed only through this finite Boolean semantics. Ask for the full T/F vector, not who is merely possible.
- **Construction/difficulty:** select a witness vector and its count; enumerate the finite legal AST pool, then seeded-select statements that agree with the witness. Independently test the resulting system; try at most 64 combinations and fail if none is unique. Level 1 uses leaf/not forms and at most one binary statement; level 2 allows and/or; level 3 also allows xor. Use the global 100-seed gate across both allowed population sizes and report population subcounts.
- **Choices/checker:** enumerate all 2^N <= 16 assignments; false options may violate the exact truthful count or a statement, but must list all people. Checker evaluates the AST recursively rather than trusting generated truth labels.
- **Fingerprint:** apply section 6's reduced-core procedure to statement-equivalence predicates, then canonicalize the retained speaker-linked AST/operator graph over person relabelings; sort commutative operands and preserve negation, population, and exact truthful count. A reduced core is internal fingerprint data, not a replacement DSL with missing person statements; always show the original complete statement set.

### 7.5 Small Arithmetic Constraints (`text`, P09)

- **DSL:** three integer variables x/y/z in 0..12 inclusive; 2-5 linear constraints `sum(coeff[i]*var[i]) op constant`, `op` one of `eq|lt|le`; coefficients -3..3, not all zero, constants -108..108; required explicit `allDifferent` Boolean (false means no distinctness restriction). No multiplication of variables, division, modulo, implicit precedence, real-valued solutions, or rounding.
- **Meaning:** enumerate all 13 cubed = 2,197 tuples, apply every comparison and optional distinctness, require exactly one full tuple. Ask for `(x,y,z)`; display every domain and distinctness assumption.
- **Construction/difficulty:** choose a witness; generate true bounded linear facts. A shuffled three-equation full-rank system is a valid anchor; use the independent enumerator, not matrix rank alone, to establish uniqueness in the bounded integer domain. Levels 1/2 use coefficient limits 1/2 and up to two additional true inequalities. Level 3 uses limit 3, replaces one independent equation `v=c` by `v<=c` and `-v<=-c`, and requires at least one retained inequality to be nonredundant. Reject a draw failing that requirement within the same 64-draw cap, not a quiet downgrade. Prune within the 2-5 constraint bounds, record actual operators, and do not claim calibrated difficulty.
- **Choices/checker:** full integer tuples in the same domain, preferably one-step perturbations, falling back to the finite tuple domain. For hashing, first map integer `a*x < c` to `a*x <= c-1`. For `<=`, divide coefficients by their positive gcd g and replace the bound by `floor(c/g)`, including negative bounds; never flip inequality sign/direction. For equality, require g divides c (otherwise unsatisfiable), divide the full row by g, and make the first nonzero coefficient positive. Then canonicalize variable relabeling. Thus `2*x<11`, `2*x<=11`, and `x<=5` normalize identically without changing actual visible instructions.
- **Fingerprint:** apply section 6's reduced-core procedure to normalized constraint rows; hash the retained coefficient/comparison graph, constants, domain, and all-different flag, not the complete unpruned list or numeric answer alone. Include tests for nonintegral linear-system solutions that have no bounded integer solution.

### 7.6 Matrix Completion (`svg`, P11-P12)

- **DSL:** a 3x3 matrix of four-bit masks (0..15) with only the bottom-right cell absent; `rule` is fixed to `xor`. A mask has four distinct fixed glyph positions; set membership is binary. No unspecified pattern inference or model-created rule.
- **Meaning:** in every row, third mask = first XOR second; in every column, bottom = top XOR middle. Visible rules define XOR as keeping glyphs present in exactly one input. Enumerate missing masks 0..15; reject contradictory visible rows/columns and require one completion. This tests explicit set-pattern reasoning, not a general Raven/IQ generator.
- **Construction/difficulty:** choose the upper-left 2x2 masks, derive the remaining five by XOR. Require at least four distinct masks among the eight visible cells and distinct first/second inputs in every complete example row/column. Level 1 seed-mask populations are 1-2, level 2 1-3, level 3 2-3; use bounded draws and record actual density. The code question explicitly states both row and column rules, so another imaginable human pattern cannot invalidate a hidden rule assumption.
- **Choices/checker:** correct mask plus three of the other 15 masks, preferring one-glyph toggles. Every option is rendered in the identical four-position mini-grid; the all-empty mask uses an explicit empty-cell convention. A separate checker verifies all row/column equations and glyph placement.
- **Fingerprint/render:** canonicalize over the 4! consistent glyph-identity permutations and matrix transpose (the declared row/column law is symmetric). Preserve all eight shown masks and the missing-cell location. Renderer uses glyph shape/position, not color as the identity; no glyph may disappear in preview.

### 7.7 Rotation and Reflection (`svg`, P13-P14)

- **DSL:** a 5x5 binary source mask with 4-8 orthogonally connected occupied cells; a one- or two-step sequence from the eight D4 square transforms. Coordinates are zero-based row/column; origin top-left. Clockwise R90 maps `(r,c)` to `(c,4-r)`; left-right reflection maps to `(r,4-c)`; derive the remaining exact integer maps and test the group table.
- **Meaning:** apply the visible operations in the displayed order about the tile center. Level 1 is a nonidentity rotation; level 2 one reflection; level 3 two noncommuting rotation/reflection steps. State clockwise direction, viewer-relative axes, and sequence order in code-owned rules. Functional output is unique; independently verify every mapped cell with coordinate equations.
- **Construction/choices:** build a connected mask by seeded neighbor growth, retain only sources with at least four distinct D4 orbit masks, and select three distinct false orbit results. If an operation sequence is equivalent to another, do not call its identical output a distinct choice. Reject sources without sufficient distractors rather than adding ambiguous orientations.
- **Fingerprint/render:** minimize `(source mask, ordered operation sequence)` under D4 frame changes, conjugating every operation by the same frame change. Retain step count/order and the derived net transform: a one-step reflection and a two-step composition with the same effect are intentionally different solving instructions, not automatic structural duplicates. Preserve cell topology. All choices have identical grids, pivot, scale, and orientation markers; never use an unmarked off-center pivot.

### 7.8 Paths and Reachability (`svg`, P15-P16)

- **DSL:** a 4x4 cell grid, 6-12 active cells, explicit undirected open orthogonal edges, distinct marked start/goal cells. Require the active graph to be connected and a tree; no diagonal edges, crossing edges, implicit corner passages, or repeated edges.
- **Meaning:** move between cell centers only through drawn open corridors, without revisiting a cell. Ask which highlighted complete S-to-G route is valid. Validate the tree with an independent graph traversal; recover the unique route with BFS, then independently check its edges and endpoints.
- **Construction/difficulty:** seeded connected cell growth and a seeded spanning tree. Choose S/G with route lengths of 3-5, 5-7, or 7-11 edges for levels 1/2/3 respectively; if no such endpoints exist, use another bounded draw, not a changed target difficulty. At most 64 draws.
- **Choices/checker:** four simple S-to-G routes drawn over the same maze; the three false routes come from the finite full-grid simple-path pool and each traverses at least one closed/nonexistent corridor. Cap path enumeration at 200,000 visited states. The valid tree route must not be accidentally omitted. A false choice may not become valid because its polyline jumps over a cell.
- **Fingerprint/render:** canonicalize occupied coordinates, open edges, and marked S/G under D4 and translation-normalized bounding boxes; retain geometry and topology, not just route length. Render corridors/walls consistently and verify blocked-edge negative fixtures at the 512-pixel preview. Do not use a maze whose passage state depends on an antialiased single pixel.

### 7.9 Symmetry and Missing Part (`svg`, P17-P18)

- **DSL:** an 8x8 binary tile; `axis` is vertical or horizontal between central columns/rows. The left half is given for vertical and top half for horizontal; the opposite half is unknown. The given half contains 4-10 occupied cells; unknown/background state is separate from an explicitly empty cell. This side convention is fixed, not a new parameter for the agent to choose.
- **Meaning:** reflect each known cell across the marked axis exactly once; all other cells in the missing half are empty. No cell is on the axis. The functional proof forces every missing cell independently, so there is one completion; do not enumerate 2^32 unconstrained images. The independent checker uses reflected coordinate pairs for all 64 cells and verifies the unchanged given half.
- **Construction/difficulty:** level 1 vertical with 4-5 occupied cells, level 2 horizontal with 6-7, level 3 either axis with 8-10 and at least two connected components. Reject all-empty/all-filled known halves. The axis is always explicitly given rather than inferred from a pattern.
- **Choices/checker:** four full completions with the same known half. Three wrong completions arise from removing a required reflected cell, adding a forbidden cell, or shifting a reflected subset; they must be distinct and fail the independent reflection check. Do not alter the known half merely to make a distractor obviously invalid.
- **Fingerprint/render:** normalize the horizontal case to vertical coordinates; minimize over reversal along the axis and exchange of displayed half, preserving the marked axis and cell topology. Gray unknown areas and ordinary empty cells must look different. The axis is dashed, labeled, and visually separate from shape membership.

### 7.10 Counting and Inclusion-Exclusion (`svg`, P19-P20)

- **DSL:** a fixed 5x5 universe of whole cells and two or three named shapes, each an orthogonally connected set of 3-8 unique cells. Queries: `unionCount`, `intersectionAll`, `exactlyOneShape`, or `exactlyKShapes(k)` for k=2/3 within the actual number of shapes. Require distinct shapes, at least one overlap and one exclusive cell. No arbitrary polygon-intersection or line-drawing shape-count problem.
- **Meaning:** count cells, not boundaries, outlines, glyphs, subcell areas, or individual shape memberships. Each universe cell contributes once if its membership count matches the query. Enumerate all 25 membership bitmasks and cross-check union/intersection/exactly-k counts with independent set/inclusion-exclusion calculations. The answer domain is integer 0..25 and is functionally unique.
- **Construction/difficulty:** level 1 two shapes of 3-5 cells and union; level 2 two shapes of 6-8 cells with intersection/exactly-one; level 3 three shapes of 4-8 cells and exactly-k/intersection. Use bounded connected-set growth, reject violated overlap/connectivity rules, and never silently reduce shape count.
- **Choices/checker:** correct count plus three distinct false integers from the query's other summary counts and +/-1 errors, then the finite 0..25 domain. Validate all four counts and reject repeated rendered numbers.
- **Fingerprint/render:** include normalized query, membership-region counts, and full spatial membership grid minimized over D4 plus shape-ID permutations. Counts alone are insufficient: different overlap layouts must not collapse automatically. Render each cell's A/B/C membership with redundant fixed glyphs and separate outline/legend conventions; do not rely on translucent colors or hide one shape under another. Test pair/triple overlaps, zero intersections where allowed, and every legend combination.

### 7.11 Canonical Structure and Near-Duplicate Feature Schema

P04 defines `CanonicalStructure = {version:1, family, domainTokens:string[], queryKind:string, queryTokens:string[], relationTokens:string[], geometryTokens:string[]}`. All token arrays are lexicographically sorted, code-owned, and nonempty where the table requires content. Apply each family's allowed relabelings/geometric frame changes, then choose the lexicographically smallest stable serialization of this object. Reduced clue-core pruning happens in the order fixed in section 6; it does not replace the original spec. Tokens carry exact integer values and typed relations, not prose, seeds, or answer-option labels.

| Family | Domain / Query Kind | Query / Relation / Geometry Tokens |
| --- | --- | --- |
| ranking | `size=N` / `full_order` | Query empty; retained `before:a:b`, `immediatelyBefore:a:b`, `at:a:p`, `notAt:a:p`; geometry empty. |
| matching | `categories=3,size=4` / `full_table` | Query empty; retained signed `same:cat.item:cat.item` or `different:...` pairs, pair endpoints sorted; geometry empty. |
| scheduling | `events=4,slots=4,capacities=2,2` / `full_schedule` | Query empty; retained typed event/slot/resource clues; geometry empty. |
| truth | `people=N,exactTruthful=K` / `full_truth_vector` | Query empty; retained `speaker:i:AST` predicates with canonical prefix AST notation; geometry empty. |
| arithmetic | `variables=3,domain=0..12,allDifferent=bool` / `full_tuple` | Query empty; retained normalized `eq:a,b,c:bound` or `le:a,b,c:bound` rows; geometry empty. |
| matrix | `grid=3x3,glyphs=4,missing=2,2` / `xor_matrix` | Query `row=xor,column=xor`; relation empty; eight `cell:r:c:mask` geometry tokens after glyph relabeling/transpose. |
| transforms | `grid=5x5` / `apply_D4` | Query `steps=N`, ordered indexed `op0=...`, `op1=...` if present, and derived `net=...`, all conjugated in one frame; relations empty; occupied source `cell:r:c` geometry. |
| paths | `grid=4x4` / `S_to_G_route` | Query `start:r:c,goal:r:c`; relations `open:r1:c1:r2:c2` with edge endpoints sorted; geometry `active:r:c`, all transformed together. |
| symmetry | `grid=8x8,axis=vertical,knownSide=left` / `reflect_half` | Query empty; relations empty; every occupied known-half `cell:r:c` after axis/side normalization. |
| counting | `grid=5x5,shapes=N` / `membership_count` | Query operation and k if used; relations `region:membershipMask:count` for masks 1..2^N-1; geometry 25 `cell:r:c:membershipMask` tokens, including zero cells. |

Comma-separated domain/query entries mean separate tokens, not one unparsed config string. Compare near pairs only within `(family, domainTokens, queryKind)` equality. Features are query tokens prefixed `q:`, relation tokens `r:`, and geometry tokens `g:`; omit constant family/domain fields rather than inflate similarity. Each table relation is one complete token: for truth a whole speaker-linked canonical prefix AST is one token, not an arbitrary collection of duplicated AST-node features. Preserve operator order and commutative normalization inside it. P04 implements the exact multiset Jaccard/edit arithmetic; P21 applies the one-edit policy, not a fixed Jaccard threshold.

Every family tests same-structure relabeling, different structures, exact feature multisets, one-edit symmetry where an admissible pair exists, and rejection of two-edit or zero-overlap pairs. If its valid canonical domain admits no one-edit pair, document that limitation instead of manufacturing padded features. At least the following valid counting positive is mandatory, so the global detector cannot be inert: three shapes on the 5x5 grid have row-major cell sets `[1,6,7,8]`, `[2,6,7,8]`, `[3,6,7,8]`. Compare otherwise identical level-3 specs querying exactly two versus exactly three memberships. They have answers 0 and 3, identical geometry/region tokens, and only `k=2` versus `k=3` differs: editDistance=1 and Jaccard=33/35 when all seven region and 25 cell tokens plus two query tokens are emitted. Both are near-suspected, not proven duplicates. This intentionally conservative geometry-reuse concern can be a human false positive; report it as such. No complete semantic-novelty claim is made.

## 8. OpenRouter, Budget, and Crash Contracts

### 8.1 Configuration and Capability Gates

Required live inputs: `OPENROUTER_API_KEY` and `DESIGNER_MODEL`. No fake model default and no required provider IDs or endpoint tags. The designer model must support strict structured outputs and the configured output cap; it does not need image input. The legacy `GENERATOR_MODEL`, `REVIEWER_MODEL`, and `VISION_REVIEWER_MODEL` inputs remain for historical runs only and are not read by the designer CLI. The designer protocol has one model role; model comparison is a separate protocol.

Balanced (Standard) is the mandatory routing mode, not Nitro (throughput-first) or Floor (price-first). Use the ordinary model slug without `:nitro` or `:floor`; omit `provider.sort`, `provider.order`, `provider.only`, and `provider.ignore`. OpenRouter selects a currently eligible provider and may fall back to another provider of the same configured model. Provider availability or catalog membership is not guaranteed and must not be frozen or implemented as an application allowlist.

Account preferences and own-provider-key (BYOK) routing can bypass default Balanced routing even with this request shape. BYOK is out of scope: this experiment uses OpenRouter shared routing/pricing and `usage.cost`, not separate upstream BYOK charges. For each live CLI invocation (including resume) and at P52 freeze, require an operator-recorded check of the account provider-preferences and provider-keys pages: provider sort must be unset/default Balanced and no BYOK provider keys may be configured. Store the actual operator identity, check timestamp, and confirmed settings with the run/protocol evidence; never read/store key values, fabricate the confirmation, request a management key, or change account settings automatically. The required OpenRouter inference key is not a BYOK provider key. A missing confirmation tied to the current invocation, a conflicting sort, or configured BYOK keys blocks live admission/freeze before any paid call. Freeze the verified policy outcome, not confirmation timestamps. The operator must keep these settings unchanged during execution and stop the run if they change; such changes are routing-policy drift, not provider churn. Affected evidence must be revalidated.

Use `https://openrouter.ai/api/v1/chat/completions`, `stream:false`, one completion, strict `response_format: {type:"json_schema", json_schema:{name,strict:true,schema}}`, and `provider:{allow_fallbacks:true,require_parameters:true}`. This keeps provider fallback enabled while excluding providers that cannot honor the request parameters; never weaken strict output to gain availability. Keep one configured model per role; do not include a `models` fallback list, tools, plugins, or `route:fallback`. Provider fallback is not model substitution, content repair, or arm replacement. Leave `temperature`, `seed`, and reasoning parameters absent by default; store supported settings when explicitly configured and tested. Freeze these explicit settings or intentional-default markers before the pilot; never silently strip unsupported parameters or claim omitted defaults are identical across Balanced providers. Local seeds do not control remote sampling.

Default maximum output tokens: 8192 for design and repair. No review cap exists in the designer protocol. Prefer `max_tokens` when supported by an otherwise compatible active endpoint; otherwise use advertised `max_completion_tokens`; otherwise fail preflight. Never send both or omit the cap; freeze the selected `outputCapField` per role and test the actual serialized request. Preflight must find at least one active endpoint supporting strict schema, all configured parameters, the output cap, and a compatible context/prompt limit. OpenRouter selects among currently eligible providers, not a locally pinned endpoint. The cap includes hidden reasoning wherever the provider defines it that way. Request deadline is 90 seconds; response bytes <= 2 MiB; input JSON text excluding base64 <= 64 KiB; historical image roles cap PNG at 1 MiB, while the designer protocol sends no image. For reservation use the full allowed input-context bound when tokenization is unknown; byte-size estimates are not exact token counts. A provider context error is recorded, not retried by shrinking the puzzle. Empty or length-truncated output is a failed first response, never automatically retried with more tokens.

Read and archive the public `GET /api/v1/models` and `GET /api/v1/models/{author}/{slug}/endpoints` with no elevated account credential. Inspect active entries (`status === 0`) for capabilities, limits, and pricing; record provider_name/tag as diagnostics, not routing inputs. Record the enclosing model's architecture modalities; the designer model does not need image input. Revalidate before live stages and after capability/pricing errors, preserving timestamped snapshots rather than requiring catalog equality. Missing/forbidden data that prevents required capability or budget validation blocks live admission; never create/use a management key to bypass it. Provider additions, removals, or health changes alone do not block execution.

Record returned provider/model identity on every inference when exposed; missing identity stays explicitly unknown. A returned provider different from preflight, including a newly available provider, is expected under Balanced and is not configuration drift. A contradictory model identity or violation of required capabilities pauses admission. Configuration hashes freeze the requested designer model, Balanced routing/fallback policy, verified account routing policy (default Balanced/no BYOK), request settings, limits, and local protocol hashes, not provider membership or the provider observed in a probe. P51 probes the designer model with a text-family and an SVG-family design schema, the configured cap, and the actual serialized request; this proves the observed requests, not every possible future provider. Generic probes do not replace the pilot.

### 8.2 Logical Calls, Retry Safety, and Unknown Outcomes

Create a unique logical call for `(run, slot, role)` before dispatch. Designer roles are `design` (attempt 0), `design_repair_1` (repair 1), `design_repair_2` (repair 2), and `preflight`. The legacy reviewer roles remain only for historical runs. Each transport attempt stores its request hash/body without credentials, expected schema hash, requested role/model/routing policy, separately observed provider/model identity, start/end UTC times and monotonic elapsed latency, HTTP status, response/generation ID, raw response, finish reason, prompt/completion/total tokens, cached-read/write and reasoning tokens when available, price estimate, actual cost, and error classification. Preserve nullable usage fields; reasoning is generally a subset of completion tokens, not extra output to add a second time.

A design attempt is not a transport retry. The first design call is role `design`; each repair is a separate logical call with role `design_repair_1` or `design_repair_2`, created only after the solver diagnostic is persisted. Never resend a saved design response as a new design attempt. The repair cap is two; a third repair is a protocol violation, not a fallback.

States are `prepared -> dispatching -> response_saved -> validated`, or `refused_unprocessed|failed_known|uncertain`. Persist `dispatching` before `fetch`. A crash between dispatch and response persistence is inherently ambiguous. Do not assert exactly-once billing or assume an unsupported idempotency key solves this.

OpenRouter's automatic provider fallback stays enabled within a single client HTTP attempt. It may change the serving provider while preserving the requested model and constraints; it is not a new candidate or application content retry. The application cannot assume every internal provider attempt is observable. Record exposed routing/charge metadata without inventing missing internal attempts; the local three-attempt ceiling limits client requests, not OpenRouter's internal routing operations.

Client-side automatic retries are limited to two additional attempts for an explicit pre-generation router rejection: HTTP 429, or HTTP 503 reporting that no eligible provider exists, with no generation ID, no partial completion, no usage, and no provider-generation error. Reuse identical request bytes, including the Balanced policy and enabled provider fallback. Wait 0.5 then 1 second plus seeded 0-0.25 second jitter; honor a valid `Retry-After`. If it exceeds 30 seconds, pause the run instead of shortening the requested delay. Record each refusal as unprocessed only when the response satisfies this allowlist.

Timeouts, disconnects, generic 5xx, HTTP-200 error bodies, partial output, provider errors, and malformed/truncated successful output are not safely unprocessed. Do not replay them automatically. Save whatever evidence exists and retain the cost reservation until actual cost is known; a failed content response with valid `usage.cost` still settles its actual charge. Mark content outcome uncertain or failed independently of monetary certainty. No usable model response at any attempt index yields that attempt's `generation_error`; infrastructure failure during subsequent deterministic checking is `inconclusive`. Both stop the content-repair loop, including after repair 1; no repair is authorized by a timeout or unknown dispatch. An untouched later assignment may still run if the remaining reserved budget permits it.

Resume reuses saved valid responses and committed stage outputs. A `prepared` request never marked dispatching may be sent; a `dispatching` request without a saved response is never silently resent. Compare the configured model, routing policy, request/schema, and limits, not the previously observed serving provider; provider churn alone is not a resume mismatch. If a generation ID exists, a bounded read-only `GET /api/v1/generation?id=...` reconciliation may update actual usage/cost; it does not regenerate content. If none exists, preserve `COST_UNKNOWN` and reserved exposure. End-to-end tests must cover the crash windows rather than merely reopen a JSON file.

### 8.3 Budget Accounting

Default worker concurrency is two, configurable to one or two only. One transaction admits each request after checking `known_actual + reservations_for_inflight_or_unknown + next_reservation <= maxCost`. Reserve for every transport attempt that may be billed; certified unprocessed refusals release their reservation. Settle a completed attempt from actual provider `usage.cost` (USD), not from a token-price guess. `usage.cost = 0` is valid when explicitly present; an absent field remains unknown.

Archive current prices across eligible providers and calculate conservative design/repair reservation estimates for Balanced routing, not just the cheapest provider or the provider observed in preflight. Use bounded input/output caps and all relevant price fields, including request/reasoning/cache/conditional pricing. Use a 2x safety margin and never assume a missing price field means a free request. Refuse unsupported pricing shapes until an operator supplies a documented conservative per-role reserve. Freeze reserves/method and the projected 400-call total in P52, using observed pilot role costs and a separately shown conservative reservation scenario. Provider prices and membership may change; preserve initial/refreshed snapshots as evidence, not a fixed-provider contract. If current exposure cannot be covered by the frozen reserve/budget method, pause for budget safety, not merely because provider identity changed. If the forecast exceeds the authorized cap, require an explicitly authorized different cap or stop; never promise USD 10 is sufficient. These are admission estimates, not a mathematical billing guarantee. Include all router-reported charges, record actual overshoot, and stop new admissions. A user-configured provider/key spending cap is an additional external backstop, not permission for the app to change account settings.

Partial runs stop safely at a budget boundary and remain `paused_budget`; their report uses the planned denominator and labels results incomplete. Raising a cap on resume requires separate user authorization plus `--ack-budget-increase`; append old/new cap, time, and operator acknowledgement. It cannot change seeds, quotas, arms, models, prompt/schema/code versions, or decision thresholds. No budget increase changes the observed cost per novel accepted threshold.

Keep preflight, pilot, primary, unknown-exposure, and any later protocol's spending separate. Upper logical call counts are:

| Stage | Assignments | AI calls | Baseline calls | Maximum transport attempts |
| --- | ---: | ---: | ---: | ---: |
| Preflight | 2 probes | 2 | 0 | 6 |
| Pilot | 20 | 80 (20 one-shot + 20 feedback first + 40 repairs) | 0 | 240 |
| Primary | 100 | 400 (100 one-shot + 100 feedback first + 200 repairs) | 0 | 1,200 |
| Mock | 100 | 400 synthetic, zero cost | 0 | 1,200 |

Transport retries are additional attempts, not new logical calls. The baseline arm makes zero AI calls. The legacy 680/70/80 reviewer counts are not part of v2.0. Do not promise these fit a default budget before measuring the chosen route.

The default pilot cap is USD 2, the default primary cap is USD 10, and the default preflight cap is USD 0.50. P51's combined command uses `--max-cost` for the pilot pool and `--preflight-max-cost` for the two probes; require authorization for both pools before dispatch and report their combined exposure as well as separate totals. The default decision threshold is USD 0.50 per feedback novel final accepted puzzle, frozen at P52. These are operating defaults, not authorization. A different cap requires an explicit user decision; a different outcome threshold/sample/rubric requires a documented protocol revision before its pilot, not tuning after pilot observation.

## 9. Metrics, Human Evaluation, and Decision Rules

### 9.1 Fixed Denominators and Uncertainty

For the designer cohort, `N_assignments=100` and `N_candidates=300` (100 per arm). Text assignments/candidates are 50/150; SVG are 50/150; each family is 10/30. Difficulty is 40/30/30 assignments (the same per arm), hence 120/90/90 candidate slots overall. Report planned, attempted, formal-accepted, novel-accepted, rejected, inconclusive, generation-error, baseline-duplicate, near-baseline, novelty-unknown, first-attempt, final, repaired, and paused/unstarted counts; never omit failed or incomplete assignments.

- `first_attempt_formal_acceptance = first_attempt_formal_accepted / N_assignments` per arm.
- `final_formal_acceptance = final_formal_accepted / N_assignments` per arm.
- `repair_success_rate = repaired_accepted / repairable_first_attempt_failures` for `ai_feedback`, where repairable failures are `rejected` or `SOLVER_LIMIT` inconclusive first attempts; generation errors and infrastructure-inconclusive attempts are reported separately and are not repair denominators. Report one-repair and two-repair success separately.
- `repair_lift = final_formal_acceptance - first_attempt_formal_acceptance` for `ai_feedback`; report the within-trajectory transition table. Since accepted first attempts never repair, completed trajectories cannot lose acceptance; the lift is repaired-to-accepted assignments / 100, with a Wilson interval for that improvement indicator, not an independent-two-proportions interval.
- `novel_acceptance = novel_accepted / N_assignments`; `novel_share = novel_accepted / formal_accepted`.
- `structural_diversity = distinct_structural_fingerprints / formal_accepted`; report the absolute distinct count per arm and family.
- `baseline_overlap = AI formal-accepted candidates with exact/structural/one-edit baseline match / AI formal-accepted`.
- `average_cost_per_first_attempt_accepted`, `average_cost_per_final_accepted`, and `average_cost_per_novel_accepted`; a zero denominator yields `null`, not zero. Also report calls per accepted, tokens/cache/reasoning usage, and latency.
- `error_code_distribution` for first attempts, repairs, and final failures.
- `human_correctness`, `human_clarity`, `human_interest`, `human_difficulty`, and `human_solve_time`; paired win/tie/loss counts and reasons.

The baseline's first attempt is its standard `generateSpec` with internal draws; report the draw count. The AI's first attempt is one design call. This comparison is reported as-is; the baseline's internal algorithmic search is not an AI call. The AI arms are independent first-response samples blocked by assignment; their first-shot rate difference includes remote sampling noise. Only feedback final versus its own attempt 0 is a within-trajectory comparison. `repair_lift` is descriptive final-minus-first improvement with diagnostics and additional calls, not the isolated causal effect of solver feedback: there is no equal-call blind-redraw control. Do not claim diagnostics outperform equally many unguided redraws or new rule invention from this experiment.

For repair metrics, a repairable first failure remains in the denominator even if budget/interrupt prevents its repair; show eligible, attempted, pending, and successful counts. A zero repair-opportunity denominator gives `null/not_applicable`, not 0% or 100%. Repair-success numerators are disjoint: accepted first repair versus accepted second repair, both divided by the same first-failure denominator; also report success per actual repair call as a secondary statistic. Late repair failures never alter attempt 0.

Cost metrics have explicit scopes: each arm's first-shot cost sums all its attempt-0 transport charges (including failures); final/novel cost sums all that arm's design and repair charges, including failed/pending trajectories. Divide by that arm's accepted or novel-accepted count, never by only successful calls. The primary cost gate uses `ai_feedback` total primary-cohort AI cost divided by feedback novel-accepted candidates. Show one-shot, pooled AI, and preflight/pilot totals separately, with all failed-call and unknown exposures; do not mix pooled costs with a single-arm denominator. Baseline has zero AI cost, not zero measured compute time.

Sum actual calls and token/cache/reasoning usage by role (`design`, `design_repair_1`, `design_repair_2`), with a combined designer rollup. Show missing-usage coverage rather than converting null token/cost fields to zero. Total actual cost and actual-cost averages are null if any possibly billed attempt is unresolved; show a known-cost lower bound and estimated reserved exposure separately.

Show the observed provider/model mix by role and missing-identity coverage as operational diagnostics. Balanced may select different providers across preflight, pilot, primary, and resume; do not claim a constant provider or complete visibility into internal fallback attempts.

Report mean/median/p95 HTTP-attempt latency and logical-call elapsed time (including retry waits) per role. Use nearest-rank p95 at `ceil(0.95*n)` in ascending non-null observations, ordinary median, and arithmetic mean. Report per-candidate active time from stage durations and end-to-end wall time from first start to terminal, explicitly including queue/interruption waits. Missing end times remain null and are reported as missing, not zero.

Failure-code frequencies may sum above candidate count. State this and report a separate exclusive verdict histogram. Report baseline-duplicate/near-baseline/novel counts per family and arm next to formal acceptance; these are novelty annotations, not formal rejections. Do not replace the planned-denominator rate with a novelty-excluded success rate.

Compute per-modality, per-family, per-arm, target-difficulty, family-by-arm, and modality-by-difficulty tables from planned strata, including failures. Difficulty means the requested generation setting, not validated human difficulty. Zero denominators produce `null`/`N/A` plus coverage, never NaN/Infinity or a favorable 0%. Show Wilson 95% intervals for binomial acceptance/novelty/human rates and explicitly describe small per-family cells as exploratory. The baseline is a reference, not a gate; report its formal acceptance, structural diversity, cost (zero AI cost), and human ratings alongside the AI arms.

### 9.2 Human Evaluation

Select the human-evaluation sample deterministically after automatic design verdicts and final novelty annotations freeze. For each family, prefer the lowest-hash assignment with accepted candidates in all three arms. If none exists, select the difficulty stratum with the largest number of arms having accepted candidates, breaking ties by a fixed hash; select the lowest-hash accepted candidate per arm within that stratum. Never compare different requested difficulties or substitute another family. Record absent arms and assignment-matched versus family/difficulty-matched triplets explicitly. This yields up to 30 core candidates. Selection is conditional on formal acceptance: it evaluates quality of usable outputs, not the average attempted design or an unbiased treatment effect.

Add up to 10 distinct accepted candidates, excluding core members, by a frozen priority rule: take the lowest-hash uncovered representative for `repaired`, `novel`, and `near_baseline` in that order, then fill remaining places by least represented family, then least represented arm, with candidate-hash ties. A candidate covering multiple categories is added once and marks all its categories covered. Store missing categories rather than inventing a representative. The maximum is 40; preserve core membership, selection reason, and every shortfall. Additions do not enter core preference or clarity/time denominators, but any verified serious defect in an addition still blocks `proceed`.

Present each family triplet in a seeded shuffled order derived from a separate `human-order` stream, frozen in the sample manifest. The human ranks the puzzles with ties allowed for interest, clarity, and appropriate difficulty and records pairwise reasons. The primary family-blocked gate is `ai_feedback` vs `baseline`; `ai_one_shot` vs `baseline` is secondary. Report assignment-matched and fallback family/difficulty-matched comparisons separately, even though both contribute to the declared family-blocked gate. A missing member is a shortfall, not a fabricated pair. Do not label a fallback comparison as a paired identical-assignment experiment.

The solving bundle contains only public question/rules/clues/options/images and opaque evaluation IDs, with no arm/assignment/repair/cost/novelty metadata in embedded data, filenames, links, or accessibility labels, and no solver key/hint/explanation. Keep the private ID-to-candidate map and reveal bundle separate. Use the same neutral skin for all arms. Record the human's choice, solve-time category, clarity, interest, difficulty, and triplet preferences before reveal; then inspect answers/proofs/hints/explanations and record correctness/defects. Blinding is procedural, not protection against a participant deliberately opening private evidence; style may reveal an arm. Record:

- correctness: the displayed puzzle is solvable, unambiguous, and the revealed answer matches the visible conditions; hints and explanation steps are supported by the visible facts;
- clarity: 1-5 (`4-5` is `clear` for the gate);
- interest: 1-5 (1 repetitive/unengaging, 3 acceptable, 5 engaging/original within the stated rules);
- perceived difficulty: 1-5 (1 trivial, 3 moderate, 5 very hard); preference for appropriate difficulty is a separate ranking, not an assumption that harder is better;
- solve time: `<=60s|61-180s|>180s|not_solved|not_inspectable`;
- defect notes and a free-text reason for the triplet ranking.

For each triplet, the human records the ranking and pairwise preferences for interest, clarity, and appropriate difficulty, with a reason. The paired preference is a bounded sample, not a population estimate. Report feedback-vs-baseline and one-shot-vs-baseline win/tie/loss counts, intervals, and the reasons.

The agent may prepare the sample, gallery, CSV, and validation, but must not fabricate or infer human ratings. The human auditor identity, timestamp, and sample/hash evidence are recorded. Labels are append-only and never rewrite primary design attempts or verdicts. A human discovery can block `proceed`; it cannot upgrade a rejected attempt or downgrade an accepted one in the primary statistics.

The human evaluation is stratified and enriched for accepted/repaired/novel cases. Its defect fraction is not an unbiased population estimate. Human readability is not proven by the solver; the evaluation is a bounded check of the actual renderers and templates.

### 9.3 Decision Rules

The following predicates are PoC hypotheses recorded before the pilot and frozen at P52 together with the metrics/decision implementation. All AI acceptance/novelty/cost predicates below use the named arm, not an unspecified pooled rate. The baseline is a reference, not a requirement to be beaten on every metric. `proceed` means the AI designer is viable for this bounded ten-family PoC, not that it invents arbitrary puzzles, proves a causal advantage of diagnostics over redraws, or guarantees human readability.

| Predicate | `proceed` threshold |
| --- | --- |
| Cohort completion | 100 assignments attempted in all three arms; 300 candidates; no replacements; same-configuration pilot/freeze |
| AI feedback final formal acceptance | >= 60% overall and >= 50% in each modality |
| AI one-shot first-attempt formal acceptance | >= 40% overall |
| Repair capability | In `ai_feedback`, >= 20% of repairable attempt-0 failures repaired and final-minus-own-first >= 5 percentage points. If feedback's own first acceptance is >= 80%, require final >= own first and at least one successful repair when opportunities exist; with zero opportunities mark repair evidence `not_applicable`, not demonstrated success. |
| Novelty | `ai_feedback` novel final accepted / 100 >= 30%; >= 3 novel final accepted / 10 in every family; >= 50 distinct accepted final structures in that arm; complete frozen/cohort-reference coverage |
| Cost | Known complete primary AI costs; feedback total primary cost including failed designs/repairs / feedback novel final accepted <= USD 0.50; zero denominator is not a pass |
| Human correctness | 30 core candidates inspected; no unresolved correctness/ambiguity/legibility defect in audited AI accepted puzzles |
| Human clarity/time | >= 16/20 planned core AI members have clarity >= 4/5 and are solved within 180 seconds; missing/noninspectable members fail the joint predicate; additions reported separately |
| Paired interest | AI feedback wins or ties at least 7/10 interest comparisons against baseline |
| Paired clarity | AI feedback wins or ties at least 8/10 clarity comparisons against baseline |

Human-evaluation shortfalls remain in the planned 10-family denominator and count as non-wins; a missing AI member also counts as not clear/solved in the 20-core-AI denominator. Never shrink the denominator to inspected candidates. The 30-core inspection predicate likewise keeps missing candidates as shortfalls, not passes. Serious correctness/ambiguity/legibility or unsupported-explanation defects in any audited accepted AI candidate, core or addition, block `proceed`; quality rates for additions are diagnostic only.

`reject` requires a complete evaluable run and at least one strong failure:

- AI feedback final formal acceptance < 30% overall, or any modality < 25%;
- AI one-shot first-attempt formal acceptance < 20/100 and feedback repair success < 10%, with at least one repairable first failure;
- a repeatable audited correctness/ambiguity defect affecting at least two distinct accepted AI puzzles in the same family;
- feedback cost per novel final accepted > 2x the frozen threshold, with complete known costs and a positive denominator;
- > 100/200 final AI candidates have `generation_error` (baseline excluded); report parsed schema rejections separately rather than silently calling them generation errors.

`revise` covers other failures, incomplete evidence, budget pauses, unknown costs, unsupported model routes, novelty below 30%, cost above the threshold but <= 2x, human-evaluation shortfalls, paired preference below the threshold, and borderline results. Always emit failed predicates and caveats; do not convert incomplete evidence into a conclusive business rejection or success.

Decision precedence is explicit: an incomplete cohort, protocol mismatch, unresolved infrastructure/safety defect, or unknown primary cost yields `revise` first. Otherwise a fully observed automatic strong-failure predicate may yield `reject` without fabricating human labels for unavailable candidates; a human-defect rejection needs actual verified defect evidence. If no strong failure applies, `proceed` requires every applicable proceed predicate, including genuine core human inspection; all other cases are `revise`. Recorded sample shortfalls are observed missing coverage, not invented labels. A baseline/reference/renderer defect is a protocol problem to revise, not proof that the AI model is incapable.

No threshold may be changed after primary observation. A change creates a new protocol version, new pilot evidence, and a new frozen decision rule; it cannot retroactively improve this cohort. Report the baseline's results, all family/arm/difficulty cells, and the human shortfalls beside the recommendation.

## 10. File Ownership and CLI Availability

Paths below are the chosen layout, not suggestions to reorganize during implementation. `src/domain/` owns shared data, `src/families/<family>/` owns mathematical meaning, `src/render/` owns SVG/PNG safety, `src/ai/` owns provider/prompt boundaries, `src/storage/` owns durable state, `src/runner/` owns workflow, `src/reporting/` owns derived output, `src/calibration/` and `src/audit/` own legacy evaluation, and `src/design/` owns the designer protocol. Tests mirror these under `tests/`.

P02 defines generic candidate/stage envelopes, not imports of nonexistent family modules. P04's interfaces and P03's generic storage methods require the caller's strict stage validator. Each family adds its real spec schema in its phase; P20 creates `src/domain/spec.ts` from the ten registered schemas. Raw API bytes remain strings at the trust boundary until parsing/validation. Do not persist unvalidated `unknown` as an accepted spec or add stub implementations to satisfy a future union.

P46-P55 add `src/design/` (assignments, attempts, feedback, baseline, novelty, orchestration), `src/ai/design-proposal.ts` and `src/ai/repair-proposal.ts` with versioned prompts, `src/presentation/templates.ts` and `explain.ts`, `src/reporting/design-metrics.ts` and `design-decision.ts`, `src/audit/design-sample.ts` and `design-labels.ts`, `src/cli/design.ts` and `src/cli/design-audit.ts`, and the `design_attempts`/`design_evaluations` migrations. They reuse P03 storage, P23-P24 ledger/transport, P25 schemas, P32 mock, P33 preparation patterns, P35-P36 concurrency/resume, P37 reporting, P38-P39 gallery, and P44 provenance. They do not use P27 wording, P28-P31 reviewer adapters/verdicts, P34 review orchestration, P40-P41 calibration, or P42-P43 review-based gates.

| Command | First implemented | Behavior before later phases |
| --- | --- | --- |
| `npm run check` | P01 | Local lint, typecheck, unit tests, build; never paid, browser tests separate. |
| `npm run experiment -- --dry-run --seed puzzle-poc-v1` | P02 | Legacy 200-slot manifest only; the designer CLI has its own dry-run. |
| `npm run preview -- --family scene-demo --seed preview-v1` | P10 | Local scene demo; a real family is accepted only after its renderer phase. |
| `npm run preflight -- --offline` | P25 | Recorded capability fixtures only. |
| `npm run experiment -- --smoke --mock --seed puzzle-smoke-v1` | P34 | Legacy reviewer smoke workflow; not part of the designer protocol. |
| `npm run designer -- --dry-run --seed puzzle-designer-v1` | P46 | 100-assignment x 3-arm manifest; no generation. |
| `npm run designer -- --build-reference` | P48 | Fixed 1,000-outcome baseline reference dataset, strict stored manifest/hash; no AI calls or seed search. |
| `npm run designer -- --mock --seed puzzle-designer-mock-v1 --max-cost 0` | P50 | 300-candidate offline mock cohort, zero paid calls. |
| `npm run designer -- --pilot --live --allow-paid --seed puzzle-designer-pilot-v1 --max-cost 2 --preflight-max-cost 0.50` | P50.4; authorized execution in P51 | 20-assignment pilot plus two probes; at most 82 AI calls; separate authorized pools. |
| `npm run freeze -- --design <pilot-id> --max-run-cost 10` | P50.2; live evidence in P52 | Designer pre-run evidence gate; no paid call. |
| `npm run designer -- --full --live --allow-paid --protocol <hash> --max-cost 10` | P50.4; authorized execution in P53 | Frozen 100-assignment x 3-arm cohort; at most 400 AI calls. |
| `npm run designer -- --resume <design-id> --live --allow-paid` | P50.1 | Same-run designer recovery under section 8; fresh operator confirmation; no content replay. |
| `npm run report -- --run <design-id>` | P50.1/P50.4 | Design metrics, first-attempt/final/repair evidence, gallery. |
| `npm run export -- --run <design-id> --format csv` or `--format jsonl` | P50.4 | Controlled design exports. |
| `npm run audit -- --design --run <design-id> --prepare`; `--import <path>` | P50.3; genuine labels in P54 | Deterministic blinded family-triplet sample and append-only labels. |
| `npm run test:browser` | P39/P50.4 | Offline gallery acceptance; design and blinded evaluation views included. |

The legacy `experiment`, `calibration`, and reviewer commands remain for P01-P45 historical runs. The designer CLI must reject `--design` combined with reviewer/calibration flags. Do not execute the legacy reviewer path as part of P46-P55. CLI `--help` must distinguish implemented offline commands, simulated execution, and authorization-gated live execution. Reject unsupported flag combinations rather than silently choose a mode.

## 11. Sequential Implementation Phases

**Baseline and legacy note.** P01-P45 are implemented and accepted. P27 (AI wording/hint/explanation), P28-P31 (blind text, blind vision, alignment, verdict reducer), P34's review orchestration, P40-P41 calibration fixtures/scoring, and P42-P43 review-based human-audit/freeze gates are legacy components. They remain in the repository and their tests remain valid historical evidence, but they are not used by the v2.0 designer protocol and must not gate P51-P55. The v1.1 live/human sequence P46-P53 is superseded by P46-P55 below; the v1.1 P46/P47 evidence is historical. Do not execute the legacy reviewer/calibration phases for the designer experiment.

For every phase, run its listed focused command and `npm run check`, unless it is explicitly an evidence-only live/manual phase. Commands with `<run-id>`, `<path>`, or `<hash>` mean substitute the actual ID printed by the preceding command and record it in the phase report. They are not literal fixture IDs to invent. All tests mentioned in a phase must be created in that phase or already exist in a stated prerequisite.

Monetary literals in operating commands are default caps, not authorization. If the user authorizes a different cap before freeze, substitute that exact amount consistently in freeze/execution and record it; never launch with a larger unapproved default or change the USD 0.50 cost-per-novel-accepted outcome threshold after observation.

### P01. Reproducible Offline Toolchain

- **Size:** S; configuration/bootstrap only, no puzzle behavior.
- **Prerequisites:** repository inspection, Node 24.22.2 and npm available; preserve existing untracked/ignored files.
- **Files:** create `package.json`, `package-lock.json`, `.nvmrc`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.mjs`, `vitest.config.ts`, `src/cli/experiment.ts`, `tests/setup.ts`, `tests/bootstrap.test.ts`, `README.md`, and `docs/PROGRESS.md`; append generated-data/secret exclusions to `.gitignore` without replacing it.
- **Instructions:** install/pin TypeScript, tsx, Vitest, ESLint/typescript-eslint, Node types, Zod 4, commander, and dotenv. Provide the `check`, `lint`, `typecheck`, `test`, `build`, and `experiment` scripts. `--help` exits successfully; imports have no side effects. Add a global test network guard that denies non-loopback HTTP and requires explicit local fake registration. Do not require a key for any check.
- **Verification:** `npm ci`; `npm run check`; `npm run experiment -- --help`. Bootstrap test asserts that importing the CLI does not create `data/` or contact a network and that unknown execution flags fail explicitly.
- **Manual acceptance:** a fresh dependency install and help command work without `.env`; only documented toolchain files and ignored build output appear.
- **Out of scope:** manifests, puzzles, persistence, API, gallery.

### P02. Domain Schemas, Seed Streams, and Slot Planner

- **Size:** M; pure data and deterministic planning.
- **Prerequisites:** P01.
- **Files:** create `src/domain/experiment.ts`, `src/domain/candidate.ts`, `src/util/random.ts`, `src/experiment/planner.ts`, `tests/experiment/planner.test.ts`, and `docs/experiment-protocol.md`; extend `src/cli/experiment.ts`.
- **Instructions:** implement sections 4.1-4.3 as strict shared types, stable slot IDs, the hash-counter PRNG, full/smoke quotas, difficulty strata, and manifest serialization. Add `--dry-run` and mutually exclusive run-kind/mode parsing. Reserve stage/verdict enums without fake stage execution. Copy fixed thresholds and the no-replacement rule into protocol documentation.
- **Verification:** `npm exec vitest run tests/experiment/planner.test.ts`; `npm run experiment -- --dry-run --seed puzzle-poc-v1`; `npm run check`. Assert exact totals 200/100/20, text 10/10, SVG 14/6, all difficulty counts, full 680/smoke 70 logical-call estimates and 2040/210 maximum transport attempts, stable repeated plan output, different derived option/layout streams, and zero IO/API side effects for dry-run.
- **Manual acceptance:** inspect the dry-run JSON; every required family, lane, seed, and target difficulty is present exactly as specified, with no generated question or database.
- **Out of scope:** family implementations and candidate generation.

### P03. Transactional Run, Slot, Stage, and Artifact Storage

- **Size:** M; one storage capability.
- **Prerequisites:** P02.
- **Files:** create `src/storage/database.ts`, `src/storage/repository.ts`, `src/storage/artifacts.ts`, `src/storage/migrations/0001_runs.sql`, and `tests/storage/checkpoints.test.ts`; update dependency locks and protocol docs.
- **Instructions:** install/pin `better-sqlite3`, its types, and `proper-lockfile`. Implement runs/slots/stage_results/artifacts/events, foreign keys, WAL, one-writer lock, transaction helpers, content-addressed bounded blobs, schema validation on read/write, and immutable stage insertion. Store manifest/slot plan atomically before any candidate work. Do not add request/budget tables yet.
- **Verification:** `npm exec vitest run tests/storage/checkpoints.test.ts`; `npm run check`. Tests create/reopen temporary databases, reject duplicate stages and unsafe paths, roll back a stage+artifact+checkpoint transaction on injected failure, detect a competing writer, and verify migrations twice are harmless. A native SQLite open/query/close must actually run.
- **Manual acceptance:** inspect test diagnostics showing a reopened run with unchanged manifest/slots; an interrupted transaction has neither a partial artifact nor an advanced checkpoint.
- **Out of scope:** paid calls, runner resume, JSON-as-database, report UI.

### P04. Shared Family Contract, Options, and Canonicalization Primitives

- **Size:** M; reusable bounded helpers, not five family engines at once.
- **Prerequisites:** P02 and P03.
- **Files:** create `src/families/contracts.ts`, `src/families/registry.ts`, `src/families/canonicalize.ts`, `src/domain/answers.ts`, `tests/families/contracts.test.ts`, and `docs/families.md`.
- **Instructions:** define engine/visibleRules/fact-ID contracts and section 7.11's strict `CanonicalStructure` schema in `src/families/contracts.ts`. Implement serialization, token feature extraction, unit-weight multiset Jaccard and one-edit arithmetic, bounded relabeling/reduced-core helpers in `src/families/canonicalize.ts`. Each family supplies its actual tokens later, not a placeholder engine here. Add finite permutations/bitsets/search counters, deep option equality and seeded four-choice shuffling. Formal engines register separately from renderers. Reject duplicate registrations, arbitrary ops, and three choices.
- **Verification:** `npm exec vitest run tests/families/contracts.test.ts`; `npm run check`. With a tiny test-only engine, assert strict canonical-schema/serialization, exact features/scores for substitution/addition/deletion/two edits/empty sets, seed/cap behavior, visible rules/fact namespaces, shuffled keys, relabeling, known redundant clues, and genuinely different structures. Production registry may be empty; real family phases repeat applicable contracts and P20 checks all ten.
- **Manual acceptance:** focused tests demonstrate that a supplied hidden witness cannot bypass enumeration/checking and that adding a duplicate/redundant test clue does not create novelty.
- **Out of scope:** actual families, renderers, model adapters.

### P05. Ranking Engine

- **Size:** M; one complete small text family.
- **Prerequisites:** P04.
- **Files:** create `src/families/ranking/schema.ts`, `src/families/ranking/engine.ts`, `src/families/ranking/canonical.ts`, and `tests/families/ranking.test.ts`; update `src/families/registry.ts` and `docs/families.md`.
- **Instructions:** implement section 7.1 literally: bounded clue union, constructive witness/anchors, independent 120-permutation solver, full-order choices, visible fact/rule templates, and reduced structural canonicalization. Enforce clue caps after construction/pruning and retain proposal counts. Register only this real engine.
- **Verification:** `npm exec vitest run tests/families/ranking.test.ts`; `npm run check`. Cover an explicit unique order, an impossible cycle, a missing-essential-clue ambiguity, adjacency direction, positions, wrong key, all options, relabeling/redundancy, and at least 100 seeded constructions with >=95 successes.
- **Manual acceptance:** inspect a deterministic fixture's English rules, four full orders, and independently enumerated unique solution; no model or future report is required.
- **Out of scope:** matching, scheduling, AI wording, gallery.

### P06. Attribute-Matching Engine

- **Size:** M; one text family with a 576-state domain.
- **Prerequisites:** P04; follow the already documented registration contract.
- **Files:** create `src/families/matching/schema.ts`, `src/families/matching/engine.ts`, `src/families/matching/canonical.ts`, and `tests/families/matching.test.ts`; update registry and family docs.
- **Instructions:** implement section 7.2, including signed B-C clues, both bijections, complete-table options, independent clue checking, code-owned visibleRules/fact IDs, and category-preserving canonicalization of section 6's reduced clue core. A rendered text table is plain structured data here, not HTML.
- **Verification:** `npm exec vitest run tests/families/matching.test.ts`; `npm run check`. Test unique/unsat/ambiguous tables, cross-category negative facts, duplicated category values, wrong keys, redundant facts, renaming across all three categories, and 100 seeded constructions with the success gate.
- **Manual acceptance:** all four choices use each item once; exactly one full table, not just one queried pair, satisfies the clues.
- **Out of scope:** visual layout, provider calls, report UI.

### P07. Scheduling/Placement Engine

- **Size:** M; one 144-state family, explicitly distinct from ranking.
- **Prerequisites:** P04.
- **Files:** create `src/families/scheduling/schema.ts`, `src/families/scheduling/engine.ts`, `src/families/scheduling/canonical.ts`, and `tests/families/scheduling.test.ts`; update registry and family docs.
- **Instructions:** implement section 7.3 with fixed ordered slots and capacity-2 resources. Enumerate event order and resource choice independently. Include capacities and common fact IDs in visibleRules; fingerprint section 6's reduced clue core. False choices remain legal domain schedules even when clues fail.
- **Verification:** `npm exec vitest run tests/families/scheduling.test.ts`; `npm run check`. Cover resource-only ambiguity, temporal contradiction, exact capacity, immediately-before meaning, a wrong resource despite correct event order, canonical renaming, and 100 seeded constructions.
- **Manual acceptance:** removing a necessary resource fact creates a detected second complete schedule; it must not still pass because the time order is unique.
- **Out of scope:** general calendars, durations, timezone handling.

### P08. Truth-Value Engine

- **Size:** M; one bounded AST evaluator and 16-state solver.
- **Prerequisites:** P04.
- **Files:** create `src/families/truth/schema.ts`, `src/families/truth/engine.ts`, `src/families/truth/canonical.ts`, and `tests/families/truth.test.ts`; update registry and family docs.
- **Instructions:** implement section 7.4 with explicit AST node/depth/leaf limits, exact truthful count, truth-teller/statement equivalence, all four choice vectors, visibleRules/common fact IDs, and speaker-linked canonicalization of section 6's internal reduced core. Build the finite AST pool from allowed nodes only; never evaluate a string expression. Preserve every original statement for display.
- **Verification:** `npm exec vitest run tests/families/truth.test.ts`; `npm run check`. Test self-reference with zero/multiple fixed points, exactly-one XOR, truthful-count contradictions, oversized ASTs, independent AST evaluation, wrong vectors, renaming/commutative forms, and 100 bounded construction seeds.
- **Manual acceptance:** the displayed truthful-count and role rules account for every solver assumption; an AST outside the grammar is rejected before evaluation.
- **Out of scope:** unconstrained English truth statements or recursive proof systems.

### P09. Arithmetic-Constraint Engine

- **Size:** M; one bounded integer family.
- **Prerequisites:** P04, with P05-P08 accepted before the five-text-engine registry check.
- **Files:** create `src/families/arithmetic/schema.ts`, `src/families/arithmetic/engine.ts`, `src/families/arithmetic/canonical.ts`, and `tests/families/arithmetic.test.ts`; update registry and family docs.
- **Instructions:** implement section 7.5, enumerate all 2,197 tuples, build and independently test unique integer anchor systems, compare exact integers, provide visibleRules/common fact IDs, and canonicalize section 6's reduced coefficient-row core without corrupting inequality direction. Display negative coefficients and parentheses unambiguously.
- **Verification:** `npm exec vitest run tests/families/arithmetic.test.ts`; `npm run check`. Include no-integer-solution, rank-deficient/multiple-solution, strict-vs-nonstrict boundary, equivalent integer inequality fingerprints (`2*x<11`/`x<=5`, negative bounds), allDifferent, forbidden nonlinear grammar, wrong key, and 100 seeds. Also assert all five text engines are registered and no visual stub is registered.
- **Manual acceptance:** one fixture's complete bounded integer search and all four tuple checks are visible; no answer is accepted by numerical approximation.
- **Out of scope:** algebra outside the closed linear DSL.

### P10. Safe SVG Scene, Pinned Font, and PNG Preview Infrastructure

- **Size:** M; shared rendering infrastructure only.
- **Prerequisites:** P03 and P04; no visual family required.
- **Files:** create `src/render/scene.ts`, `src/render/svg.ts`, `src/render/png.ts`, `src/cli/preview.ts`, `tests/render/safety.test.ts`, `assets/fonts/DejaVuSans.ttf`, and `assets/fonts/LICENSE.txt`; update package locks/scripts. These extra small asset/CLI files do not add a family to this assignment.
- **Instructions:** pin saxes, resvg, pngjs and their needed types. Vendor DejaVu Sans 2.37 from its official distribution with license and recorded SHA-256; do not fall back to a system font. Implement section 5.4, a scene-demo containing stem/legend/four option boxes, strict parser assertions, deterministic rasterization, bounds/contrast helpers, and ignored preview exports. Add renderer registration without importing unfinished renderers.
- **Verification:** `npm exec vitest run tests/render/safety.test.ts`; `npm run preview -- --family scene-demo --seed preview-v1`; `npm run check`. Test real PNG signature/dimensions, identical repeated hashes in the pinned environment, unsafe tags/attrs/DOCTYPE/URLs, escaping, blank/clipped/oversized images, and disabled system fonts.
- **Manual acceptance:** open the printed source/512-pixel PNG paths directly; four labels and the demonstration legend are readable. There is no gallery dependency.
- **Out of scope:** all ten real puzzle renderers, AI SVG, browser report.

### P11. Matrix Specification and Formal Engine

- **Size:** S/M; 16-mask formal reasoning only.
- **Prerequisites:** P04 and P10.
- **Files:** create `src/families/matrix/schema.ts`, `src/families/matrix/engine.ts`, `src/families/matrix/canonical.ts`, and `tests/families/matrix.test.ts`; update formal registry and family docs.
- **Instructions:** implement section 7.6 with only explicit XOR, derive consistent cells from the 2x2 seed, enumerate every missing mask, construct mask options, and expose typed facts/scene input without rendering it.
- **Verification:** `npm exec vitest run tests/families/matrix.test.ts`; `npm run check`. Test inconsistent complete rows/columns, unknown rule, malformed missing-cell location, empty-mask convention, one-bit distractors, transpose/glyph renaming, and 100 seeds.
- **Manual acceptance:** a JSON fixture shows exactly one of 16 masks satisfies all six row/column equations; the intended rule is explicit, not guessed.
- **Out of scope:** SVG layout and gallery.

### P12. Matrix Renderer and Visual Evidence

- **Size:** M; one renderer, not a new solver.
- **Prerequisites:** P10 and P11.
- **Files:** create `src/families/matrix/render.ts` and `tests/render/matrix.test.ts`; update renderer registry, `src/cli/preview.ts`, and family docs.
- **Instructions:** render the 3x3 stem, missing-cell marker, XOR legend, and four labeled answer tiles from the exact checked masks. Use identical glyph positions/styles in examples/options. Implement matrix-specific clipping/overlap/empty-mask assertions and critical-group metadata.
- **Verification:** `npm exec vitest run tests/render/matrix.test.ts`; `npm run preview -- --family matrix --seed preview-v1`; `npm run check`. Rasterize 100 seeds for basic bounds/distinctness; use fixed adversarial plus ten seeded cases for removed-critical-group pixel checks. Include swapped glyph positions and clipped-glyph negatives.
- **Manual acceptance:** open the 512-pixel PNG; the missing cell, both rule directions, each glyph, and A-D are distinguishable, with no visual cue revealing the key.
- **Out of scope:** another family or HTML gallery.

### P13. Transform Specification and Coordinate Engine

- **Size:** M; one D4 coordinate algebra.
- **Prerequisites:** P04 and P10; no other family's renderer.
- **Files:** create `src/families/transforms/schema.ts`, `src/families/transforms/engine.ts`, `src/families/transforms/canonical.ts`, and `tests/families/transforms.test.ts`; update formal registry and family docs.
- **Instructions:** implement section 7.7's exact D4 maps/compositions, connected construction/orbit gate, ordered operations, checked choices, and conjugated source/sequence canonicalization. Level 3 uses R90/R270 with a reflection (R180 commutes and is not a valid noncommuting pair). Independent checking uses coordinate equations, not cached generator outputs.
- **Verification:** `npm exec vitest run tests/families/transforms.test.ts`; `npm run check`. Assert group identities/composition, noncommuting order, symmetric-source duplicate rejection, frame-equivalent sequence hashes, distinct one-step/two-step same-effect fingerprints, and 100 construction seeds within bounds.
- **Manual acceptance:** an asymmetric fixed mask produces the hand-checked R90 and left-right outputs; reversed step order is detectably wrong.
- **Out of scope:** raster layout, continuous geometry, arbitrary pivots.

### P14. Transform Renderer and Orientation Clarity

- **Size:** M; one visual presentation.
- **Prerequisites:** P10 and P13.
- **Files:** create `src/families/transforms/render.ts` and `tests/render/transforms.test.ts`; update renderer registry, preview CLI, and family docs.
- **Instructions:** render source, explicit ordered operation arrows/axis legend, and four same-scale grids. Keep center/pivot fixed and include viewer-relative direction. Validate exact occupied-cell geometry and option raster distinctness; prohibit decorative rotations outside the formal operation.
- **Verification:** `npm exec vitest run tests/render/transforms.test.ts`; `npm run preview -- --family transforms --seed preview-v1`; `npm run check`. Include 100-seed render bounds checks, missing-axis/reversed-arrow adversarial fixtures, and ten seeded critical-pixel checks.
- **Manual acceptance:** the PNG alone plus its public rule text determines clockwise direction, mirror axis, and which operation occurs first.
- **Out of scope:** animation, free-form SVG transformations, gallery.

### P15. Path Graph and Route Engine

- **Size:** M; one bounded graph family.
- **Prerequisites:** P04 and P10; no other family's renderer.
- **Files:** create `src/families/paths/schema.ts`, `src/families/paths/engine.ts`, `src/families/paths/canonical.ts`, and `tests/families/paths.test.ts`; update formal registry and family docs.
- **Instructions:** implement section 7.8: connected embedded tree, marked endpoints, target route-length ranges, independent tree/BFS checks, and bounded full-grid simple-path distractor enumeration. Reuse no hidden spanning-tree witness as the verified route.
- **Verification:** `npm exec vitest run tests/families/paths.test.ts`; `npm run check`. Test disconnected/cyclic/diagonal graphs, duplicate edges, start=goal, invalid closed-edge route, revisits, route enumeration cap, D4/translation equivalence, genuinely different topology, and 100 seed constructions.
- **Manual acceptance:** one test introduces an extra open edge and demonstrates why the tree/unique-route check fails; a visually tempting shortcut is formally invalid.
- **Out of scope:** shortest-path variants or arbitrarily large mazes.

### P16. Path Renderer and Corridor/Wall Checks

- **Size:** M; one graph-to-pixels capability.
- **Prerequisites:** P10 and P15.
- **Files:** create `src/families/paths/render.ts` and `tests/render/paths.test.ts`; update renderer registry, preview CLI, and family docs.
- **Instructions:** render the checked maze and four copies with highlighted routes. Draw every open/closed edge from one explicit wall convention; keep identical maze geometry and S/G markers in each choice. Check no path segment crosses a blocked boundary unnoticed, and keep walls distinguishable in grayscale/preview.
- **Verification:** `npm exec vitest run tests/render/paths.test.ts`; `npm run preview -- --family paths --seed preview-v1`; `npm run check`. Rasterize 100 seeds; include hidden-wall, clipped-endpoint, illegal diagonal, and changed-maze-choice negatives plus ten critical-pixel cases.
- **Manual acceptance:** at 512 pixels, S/G, corridor openings, walls, and each highlighted route are unambiguous without looking at source JSON.
- **Out of scope:** maze interaction, path drawing UI, gallery.

### P17. Symmetry Specification and Reflection Proof

- **Size:** S/M; finite cell correspondence, not exponential image search.
- **Prerequisites:** P04 and P10; no other family's renderer.
- **Files:** create `src/families/symmetry/schema.ts`, `src/families/symmetry/engine.ts`, `src/families/symmetry/canonical.ts`, and `tests/families/symmetry.test.ts`; update formal registry and family docs.
- **Instructions:** implement section 7.9 with explicit known/unknown/empty states, axis, forced full completion, three distinct incorrect missing halves, and axis-preserving canonicalization. The independent checker verifies all reflected pairs and unchanged known cells.
- **Verification:** `npm exec vitest run tests/families/symmetry.test.ts`; `npm run check`. Cover vertical/horizontal maps, off-axis/bad-size metadata, altered known half, omitted/extra reflected cell, duplicate false options, normalized-axis equivalence, and 100 seeds. Assert no 2^32 enumeration occurs.
- **Manual acceptance:** every cell in the missing half has a recorded forced source or empty counterpart, so no unstated completion freedom remains.
- **Out of scope:** continuous shapes, diagonal axes, generic visual symmetry detection.

### P18. Symmetry Renderer and Unknown-State Clarity

- **Size:** M; one renderer with explicit uncertainty visualization.
- **Prerequisites:** P10 and P17.
- **Files:** create `src/families/symmetry/render.ts` and `tests/render/symmetry.test.ts`; update renderer registry, preview CLI, and family docs.
- **Instructions:** render known half, visibly unknown half, dashed labeled axis, and full completion choices. Preserve the same known half in all choices. Unknown gray must not be mistaken for an empty or filled cell; axis stroke must not create counted cells.
- **Verification:** `npm exec vitest run tests/render/symmetry.test.ts`; `npm run preview -- --family symmetry --seed preview-v1`; `npm run check`. Include 100 seeds, swapped-known-half and hidden-axis negatives, known/unknown contrast assertions, and ten critical-pixel cases.
- **Manual acceptance:** a reader can distinguish unknown from empty at 512 pixels and see the exact axis between cells; no option changes the given half.
- **Out of scope:** infer-the-axis questions or gallery.

### P19. Counting/Membership Engine

- **Size:** M; one 25-cell set algebra.
- **Prerequisites:** P04 and P10; no other family's renderer.
- **Files:** create `src/families/counting/schema.ts`, `src/families/counting/engine.ts`, `src/families/counting/canonical.ts`, and `tests/families/counting.test.ts`; update formal registry and family docs.
- **Instructions:** implement section 7.10 with bounded connected cell sets, valid query enums, membership enumeration, independent set/inclusion-exclusion calculations, full-grid fingerprints, and four numeric choices. Normalize `exactlyOneShape` consistently; reject k=3 for two shapes.
- **Verification:** `npm exec vitest run tests/families/counting.test.ts`; `npm run check`. Cover pair/triple overlap, exclusive cells, invalid/disconnected shapes, duplicate cells, boundary-count exclusion, query differences, geometry-vs-count fingerprint tests, wrong keys, and 100 seeds.
- **Manual acceptance:** independently computed membership counts and inclusion-exclusion values agree for every query in a fixed two- and three-shape fixture.
- **Out of scope:** arbitrary polygon/triangle/square detection.

### P20. Counting Renderer and Complete Registry Gate

- **Size:** M; final family renderer and registry completeness check.
- **Prerequisites:** P10 and P19, with P05-P18 already accepted.
- **Files:** create `src/families/counting/render.ts`, `src/domain/spec.ts`, `tests/render/counting.test.ts`, and `tests/families/registry.test.ts`; update registries, preview CLI, and family docs.
- **Instructions:** render the 5x5 membership grid, redundant A/B/C glyph legend, distinguishable overlap combinations, the exact query, and four numeric choices. No translucent-fill-only encoding. Final registry must contain ten engines, five visual renderers, nonempty code-owned visibleRules/common fact inventories for every engine, and no placeholder implementations.
- **Verification:** `npm exec vitest run tests/render/counting.test.ts tests/families/registry.test.ts`; `npm run preview -- --family counting --seed preview-v1`; `npm run check`. Test all seven nonempty three-shape memberships, 100 seeds, hidden-overlap/legend negatives, critical-pixel cases, and modality/family capability coverage.
- **Manual acceptance:** a grayscale/512-pixel preview still exposes every cell membership; all ten engines and five real renderers are available without API configuration.
- **Out of scope:** generation orchestration and gallery; they are later, not prerequisites for this gate.

### P21. Structural Fingerprints and Deterministic Duplicate Barrier

- **Size:** M; one cohort-level novelty capability.
- **Prerequisites:** P05-P20 and P03.
- **Files:** create `src/validation/fingerprints.ts`, `src/validation/duplicates.ts`, and `tests/validation/duplicates.test.ts`; extend candidate assessment schemas and protocol docs. Fix an existing `src/families/<family>/canonical.ts` only where equivalence tests reveal a defect.
- **Instructions:** implement section 6 over the completed canonical data: separate content/spec/structure and applicable SVG/PNG hashes, reduced cores, P04's features, one-edit near policy, deterministic eligible-owner selection, and immutable assessments. Require all planned preparation results/early failures before the barrier; budget pause is not completion. Emit pair evidence, including early-failure diagnostics, without replacing candidates or rewriting terminal failures.
- **Verification:** `npm exec vitest run tests/validation/duplicates.test.ts`; `npm run check`. Test exact tokens, relabelings, known redundant clues, cross-lane groups/owners, one-edit positives and two-edit negatives where admissible, section 7.11's mandatory counting pair and both flag directions, distinct transform step sequences, shuffled completion order, incomplete-barrier refusal, and zero replacements. Do not claim the reduced-core proxy detects all logically equivalent clue sets.
- **Manual acceptance:** the same prepared cohort in different completion orders yields identical owners/flags; raw JSON hash differences alone never justify uniqueness.
- **Out of scope:** a claim of complete natural-language/semantic duplicate detection or human adjudication.

### P22. Visible Presentation Assembly and Mechanical Semantic Checks

- **Size:** M; deterministic public/reveal boundary.
- **Prerequisites:** P20, P21, and P03.
- **Files:** create `src/presentation/wording.ts`, `src/presentation/assemble.ts`, `src/validation/presentation.ts`, and `tests/presentation/assemble.test.ts`; extend shared presentation types and protocol docs.
- **Instructions:** implement the strict wording schema, code-owned rules/targets/options, field/fact coverage checks, safe public `VisiblePresentation` DTO, and separate reveal data for key/hint/explanation/proof. Add deterministic fixture wording only for tests/previews, labeled as such. A natural-language paraphrase with correct IDs remains `semantic_alignment_pending`, never mechanically proven true. SVG assembly refers to actual stored PNG/SVG hashes.
- **Verification:** `npm exec vitest run tests/presentation/assemble.test.ts`; `npm run check`. Test missing/extra/duplicate facts, unknown entity/reference, length bounds, wrong ordered choices, model HTML/script strings retained as plain text, missing image asset, and a same-ID semantic contradiction that must not receive an automatic semantic pass.
- **Manual acceptance:** public JSON has no answer/hint/proof; the reveal object is separate; an intentionally wrong paraphrase is pending review rather than silently repaired or falsely verified.
- **Out of scope:** model calls and HTML gallery.

### P23. Request Ledger and Transactional Budget Admission

- **Size:** M; durable accounting without HTTP.
- **Prerequisites:** P03 and shared schemas from P02/P22.
- **Files:** create `src/storage/migrations/0002_requests.sql`, `src/ai/ledger.ts`, `src/ai/budget.ts`, and `tests/ai/budget.test.ts`; pin decimal.js and update lockfiles/types.
- **Instructions:** implement section 8 logical-call/attempt state machines, unique nullable-slot/probe keys, decimal money, reservations, settlement, unknown exposure, and append-only budget events. Inject estimates/clock rather than query a provider here. Save request intent before a caller can dispatch. Separate role/run-kind totals and permit no call admission on a zero mock budget unless the injected transport is explicitly nonbilling.
- **Verification:** `npm exec vitest run tests/ai/budget.test.ts`; `npm run check`. Test two simultaneous admissions at the boundary, duplicate logical calls, prepared/dispatching crashes, exact 0.1+0.2 decimal math, explicit zero vs missing actual cost, actual > reserve, unknown reservation retention, insufficient budget pause, and separate calibration/main accounts.
- **Manual acceptance:** a controlled two-request test cannot spend the same remaining reservation twice; unknown costs remain visible and prevent false zero-cost reporting.
- **Out of scope:** fetch, retries, live price estimation, automatic resume.

### P24. OpenRouter Transport and Conservative Retry Policy

- **Size:** M; one externally facing adapter, tested only locally.
- **Prerequisites:** P23.
- **Files:** create `src/ai/openrouter.ts`, `src/ai/retry.ts`, `src/ai/redact.ts`, `tests/ai/openrouter.test.ts`, and `tests/helpers/fake-openrouter.ts`.
- **Instructions:** implement native non-streaming fetch with dependency-injected base/clock only in test harnesses; production host is fixed. Preserve Balanced routing and enabled OpenRouter provider fallback; record returned provider identity without enforcing a fixed endpoint. Enforce deadline/byte caps, raw response persistence before validation, credential redaction, top-level and choice-level error inspection even on HTTP 200, strict finish-reason handling, and the allowlisted client retry rules in section 8.2. Add bounded generation-ID usage reconciliation, not generation replay.
- **Verification:** `npm exec vitest run tests/ai/openrouter.test.ts`; `npm run check`. Fake 429/no-provider 503, long Retry-After, 401/402/403, generic 500/502, 200 error body, provider rate error after generation ID, timeout/disconnect, refusal, reasoning-only/length output, malformed body, missing cost, oversized response, and a saved usable response. Assert identical retry hashes, <=3 client attempts only for allowlisted refusals, no extra client/SDK retries, accepted/recorded provider changes, and no credential in DB/logs. Router-internal fallback is not counted as an extra client attempt.
- **Manual acceptance:** local fake diagnostics distinguish an unprocessed refusal from an uncertain possibly billed request; neither changes candidate content to obtain success.
- **Out of scope:** paid requests, a custom application-side provider selector/fallback loop, JSON repair, model substitution. OpenRouter-managed provider fallback remains enabled.

### P25. Strict Role Schemas, Capabilities, and Offline Preflight

- **Size:** M; route/schema gate, no content generation.
- **Prerequisites:** P20, P22, and P24.
- **Files:** create `src/ai/schemas.ts`, `src/ai/config.ts`, `src/ai/preflight.ts`, `src/cli/preflight.ts`, `tests/ai/preflight.test.ts`, and `tests/fixtures/openrouter/catalog.json`; add preflight script and `.env.example` with empty IDs/key plus documented limits.
- **Instructions:** compile family/wording/review schemas from Zod using provider-compatible strict JSON Schema, all required fields and forbidden extra properties. Define the blind/alignment response schemas now. Implement model-level Balanced routing and dynamic compatible-endpoint/cap-field checks from section 8.1, context/pricing validation, role separation, and offline catalog fixtures; require no provider IDs and build no endpoint allowlist. Live entry points must validate and archive the current operator routing-settings confirmation, blocking conflicting account sort/BYOK or missing confirmation; offline tests use explicit fixtures, not invented live observations. Implement live probe code behind paid gates but do not execute it. Public catalog GETs do not require elevated management credentials. No default key/model may be included.
- **Verification:** `npm exec vitest run tests/ai/preflight.test.ts`; `npm run preflight -- --offline`; `npm run check`. Test unavailable model, no compatible active provider, provider addition/removal/recovery without pinning, unsupported strict schema/image/cap field, max_tokens vs max_completion_tokens serialization (never both/neither), insufficient context/output limits, conservative multi-provider/unknown pricing, unsupported settings, extra fields, missing inference key, catalog 403 fail-closed/no privilege escalation, and zero real network/key use offline. Assert enabled fallback, required parameters, absent provider selectors/sort and Nitro/Floor suffixes, successful configuration without provider IDs, and pre-dispatch blocking for missing/stale routing confirmation, conflicting account sort, or BYOK.
- **Manual acceptance:** offline preflight names the exact missing capability for each negative fixture; it cannot pass an image route merely because the model name sounds multimodal.
- **Out of scope:** actual live model validation; that is P51 in the v2.0 designer sequence, not an assumed offline success.

### P26. One-Shot AI Specification Proposer

- **Size:** M; one adapter across the already-fixed family DSLs.
- **Prerequisites:** P25 and P05-P20.
- **Files:** create `src/ai/propose-spec.ts`, `src/ai/prompts/v1/spec.txt`, `src/ai/prompts/v1/family-guidance.json`, and `tests/ai/propose-spec.test.ts`; update prompt hashing documentation.
- **Instructions:** build a family-specific schema request with fixed IDs/domain/difficulty and normative DSL guidance from section 7. Accept one response, validate its exact requested family/difficulty bounds, save it, and pass it to the independent engine. Do not accept a supplied answer, options, prose, SVG, or arbitrary constraint string. Save schema/prompt versions with every logical call.
- **Verification:** `npm exec vitest run tests/ai/propose-spec.test.ts`; `npm run check`. Exercise valid and invalid responses for all ten families, wrong family, out-of-domain IDs, extra answer key, unsat/multiple formal result, refusal/truncation, and a single content proposal after failure. All responses come from the local fake.
- **Manual acceptance:** a malformed first proposal leaves one failed slot with its raw response and cost record, not a hidden fallback to a programmatic puzzle.
- **Out of scope:** wording, generation retries, live experimentation.

### P27. AI Wording, Hint, and Explanation Adapter

- **Size:** M; one common presentation-generation adapter.
- **Prerequisites:** P22, P25, and P26.
- **Files:** create `src/ai/write-wording.ts`, `src/ai/prompts/v1/wording.txt`, and `tests/ai/write-wording.test.ts`; extend prompt/version inventory.
- **Instructions:** use the same request builder for both lanes after successful formal checking and code-owned option creation. Supply spec, visible rules/facts, proof, correct option, and option values to the generator; it may see the key because it writes the explanation. The generator needs no image-input capability. Strictly parse/save original wording, run P22 mechanical checks, and leave semantic alignment pending. Do not repair, truncate, substitute templated prose, or ask again after a failed first response.
- **Verification:** `npm exec vitest run tests/ai/write-wording.test.ts`; `npm run check`. Cover both lanes/all modalities, swapped or missing facts, unsupported explanation references, fact-ID-preserving negation drift, answer leakage into question, HTML/script-like strings, empty reasoning-only response, and exactly one wording call per eligible slot. Semantic drift/leakage without a mechanical disproof stays pending for P30, not falsely passed or detected by a nonexistent English parser. SVG public text must not contain a hidden scene transcription.
- **Manual acceptance:** both lanes produce the same stored presentation shape; bad text stays auditable and cannot become approved without the later alignment role.
- **Out of scope:** blind reviewers, repair loops, paid calls.

### P28. Blind Text Reviewer and Leakage Tests

- **Size:** S/M; one strict role boundary.
- **Prerequisites:** P25 and P27.
- **Files:** create `src/ai/review-text.ts`, `src/ai/prompts/v1/blind-text.txt`, and `tests/ai/review-text.test.ts`.
- **Instructions:** build the section 5.3 allowlisted payload from public DTO only, parse the blind schema, save exact input/output, and compare the choice with the code key outside the builder. Fixed role instructions treat puzzle text as untrusted data and forbid obeying embedded directions that alter review policy/output. Preserve all review evidence; do not feed a key back. This prompt instruction is defense-in-depth, not proof of prompt-injection immunity.
- **Verification:** `npm exec vitest run tests/ai/review-text.test.ts`; `npm run check`. Use hidden canaries for slot/lane/spec/key/hint/proof/previous review, deep-compare the full request's public data, test every answer-status/null relation, wrong choice, uncertainty, refusal/invalid JSON, and no content retry after disagreement.
- **Manual acceptance:** a captured fake request contains exactly the human-visible question and four choices plus fixed role instructions, with no expected label or reveal material.
- **Out of scope:** vision and informed semantic review.

### P29. Blind Vision Reviewer Using the Actual PNG

- **Size:** M; one image input boundary.
- **Prerequisites:** P10, P20, P25, and P28.
- **Files:** create `src/ai/review-vision.ts`, `src/ai/prompts/v1/blind-vision.txt`, and `tests/ai/review-vision.test.ts`; extend PNG metadata/safety assertions if necessary.
- **Instructions:** send the stored full PNG bytes, public text, and A-D choices using the Chat Completions image part. Persist the same image hash, but do not put that audit metadata, raw SVG, hidden scene IDs, DSL, or solution metadata in the model's textual input. Strip/check PNG ancillary text metadata so a key cannot leak through the image file. Parse legibility/ambiguity and the chosen option without claiming a correct answer proves visual correctness.
- **Verification:** `npm exec vitest run tests/ai/review-vision.test.ts`; `npm run check`. Assert byte-for-byte PNG equality, source-hash agreement, no SVG/scene/metadata in request, correct image MIME/shape, absent/corrupt/oversized PNG failures, unreadable/wrong/uncertain response handling, and all five visual family payloads.
- **Manual acceptance:** compare the captured fake request image to the saved preview/full asset; the reviewer is not merely solving a textual description of hidden layout parameters.
- **Out of scope:** using generator vision, external image URLs, or live route assumptions.

### P30. Informed Alignment Reviewer

- **Size:** M; one semantic evidence adapter with two modalities.
- **Prerequisites:** P27-P29 and their strict schemas from P25.
- **Files:** create `src/ai/review-alignment.ts`, `src/ai/prompts/v1/alignment-text.txt`, `src/ai/prompts/v1/alignment-vision.txt`, and `tests/ai/review-alignment.test.ts`.
- **Instructions:** implement section 5.2 in a new stateless request using the independent reviewer's text/vision route, with proof/key and actual presentation. Treat model-authored wording/hint/explanation as untrusted data, not reviewer instructions. Do not include the blind review or reuse its conversation. Check required field statuses in code and cite concerns separately from deterministic evidence. SVG uses the actual PNG; keep this role/cost separate from blind solving.
- **Verification:** `npm exec vitest run tests/ai/review-alignment.test.ts`; `npm run check`. Detect mocked paraphrase negation, extra assumption, unsupported hint, wrong explanation step, changed visual option, SVG rules/observation mismatch despite empty clueTexts, `overall pass` with a failing field, improper N/A in any field except text image, uncertain status, and missing/errored review. Assert blind request hashes are unaffected by informed context.
- **Manual acceptance:** the fake contradiction passes fact-ID coverage but fails informed alignment; the report data identifies this as model evidence, not formal proof.
- **Out of scope:** adjudication, rewriting the presentation, changing the primary answer.

### P31. Pure Primary-Verdict Reducer

- **Size:** S/M; decision table without scheduling/API behavior.
- **Prerequisites:** P21-P30.
- **Files:** create `src/validation/verdict.ts`, `tests/validation/verdict.test.ts`, and `docs/verdict-table.md`; finalize failure-code/evidence schemas.
- **Instructions:** implement section 4.3 as a pure exhaustive reducer. Precedence: no usable generation -> generation_error; deterministic disproof -> rejected; only model/near-duplicate/missing-review concern -> inconclusive; approved only after every required pass. Keep all failure codes even if one decides the verdict. Cost unknown blocks business `proceed`, but does not by itself reverse an otherwise valid puzzle quality label; record this distinction.
- **Verification:** `npm exec vitest run tests/validation/verdict.test.ts`; `npm run check`. Cover every verdict and each failure code, a correct reviewer answer with invalid spec, an incorrect reviewer on a valid spec, blind/alignment conflict, missing vision, exact duplicate ownership, suspected near-pairs on both members, incomplete budget-paused stages, and strict prohibition of approval with a pending check.
- **Manual acceptance:** the printed/documented truth table unambiguously decides edge cases without requiring the later runner to invent policy.
- **Out of scope:** human-overwriting of primary verdicts or rate calculation.

### P32. Deterministic Mock Transport and Role Scenarios

- **Size:** S/M; test/simulation transport only, no runner.
- **Prerequisites:** P20 and P23-P31.
- **Files:** create `src/ai/mock.ts`, `tests/ai/mock.test.ts`, and `tests/fixtures/mock/role-responses.json`; extend the injected transport factory without changing live request DTOs.
- **Instructions:** supply role-specific valid and deliberately failing mock responses, explicit zero synthetic cost, stable seeded output, and an out-of-band mock scenario registry keyed by logical call. Fixture oracles may know the answer only in this mock module; callers must not add it to a blind request. Reuse deterministic family engines/templates for spec/wording scenarios. Enable wrong-answer/schema/refusal/timeout scenarios by injected test configuration, never as a live-to-mock fallback. Every mock response is still saved and parsed through the real ledger/schema path.
- **Verification:** `npm exec vitest run tests/ai/mock.test.ts`; `npm run check`. Exercise every family/role, repeated-seed stability, synthetic usage labels, failure scenarios, absence of credentials/network, live-factory rejection of mock oracles, and unchanged blind request allowlists. No smoke CLI is promised yet.
- **Manual acceptance:** captured simulated requests look like real public role requests; hidden oracle data exists only in the test/simulation registry, and output is visibly not live evidence.
- **Out of scope:** slot orchestration, duplicate barrier, experiment execution.

### P33. Per-Slot Preparation and Durable Checkpoints

- **Size:** M; one preparation stage, no cohort scheduling or reviews.
- **Prerequisites:** P03, P20-P27, P31, and P32.
- **Files:** create `src/runner/prepare-slot.ts` and `tests/runner/prepare.test.ts`; extend stage-result schemas only for the preparation result envelope.
- **Instructions:** implement one slot's lane-specific spec acquisition, independent solving, options, SVG/PNG when applicable, wording, public assembly, and deterministic checks. Commit each stage transactionally and return `ready_for_duplicate_barrier` or an evidenced early failure. Consume existing adapters/engines rather than add family branches. In mock mode only, register the required role scenario outside request DTOs. Never call a reviewer, choose a duplicate owner, or mark a ready candidate approved here.
- **Verification:** `npm exec vitest run tests/runner/prepare.test.ts`; `npm run check`. Prepare one slot for each family/lane (20 fixtures) through the injected mock transport. Assert exact persisted stage artifacts, real visual bytes, raw first failures, no hidden content/lane fallback or regeneration, no blind/alignment calls, known synthetic cost, and no partial transaction on failure.
- **Manual acceptance:** inspect prepared records directly in the test database: usable presentations are awaiting cohort checks, failures retain their first evidence, and none is prematurely approved.
- **Out of scope:** full smoke command, review sequence, concurrent workers, resume.

### P34. Serial Cohort Barrier, Reviews, and Mock Smoke CLI

- **Size:** M; orchestration over the already working mock and preparation stages.
- **Prerequisites:** P21, P28-P33, and P03.
- **Files:** create `src/runner/review-slot.ts`, `src/runner/run.ts`, and `tests/runner/serial.test.ts`; extend experiment CLI and README.
- **Instructions:** allocate 20 mock smoke slots, call P33 serially, persist the barrier, run blind then informed reviews once for eligible and near-suspected presentations, and apply P31. Preserve early failures and skip confirmed exact/structural duplicates or other deterministically rejected inputs; near suspicion alone must not skip reviews. Use the existing ledger/budget, not a second mock-only runner. Support smoke+mock; reject unfinished live/full/resume paths.
- **Verification:** `npm exec vitest run tests/runner/serial.test.ts`; `npm run experiment -- --smoke --mock --seed puzzle-smoke-v1 --max-cost 0`; `npm run check`. Assert ten families/both lanes, fixed 20 slots, role counts, no replacements/review before barrier, no calls on confirmed duplicates, both reviews on otherwise eligible near pairs with inconclusive final outcomes, and zero paid traffic. Inspect SQLite; reports do not exist yet.
- **Manual acceptance:** the printed run UUID reopens with all 20 slots and honest outcomes without `.env`, HTML, concurrency, or resume being required.
- **Out of scope:** all-200 CLI, production readiness, cancellation/recovery.

### P35. Bounded Concurrency and Graceful Cancellation

- **Size:** M; scheduling, not recovery.
- **Prerequisites:** P34 and P23.
- **Files:** create `src/runner/workers.ts`, `src/runner/cancel.ts`, and `tests/runner/concurrency.test.ts`; extend `src/runner/run.ts` and CLI concurrency parsing.
- **Instructions:** run one/two candidate workers in one process with shared transactional admission; max two HTTP requests in flight across roles. Yield between bounded formal jobs. Preparation must finish before the duplicate barrier, and blind/alignment remain sequential per slot. SIGINT stops new admission, drains active calls up to 95 seconds, checkpoints, then marks any unfinished dispatch uncertain rather than releasing its reservation. Keep the writer lock refreshed; lock compromise stops admissions immediately.
- **Verification:** `npm exec vitest run tests/runner/concurrency.test.ts`; `npm run experiment -- --smoke --mock --seed puzzle-smoke-v1 --concurrency 2 --max-cost 0`; `npm run check`. Fake-clock tests assert max in-flight count, identical structural owners/results at concurrency 1/2, no budget race, no starvation, stop-admission behavior, drain timeout, and rejection of concurrency 0/3.
- **Manual acceptance:** cancellation leaves a resumable checkpoint and truthful reservations, not a success message or an artificially completed run.
- **Out of scope:** multi-process distributed workers, full restart/resume implementation.

### P36. Crash-Safe Resume and Reconciliation

- **Size:** M; dedicated recovery assignment because it is not a flag-only change.
- **Prerequisites:** P03, P23-P24, and P35.
- **Files:** create `src/runner/resume.ts`, `tests/runner/resume.test.ts`, and `tests/helpers/runner-child.ts`; extend run/CLI recovery paths and README.
- **Instructions:** resume from committed stage boundaries; reuse persisted valid responses; distinguish safe prepared intents from uncertain dispatched calls; preserve stage/call unique keys. Implement bounded cost-only reconciliation and explicit authorized budget increases. Reject source/prompt/schema/manifest/model/routing-policy/seed/mode changes, not changes in observed serving providers. Require a fresh operator routing-settings confirmation before live resume. Never automatically resend a request whose success/billing is unknown or replace its slot. Recompute a missing duplicate barrier only after all preparation states exist.
- **Verification:** `npm exec vitest run tests/runner/resume.test.ts`; `npm run check`. Spawn/kill a child using only a loopback fake before dispatch, after acceptance/before response persistence, after response save/before validation, after stage commit, and during duplicate/review stages. Restart and assert no duplicate logical/content call, no lost paid exposure, safe reuse of the saved body, all slot identities retained, provider churn accepted under unchanged Balanced policy, rejection of missing/conflicting account-policy confirmation before live dispatch, and useful errors for mismatched versions/routing policy or an active writer. Tests synchronize on events, not arbitrary sleeps.
- **Manual acceptance:** interrupt a mock smoke run and execute `npm run experiment -- --resume <run-id> --mock`; inspect the same UUID/slot ledger, including an intentionally uncertain request that was not replayed.
- **Out of scope:** impossible guarantees of exactly-once external billing or automatic semantic repair.

### P37. Exact Metrics and Machine-Readable Exports

- **Size:** M; pure projections plus bounded exports.
- **Prerequisites:** P31 and P34-P36, plus P03.
- **Files:** create `src/reporting/metrics.ts`, `src/reporting/export.ts`, `src/cli/report.ts`, `src/cli/export.ts`, `tests/reporting/metrics.test.ts`, and `tests/reporting/export.test.ts`; add scripts.
- **Instructions:** implement every section 9.1 metric, including planned-denominator and secondary infrastructure-excluded rates, target-difficulty tables, per-role mean/median/nearest-rank-p95 latency, active/wall times, ambiguity, token/cache/reasoning rollups, observed provider/model mix, Wilson intervals, verdicts, and monetary/identity coverage. Export manifest/candidate/request JSONL/CSV/assets from committed SQLite snapshots and controlled paths. Escape CSV formula-like text (`=`, `+`, `-`, `@`, leading control/whitespace bypasses) without modifying original JSON. Preserve one candidate row per planned slot.
- **Verification:** `npm exec vitest run tests/reporting/metrics.test.ts tests/reporting/export.test.ts`; `npm run report -- --run <mock-smoke-id>`; `npm run export -- --run <mock-smoke-id> --format csv`; `npm run check`. Use hand-calculated miniature cohorts with zero approvals/starts, missing usage/cost/end times/provider identities, known latency quantiles, infrastructure-vs-content errors, difficulty cells, retry waits, provider changes, duplicates, partial runs, and multiple failure codes. Re-import exports structurally; reject unsafe paths and formula injections.
- **Manual acceptance:** totals match the database, unknown money is never zero, and all 20 smoke slots appear including missing/failed presentations. HTML is not required yet.
- **Out of scope:** gallery, calibration scoring, business success claims.

### P38. Static Offline HTML Gallery

- **Size:** M; one report interface, browser automation separately follows.
- **Prerequisites:** P22 and P37.
- **Files:** create `src/reporting/html.ts`, `src/reporting/assets/report.css`, `src/reporting/assets/report.js`, and `tests/reporting/html.test.ts`; extend report output/README.
- **Instructions:** generate escaped `report.html` with modality/family/lane/status/difficulty/disagreement filters, public question/PNG, hidden-by-default key/hint/explanation/proof/reviews, cost/failure/provenance details, and every planned failure card. Use local images, safely escaped embedded JSON, fixed JS, restrictive CSP with a generated script hash, and no fetch/CDN. Show mock/live/incomplete banners. Provide keyboard-accessible reveal/filter/zoom and 360px-responsive layout.
- **Verification:** `npm exec vitest run tests/reporting/html.test.ts`; `npm run report -- --run <mock-smoke-id>`; `npm run check`. Check card counts, complete evidence/reveal sections, correct resource paths, script hash, escaped `</script>` and hostile attributes, safe embedded JSON, and no remote resource references. Do not claim these string-level tests prove browser CSP or layout correctness.
- **Manual acceptance:** open the printed file directly, try reveal/filter/zoom on text and SVG records, and confirm failures remain visible. Automated cross-viewport acceptance is P39.
- **Out of scope:** Playwright setup, server/framework/authentication, calibration UI.

### P39. Browser Acceptance for the Offline Gallery

- **Size:** S/M; one independent browser/security regression suite.
- **Prerequisites:** P38.
- **Files:** create `playwright.config.ts` and `tests/browser/report.spec.ts`; pin @playwright/test, add `test:browser`, and document Chromium installation. Fix P38's existing files only for demonstrated browser failures.
- **Instructions:** run the real generated gallery from `file://` in Chromium at desktop/mobile sizes. Intercept/deny external requests, capture console errors, and exercise accessibility, filters, unrevealed data, zoom, hostile model text, relative PNG loading, and the actual CSP. Keep browser tests separate from unit tests and all API credentials.
- **Verification:** `npm exec playwright install chromium`; `npm run test:browser`; `npm run check`. Assert 1440x900 and 360x800, no document overflow, keyboard reveal/filter controls, full-image zoom, failed/incomplete cards, zero external network, no hostile-text execution, no console errors, and visible relative PNGs under CSP.
- **Manual acceptance:** a browser-tested offline gallery is usable on desktop/mobile without a development server or a revealed solution in the initial view.
- **Out of scope:** new report features, network hosting, live model calls.

### P40. Held-Out Calibration Fixture Pack and Pending Ground Truth

- **Size:** M; one reproducible 40-item fixture/evidence pack, no reviewer calls.
- **Prerequisites:** P05-P22 and P38-P39.
- **Files:** create `src/calibration/fixtures.ts`, `src/calibration/mutations.ts`, `src/calibration/pack.ts`, `src/cli/calibration.ts`, `tests/calibration/fixtures.test.ts`, and `docs/calibration-labeling.md`; add calibration script.
- **Instructions:** construct exactly two sound + two visibly defective cases per family with disjoint fixed seeds and deterministic template wording. Reuse the known adversarial data from each family's accepted formal/render tests; do not invent ten new solver behaviors here. Corruption 1 duplicates the actual correct displayed option under another label for every family. Corruption 2 is: ranking/matching/scheduling/truth/arithmetic, alter a selected visible primitive so the independent visible-domain check proves no offered solution (or at least two); matrix, contradict one visible XOR example and prove no missing mask can fix it; transforms, show contradictory clockwise/counterclockwise instructions with both different outputs offered; paths, close an edge of the unique correct route so all four choices fail against the visible graph; symmetry, contradict the public horizontal/vertical instruction and displayed marked axis; counting, require both union-once and overlap-once-per-shape counting with their two distinct counts offered. Preserve original DSL/proof and a separate precise visible-mutation record. These intentionally invalid presentations bypass primary eligibility only in the held-out calibration path, never in candidate generation; safe SVG/parser limits still apply.
- **Verification:** `npm exec vitest run tests/calibration/fixtures.test.ts`; `npm run calibration -- --prepare`; `npm run check`. Assert 40=20 sound+20 defective, each family 2+2, modality 10+10, stable hashes, no seed overlap with primary/smoke, real PNG corruption/option consequences, and all human labels pending. A mutation that still leaves one clear valid visible answer must fail fixture construction, not be labeled defective anyway.
- **Manual acceptance:** open the generated calibration gallery and labeling template. The 40 records include evidence and proposed expected outcomes, but every `human_verified` field is false.
- **Out of scope:** agent-certified human labels or calibration accuracy claims.

### P41. Calibration Runner, Label Validation, and Scoring

- **Size:** M; review-only evaluation, no puzzle generation.
- **Prerequisites:** P28-P30, P36-P37, and P40.
- **Files:** create `src/calibration/labels.ts`, `src/calibration/run.ts`, `src/calibration/score.ts`, `tests/calibration/score.test.ts`, and `tests/fixtures/calibration/mock-labels.csv`; extend calibration CLI/report and label docs.
- **Instructions:** validate auditor identity/time, fixture hashes/version, complete expected labels and accepted defect codes. Add `--verify-labels <path> --auditor <name>` import validation without filling observations or claiming actual human review. Run exactly blind+alignment once per fixture, with the same frozen prompts/models/Balanced routing policy/limits/payload builders as primary, not necessarily the same serving providers; never include calibration truth/defect labels in blind inputs. Implement separate four-cell-role confusion matrices, conservative denominators, abstentions/errors/coverage, intervals, and fixed 9/10 and 8/10 gates. Mock test labels are explicitly test-only and cannot qualify a live freeze.
- **Verification:** `npm exec vitest run tests/calibration/score.test.ts`; `npm run calibration -- --mock --labels tests/fixtures/calibration/mock-labels.csv`; `npm run check`. Create the CSV with mock/test-only provenance. Hand-check diagnostic matrix vs conservative gates, all-abstain/errors, unrelated criticism, wrong clean answers on sound fixtures, incorrect failing fields/fact IDs, partial runs, false positives/negatives, hash/verification failures, and 80 review calls with zero generations.
- **Manual acceptance:** a mock reviewer that agrees with every answer does not appear sensitive to defects; a reviewer rejecting everything does not pass specificity. No mock result is shown as live calibrated evidence.
- **Out of scope:** tuning the reviewer on primary results or silently reusing stale calibration.

### P42. Deterministic Human-Audit Sample and Append-Only Imports

- **Size:** M; one human-evidence workflow.
- **Prerequisites:** P36-P39 and P41's label validation pattern.
- **Files:** create `src/storage/migrations/0003_human_labels.sql`, `src/audit/sample.ts`, `src/audit/labels.ts`, `src/cli/audit.ts`, `tests/audit/sample.test.ts`, and `docs/human-audit.md`; add audit script/report sections.
- **Instructions:** implement section 9.3's explicit family/lane loops, two reserved approvals per family, 40 core slots plus at most four category additions, and shortfall reporting. Preserve noninspectable failures and separate correctness/clarity/time/legibility/novelty/enjoyment/difficulty labels. Export pending CSV/read-only gallery; import genuine observations with auditor/time/hash and append-only revisions. Never auto-complete labels, infer solving time, or mutate primary verdicts.
- **Verification:** `npm exec vitest run tests/audit/sample.test.ts`; `npm run audit -- --run <mock-smoke-id> --prepare`; `npm run check`. A smoke must refuse a production 40-slot audit and return only a labeled preview. Use a synthetic 200-slot cohort to prove core40/four per family/two per lane, 20 reserved approvals when available, one-lane-only approvals, insufficient approvals/terminal slots, missing categories/max44, hash ties, noninspectable failures, import rejection, and immutable primary hashes. Report total and approved audit denominators independently.
- **Manual acceptance:** audit preview and template are inspectable offline; importing test-only annotations creates a new evidence record and leaves first-attempt outcomes unchanged.
- **Out of scope:** final decision logic, agent-generated human approvals, new candidate generation.

### P43. Protocol Freeze and Explicit Business-Decision Evaluator

- **Size:** M; one evidence-gating capability with pure predicate tests.
- **Prerequisites:** P25, P37, P41, and P42.
- **Files:** create `src/storage/migrations/0004_protocol_freezes.sql`, `src/experiment/freeze.ts`, `src/reporting/decision.ts`, `src/cli/freeze.ts`, and `tests/experiment/freeze.test.ts`; add freeze script and decision docs.
- **Instructions:** implement two separate pure gates: `canFreezeProtocol` validates pre-run live preflight, current operator routing-settings confirmation, verified fixture pack, passing calibration, accepted smoke coverage, hash/configuration agreement, prices/reserves/forecast, and authorized cap; `decideFinal` evaluates every post-run predicate in section 9.3 and incomplete-evidence precedence to `revise`. Configuration agreement freezes model IDs, Balanced routing/fallback policy including verified account defaults/no BYOK, limits, and local protocol inputs, not provider identity or catalog membership. Freeze must not require primary results or future audit. Inject the provenance interface for tests; its real archive arrives in P44 and is not consumed here. Freeze USD 0.10 cost/approved and immutable quotas/seeds; cap amendments are operational events only. Reject mock/partial/stale/unverified evidence without treating normal provider churn as stale calibration.
- **Verification:** `npm exec vitest run tests/experiment/freeze.test.ts`; `npm run check`. Hand-build evidence for modality proceed 79/100 vs 80/100, reject 49/100 vs 50/100; family approvals 9/20 vs 10/20; calibration detection 8/10 vs 9/10, specificity 7/10 vs 8/10, reject 4/10 vs 5/10. Test costs/cap increases, missing audit or fewer than 20 inspected approvals/two per family, sparse fingerprints, novelty-only vs quality/missing-evidence shortfalls without changing outcomes, stale calibration, model/policy drift, missing/conflicting account-policy checks, provider churn with unchanged configuration, and mocks. No live network is needed.
- **Manual acceptance:** a synthetic complete pass and every one-predicate failure produce explicit readable reasons; an incomplete run never claims a definitive proceed or reject.
- **Out of scope:** actually approving live expenditure, running the primary cohort, changing measured outcomes.

### P44. Source Provenance and Artifact Security Boundary

- **Size:** M; one reproducibility/security boundary, no full-run execution.
- **Prerequisites:** P03, P36-P39, and P43.
- **Files:** create `src/experiment/provenance.ts`, `tests/experiment/provenance.test.ts`, `tests/security/artifacts.test.ts`, and `docs/reproduction.md`; connect the real provenance provider to freeze and update README.
- **Instructions:** archive a hashed allowlist of source/prompt/schema files, lockfile/configs, font/license, runtime info, and optional Git commit/dirty status. Never auto-commit or archive secrets/environment; a dirty source snapshot is supported. Test HTML/CSV/SVG/path/credential exports, public/reveal boundaries, and exact source/hash matching. Deterministic local replay uses stored LLM responses, not a promise of identical future remote generations.
- **Verification:** `npm exec vitest run tests/experiment/provenance.test.ts tests/security/artifacts.test.ts`; `npm run check`; `npm run test:browser`. Check missing/modified/extra/symlink files, secret canaries, safe archives/paths, code/hash drift rejection, replayed response identity, and unchanged primary snapshots. Use existing smoke/synthetic fixtures, not a not-yet-enabled full-run CLI.
- **Manual acceptance:** inspect the source manifest and safe archive; it is sufficient to identify/replay the exact local implementation without exposing credentials or relying on a clean Git commit.
- **Out of scope:** 200-slot release run, fresh-install acceptance, paid integration.

### P45. Full Offline Release Run and Fresh Reproduction

- **Size:** M; integration acceptance over completed components, no new architecture.
- **Prerequisites:** P01-P44.
- **Files:** create `tests/experiment/full-mock.test.ts`; extend full-mode CLI guard and `docs/reproduction.md`/README with exact verified commands. Fix existing files only for demonstrated release defects.
- **Instructions:** enable full mock execution and authorization-gated live command paths, with live full requiring immutable protocol evidence. Run the complete 200-slot simulation, report/recovery/coverage checks, and fresh-copy reproduction without .env. Keep the generated full report labeled synthetic and prohibit mock proceed. Do not combine source-archive design with this acceptance assignment; that is complete in P44.
- **Verification:** `npm ci`; `npm run check`; `npm run test:browser`; `npm run experiment -- --full --mock --seed puzzle-poc-v1 --max-cost 0`; `npm run report -- --run <full-mock-id>`; `npm exec vitest run tests/experiment/full-mock.test.ts`. Assert 200 planned/terminal entries, exact quotas, all stage/failure/ledger records, deterministic local replay/concurrency, every exported slot/card, no paid traffic/credentials/mock proceed. Repeat the reproduction in a fresh temporary checkout/copy, installing the documented native/browser tooling.
- **Manual acceptance:** an offline reviewer reproduces the manifest, reopens SQLite, views 200 safe desktop/mobile cards, and can trace the forced uncertain-call recovery tests. Missing setup or a skipped test is a failed/unverified gate, not a pass.
- **Out of scope:** paid compatibility. Acceptance means offline-verified and live-unverified, not experiment success.

### P46. AI Puzzle Designer Contract and Design Proposal Adapter

- **Size:** M; one AI design boundary and strict schema, no solver feedback or live call.
- **Prerequisites:** P02-P26, P32-P33, P36-P37, and P44-P45. P26 supplies the one-shot spec-proposal patterns; P25 supplies strict schemas/capabilities; P23-P24 supply the ledger/transport; P22 supplies the presentation boundary; P21 supplies structural fingerprints; P02-P03 supply the planner and storage contracts.
- **Files:** create `src/domain/design.ts`, `src/design/assignments.ts`, `src/design/bounds.ts`, `src/cli/design.ts`, `src/ai/design-proposal.ts`, `src/ai/prompts/designer-v1/design.txt`, `tests/ai/design-proposal.test.ts`, and `docs/design-protocol.md`; extend `src/ai/config.ts`, `src/ai/schemas.ts`, and package scripts. Do not create the repair prompt or attempt ledger yet.
- **Instructions:** define the strict `DesignProposal` schema: exact `family`, exact `difficulty`, the existing family `spec` union, an optional bounded `designIntent` for provenance only, and an optional `presentationSkin` from a code-owned closed catalog. Reject answers, options, free-form visible prose (question/clue/hint/explanation), SVG/XML, executable code, arbitrary provider fields, extra properties, and labels outside the closed skin catalog. The prompt includes the selected family's DSL schema, bounds, allowed operators, the assignment's family/difficulty, and the closed skin catalog when skin proposals are enabled; it asks for a complete DSL specification that uses any valid combination of the family's allowed fields within bounds, and it must not ask the model to fill a fixed parameter template or copy a baseline example. Include a structural-originality instruction but no baseline spec, witness, answer, options, or human feedback. Validate family/difficulty bounds before solving; the solver call belongs to P47. Add `DESIGNER_MODEL` to the designer live configuration without changing legacy role inputs. Extend the designer CLI's `--dry-run` to print the 100-assignment x 3-arm manifest and the 400-call ceiling; reject bare execution and reviewer/calibration flags.
- **Wire boundary:** implement section 4.2's required-null optional fields and selected-family strict schema, not merely a Zod runtime schema. Compare exact serialized request/schema hashes for one-shot and feedback attempt 0 (excluding ledger identity), exercise null and non-null decorative fields, and prove unsupported schema constructs fail before transport. Create strict designer plan/run/candidate types rather than relabel legacy lane/`approved` data or fabricate absent reviewer roles.
- **Configuration boundary:** add `readDesignerLiveEnvironment` requiring only `OPENROUTER_API_KEY` and `DESIGNER_MODEL` plus validated designer settings; do not invoke legacy `readLiveEnvironment` or weaken its reviewer separation rules. Audit every shared role-dependent seam (`REQUEST_ROLES`/designer role union, `LedgerRoleSchema`, request builder/cap mapping, `responseFormatForRole`, mock scenarios, and preflight serialization) and add explicit designer cases/adapters. Preserve legacy probe-role arrays/counts and fixtures; the designer has its own text/SVG schema probes, not an expanded legacy calibration/preflight suite.
- **Verification:** `npm exec vitest run tests/ai/design-proposal.test.ts`; `npm run designer -- --dry-run --seed puzzle-designer-v1`; `npm run check`. Test all families, section 7's pre-solver level rules and valid non-baseline specs, wrong family/difficulty, global bounds, supplied answers/options/free-form-prose/SVG/code, closed skin/null fields, unsupported dynamic record schemas, prompt/schema hashes, no network/live calls, and exact 100/300/400/0 manifest counts. With reviewer environment variables absent, designer configuration succeeds and legacy configuration still enforces its original contract. Unsupported wire schemas fail loudly before dispatch.
- **Manual acceptance:** inspect a mock design prompt and parsed proposal. The model is asked to design a full DSL structure, not merely choose parameters; the proposal contains no trusted answer/options/free-form prose/SVG, and no reviewer role is present.
- **Out of scope:** repair loop, solver diagnostics, baseline comparison, deterministic presentation, live calls.

### P47. Solver-Feedback Repair Loop and Attempt Ledger

- **Size:** separately accepted storage/migration and feedback-loop steps; no baseline construction or live call. The populated-database migration gate passes before wiring the loop.
- **Prerequisites:** P46, P03, P23-P24, P33, and P36.
- **Files:** create `src/storage/migrations/0006_design_attempts.sql`, `src/design/attempts.ts`, `src/design/diagnostics.ts`, `src/design/feedback.ts`, `src/design/verdict.ts`, `src/ai/repair-proposal.ts`, `src/ai/prompts/designer-v1/design-repair.txt`, `tests/design/feedback.test.ts`, `tests/storage/design-migration.test.ts`, and update `docs/design-protocol.md`; extend repository/ledger/budget/config and strict stored-record parsers, keeping legacy domain contracts intact.
- **Instructions:** implement section 4.4's preserving shared-schema migration, run kinds/pools, and append-only attempt/artifact records. Each attempt has the canonical arm (`baseline|ai_one_shot|ai_feedback`), index 0-2, nullable logical-call/proposal references where no AI call/usable proposal exists, solver/level diagnostic, verdict, cost snapshot, and timestamps. Baseline has only attempt 0 with no AI call/cost; one-shot only index 0; feedback adds at most two repairs under the stop rules. Extend role and stage parsers alongside SQL, including `slots` checkpoints, not just `stage_results`. Implement independent solver checks, section 7's post-formal level checks, and typed diagnostics: schema/bounds paths, at most two independently verified ambiguity witnesses, solver-limit state counts, and input-level option/renderability failures, never final key/options, baseline specs, or human feedback. Obtain ambiguity witnesses through bounded domain enumeration/diagnostic support; do not read a nonexistent unique `correctAnswer` or invent examples from an aggregate count. Preserve legacy serialized solver results if adding diagnostic-only support. The repair request contains the original assignment, the bounded prior proposal or parsed invalid object, and diagnostic, and returns a full proposal. Reject third repairs, patch-shaped responses, supplied answers/options/prose/SVG/code, and replay disguised as a new design. Implement the pure attempt/final reducer with immutable first-attempt evidence.
- **Integration boundary:** P47 exercises downstream option/render/presentation evidence through explicit test doubles; it cannot mark a real candidate accepted before P49 supplies the actual deterministic presentation checks. Pending checks remain pending, not assumed passes. The P47 manual trajectory is synthetic, and P50 repeats it through the complete real pipeline. Apply section 5.1 stop rules after every repair, not only after attempt 0.
- **Verification:** `npm exec vitest run tests/storage/design-migration.test.ts` for the storage step; `npm exec vitest run tests/design/feedback.test.ts` for feedback; `npm run check` after each. Migration covers section 4.4's populated legacy round-trip/FK/hash and 300-slot/pilot-pool cases. Feedback covers 0/1/2 repairs, solver limit, terminal errors at every index, first-attempt immutability, third-repair rejection, all level checks including essential inequality/route length, verified two-witness ambiguity evidence, no key leakage, actual versus snapshot cost, saved-response recomputation, and dispatching-to-uncertain non-replay. Synthetic final `accepted` must not alter first-attempt `rejected`.
- **Manual acceptance:** inspect a mock feedback trajectory: the first proposal is rejected with `MULTIPLE_SOLUTIONS`, the diagnostic shows two distinct solutions, the repair returns a unique spec, and the final verdict is `accepted` while the first-attempt metric still reports the initial rejection.
- **Out of scope:** baseline generator, structural comparator, deterministic presentation, live calls.

### P48. Algorithmic Baseline and Structural Originality Comparator

- **Size:** M; deterministic baseline and novelty measurement, no AI calls.
- **Prerequisites:** P05-P21, P37, P45, and P47.
- **Files:** create `src/design/baseline.ts`, `src/design/novelty.ts`, `src/reporting/design-metrics.ts`, `tests/design/novelty.test.ts`, and update `docs/design-protocol.md`; extend the designer CLI, strict reference-dataset persistence, reporting, and gallery.
- **Instructions:** implement the baseline arm with existing `generateSpec(seed, difficulty)` and its normal bounded construction; record trace/draw counts, independently checked spec/options, and renderer output. Presentation remains pending until P49/P50; a unique solver result alone is not final `accepted`. Build section 6's frozen 100-fixture-per-family reference from the exact existing fixture seed/difficulty tuples, preserving failed draws and repeated structures, and the separate same-cohort baseline reference. Compare AI against their union and compare AI candidates within/across arms. Report exact/structural/one-edit clusters, Jaccard distances, distinct accepted/novel counts, coverage, and per-family/modality/difficulty tables. Use `novelty_unknown` for incomplete reference/comparator evidence. Novelty never changes formal acceptance. Reuse P21 canonical structures and P37 conventions, not duplicate-barrier rejection or AI judgment.
- **Verification:** `npm exec vitest run tests/design/novelty.test.ts`; `npm run designer -- --build-reference`; `npm run check`. The focused test exercises the 100 primary baseline assignments; the offline command persists/exports the separate frozen 1,000-outcome reference. Test exact/one-edit/two-edit pairs, empty features, cross-family isolation, both reference memberships, reference failure/coverage, AI-AI near clusters, repeated novel outputs versus distinct counts, first/final de-duplication, deterministic completion-order-independent hashes, and the mandatory counting positive. A forced bounded construction failure is `inconclusive/BASELINE_CONSTRUCTION_FAILED`, not `generation_error`; unexpected infrastructure exceptions remain distinct. The baseline makes zero AI calls; failures remain counted. Presentation/proof traces are not prerequisites for a solver-verified reference spec and are not falsely marked accepted in this phase.
- **Manual acceptance:** inspect one baseline and one AI candidate for the same assignment. The comparator reports their structural distance and novelty annotation without claiming semantic novelty or human quality.
- **Out of scope:** AI generation, repair, deterministic presentation, human evaluation.

### P49. Deterministic Presentation and Proof-Derived Explanations

- **Size:** three bounded acceptance steps (text templates, visual templates/certificate, proof traces/hints) within P49; no AI prose. Accept each step before the next instead of treating ten families plus proof construction as one small edit.
- **Prerequisites:** P22, P05-P20, P37, and P46-P48.
- **Files:** create `src/presentation/templates.ts`, `src/presentation/explain.ts`, `src/presentation/design-view.ts`, `tests/presentation/design-view.test.ts`, and `docs/presentation-templates.md`; extend the report/gallery with a design view.
- **Instructions:** implement code-owned templates for question, rules, clue text, option text, and title for every family. Templates consume the verified spec, code-owned visible rules/facts, and a neutral entity-label set. The primary protocol uses no free-form model text. If the optional AI `presentationSkin` is present, restrict it to a closed theme catalog and safe decorative label slots; validate that it cannot change conditions, numbers, relations, the query, options, or the answer; store it separately and do not use it in the primary human comparison. Implement deterministic hint/explanation builders from a checked proof trace as specified in section 5.3, not from a witness alone. Each step carries fact IDs, a typed deduction, and a justification. Reuse P22's assembly/fact-coverage/reference checks. For visual families, explain the code-owned rule and forced output; do not introduce observations absent from the diagram. Escape all labels and text.
- **Proof boundary:** implement section 5.3's typed, entailment-checked trace and separate designer presentation certificate; do not treat a witness/reduced core, valid fact IDs, or agreement with the unique answer as sufficient step justification. Reuse legacy P22 without changing its semantics. All three P49 acceptance steps finish before P50 release acceptance; interim presentations remain nonterminal until the proof/certificate checks exist.
- **Verification:** `npm exec vitest run tests/presentation/design-view.test.ts`; `npm run check` after each P49 acceptance step. Test all ten families, text/SVG, valid specs outside baseline construction patterns, template determinism, every operator/polarity/nesting, exact fact coverage, no answer leakage before reveal, every explanation reference resolves, entailment of each step, witness-true but premise-unentailed deductions, circular/forward references, exhaustive-elimination fallback, non-spoiling hint/strategy fallback, the unique final answer, neutral skin stability, hostile-label escaping, and rejection of an AI skin that changes a condition or option. Assert no AI wording/reviewer call occurs.
- **Manual acceptance:** inspect one text and one SVG puzzle. The question/rules/clues/options are code-generated, the hint/explanation follow verified solution steps, and no AI reviewer or free-form wording is involved.
- **Out of scope:** AI wording, AI hints/explanations, reviewer roles, new renderers, human evaluation.

### P50. Offline Designer Completion and Mock Release

- **Size:** four separately implemented, verified, and accepted offline subphases below; not one silently bundled assignment.
- **Prerequisites:** P46-P49, P32, P35-P36, and P37.
- **Files:** P50.1 creates `src/design/mock.ts`, `src/design/run.ts`, `tests/design/resume.test.ts`, and `tests/fixtures/design/mock-scenarios.json`, and completes `src/reporting/design-metrics.ts`; P50.2 creates `src/storage/migrations/0007_designer_protocol_freezes.sql`, `src/design/freeze.ts`, `src/reporting/design-decision.ts`, `tests/design/freeze.test.ts`, and `tests/reporting/design-decision.test.ts`; P50.3 creates `src/storage/migrations/0008_design_evaluations.sql`, `src/audit/design-sample.ts`, `src/audit/design-labels.ts`, `src/cli/design-audit.ts`, `tests/audit/design-sample.test.ts`, and `docs/design-evaluation.md`; P50.4 creates `tests/design/mock-cohort.test.ts` and `tests/browser/design.spec.ts`. Extend the existing designer/freeze/audit/report/export CLIs, gallery, mock factory, and `docs/design-protocol.md` in their owning subphase.
- **Instructions:** execute P50.1, P50.2, P50.3, and P50.4 in that order with an explicit acceptance boundary after each. All live entry points, protocol/decision logic, sampling/import logic, migrations, and provider preflight/resume paths must be implemented and offline-tested here; P51-P55 do not introduce new source files or evaluation rules.
- **Verification:** use the exact subphase commands below and `npm run check` after each implementation; no paid traffic or fabricated live/human evidence is allowed. P50.4 is the final release gate.
- **Manual acceptance:** inspect the mock report, frozen synthetic evidence rejection, resume evidence, and blinded evaluation preview. Every assignment has three arm cards, failures/repairs are visible, first-attempt and final results are separate, and no reviewer role is present. Mock acceptance is not live freeze eligibility or human approval.
- **Out of scope:** executing paid calls, accepting a live protocol, or supplying genuine human observations.

#### P50.1. Designer Orchestration, Recovery, and Metrics

Implement the real three-arm runner and deterministic mock scenarios keyed outside request DTOs: first accepted, multiple solutions/unsat/schema invalid then repaired, all repairs fail, solver limit, declared input-level renderability failure, and generation error. Test implementation/storage/renderer exceptions in separate fault-injection runs that must pause, not as expected fully completed cohort scenarios. Finish every section 9.1 metric with hand-calculated miniature fixtures, including missing costs, repair denominators, novelty coverage, and incomplete runs. Reuse ledger/workers/cancellation patterns, not the legacy reviewer runner. Add designer `--resume <run-id>` with same-source/model/plan checks, fresh live routing confirmation, safe saved-response reuse, no ambiguous dispatch replay, and separately authorized cap amendments.

Verification: `npm exec vitest run tests/design/feedback.test.ts tests/design/resume.test.ts tests/design/novelty.test.ts`; `npm run check`. Force crashes before dispatch, after dispatch without a response, after response save, after attempt commit/before repair creation, and after repair response/before terminal commit. Verify identical first-attempt/repair identities, no extra content call, no lost reservation, deterministic novelty independent of completion order, and concurrency 1/2 equivalence for stored-response replay. Accept this subphase before P50.2.

#### P50.2. Designer Freeze and Decision Implementation

Implement `canFreezeDesignerProtocol`, section 4.4's new append-only designer-freeze persistence, and the pure section 9.3 decision evaluator, with designer CLI dispatch; do not weaken or populate the calibration-bound legacy freeze. Freeze validates pre-run evidence only and cannot require future primary/human outcomes. Test every proceed/reject boundary and incomplete-evidence precedence, null denominators, novelty coverage, human shortfalls, and known versus unknown costs. Test mock/partial/stale/mismatched pilot rejection, source/model/routing drift, unchanged-policy provider churn, and forecast above authorization. Threshold changes are explicit pre-pilot protocol changes, not CLI defaults that drift. DB commit precedes export; verify freeze replay from SQLite with `protocol.json` removed and regenerated.

Verification: `npm exec vitest run tests/design/freeze.test.ts tests/reporting/design-decision.test.ts`; `npm run check`. Include 59/100 vs 60/100 feedback, 24/50 vs 25/50 modality, 39/100 vs 40/100 one-shot, 11/60 vs 12/60 repaired, 4 vs 5 percentage-point lift, ceiling/no-repair-opportunity cases, 29/100 vs 30/100 novelty, 2/10 vs 3/10 per family, 49 vs 50 distinct structures, USD 0.50 vs 0.51, all human boundaries, and each strong-failure reject boundary. No live freeze is issued. Accept before P50.3.

#### P50.3. Blinded Human-Evaluation Tooling

Implement section 9.2's fixed sampler/order/rubric and section 4.4's strict append-only sample/evaluation records, pending CSV, staged public-then-reveal gallery, auditor/hash validation, and pairwise preferences. Wire `npm run audit -- --design` without altering legacy audits. All sampling/rubric code and migration hashes exist before the pilot and freeze; P54 only prepares/imports genuine observations. Synthetic labels are visibly test-only and cannot satisfy live decision gates.

Verification: `npm exec vitest run tests/audit/design-sample.test.ts`; `npm run check`. Cover complete/fallback/missing triplets, addition priorities/ties/max40, anonymous URLs/asset names, absence of arm/repair/novelty metadata in the solving view, genuine-label provenance checks, unchanged primary snapshots, and fixed denominators. Accept before P50.4.

#### P50.4. Full Offline Designer Release

Run the full mock cohort through the real storage/ledger/solver/renderer/presentation/metrics/export path, including the P50.2 evaluator and P50.3 blinded preview. Complete authorization-gated pilot/full command paths using only local fakes in this phase. Add real file-URL browser tests for both designer and blinded views at desktop/mobile sizes, CSP, reveal, safe text/PNG loading, filters, and zero external requests. Verify fresh offline reproduction with stored responses; a designer run must never dispatch legacy reviewer roles.

Verification: `npm exec vitest run tests/design/mock-cohort.test.ts`; `npm run designer -- --mock --seed puzzle-designer-mock-v1 --max-cost 0`; `npm run report -- --run <mock-design-id>`; `npm run audit -- --design --run <mock-design-id> --prepare`; `npm run check`; `npm run test:browser`. Assert exactly 100 assignments, 300 candidates, 100 per arm, at most 400 mock AI calls, zero baseline AI calls, first-attempt/final separation, all families/modalities, every planned export/card, known zero synthetic cost, recovery/cancellation, and explicit refusal to treat mock labels or a mock pilot as live evidence. P50 is accepted only after all four subphases pass.

### P51. Authorized Live Designer Compatibility Probe and Pilot

- **Size:** M; bounded live integration, at most 82 logical calls (2 probes + 80 pilot).
- **Prerequisites:** all P50 subphases, P25, and P45; explicit user authorization covering the separate preflight and pilot pools; actual `DESIGNER_MODEL` and inference key supplied locally. Default caps are USD 0.50 preflight plus USD 2 pilot (USD 2.50 combined maximum), not a combined USD 2 authorization. No authorization means `blocked/live-unverified`, not a mock substitute.
- **Files:** append truthful evidence to `docs/PROVIDER_SMOKE_TESTS.md` and `docs/PROGRESS.md`; save the pilot run, report, and artifacts under ignored `data/`. No feature code changes in a passing phase.
- **Instructions:** archive the actual operator routing-settings confirmation from section 8.1 before dispatch; a conflicting account sort, BYOK, or missing confirmation blocks the pilot. Validate `DESIGNER_MODEL` against the current public catalog for strict structured output, the configured output cap, and context limits; the designer model does not need image input. Run one strict-schema design probe for a text family and one for an SVG family (2 calls). Then run the 20-assignment pilot (two per family; ten text/ten SVG) with all three arms and the same prompts/schema/model/routing/limits intended for the primary cohort. AI calls are 20 one-shot + 20 feedback first + up to 40 repairs = 80; baseline makes zero AI calls. Record actual costs, provider/model identity, first-attempt/final acceptance, repair counts, error codes, structural novelty, latency, and budget. Do not substitute models or retry content; only the certified transport retries. If the pilot reveals a code/prompt/schema defect, stop and return to the owning phase; a new pilot requires separate authorization.
- **Verification:** `npm run designer -- --pilot --live --allow-paid --seed puzzle-designer-pilot-v1 --max-cost 2 --preflight-max-cost 0.50`; `npm run report -- --run <pilot-id>`; inspect exactly 2 probes + at most 80 pilot calls, 60 terminal candidates, all ten families, both modalities, separate/combined cost exposure, provider/model identity, first-attempt/final/repair metrics, reference coverage, and zero reviewer calls. Both probes must pass their actual serialized strict contract before the pilot begins; an ordinary invalid design is retained as a pilot quality failure, not a reason for replacement. Pilot acceptance requires complete ledger/checkpoint coverage, known reconciled costs, no unresolved schema-enforcement/solver/presentation/safety defect, and at least one fully accepted real-pipeline candidate per family. Missing real presentation coverage blocks freeze; any new pilot requires separate authorization. `npm run check` must pass without live calls.
- **Manual acceptance:** inspect actual design prompts/responses and the pilot report. The model designs full DSL specs, the solver is the only judge, repair attempts are visible, and the budget is respected. The pilot is integration evidence, not the primary cohort.
- **Out of scope:** full cohort, reviewer calibration, model substitution, human evaluation.

### P52. Freeze the Designer Protocol and Authorized Budget

- **Size:** S; immutable pre-run gate, no paid calls.
- **Prerequisites:** P43, P44, and P51 accepted; explicit primary budget authorization (default USD 10).
- **Files:** commit the strict immutable `designer_protocol_freezes` record in SQLite and export `data/protocols/<protocol-hash>/protocol.json` plus provenance; record the protocol hash, accepted pilot evidence, thresholds, and authorization in `docs/PROGRESS.md` and `docs/design-protocol.md`. The migration/CLI/evaluator already exist from P50.2; do not change source or put secrets in the snapshot.
- **Instructions:** execute P50.2's `canFreezeDesignerProtocol`; do not weaken or bypass the legacy freeze. Validate the same-configuration pilot (source/prompt/schema/model/routing/limits/templates/comparator/evaluation/evaluator hashes), the 100-assignment plan, three arms, first-attempt/repair caps, baseline generator version, presentation/explanation template version, human-evaluation rubric, the section 9.3 thresholds, the 400-call forecast with a conservative multi-provider reserve, the operator routing-settings confirmation, and the authorized cap. Reject mock, stale, partial, or mismatched evidence. Freeze the model ID, Balanced policy, output cap, prompts/schema/source/font/lock hashes, seeds, thresholds, and cap. A code/prompt/schema/model/threshold change requires a new protocol and affected pilot evidence; provider churn under an unchanged Balanced policy is not such a change. The designer freeze must not require reviewer calibration, reviewer labels, or the legacy smoke.
- **Verification:** `npm run freeze -- --design <pilot-id> --max-run-cost 10`; `npm run designer -- --dry-run --seed puzzle-designer-v1`. Inspect exact frozen plan/configuration/provenance equality and the accepted P50.2 boundary-test evidence; no new tests or implementation are introduced in this operational phase.
- **Manual acceptance:** the user accepts the named frozen protocol, thresholds, human-evaluation plan, and authorized cap before the main run. There is no implicit authorization inherited from the pilot.
- **Out of scope:** starting the full run or deciding its success in advance.

### P53. Execute the Frozen Designer Cohort

- **Size:** M; operational batch, at most 400 AI logical calls plus safe transport attempts.
- **Prerequisites:** P52 accepted and still hash/configuration-identical; user authorization remains valid.
- **Files:** save the primary design run DB/manifest/checkpoints/ledger/artifacts/report under `data/`; append actual execution facts to progress. No implementation changes during the cohort.
- **Instructions:** run exactly the frozen 100 assignments x 3 arms. Each AI arm gets one first attempt; the feedback arm gets up to two repairs; the baseline arm gets one standard construction. Do not replace failed assignments, cherry-pick, or start another full run. Preserve every first attempt and every failed repair. On budget/interrupt, report incomplete planned-denominator results and use same-run resume only under section 8; an authorized cap increase is an append-only amendment. Balanced provider fallback is allowed; do not substitute another model. A late billed response never overwrites a committed attempt or verdict.
- **Verification:** `npm run designer -- --full --live --allow-paid --protocol <hash> --max-cost 10`; `npm run report -- --run <design-id>`; `npm run export -- --run <design-id> --format csv`; `npm run export -- --run <design-id> --format jsonl`. Assert 100 assignments, 300 candidates, 50 text/50 SVG, 10 per family, per-family difficulty `(4,3,3)`, 100 one-shot + 100 feedback first + at most 200 repairs, zero baseline AI calls, every attempt/cost/failure visible, first-attempt and final verdicts separate, and all ten families represented. For partial execution, record the missing counts and do not claim completion.
- **Manual acceptance:** inspect the live manifest, random text/SVG cards from each arm, failed attempts, repair trajectories, costs, and structural novelty. The report remains `decision_pending_human_evaluation` or `revise/incomplete`, not automatic proceed.
- **Out of scope:** prompt changes, repairs beyond the frozen cap, adjudication, a replacement cohort.

### P54. Human Evaluation of Designer Outputs

- **Size:** M; genuine human inspection, up to 10 family triplets (30 core candidates) plus up to 10 additions.
- **Prerequisites:** P42's append-only label pattern, P38-P39 gallery, and completed P53; a real human evaluator, not a simulated identity, except under the documented operator waiver below (2026-11-09).
- **Files:** use the unchanged P50.3 migration/sampler/importer/CLI/gallery; store immutable sample/CSV/gallery and genuine imported evidence under `data/`; append observed progress. No source, rubric, sampler, or schema changes after freeze.
- **Instructions:** execute the frozen section 9.2 sampler without changing its rules: up to ten assignment-matched triplets or explicitly family/difficulty-matched fallbacks, 30 planned core members, up to ten deterministic additions, and preserved shortfalls. Use the neutral skin, seeded order, opaque IDs, and public-only solving bundle. Record choices/time/ratings and family-blocked preferences before reveal; then inspect answers, supported hints/explanations, and defects. Keep additions out of the 20-core-AI clarity/time and ten-family preference denominators, while preserving serious-defect findings from every audited accepted AI candidate. The agent must not fabricate human ratings. Store auditor identity, timestamps, sample/content hashes, and append-only revisions without rewriting primary attempts or verdicts.
- **Verification:** `npm run audit -- --design --run <design-id> --prepare`; after genuine human completion, `npm run audit -- --design --run <design-id> --import <human-evaluation-path>`; `npm run report -- --run <design-id>`; `npm run check`. Assert up to 10 complete family triplets/30 core candidates, max 40, hidden arm labels, complete hashes, unchanged primary attempts, separate correctness/clarity/interest/difficulty/time denominators, feedback-vs-baseline and one-shot-vs-baseline preference counts, and explicit shortfalls. A missing or noninspectable candidate stays a shortfall, not a success.
- **Manual acceptance:** the operator explicitly accepts the recorded observations. Under the 2026-11-09 operator waiver, those observations are AI-assisted, not human; the same defect rule still blocks proceed. If any audited AI accepted puzzle has unresolved correctness/ambiguity/legibility concerns, proceed is blocked. The triplet preference is a bounded sample, not a population estimate.
- **Operator waiver (2026-11-09).** The operator explicitly decided that the AI-assisted evaluation produced by a separate agent (`ChatGPT (synthetic AI assessment; not a human)`) fully replaces genuine human verification for this experiment. The AI-assisted labels are imported with `synthetic=true` and must never be described as human labels. The waiver is recorded in `data/runs/<design-id>/design-evaluation/human-verification-waiver.json`; the AI-assisted notes, pre-reveal choices, original draft, and imported synthetic labels are stored under `data/runs/<design-id>/design-evaluation/ai-assisted/` and `labels-ai-assisted-synthetic.csv`. P54/P55 reports must disclose that solve-time categories are AI guesses, not observations, that visual puzzles were not all independently formalized, that pre-reveal choices are AI-selected (the per-run waiver artifact records the exact counts; for the P54r2 sample: 32/40 selections, 30 matches, 2 preserved mismatches, 8 blanks), and that `genuineHumanLabels=false`. The frozen decision evaluator remains unchanged and still treats synthetic labels as test-only; the AI-assisted conclusion is reported as the operator-authorized substitute for human verification, not as human evidence. The operator authorized the AI-assisted evaluation as the substitute and accepts its limitations; P54 phase acceptance remains a separate pending operator event. This waiver is a documented methodological deviation, not a claim that AI ratings are human ratings.
- **Out of scope:** AI reviewers, calibration labels, automatic human approval, using human ratings to rewrite first-attempt outcomes.

### P55. Final Evidence Report and Proceed/Revise/Reject Recommendation

- **Size:** S/M; final evidence synthesis, no new calls or puzzle edits.
- **Prerequisites:** P37, P43, and observed P51-P54 evidence, including any explicit incompleteness/blocker.
- **Files:** create `docs/DESIGNER_ASSESSMENT.md`; finalize `data/runs/<design-id>/summary.json`, `results.csv`, `candidates.jsonl`, `requests.jsonl`, `design-attempts.jsonl`, `report.html`, `design-evaluation/` exports, and provenance links from immutable DB. Update progress with the actual state. Use the unchanged P50.2 decision evaluator; do not implement or tune it after observing outcomes.
- **Instructions:** report the three-arm cohort, first-attempt/final/repair metrics, baseline comparison, structural diversity/novelty, cost/latency/usage, failure-code distribution, human correctness/clarity/interest/difficulty/time, paired win/tie/loss counts, shortfalls, and all limitations. Apply the frozen section 9.3 predicates to one recommendation (`proceed|revise|reject`) with failed gates and caveats. Do not revisit thresholds or replace failed assignments. Do not invent an eventually-approved or remediation-success rate; those are out of scope. State explicitly that the experiment measures AI design within the ten bounded DSLs, not arbitrary puzzle invention or general human readability.
- **Verification:** `npm run report -- --run <design-id>`; `npm run export -- --run <design-id> --format csv`; `npm run export -- --run <design-id> --format jsonl`; `npm run test:browser`. Reconcile every aggregate to the 300-candidate manifest/ledger; confirm no NaN/Infinity/unknown-as-zero; verify frozen metrics/evaluator/source hashes before replaying the decision. Hash mismatch is `revise/protocol_mismatch`, not permission to tune the evaluator. Record commands/results honestly if an incomplete run or missing authorization makes an artifact provisional.
- **Manual acceptance:** a reviewer can open the HTML and raw evidence offline, reproduce every reported numerator/denominator/cost, see all failures and repairs, and understand why the single recommendation follows. A failed experiment with complete trustworthy evidence is a valid outcome.
- **Out of scope:** automatic remediation, production launch, arbitrary puzzle generation, reintroducing AI reviewers.

## 12. Dependency and Acceptance Cross-Check

| Range | Capability produced | What it must not assume |
| --- | --- | --- |
| P01-P04 | Tooling, manifest, storage, family contracts | No existing designer protocol or API adapter. |
| P05-P09 | Five text engines | No natural-language solver or reviewer. |
| P10 | Safe local scene/PNG | No real visual family or gallery. |
| P11/P13/P15/P17/P19 | Five visual formal engines | No renderer until the next phase, and no other family's renderer dependency. |
| P12/P14/P16/P18/P20 | Five checked renderers and previews | Direct PNG inspection, not the later HTML gallery. |
| P21-P22 | Structural fingerprints and exact public/reveal data | No AI reviewer semantics assumed. |
| P23-P25 | Ledger, conservative transport, strict capability schemas | Local HTTP fakes only, no live compatibility claim. |
| P26 | One-shot spec-proposal patterns reused by the designer adapter | No wording/reviewer behavior and no designer gate. |
| P27-P31 | Legacy wording/reviewer adapters and verdict policy | Historical only; not a designer gate. |
| P32-P34 | Mock transport, slot preparation, legacy serial cohort | Designer work reuses only the mock/preparation patterns. |
| P35-P36 | Bounded workers and actual recovery | No metrics/gallery until P37/P38. |
| P37-P39 | Exact exports, static gallery, browser acceptance | No designer protocol or human evaluation yet. |
| P40-P43 | Legacy calibration, audit workflow, freeze/decision gates | Historical only; new designer freeze/decision and human tooling are implemented offline in P50. |
| P44-P45 | Source/security provenance and full offline release/replay | No paid run validated by mock success. |
| P46-P47 | AI design adapter, solver-feedback repair loop, attempt ledger | No baseline comparator, presentation, or live calls. |
| P48-P49 | Algorithmic baseline, structural novelty, deterministic presentation/explanations | No AI prose, reviewer roles, or live calls. |
| P50.1-P50.4 | Designer recovery/metrics, freeze/decision, blind evaluation tooling, full mock release | All code is accepted before the pilot; no paid calls or fabricated human evidence. |
| P51-P52 | Live designer probe/pilot and frozen protocol | No primary outcomes or human evaluation required before freeze. |
| P53-P55 | Frozen cohort, genuine human evaluation, final decision | Only the frozen two-repair loop; no extra repair/refill, source/threshold edits, or AI reviewers. |

Every implementation phase has explicit files, lower-numbered prerequisites, a focused test or evidence command, independent acceptance observations, and an out-of-scope boundary. The operating phases have explicit authorizations/human inputs, call ceilings, and blocked-state behavior. `docs/PROGRESS.md` records accepted/offline/live state rather than a single misleading all-green checklist.

Before accepting any future phase, independently check: its tests fail for the intended negative fixture; skipped tests are not passes; all newly persisted data passes strict schemas; no command invokes a not-yet-implemented feature; no solution/prose is silently repaired outside the approved solver-feedback loop; failure artifacts survive; the first-attempt evidence is immutable; no AI reviewer role is called; and no paid traffic occurs without separate authorization.

## 13. Reference Facts and Revalidation

External interfaces were reviewed against the following official documentation on 2026-11-03; OpenRouter default routing and provider fallback were rechecked on 2026-11-06 for version 1.1 and retained for v2.0 on 2026-11-07. The implementing agent must revalidate current capability data before live evidence; documentation/model names are not runtime guarantees.

- Node.js release status: https://nodejs.org/en/about/previous-releases
- OpenRouter strict structured outputs: https://openrouter.ai/docs/guides/features/structured-outputs
- Balanced default routing, Nitro/Floor, and `require_parameters`/provider fallback controls: https://openrouter.ai/docs/features/provider-routing
- Exact model endpoints and price fields: https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model.md
- Image inputs and supported MIME types (legacy reviewer roles only; the designer protocol sends no image): https://openrouter.ai/docs/guides/overview/multimodal/image-understanding.md
- Error bodies, HTTP-200 provider errors, truncation, and retry limits: https://openrouter.ai/docs/api_reference/errors-and-debugging.md
- Actual usage/cost: https://openrouter.ai/docs/guides/guides/usage-accounting

The v2.0 plan retains the base plan's bounded families, deterministic SVG, independent checking, complete cost accounting, human inspection, and final decision. It intentionally removes the mandatory informed alignment role and reviewer calibration, replaces the `spec_first`/`ai_spec` lane comparison with the three-arm designer cohort, and adds first-attempt/repair/novelty metrics. These are intentional methodological corrections, not unresolved options for the coding agent. The OpenRouter/Balanced/strict-schema contracts remain; revalidate capability data before live evidence. The AI design scope is the ten DSLs in section 7, not arbitrary puzzle invention.

## 14. Version 2.0 Revision and Audit Status

Version 2.0 is a directional revision proposed on 2026-11-07 after the v1.1 reviewer-calibration line produced repeated live failures (closed-route visual detection, duplicate detection, budget pauses) without an accepted reviewer contract. The revision keeps the implemented P01-P45 offline baseline and replaces the reviewer-centric live/human sequence with the AI Puzzle Designer.

Key changes:

- AI designs full DSL structures; the deterministic solver is the only acceptance judge.
- AI reviewer, alignment reviewer, and vision reviewer are removed from the primary protocol.
- Three assignment-blocked arms: baseline, one-shot, feedback; separate AI first responses and within-trajectory repair metrics.
- 100 assignments x 3 arms = 300 candidates; 400 AI calls maximum; no reviewer/calibration calls.
- Code-owned presentation templates and proof-derived hints/explanations; no free-form AI prose in the primary protocol.
- Structural novelty/diversity against the baseline corpus; blinded human evaluation for correctness/clarity/interest.
- New decision gates and cost threshold; no 80/100 reviewer approval or 9/10 calibration gate.

Operational decisions requiring user confirmation: `DESIGNER_MODEL` before the pilot; separate preflight/pilot authorizations (default USD 0.50 + USD 2); and the primary authorization/cap (default USD 10) before P52. Section 9's metric definitions, USD 0.50 feedback cost threshold, sample/rubric, and decision gates are the proposed protocol, not tunable after seeing its pilot. A requested methodological change must be recorded as a new protocol revision before a new affected pilot. The plan is not implementation or spending authorization.

The v1.0/v1.1 audit findings for the superseded reviewer pipeline remain historical. A static v2.0 audit on 2026-11-07 compared the revised plan with `_old.md`, the user's designer/solver requirements, project memory, and relevant existing interfaces, supplemented by two targeted read-only subagent reviews. Findings were checked against the plan/source before integration; not every suggested methodological change was adopted. This is a document audit, not proof that future implementation passes. No v2.0 P46-P55 code, paid designer run, or human designer evaluation exists yet. No unit, integration, browser, build, or live test command was run in this audit; future phase verification commands remain requirements, not results.

| Static audit finding | Plan correction |
| --- | --- |
| Freeze/evaluation code was scheduled after the same-source pilot or frozen cohort. | Separately accepted P50.1-P50.4 implement recovery, metrics, freeze/decision, human tooling, and browser release before P51; P51-P55 consume evidence only. |
| A witness-consistent explanation was not a proved deduction. | Typed fact-scoped entailment checks, no circular references, explicit exhaustive fallback, non-spoiling hints, and a separate template/presentation certificate. |
| Sparse cohort-only novelty could miss baseline patterns and AI near-repetition. | Frozen 100-fixture-per-family reference plus same-cohort reference, reference coverage, AI-AI clusters, and distinct novel counts; unknown novelty is not novelty. |
| First-shot, repair, novelty, cost, and human denominators were ambiguous. | Independent AI first draws kept separate; same-trajectory repair gap, arm-scoped gates/costs, zero-opportunity behavior, 20-core-AI and ten-family human denominators. |
| Repair errors and pauses could authorize unintended further calls. | One stop rule at every attempt, preserved failed/unknown costs, no retry after content/transport uncertainty, and explicit designer crash-window acceptance. |
| Human metadata/order/reveal and fallback matching were underspecified. | Opaque public bundle, seeded order, same-difficulty fallback, pre-reveal ratings/preferences, fixed addition priorities, and disclosed accepted-output selection bias. |
| Legacy history and v2.0 execution instructions could be confused. | Historical phase scope and legacy presentation state stay intact; new designer contracts and evidence are distinct. |
| Legacy SQL/types/config cannot represent 300 designer slots or a calibration-free freeze. | Explicit preserving migration, designer-tagged records/roles, isolated pilot/probe/mock pools, required-null strict schemas, and a separate SQLite designer-freeze table. |
| Baseline difficulty recipes and nonexistent partial checkpoints could constrain or break design/recovery. | Explicit per-family designer admission rules; raw-response replay with bounded deterministic recomputation; per-attempt artifact links committed with immutable verdicts. |

| Superseded v1.1 element | v2.0 replacement |
| --- | --- |
| `spec_first` vs `ai_spec` lanes | Baseline vs AI one-shot vs AI feedback arms |
| AI blind text/vision and informed alignment reviewers | Deterministic solver plus code-owned presentation; no AI reviewer |
| Reviewer calibration (40 fixtures, 9/10 and 8/10 gates) | No reviewer calibration; pilot plus formal designer metrics |
| 200-slot primary cohort, 680 calls | 100 assignments x 3 arms, 300 candidates, 400 AI calls |
| 80/100 approval and 10/20 family gates | 60% feedback final, 40% one-shot, 30% novelty, human-evaluation gates |
| AI wording/hints/explanations | Code-owned templates and proof-derived explanations |
| Free-form AI prose in the visible puzzle | Strict DSL spec plus optional closed-catalog decorative skin |
| Human audit of reviewer-approved outcomes | Blinded human evaluation of formal-accepted designer outputs |
