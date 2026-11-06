# AI Puzzle Factory: Auditable Proof-of-Concept Implementation Plan

Version: 1.1, 2026-11-06. Language of code, prompts, puzzle content, and documentation: English. Communication with the user: Czech.

This document replaces the implementation instructions in `AI_PUZZLE_FACTORY_EXPERIMENT_PLAN_base.md`. The base and `EXAMPLE_ONLY_AI_VOICE_NOTES_IMPLEMENTATION_PLAN.md` are reference material, not additional requirements to execute. This is a plan, not evidence that the application, tests, paid experiment, or human audit have already been performed.

Routing revision: OpenRouter Balanced (Standard) with automatic provider selection and provider fallback replaces fixed endpoint tags and disabled provider fallback throughout this plan. Providers may appear, disappear, or become unavailable. This is a specification correction, not certification that existing code or evidence implements it; correct affected owning phases and repeat P45 plus affected evidence before P46 live work.

## 1. Objective and Fixed Scope

Test whether a deliberately bounded pipeline can produce short, correct, understandable English multiple-choice puzzles, without hiding unsuccessful attempts. The primary cohort contains exactly 200 preallocated candidate slots: 100 text puzzles and 100 deterministic SVG puzzles, with 20 candidates in each of ten families.

The experiment measures two separate claims: formal correctness of a structured specification, and usability of the actual question, choices, explanation, and image presented to a person. A formal solver does not prove the semantics of unconstrained AI prose or the legibility of pixels. An LLM opinion is never a formal proof.

In scope: a local TypeScript CLI; bounded family DSLs; independent enumeration/checking; deterministic distractors and SVG/PNG rendering; OpenRouter generation and reviews; durable checkpoints and cost accounting; offline reports; reviewer calibration; a stratified human audit; an explicit proceed/revise/reject decision.

Out of scope: a public web application, accounts, payments, a backend service, arbitrary natural-language logic, arbitrary SVG from a model, unbounded theorem proving, free-form Raven/IQ claims, image-generation models, semantic repair, paid adjudication, and automatic regeneration. Remediation is deliberately deferred: this version reports `eventually_approved_rate = null` and `remediation_cost = 0`, not a fabricated remediation success rate. Adding remediation requires a new, separately reviewed protocol; it cannot alter this primary cohort.

The repository currently contains planning documents and no application skeleton. Do not assume any `src/`, CLI, test harness, database, or gallery already exists.

## 2. Execution Rules for the Coding Agent

- Execute P01 through P53 in order. P01-P45 are offline implementation assignments; P46-P53 are explicitly authorized live or human acceptance assignments. Do not implement several phases silently in one assignment.
- Each phase inherits all previously accepted phases. Its explicit prerequisites identify the capabilities it actually consumes; all prerequisite numbers must be lower than the phase number.
- A normal implementation assignment is one bounded capability, normally three to six code/test files plus small registry or documentation edits. Family engines and visual rendering are separated where their combined workload would be excessive. If an assignment cannot fit one focused session, split it before implementation and preserve the dependency ordering; never silently omit its negative tests.
- Before editing, read `agent-memory/index.md` and applicable baseline notes, state which notes and invariants are active, and inspect the existing worktree. Do not overwrite unrelated changes. Do not update project memory without an explicit request; list numbered memory proposals instead.
- Use English in new files. Preserve existing documents, `.gitignore` entries, and unrelated configuration. Do not create Agent Manager sessions/worktrees, commit, or push unless separately requested.
- `npm run check` must never contact OpenRouter. Mock tests deny unexpected network calls and run without an API key. Native dependencies and browser binaries are local tooling, not a reason to silently switch the chosen architecture.
- The phase report must state phase ID, `implemented/offline-verified/live-unverified/blocked` state, changed files, observable behavior, exact commands and results, and manual acceptance steps. A command not executed must be marked `NOT RUN`, not passed. Update `docs/PROGRESS.md` with the same facts.
- Request acceptance explicitly after a future implementation phase. End that report with the exact Czech call-to-action prefix `Otestujte nyní, zda…` and the concrete manual observation specified by the phase. Wait for acceptance before the next phase. A phase blocked on authorization or human labels is not accepted by agent assertion.
- This document does not authorize API expenditure or a full experiment. Live work requires the user's explicit budget authorization as well as the CLI's `--live --allow-paid --max-cost` flags. Flags alone are not authorization. Do not read, print, or transmit `.env` or API keys in reports.

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
| Tests | Vitest; ESLint flat config; TypeScript; Playwright Chromium for the offline gallery | Browser tests arrive in P39, not before. No React, Vite, server, or database service is necessary. |
| Reports | Static escaped HTML/CSS/vanilla JS, local PNG files, JSON/JSONL/CSV | Must work from `file://` without a server or external CDN. No raw model HTML or raw untrusted SVG embedded in HTML. |
| Experiment language | English with fixed code-owned entity labels | Natural-language aliases cannot change entity identity. Difficulty 1-3 is a generation target, not a validated psychometric score. |
| Primary runs | One immutable first version per slot, no paid/content repair | Infrastructure retries and internal constructive search are explicitly logged and are not replacement candidates. |
| Semantic boundary | Deterministic structural checks, then blind solving, then a separate informed alignment review | This adds an explicitly costed review call; it does not pretend that free prose is mechanically proven equivalent to DSL. |

No coding phase may choose a different solver, database, generation protocol, review policy, or quota. Role model IDs, the Balanced routing policy, request limits, and authorized budgets are operational inputs selected and frozen in P46-P50, not architecture left to the coding agent. Serving provider IDs are observed request metadata, not frozen inputs. If the model/capability/budget gates cannot be satisfied, live execution is blocked; mocks do not waive those gates.

## 4. Experiment Manifest and State Contracts

### 4.1 Immutable Slot Plan

Families in stable order: `ranking`, `matching`, `scheduling`, `truth`, `arithmetic`, `matrix`, `transforms`, `paths`, `symmetry`, `counting`.

| Modality | Families | Slots/family | `spec_first`/family | `ai_spec`/family | Total |
| --- | --- | ---: | ---: | ---: | ---: |
| Text | First five | 20 | 10 | 10 | 100 |
| SVG | Last five | 20 | 14 | 6 | 100 |
| All | Ten | 20 | 120 total | 80 total | 200 |

Within each text family, allocate difficulty counts `(4,3,3)` to the ten `spec_first` slots and `(3,4,3)` to the ten `ai_spec` slots. Within each SVG family, use `(5,5,4)` for `spec_first` and `(2,2,2)` for `ai_spec`. Thus every family has difficulty totals `(7,7,6)`, and both lanes cover every difficulty. Build these tuples first, then seed-shuffle within each family; do not correlate one lane with only one difficulty.

Fixed root seeds: `puzzle-poc-v1` for full, `puzzle-smoke-v1` for smoke, and `puzzle-calibration-v1` for calibration construction. Slot IDs are stable, for example `text-ranking-01`; `slotOrdinal` is 1-200. Derive independent random streams with SHA-256 over protocol version, root seed, slot ID, and purpose (`spec`, `options`, `layout`). A hash-counter PRNG with tested golden vectors and unbiased bounded integers drives all local randomness. Do not use `Math.random()` or consume a shared RNG from asynchronous workers.

`--dry-run` prints a deterministic `PlanManifest` (protocol version, run kind, slot tuples, seeds, quotas/difficulties, logical request count estimate by role, and maximum client HTTP transport-attempt count) and performs no generation, database write, model call, or image rendering; it requires no model configuration or API key. The attempt ceiling excludes OpenRouter's internal provider fallback operations. Use the no-early-failure ceilings in section 8.3, not a promise of observed success. A smoke run has exactly 20 slots: one per family and lane, ten text and ten SVG. Its 50/50 SVG lane split is a coverage test, not the main cohort's 70/30 estimate. Assign smoke difficulty by family ordinal modulo three and the other lane to the next difficulty.

`RunManifest` extends that plan with evidence kind (`mock|live`), run UUID, role/model/routing-policy configuration, operator routing-settings confirmation, output limits, concurrency, budget, timestamped capability/price snapshots and reservation method, prompts/schema/source/font hashes, dependency lock hash, runtime versions, thresholds, calibration reference, and creation time. Record actual serving providers in the request ledger; catalog membership and observed provider identities are evidence, not immutable role configuration. Compare `PlanManifest` hashes for deterministic slot plans; hash the entire redacted `RunManifest` for evidence integrity. Mock configuration is explicitly synthetic. Preflight has zero candidate slots; calibration has 40 held-out fixture keys rather than primary slot IDs.

### 4.2 Family and Candidate Types

Use a strict discriminated union on `family`; do not accept a free-form `constraints: string[]`. Each family owns its bounded specification and answer type. A `FamilyEngine<S,A>` provides `schema`, `generateSpec(seed,difficulty)`, `enumerateSolutions(spec)`, `verifyAnswer(spec,answer)`, `makeOptions(spec,answer,seed)`, `visibleRules(spec): VisibleRules`, `facts(spec)`, `canonicalData(spec)`, and deterministic test mutations. Implement these methods in the family's `engine.ts`; no agent chooses a new rules-file architecture. `VisibleRules` has `domain`, `closedWorld`, `target`, `operations`, and `conventions`; the first four are nonempty code-owned strings/arrays, and conventions may be empty only when no coordinate/counting convention applies. Visual renderers register separately only after their rendering phase is complete. Registration must not import a future or placeholder renderer.

`SolveResult` contains `solutionCount` (exact within the bounded domain), `answerCount`, `correctAnswer`, proof facts/witness, enumerated-state count, and checker version. Construction and checking must not share the generator's hidden witness as their result. Constraint families require an exhaustive domain scan. Functional visual families require exhaustive checking of their finite input cells/operations and a constructive uniqueness proof; they must not enumerate an exponential set of unconstrained images. Each family section defines the required result. Reaching a state/time cap is `SOLVER_LIMIT`, not proof of uniqueness.

Candidate snapshots are append-only: `slotPlan`, optional `spec`, formal proof, deterministic option values/order, wording response, visible presentation, SVG/PNG assets and hashes, deterministic checks, duplicate assessment, blind review, alignment review, primary verdict, and timestamps. Missing stages remain explicit `null` with a reason, not invented successful records. Keep full sanitized raw model responses and parsing errors even when a usable puzzle never exists.

Options are always constructed by code, exactly four, labeled A-D after a seeded permutation. The option order is stored before review; the correct label is computed from value equality after shuffling. Check both semantic distinctness and rendered distinctness; compare normalized option content with the A-D label layer excluded, otherwise identical values under different letters would appear visually distinct. No model supplies options or a trusted answer key.

### 4.3 Checkpoints and Terminal Verdicts

Workflow stages: `planned -> spec_ready -> formal_checked -> presentation_ready -> duplicate_checked -> blind_reviewed -> alignment_reviewed -> terminal`. A failure can terminate earlier. Run control states (`running|paused_budget|paused_operator|interrupted|completed|failed`) are separate from candidate quality verdicts. Unstarted or paused slots are not `generation_error` merely to make a run look complete.

| Verdict | Exact meaning |
| --- | --- |
| `approved` | All required deterministic checks pass, no exact/structural/high-risk near-duplicate flag, blind reviewer selects the code key with clear wording and no ambiguity/issues, and every applicable alignment check passes. Both reviews are real for a live candidate. |
| `rejected` | A deterministic invariant is disproved: unsatisfiable/multiple solutions where forbidden, invalid choices, unsafe/broken render, mechanically observable missing/extra facts, or exact/structural duplicate. Store the proof/evidence. |
| `inconclusive` | Formally eligible presentation but reviewer disagreement, a model-only defect allegation, a high-risk near-duplicate suspicion, missing/uncertain review, or unresolved vision/semantic uncertainty. LLM criticism alone must not masquerade as deterministic rejection. |
| `generation_error` | No usable first candidate due to model refusal, malformed/truncated JSON, out-of-family/out-of-bounds specification, failed construction, or uncertain/failed generation request. Preserve every request and cost. |

Persist failure codes with stage, severity, and evidence source (`deterministic|model|human|infrastructure`). Codes include `SCHEMA_INVALID`, `UNSAT`, `MULTIPLE_SOLUTIONS`, `MULTIPLE_ANSWERS`, `SOLVER_LIMIT`, `DUPLICATE_OPTION`, `EXACT_DUPLICATE`, `STRUCTURAL_DUPLICATE`, `NEAR_DUPLICATE_SUSPECTED`, `TEXT_SPEC_MISMATCH`, `EXPLANATION_MISMATCH`, `REVIEWER_DISAGREES`, `REVIEWER_CANNOT_SOLVE`, `VISION_REVIEW_UNCERTAIN`, `SVG_RENDER_INVALID`, `VISUAL_AMBIGUITY`, `COST_UNKNOWN`, and `API_ERROR`. Multiple codes may coexist; a deterministic precedence table in P31 chooses the one primary verdict.

Human labels and final decision records are append-only evidence, not edits of primary snapshots. A later human discovery can block `proceed`; it cannot rewrite first-attempt approval statistics. There is no automatic upgrade from a matching reviewer answer after another required check failed.

### 4.4 Persistence Layout and Ownership

Use `data/experiment.sqlite` with migrations in `src/storage/migrations/`. Core tables are `runs`, `slots`, `stage_results`, `artifacts`, and `events` (P03); request tables `logical_calls`, `request_attempts`, and `budget_events` arrive in P23; `human_labels` arrives in P42 and `protocol_freezes` in P43. Add each table in its owning phase's migration, not as a partially implemented feature in P03.

Unique keys: `(run_id,slot_id)`, `(run_id,slot_id,stage,version=1)`, `(run_id,slot_id,role)` for logical calls, `(logical_call_id,attempt_index)` for transport attempts, and content hashes for artifacts. Calibration/preflight calls may have a nullable slot ID and a separate unique fixture/probe key. Include an explicit `CHECK` constraint for this distinction; SQLite `NULL` uniqueness alone is insufficient.

Commit a complete stage result, its artifact bytes, and the next checkpoint in one transaction. Persist stage `started_at`, `finished_at`, and measured `elapsed_ms`; incomplete durations are null. Store source SVG, PNG, presentation JSON, raw responses, and request bodies in the database before exporting files. Bound individual JSON/response artifacts to 2 MiB, SVG to 256 KiB, and PNG to 1 MiB. Restrict exports to safe run UUIDs and controlled filenames beneath `data/runs/<run-id>/`; never derive a path from model text. Atomic file replacement is sufficient for regenerable exports.

Export layout: `manifest.json`, `candidates.jsonl`, `requests.jsonl`, `summary.json`, `results.csv`, `report.html`, `puzzles/<slot-id>.json`, `images/<slot-id>.svg`, `images/<slot-id>.png`, `audit/sample.json`, `audit/labels.csv`, and `provenance/`. Request exports contain sanitized request/response metadata, raw bodies, and monetary evidence. Failed candidates still have JSON records and gallery cards, with unavailable assets explicitly marked. Do not put an API key, authorization header, full environment, or `.env` in any artifact.

## 5. Bounded Generation, Presentation, and Review

### 5.1 Lane Protocol

`spec_first`: code constructs one specification and logs its bounded constructive search; independently solve/check; construct four options; request AI wording/hint/explanation once; assemble the final visible presentation; run deterministic presentation checks.

`ai_spec`: request one family-specific DSL specification with no answer key, no SVG, and no prose; strictly parse and independently solve it; construct options; request wording once using the same wording adapter as `spec_first`; assemble/check. An invalid first specification is terminal; do not ask the model to fix it, switch to `spec_first`, or replace the slot.

Code construction may use at most 64 deterministic internal proposals to choose a witness and add constraints. Log proposal count and pruning operations; never use review scores, novelty results, or paid retries to choose a prettier first version. Each final spec has at most 200,000 enumerated states and a two-second solver guard. Unit tests use state counts rather than flaky sub-millisecond timing. The runner may checkpoint/yield between bounded jobs.

Prepare all slots up to presentation or early failure before assigning duplicate ownership. Then run the duplicate barrier in slot order; only then review otherwise eligible presentations. Confirmed exact/structural duplicates skip reviews, but near-suspected presentations still receive both reviews so quality concerns can be distinguished from novelty gating; their primary outcome remains inconclusive even if both reviews pass. This prevents completion order from choosing the survivor. Finally reduce all evidence to terminal verdicts. Both reviews are attempted once even after blind disagreement, unless budget or transport blocks execution.

### 5.2 Wording and Semantic Alignment

The wording response schema is `{question, clueTexts:[{factId,text}], hint, explanationSteps:[{factIds,text}]}`. All fields are required; at most 12 clue facts, 400 characters in the question, 200 per clue, 300 in the hint, and eight explanation steps of 240 characters. For text, fact IDs must cover the supplied local clue facts exactly once in `clueTexts`; domain/global rules are a separate code-owned block, not extra clue facts. For SVG, `clueTexts` is empty: the diagram holds the observations and code-owned rules hold the operations/query. AI must not transcribe hidden mask coordinates/counts into the public question. Explanation references may address the full proof-fact inventory in either modality. Entity IDs and option values are immutable. Store the original strings, including unsuccessful output.

Every family also supplies code-owned visible rules: domain, closed-world assumptions, target, admissible operations/pattern class, and any coordinate/counting convention. These are always included from the start, not inserted as an after-the-fact repair. AI clue text is still shown and can contradict those rules. Structural checks catch missing/extra/unknown references, impossible bounds, or altered machine-valued fields, but must not claim to prove an arbitrary paraphrase, hint, or explanation. An unprovable semantic mismatch is a model allegation until human-verified.

An informed alignment review is mandatory after the blind solve, in a new stateless request. It receives DSL, proof, correct option, actual visible text/options, hint, explanation, and the actual PNG for SVG. It returns per-field `pass|fail|uncertain|not_applicable` for `question`, `rulesAndClues`, `options`, `hint`, `explanation`, and `image`, plus cited fact IDs/reasons. For text, `rulesAndClues` covers code-owned rules and all AI clue texts; for SVG it covers code-owned rules and the diagram's mathematical observations, while `image` covers actual rendered content/legibility against those observations. `not_applicable` is allowed only for the text family's image check. Code computes overall alignment status; the model cannot override a failed field with `overall: pass`.

This extra call resolves the base plan's unspecified semantic check without overstating assurance. It is not independent solution evidence, because it sees the key. Its cost and calibrated performance are reported separately from the blind reviewer.

### 5.3 Blind Review Contracts

The text reviewer receives only the exact public question/rules/clues and A-D option texts, with a fixed instruction to solve and assess ambiguity. The vision reviewer receives exactly that public text plus the rasterized PNG bytes as `data:image/png;base64,...`. It receives neither raw SVG nor scene graph nor metadata. Visual option text says only `See labeled tile A/B/C/D`, except numeric counting choices which may show their actual numbers; never serialize mask bits, routes, or cell coordinates as option descriptions. The PNG contains the diagram and visual options with the same stored A-D labels used in the gallery. Generic image alt text describes the interface, not a hidden scene transcription.

Never send slot ID, family DSL, witness, solution, expected label, hidden layout parameters, hint, explanation, previous checks, lane, or another review to the blind role. Create role-specific allowlisted DTOs from `VisiblePresentation`, not a serialized `Candidate`. Persist the exact request and PNG hash and assert the allowlist in tests. Image alt text and filenames sent in a request must not contain the solution.

Review schema: `answerStatus: selected|no_unique_answer|cannot_determine`, `chosenOption: A|B|C|D|null`, `reasoning`, `clarity: clear|unclear`, `ambiguity: none|present|uncertain`, `confidence` in 0-1, `visualLegibility: legible|unclear|not_applicable`, and `issues` with bounded evidence strings. Issue enum: `duplicate_options|no_correct_option|ambiguous_rules|missing_information|unreadable_image|contradictory_clues|answer_leak|other`. `selected` requires a non-null choice; other statuses require null. Text requires legibility `not_applicable`; SVG requires `legible` for approval. Self-reported confidence is displayed, not treated as calibrated probability or a sole approval gate. Review refusals, truncation, parse errors, and incorrect choices are retained, never retried as new creative attempts.

### 5.4 Rendering Rules

All visual specs pass a typed scene builder. Serialize only SVG, `g`, `rect`, `circle`, `line`, `polyline`, `polygon`, `path`, `text`, `title`, and `desc` with an explicit attribute allowlist. Disallow scripts, event handlers, `foreignObject`, links, URLs, CSS, external resources, entities/DOCTYPE, processing instructions, animation, filters, and arbitrary model-supplied paths. Escape all text. The serializer is not allowed to pass through an XML fragment.

Use a 1024 x 1024 viewBox with four labeled answer regions, fixed layout/padding, stroke width at least 4 source pixels, essential marks at least 12 source pixels, and label font at least 32 source pixels. Renderer-specific layouts reserve disjoint boxes for stem, legend, and choices. Code checks bounds, overlap rules, positive feature contrast, option equivalence after rasterization, and the presence of every critical scene group. Treat parser/rasterizer errors as failures, not blank images.

Render the full PNG and a 512-pixel preview using the pinned font/configuration; record both hashes. For critical groups, require at least eight changed nonbackground pixels between full/removed-group previews on the designated test subset to catch invisible/occluded marks, rather than accepting scene metadata alone. Production checks inspect raster non-emptiness and minimum contrast (4.5:1 labels, 3:1 essential graphics against their background); they are explicitly not proof of human perception. The gallery offers a 1:1 zoom and must not overflow a 360-pixel mobile viewport. No family may depend on color alone or count outline thickness as an extra object.

## 6. Novelty and Duplicate Policy

Store distinct values: `content_hash` over the actual visible presentation/options, `canonical_spec_hash` over the complete normalized parsed DSL (all original constraints, stable IDs, no run metadata), `structural_fingerprint` over the reduced canonical structure below, and separate SVG/PNG render hashes. The request ledger separately hashes raw response bytes. Never call a raw JSON/text hash a structural fingerprint.

Family `canonicalData` removes entity names/IDs through bounded canonical relabeling, sorts commutative constraints, normalizes equivalent orientations/operations where the family contract allows them, and excludes seed, lane, difficulty label, clue order, option order, colors used only decoratively, and prose. Preserve graph relations, mathematical constants, geometry/topology, marked target roles, and admissible-rule class. Do not reduce a fingerprint to the answer or the solved arrangement alone. Each family must pass an equivalent-renaming test and a genuinely different-structure test before it is registered.

For clue-based constraint families, retain the actual complete clue list for presentation, but fingerprint a deterministic reduced core so repeated/easy redundant hints do not automatically buy novelty. First canonicalize the complete typed clue list over the family's allowed relabelings, then visit that normalized list in reverse lexicographic order, removing a clue only if the independent domain truth table still gives the same single complete solution. Use cached per-clue bitsets, not a new 200,000-state search per relabeling. Canonicalize the retained core again, store removed indices, and preserve domain/global rules. This is an irredundant-core proxy, not a claim of complete logical-equivalence canonicalization; different sufficient cores may still need near-duplicate/human inspection. Required tests include exact duplicate, known transitively redundant, and nonredundant added clues. Functional visual specs instead normalize equivalent operations as defined below.

At the barrier, eligibility decisions compare presentation-check-passed candidates only: exact/spec/structural duplicate groups keep the lowest eligible slot ordinal as owner; later eligible members are `rejected`. Failed/incomplete presentations cannot own or suppress a usable candidate, and early terminal failures are not rewritten. Novelty diagnostics still count every formal-passed, fingerprintable attempted spec, including those whose later wording failed. Do not generate replacements; owners can still fail reviews. Compare within family across both lanes, and compare exact rendered content across all visual families as a separate diagnostic. High-risk near-pair approval flags likewise apply to eligible presentations; diagnostic pairs involving early failures are retained without changing their terminal verdict.

Near-duplicate detection is a declared one-feature-edit heuristic, not semantic equivalence. Section 7.11 fixes features/grouping. Let `removed=sum(max(countA-countB,0))`, `added=sum(max(countB-countA,0))`, and `editDistance=max(removed,added)` so substitution costs one. With unequal structural hashes, at least one common feature, and editDistance exactly one, flag a high-risk pair. Record unit-weight multiset Jaccard `sum(min(countA,countB))/sum(max(countA,countB))` as a diagnostic, not a 0.95 gate: for small token sets that cutoff is unreachable even for one change. Empty features or unequal hashes with identical complete canonical data are implementation errors. Flag both eligible members `NEAR_DUPLICATE_SUSPECTED`, prevent first-pass approval, and retain both scores/features. This does not change the separate 95% structural-uniqueness cohort threshold. Report exact/structural/near counts and human false-positive concerns; do not claim complete semantic novelty.

## 7. Family Contracts

The following contracts are normative. Each named family phase must implement its own positive, unsatisfiable, ambiguous, wrong-key, equivalent-renaming, genuinely-different, and distractor tests, plus at least 100 deterministic generation seeds spread across all difficulties. A generated specimen must obey bounds and have the required unique result; a failure must be explicit, not silently repaired. Visual formal phases do not require a future renderer or gallery.

All fact identifiers are code-owned. P04 supplies the common helper: text local clues use `f001` onward in the accepted stored clue order; truth uses speaker order and arithmetic uses constraint-row order. IDs are not part of structural fingerprints or derived from a reduced core. Code-owned rules use fixed `r-domain`, `r-closed`, `r-target`, `r-operations`, and `r-conventions` IDs. SVG observations use `p001` onward in deterministic row/column/operation order. Derived proof facts use a separate `s001` namespace. `facts(spec)` returns local/observation facts; the proof adds derived facts. Explainable references are their merged inventory; model-supplied IDs never define new facts.

For constraint families, require exactly one complete assignment, not merely a unique answer projection over several possible worlds. For functional families, the explicit visible operation determines one complete output; test omitted/contradictory operation metadata as ambiguity/schema failures. Across 100 fixed `spec_first` construction seeds per family (34 level 1, 33 level 2, 33 level 3), require at least 95 successful constructions in aggregate, with every success independently verified and every failure counted; report all three subcounts. This includes truth's two population sizes in the same 100, not an additional 100 per size. An implementation that always returns a bounded failure does not pass. This engineering fixture gate is not the main cohort's quality rate.

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

Required live inputs: `OPENROUTER_API_KEY`, `GENERATOR_MODEL`, `REVIEWER_MODEL`, and `VISION_REVIEWER_MODEL`. No fake model default and no required provider IDs or endpoint tags. Generator and text reviewer IDs must differ; the vision reviewer must also differ from the generator, but may equal the text reviewer if the model supports images and the live PNG probe passes. Different model families are preferred; disclose shared models and observed provider correlations without claiming provider independence.

Balanced (Standard) is the mandatory routing mode, not Nitro (throughput-first) or Floor (price-first). Use the ordinary model slug without `:nitro` or `:floor`; omit `provider.sort`, `provider.order`, `provider.only`, and `provider.ignore`. OpenRouter selects a currently eligible provider and may fall back to another provider of the same configured model. Provider availability or catalog membership is not guaranteed and must not be frozen or implemented as an application allowlist.

Account preferences and own-provider-key (BYOK) routing can bypass default Balanced routing even with this request shape. BYOK is out of scope: this experiment uses OpenRouter shared routing/pricing and `usage.cost`, not separate upstream BYOK charges. For each live CLI invocation (including resume) and at P50 freeze, require an operator-recorded check of the account provider-preferences and provider-keys pages: provider sort must be unset/default Balanced and no BYOK provider keys may be configured. Store the actual operator identity, check timestamp, and confirmed settings with the run/protocol evidence; never read/store key values, fabricate the confirmation, request a management key, or change account settings automatically. The required OpenRouter inference key is not a BYOK provider key. A missing confirmation tied to the current invocation, a conflicting sort, or configured BYOK keys blocks live admission/freeze before any paid call. Freeze the verified policy outcome, not confirmation timestamps. The operator must keep these settings unchanged during execution and stop the run if they change; such changes are routing-policy drift, not provider churn. Affected evidence must be revalidated, and calibration obtained under a different routing policy cannot be reused.

Use `https://openrouter.ai/api/v1/chat/completions`, `stream:false`, one completion, strict `response_format: {type:"json_schema", json_schema:{name,strict:true,schema}}`, and `provider:{allow_fallbacks:true,require_parameters:true}`. This keeps provider fallback enabled while excluding providers that cannot honor the request parameters; never weaken strict output to gain availability. Use the Chat Completions image part `{type:"image_url",image_url:{url:"data:image/png;base64,..."}}`, not the Responses API's `input_image` shape. Keep one configured model per role; do not include a `models` fallback list, tools, plugins, or `route:fallback`. Provider fallback is not model substitution, content repair, or lane replacement. Leave `temperature`, `seed`, and reasoning parameters absent by default; store supported settings when explicitly configured and tested.

Default maximum output tokens: 8192 for spec/wording and 4096 for each review. Prefer `max_tokens` when supported by an otherwise compatible active endpoint; otherwise use advertised `max_completion_tokens`; otherwise fail preflight. Never send both or omit the cap; freeze the selected `outputCapField` per role and test the actual serialized request. Preflight must find at least one active endpoint supporting strict schema, all configured parameters, the output cap, and a compatible context/prompt limit. OpenRouter selects among currently eligible providers, not a locally pinned endpoint. The cap includes hidden reasoning wherever the provider defines it that way. Request deadline is 90 seconds; response bytes <= 2 MiB; input JSON text excluding base64 <= 64 KiB; PNG <= 1 MiB. For reservation use the full allowed input-context bound when image tokenization or tokenizer overhead is unknown; byte-size estimates are not exact token counts. A provider context error is recorded, not retried by shrinking the puzzle. Empty or length-truncated output is a failed first response, never automatically retried with more tokens.

Read and archive the public `GET /api/v1/models` and `GET /api/v1/models/{author}/{slug}/endpoints` with no elevated account credential. Inspect active entries (`status === 0`) for capabilities, limits, and pricing; record provider_name/tag as diagnostics, not routing inputs. Record the enclosing model's architecture modalities; a missing per-entry modality field is not a missing model architecture. Model-level image support is necessary but does not replace the actual PNG probe. Revalidate before live stages and after capability/pricing errors, preserving timestamped snapshots rather than requiring catalog equality. Missing/forbidden data that prevents required capability or budget validation blocks live admission; never create/use a management key to bypass it. Provider additions, removals, or health changes alone do not block execution.

Record returned provider/model identity on every inference when exposed; missing identity stays explicitly unknown. A returned provider different from preflight, including a newly available provider, is expected under Balanced and is not configuration drift. A contradictory model identity or violation of required capabilities pauses admission. Configuration hashes freeze requested role models, Balanced routing/fallback policy, verified account routing policy (default Balanced/no BYOK), request settings, limits, and local protocol hashes, not provider membership or the provider observed in a probe. P46 probes each role with actual strict schema, configured cap, and PNG for vision; this proves the observed requests, not every possible future provider. Generic probes do not replace all-family smoke.

### 8.2 Logical Calls, Retry Safety, and Unknown Outcomes

Create a unique logical call for `(run,slot,role)` before dispatch. Roles are `spec`, `wording`, `blind_text`, `blind_vision`, `alignment_text`, `alignment_vision`, and `preflight`; calibration uses the review roles with fixture keys. Each transport attempt stores its request hash/body without credentials, expected schema hash, requested role/model/routing policy, separately observed provider/model identity, start/end UTC times and monotonic elapsed latency, HTTP status, response/generation ID, raw response, finish reason, prompt/completion/total tokens, cached-read/write and reasoning tokens when available, price estimate, actual cost, and error classification. Preserve nullable usage fields; reasoning is generally a subset of completion tokens, not extra output to add a second time.

States are `prepared -> dispatching -> response_saved -> validated`, or `refused_unprocessed|failed_known|uncertain`. Persist `dispatching` before `fetch`. A crash between dispatch and response persistence is inherently ambiguous. Do not assert exactly-once billing or assume an unsupported idempotency key solves this.

OpenRouter's automatic provider fallback stays enabled within a single client HTTP attempt. It may change the serving provider while preserving the requested model and constraints; it is not a new candidate or application content retry. The application cannot assume every internal provider attempt is observable. Record exposed routing/charge metadata without inventing missing internal attempts; the local three-attempt ceiling limits client requests, not OpenRouter's internal routing operations.

Client-side automatic retries are limited to two additional attempts for an explicit pre-generation router rejection: HTTP 429, or HTTP 503 reporting that no eligible provider exists, with no generation ID, no partial completion, no usage, and no provider-generation error. Reuse identical request bytes, including the Balanced policy and enabled provider fallback. Wait 0.5 then 1 second plus seeded 0-0.25 second jitter; honor a valid `Retry-After`. If it exceeds 30 seconds, pause the run instead of shortening the requested delay. Record each refusal as unprocessed only when the response satisfies this allowlist.

Timeouts, disconnects, generic 5xx, HTTP-200 error bodies, partial output, provider errors, and malformed/truncated successful output are not safely unprocessed. Do not replay them automatically. Save whatever evidence exists and retain the cost reservation until actual cost is known; a failed content response with valid `usage.cost` still settles its actual charge. Mark content outcome uncertain or failed independently of monetary certainty. A generation-stage uncertainty yields `generation_error`; a review-stage uncertainty yields `inconclusive`. An untouched later slot may still run if the remaining reserved budget permits it.

Resume reuses saved valid responses and committed stage outputs. A `prepared` request never marked dispatching may be sent; a `dispatching` request without a saved response is never silently resent. Compare the configured model, routing policy, request/schema, and limits, not the previously observed serving provider; provider churn alone is not a resume mismatch. If a generation ID exists, a bounded read-only `GET /api/v1/generation?id=...` reconciliation may update actual usage/cost; it does not regenerate content. If none exists, preserve `COST_UNKNOWN` and reserved exposure. End-to-end tests must cover the crash windows rather than merely reopen a JSON file.

### 8.3 Budget Accounting

Default worker concurrency is two, configurable to one or two only. One transaction admits each request after checking `known_actual + reservations_for_inflight_or_unknown + next_reservation <= maxCost`. Reserve for every transport attempt that may be billed; certified unprocessed refusals release their reservation. Settle a completed attempt from actual provider `usage.cost` (USD), not from a token-price guess. `usage.cost = 0` is valid when explicitly present; an absent field remains unknown.

Archive current prices across eligible providers and calculate conservative text/vision reservation estimates for Balanced routing, not just the cheapest provider or the provider observed in preflight. Use bounded input/output caps and all relevant price fields, including request/image/reasoning/cache/conditional pricing. Use a 2x safety margin, never assume a missing image price means a free image, and refuse unsupported pricing shapes until an operator supplies a documented conservative per-role reserve. Token-priced image input can instead reserve the entire permitted input-context token cost; do not silently assign image cost zero. Freeze reserves/method and projected 680-call total/at-160-approvals cost in P50, using observed smoke role costs and a separately shown conservative reservation scenario. Provider prices and membership may change; preserve initial/refreshed snapshots as evidence, not a fixed-provider contract. If current exposure cannot be covered by the frozen reserve/budget method, pause for budget safety, not merely because provider identity changed. If the forecast exceeds the authorized cap, require an explicitly authorized different cap or stop; never promise USD 10 is sufficient. These are admission estimates, not a mathematical billing guarantee. Include all router-reported charges, record actual overshoot, and stop new admissions. A user-configured provider/key spending cap is an additional external backstop, not permission for the app to change account settings.

Partial runs stop safely at a budget boundary and remain `paused_budget`; their report uses the planned denominator and labels results incomplete. Raising a cap on resume requires separate user authorization plus `--ack-budget-increase`; append old/new cap, time, and operator acknowledgement. It cannot change seeds, quotas, models, prompt/schema/code versions, or decision thresholds. No budget increase changes the observed cost per approved puzzle threshold.

Keep preflight, calibration, smoke, primary, unknown-exposure, and any later protocol's spending separate. With every candidate eligible, upper logical call counts are: full 680 (80 specs + 200 wordings + 200 blind + 200 alignment), smoke 70, calibration 80 (40 blind + 40 alignment), preflight three. Transport retries are additional attempts, not new logical calls. Do not promise these fit a default budget before measuring the chosen routes.

## 9. Metrics, Calibration, Audit, and Decision Rules

### 9.1 Fixed Denominators and Uncertainty

For a full run, `N_planned=200` always. Text and SVG denominators are 100; each family denominator is 20. Report lane denominators 120/80 overall, text 50/50, SVG 70/30, and the per-family 10/10 or 14/6 split. Report planned, started, terminal, fingerprintable, formal-passed, presentation-check-passed, reviewed, approved, rejected, inconclusive, generation-error, and paused/unstarted counts; never omit failed or incomplete slots.

- `formal_pass_rate = formal_passed / N_planned`.
- `pre_review_pass_rate = deterministic presentation eligible before duplicate/review decisions / N_planned`.
- `first_attempt_approval_rate = approved_primary / N_planned`; `post_review_approval_rate` is an explicit alias of this, not a second denominator.
- `first_pass_approval_rate` is the base plan's name for that same primary metric. A separately labeled secondary rate is `approved_primary / (N_planned - infrastructure_only_terminal_failures)`. Exclude only terminal failures exclusively due to router/network/auth/timeout/uncertain delivery, not invalid model JSON/content, solver failure, wrong answers, duplicates, unstarted slots, or budget pauses. Show excluded counts/reasons and retain the planned-denominator primary rate beside it; incomplete secondary rates remain provisional.
- `conditional_review_agreement = correct blind choices / successfully parsed blind reviews of deterministic-eligible items`; report this denominator and review coverage alongside it.
- `blind_ambiguity_rate = parsed blind reviews with ambiguity present or uncertain / parsed blind reviews`; show its coverage and planned-denominator count separately. Model disagreement is not proof of invalidity.
- `structural_uniqueness = distinct structural fingerprints / fingerprintable candidates`; report `fingerprint_coverage = fingerprintable / N_planned` so missing generations cannot inflate uniqueness silently.
- `average_cost_per_attempt = total actual primary generation + review + retry cost / started candidates`; report zero-start as `null`.
- `average_cost_per_approved = total actual primary cost / approved_primary`; no approvals yields `null`, not zero. Also report conservative exposure per approval when costs are unknown.
- `average_review_cost` separates blind-text, blind-vision, alignment-text, and alignment-vision, each with request counts. `end_to_end_cost` includes preflight, calibration, and smoke separately from primary marginal cost.
- Sum actual calls and token/cache/reasoning usage by role, with generator (`spec+wording`), text-review, and vision-review rollups. Show missing-usage coverage rather than converting null token/cost fields to zero. Total actual cost and actual-cost averages are null if any possibly billed attempt is unresolved; show a known-cost lower bound and estimated reserved exposure separately.
- Show the observed provider/model mix by role and missing-identity coverage as operational diagnostics. Balanced may select different providers across preflight, calibration, smoke, primary, and resume; do not claim a constant provider or complete visibility into internal fallback attempts.
- Report mean/median/p95 HTTP-attempt latency and logical-call elapsed time (including retry waits) per role. Use nearest-rank p95 at `ceil(0.95*n)` in ascending non-null observations, ordinary median, and arithmetic mean. Report per-candidate preparation/review active time from stage durations and end-to-end wall time from first start to terminal, explicitly including barrier/queue/interruption waits in wall time. Missing end times remain null and are reported as missing, not zero.
- Failure-code frequencies may sum above candidate count. State this and report a separate exclusive verdict histogram.
- Show near-duplicate-blocked counts per family/lane next to approval floors: separate candidates whose only remaining concern is the near flag and all other checks/reviews pass, candidates with additional quality findings, and candidates with incomplete/failed review evidence. The last category is unverified, not proof of a quality defect. Do not upgrade primary verdicts or replace the planned-denominator rate with a novelty-excluded success rate.

Compute per-modality, per-family, per-lane, target-difficulty, family-by-lane, modality-by-difficulty, and family-by-difficulty tables from planned strata, including failures. Difficulty means the requested generation setting, not validated human difficulty. Zero denominators produce `null`/`N/A` plus coverage, never NaN/Infinity or a favorable 0%. Show Wilson 95% intervals for binomial approval/calibration rates and explicitly describe the small 6-item SVG `ai_spec` cells as exploratory. Do not claim causal model/lane superiority from unpaired small samples.

### 9.2 Calibration Ground Truth

Prepare exactly 40 held-out presentations, four per family: two sound and two deliberately corrupted. This is 20 sound/20 defective, ten sound/ten defective per modality. They are constructed offline with fixed seeds disjoint from smoke/full and are not part of the 200 primary slots. A corrupted hidden answer key alone is not a blind-review negative; reviewers cannot see hidden truth.

Corruptions must affect what the reviewer actually sees: duplicate correct choices, omitted essential visible facts producing multiple offered solutions, inconsistent visible constraints producing no valid choice, or a genuinely unreadable/ambiguous critical visual element. P40 defines concrete mutations per family and independently establishes their visible consequences. Never assume a random removed clue changes the query answer. Original correct options/scene/spec and mutation evidence remain stored for alignment and ground-truth review.

Ground-truth records contain fixture ID, content/PNG hashes, sound/defective label, expected blind result/choice or accepted defect codes, expected alignment result with accepted failing-field/fact-ID sets, corruption explanation, and human auditor identity/time. Initially every record is `human_verified=false`. The agent may prepare evidence but must not impersonate the human or mark labels approved. P47 is the manual gate; any incorrect label or ambiguous corruption is corrected and the fixture hash/version changes before live calibration.

Evaluate blind and alignment roles separately, and separately for text/SVG. For sound cases, blind success requires the correct option and no defect/ambiguity flag; alignment success requires all relevant fields pass. For defective cases, blind detection requires an explicit accepted visible defect/no-unique result, not merely low confidence; alignment requires a supported failing field. A wrong answer, abstention, parse/API error, or unrelated criticism is not a qualifying detection for the conservative gate. Show the decisive-result confusion matrix, counts of errors/abstentions, coverage, and conservative sensitivity/specificity with all ten defective/sound cases in each modality's denominator.

For the diagnostic 2x2 matrix, an explicit defect/failed applicable alignment field predicts defective; a selected clear/no-issue answer or all-pass alignment predicts sound; uncertainty, parse/API errors, and contradictions in the response are separate abstention/error buckets. Compare those predictions with human truth without silently dropping a case. In addition, the conservative gate numerator on defective cases counts only a labeled compatible defect code/failing field (and affected fact ID when specified); its numerator on sound cases counts only correct/no-issue solving or all-pass alignment. Thus a wrong clean answer can appear as a matrix true negative for defect classification but still fails the valid-puzzle gate, and an unrelated accusation is never rewarded by the conservative detection gate. Report both conventional decisive-only matrix rates and these stricter all-ten denominators with explicit names; they are not interchangeable estimates.

For each of the four modality/role combinations, require sensitivity >= 90% (at least 9/10) and specificity >= 80% (at least 8/10), including failures in the conservative denominators. These are coarse PoC gates, not precise accuracy estimates; report intervals. Changing a reviewer model, prompt, schema, request limits, or routing policy after calibration invalidates that calibration and requires a new separately costed calibration before freeze. Automatic provider selection/fallback and catalog churn under the unchanged Balanced policy do not invalidate calibration; disclose the observed provider mix and its limits instead.

### 9.3 Human Audit and Business Decision

Select the primary audit deterministically after automatic verdicts freeze, with family and then family-by-lane as explicit outer loops. Each family has four core slots, exactly two from each lane. First reserve two approved slots per family: one from each lane if both have approvals; otherwise two from the sole approving lane, if available. Choose approval ties by hash of run seed and slot ID. Then fill the remaining capacity of each two-slot family/lane cell by reviewer disagreement/model-only concern, other non-approved presentation, remaining approval, then no-presentation failure, with the same hash tie-break. If fewer than two approvals exist in a family or fewer than two terminal slots in a lane, record the shortfall; never substitute another family's/lane's slot. For complete runs this yields 40 core slots. Append up to one representative for each globally available but unsampled major verdict category, at most four additions and 44 total. Preserve the core sample and any shortfall in its manifest.

Labels cover actual displayed correctness, wording clarity, hint/explanation support, image readability, novelty concerns, enjoyment and perceived difficulty (1-5, or null when not inspectable), and independent solve time (`<=60s|61-180s|>180s|not_solved|not_inspectable`). Missing presentations remain sampled as `not_inspectable`, not silently swapped for successes. For `proceed`, at least 32 core slots and at least two approved core slots per family (20 total) must be inspectable and genuinely audited; below either floor is not met, never a vacuous pass. Report approval-based and total inspectability denominators separately. Enjoyment/difficulty ratings are exploratory and do not claim population preference. This diagnostic sample is stratified and enriched for problems, so its defect fraction is not an unbiased population accuracy estimate. Disagreement may remain unresolved; it blocks `proceed` rather than forcing an answer.

Freeze the primary cost-per-approved threshold to USD 0.10 in P50, with the chosen authorized main-run budget (CLI default USD 10). Threshold changes after primary observation create a new protocol version, not a more favorable conclusion for this run.

`proceed` requires all of: completed live 200-slot cohort; valid same-configuration live calibration; text approval >= 80/100; SVG approval >= 80/100; structural uniqueness >= 95% with fingerprint coverage >= 80%; known complete costs and primary cost/approved <= USD 0.10; no approved high-risk near-duplicate flag; completed required human audit with no unresolved soundness/semantic/legibility defect among audited approvals, at least 80% of inspectable audited approvals rated clear and solved within 180 seconds, and adequate inspectability. Also disclose every family/lane's result; no family may have fewer than 10/20 approvals for `proceed`.

The 20-approval audit floor above applies to both approval-based predicates; their denominator may never be one/two or zero. Compared with the base's 80% overall/70% modality gate, this plan deliberately uses 80% in each modality so one cannot subsidize the other; its 90% calibration sensitivity allows at most one miss of ten visible defects rather than two. These stricter, pre-data PoC hypotheses are intentional, not promised attainable results or statistical certification.

An approval shortfall involving `NEAR_DUPLICATE_SUSPECTED` must disclose the three novelty-blocked evidence categories above beside each 80/100 modality and 10/20 family floor, separately from puzzle-quality failures. This explains a possible recommendation to revise the novelty heuristic rather than the generator/reviewer; it does not waive the frozen proceed gate or retrospectively restore approvals.

`reject` requires a complete evaluable run and at least one strong failure: either modality approval < 50%, any modality/role calibration sensitivity or specificity < 50%, or a repeatable audited correctness defect affecting at least two distinct approved candidates in the same family. `revise` covers other failures, missing human evidence, unknown costs, interrupted/incomplete runs, unsupported model routes, and borderline results. Always emit failed predicates and caveats; do not convert incomplete evidence into a conclusive business rejection or success.

## 10. File Ownership and CLI Availability

Paths below are the chosen layout, not suggestions to reorganize during implementation. `src/domain/` owns shared data, `src/families/<family>/` owns mathematical meaning, `src/render/` owns SVG/PNG safety, `src/ai/` owns provider/prompt boundaries, `src/storage/` owns durable state, `src/runner/` owns workflow, `src/reporting/` owns derived output, `src/calibration/` and `src/audit/` own evaluation. Tests mirror these under `tests/`.

P02 defines generic candidate/stage envelopes, not imports of nonexistent family modules. P04's interfaces and P03's generic storage methods require the caller's strict stage validator. Each family adds its real spec schema in its phase; P20 creates `src/domain/spec.ts` from the ten registered schemas. Raw API bytes remain strings at the trust boundary until parsing/validation. Do not persist unvalidated `unknown` as an accepted spec or add stub implementations to satisfy a future union.

| Command | First implemented | Behavior before later phases |
| --- | --- | --- |
| `npm run check` | P01 | Local lint, typecheck, unit tests, build; never paid, browser tests separate. |
| `npm run experiment -- --dry-run --seed puzzle-poc-v1` | P02 | Manifest only; no runner exists yet. |
| `npm run preview -- --family scene-demo --seed preview-v1` | P10 | Local scene demo; a real family is accepted only after its renderer phase. |
| `npm run preflight -- --offline` | P25 | Recorded capability fixtures only. |
| `npm run experiment -- --smoke --mock --seed puzzle-smoke-v1` | P34 | Serial mock workflow first; parallel execution arrives P35, resume P36. |
| `npm run experiment -- --resume <run-id>` | P36 | Preserve frozen mode/configuration; live also requires paid flags, cap, and authorization. |
| `npm run report -- --run <run-id>`; `npm run export -- --run <run-id> --format csv` | P37 | JSON/CSV/JSONL until HTML gallery P38. |
| `npm run test:browser` | P39 | Offline report in Chromium at desktop/mobile sizes. |
| `npm run calibration -- --prepare` | P40 | Offline fixture pack, evidence, pending label template, gallery. |
| `npm run calibration -- --mock --labels <path>` | P41 | Synthetic evaluation, labeled mock; not live evidence. |
| `npm run calibration -- --verify-labels <path> --auditor <name>` | P41 | Validate genuine completed labels; no fabricated observations. |
| `npm run audit -- --run <run-id> --prepare`; `--import <path>` | P42 | Deterministic sample and append-only human label import. |
| `npm run freeze -- --smoke <id> --calibration <id> --max-run-cost 10` | P43 | Pre-run evidence graph; real provenance supplied by P44. |
| `npm run preflight -- --live --allow-paid --max-cost 0.50` | P46 | Three bounded role probes after user authorization. |
| `npm run calibration -- --live --allow-paid --labels <path> --max-cost 2` | P48 | At most 80 logical review calls, no new generation. |
| `npm run experiment -- --smoke --live --allow-paid --seed puzzle-smoke-v1 --max-cost 2` | P49 | All-family integration, not primary inference. |
| `npm run experiment -- --full --mock --seed puzzle-poc-v1 --max-cost 0` | P45 acceptance | 200-slot simulation, zero paid calls, never proceed. |
| `npm run experiment -- --full --live --allow-paid --protocol <hash> --max-cost 10` | P51 | Frozen protocol, no seed/model override, 200 planned slots. |

P24 transport code and P25 preflight implementation may be tested with local HTTP fakes, but no implementation phase may execute a live command merely because its parser exists. CLI `--help` must distinguish implemented offline commands, simulated execution, and authorization-gated live execution. Reject unsupported flag combinations rather than silently choose a mode.

## 11. Sequential Implementation Phases

For every phase, run its listed focused command and `npm run check`, unless it is explicitly an evidence-only live/manual phase. Commands with `<run-id>`, `<path>`, or `<hash>` mean substitute the actual ID printed by the preceding command and record it in the phase report. They are not literal fixture IDs to invent. All tests mentioned in a phase must be created in that phase or already exist in a stated prerequisite.

Monetary literals in operating commands are default caps, not authorization. If the user authorizes a different cap before freeze, substitute that exact amount consistently in freeze/execution and record it; never launch with a larger unapproved default or change the USD 0.10 outcome threshold.

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
- **Out of scope:** actual model validation; that is P46, not an assumed offline success.

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

### P46. Authorized Live Model/Route Compatibility Probes

- **Size:** S; operational compatibility only, maximum three logical calls.
- **Prerequisites:** P45 accepted under the revised routing contract; explicit user authorization for up to USD 0.50; actual inference key and selected model IDs for the three roles supplied locally. Balanced routing with provider fallback is fixed by section 8.1; no provider IDs are required. No authorization means `blocked/live-unverified`, not a mock substitute.
- **Files:** append truthful evidence to `docs/PROVIDER_SMOKE_TESTS.md` and `docs/PROGRESS.md`; generated preflight run/price/capability artifacts live under ignored `data/`. No feature code changes in a passing phase.
- **Instructions:** archive the actual operator routing-settings confirmation from section 8.1 before dispatch; a conflicting account sort, BYOK, or missing confirmation blocks the probes. Validate the selected models against the current public catalog, retain role separation, and run one strict-schema probe per role through Balanced with provider fallback enabled, including actual PNG for vision and the actual cap field/value. Confirm expected visible JSON/image interpretation, finish/usage/cost metadata, observed provider identity when exposed, and spending backstop. Document unknown-cost/model-drift limits and the lack of a provider-availability guarantee. No management credential or automatic model substitution is permitted. If code changes are needed, return to its owning phase and repeat P45 plus affected evidence.
- **Verification:** `npm run preflight -- --live --allow-paid --max-cost 0.50`; `npm run report -- --run <preflight-id>`. Record requested models/Balanced policy, observed model/provider IDs or explicit unknowns, timestamps, schema result, actual cost/reservations, image interpretation, generation IDs, and command exit status. Never publish a key.
- **Manual acceptance:** inspect the actual probe artifacts and timestamped capability snapshot; all three role requests use Balanced with enabled provider fallback and satisfy strict structured output, and the vision request actually processes the PNG. No provider is pinned or promised for subsequent calls.
- **Out of scope:** calibration, all-family generation smoke, primary experiment.

### P47. Human Verification of All Calibration Labels

- **Size:** M, human review; 40 bounded fixture inspections, no API.
- **Prerequisites:** P40-P41 and P46; a real human auditor, not a simulated identity.
- **Files:** create the actual human-completed label file under `data/calibration/<pack-hash>/`; append acceptance evidence to calibration labeling docs/progress. Preserve the original pending template and pack version.
- **Instructions:** the human inspects/solves all 40 actual visible presentations, including rasterized PNGs, checks proposed ground truth and mutation evidence, and fills verified labels/expected outcomes/auditor/time. Reject negatives that only corrupt a hidden answer or still form one clear valid visible question. Correct a faulty fixture in P40, create a new pack hash, rerun offline checks, and obtain human verification again. The coding agent may validate completeness/hashes, not fabricate judgments.
- **Verification:** `npm run calibration -- --verify-labels <human-labels-path> --auditor <actual-auditor>`; `npm exec vitest run tests/calibration/fixtures.test.ts tests/calibration/score.test.ts`. Require exactly 40 verified, version-matching entries and a stable label-set hash. Record actual manual evidence separately from code test results.
- **Manual acceptance:** the auditor explicitly accepts every sound/defective label and expected blind/alignment outcome for the displayed version. Unresolved labels block live calibration.
- **Out of scope:** automatic human approval, reviewer calls, tuning to reviewer answers.

### P48. Authorized Live Reviewer Calibration

- **Size:** M, bounded live evaluation; at most 80 logical calls.
- **Prerequisites:** P46 and P47 accepted; explicit authorization for the calibration budget, default cap USD 2.
- **Files:** append real calibration results to `docs/PROVIDER_SMOKE_TESTS.md` and progress; immutable live run, label hashes, requests, PNGs, and score exports under `data/`.
- **Instructions:** use the same prompt/schema/model/Balanced routing policy/limits intended for primary, not a fixed provider; run blind and informed roles in separate requests for every held-out fixture. Record the actual provider mix without invalidating calibration solely for automatic provider changes. Do not reveal fixture labels to blind solving, retry wrong content, drop hard fixtures, or turn partial evaluation into a pass. Score every modality/role using the conservative rates in section 9.2.
- **Verification:** `npm run calibration -- --live --allow-paid --labels <verified-labels-path> --max-cost 2`; `npm run report -- --run <calibration-id>`. Confirm 40 fixture outcomes for each role, all costs/unknown exposure, four matrices, intervals, abstention/error counts, and fixed gates. An incomplete/budget-paused calibration fails freeze eligibility.
- **Manual acceptance:** a human confirms actual scores and limitations; all four sensitivity/specificity gates pass before primary freeze. A different reviewer/configuration requires a new authorized calibration and preserved prior result, never relabeling fixtures to obtain a pass.
- **Out of scope:** primary-candidate generation, remediation, claims of precise reviewer accuracy.

### P49. Authorized Twenty-Slot All-Family Smoke Run

- **Size:** M, bounded integration; at most 70 logical calls.
- **Prerequisites:** P45, P46, and successful P48; explicit user authorization for smoke budget, default USD 2.
- **Files:** update live evidence/progress and reproduction docs only as observed; save the run and full report under `data/`.
- **Instructions:** run the immutable 20-slot smoke plan with both lanes in every family. Exercise spec proposal, wording, render, duplicate barrier, blind solve, alignment, verdict, accounting, resume, and exports on real responses. Preserve first failures. Smoke acceptance requires all 20 slots terminal, no unresolved payload/route/schema-enforcement/ledger/safety defect, at least one full blind+alignment path per family, and both lanes represented by completed review paths in each modality. Ordinary bad model content remains an observed error, not a replacement opportunity.
- **Verification:** `npm run experiment -- --smoke --live --allow-paid --seed puzzle-smoke-v1 --max-cost 2`; `npm run report -- --run <smoke-id>`; `npm run export -- --run <smoke-id> --format jsonl`. Inspect actual reviewer input allowlists/PNG hashes, exact 20-slot family/lane manifest, all stage/cost records, HTML, and terminal coverage. Exercise a safe resume only if a real interruption occurred; the forced crash matrix is already covered offline.
- **Manual acceptance:** solve representative text and SVG items from the public view, then inspect explanations/reviews/failures. The smoke is integration evidence, not an estimate substituted for the primary sample. If coverage fails, stop and revise; any new pilot run is separately authorized, versioned, and reported alongside this one.
- **Out of scope:** quota changes, filtering failures, repeated smoke slots until every one succeeds, full run.

### P50. Freeze the Primary Protocol and Authorized Budget

- **Size:** S; immutable pre-run operational gate, no paid calls.
- **Prerequisites:** P43-P49; accepted live preflight/calibration/smoke using identical source/prompt/schema/configuration hashes; explicit primary budget authorization.
- **Files:** write an immutable `data/protocols/<protocol-hash>/protocol.json` and provenance snapshot; record protocol hash, accepted evidence IDs, thresholds, and authorization in `docs/PROGRESS.md` and protocol docs. Do not put secrets in the snapshot.
- **Instructions:** validate the pre-run evidence graph only, not future primary results/audit. Reconfirm and archive the operator's current account-routing check; missing confirmation, a conflicting sort, or BYOK blocks freeze. Freeze full 200-slot plan, role model IDs, Balanced routing with provider fallback enabled and verified account defaults/no BYOK, cap fields, source/font/lock hashes, limits, reservation method/reserves, concurrency, USD 0.10 cost/approved threshold, and authorized primary cap (default USD 10). Archive timestamped price/capability evidence, not a guaranteed provider roster. Record observed-cost forecast for all 680 potential calls, projected cost at 160 approvals, conservative multi-provider reserve scenario, and evidence the authorized cap is adequate; otherwise stop for explicit reauthorization. Reject mock/stale/partial/mismatched evidence. Subsequent semantic/code/config changes require new protocol/affected live evidence, not in-place mutation; normal provider churn under unchanged Balanced policy is not such a change.
- **Verification:** `npm run freeze -- --smoke <smoke-id> --calibration <calibration-id> --max-run-cost 10`; `npm run experiment -- --dry-run --seed puzzle-poc-v1`. Compare frozen vs planned slots exactly, inspect stored hashes, verify source snapshot is reproducible, and ensure no paid call occurs.
- **Manual acceptance:** the user accepts the named frozen protocol and authorized cost cap before the main run. There is no implicit authorization inherited from paying for smoke/calibration.
- **Out of scope:** starting the full run or deciding its success in advance.

### P51. Execute the Frozen Two-Hundred-Slot Primary Run

- **Size:** M, operational batch; at most 680 logical content/review calls plus safe transport attempts.
- **Prerequisites:** P50 accepted and still hash/configuration-identical; user authorization remains valid.
- **Files:** save primary run DB/manifest/checkpoints/request ledger/presentation assets and provisional exports under `data/`; append actual execution facts to progress. No implementation changes during the cohort.
- **Instructions:** run exactly the frozen slots, with one first version per slot. Do not refill invalid/duplicate/uncertain slots or silently start another full run. On budget/interrupt, report incomplete planned-denominator results and use same-run resume only under section 8, including explicit authorized cap-increase amendments if needed. OpenRouter may select new/different providers or fall back when one disappears or is unavailable; keep Balanced and the configured role model unchanged and record exposed provider metadata. An unavailable model with no compatible provider after the allowed client attempts, unmet capability/budget gates, or source drift pauses execution; do not substitute another model. A late billed response never overwrites a committed terminal snapshot.
- **Verification:** `npm run experiment -- --full --live --allow-paid --protocol <protocol-hash> --max-cost 10`; `npm run report -- --run <primary-id>`; `npm run export -- --run <primary-id> --format csv`. For a completed cohort assert 200 planned and terminal, text 100/SVG 100, every family 20, exact lane quotas, one primary snapshot per slot, documented unknown-cost reconciliation, and all failures visible. For partial execution explicitly record the missing terminal count and do not claim completed acceptance.
- **Manual acceptance:** inspect the live cohort manifest, random public text/SVG cards, all failed outcomes, and costs. The report remains `decision_pending_human_audit` or `revise/incomplete`, not automatic proceed.
- **Out of scope:** prompt changes, repairs, adjudication, a cherry-picked replacement cohort.

### P52. Human Audit of the Frozen Primary Outcomes

- **Size:** M, human inspection; core 40 plus up to four category representatives.
- **Prerequisites:** P42 and completed P51; a real human auditor. If P51 is incomplete, report diagnostic evidence only and keep final recommendation `revise`.
- **Files:** generate immutable `audit/sample.json` and pending `audit/labels.csv`; import genuine human labels as append-only DB evidence; update audit docs/progress with actual observations.
- **Instructions:** select the sample using the frozen deterministic algorithm, preserving both lanes/all families and noninspectable failures. The human solves from the public view before reveal, then checks correctness, clue semantics, explanation/hint support, SVG clarity, novelty concerns, and solving-time category. Keep reviewer/human disagreements unresolved unless evidence actually settles them; a second rater is welcome but not required or impersonated. Record the number of inspectable items/approvals and evidence for every discovered defect. Do not rewrite automatic primary verdicts.
- **Verification:** `npm run audit -- --run <primary-id> --prepare`; after actual human completion, `npm run audit -- --run <primary-id> --import <human-audit-path>`; `npm run report -- --run <primary-id>`. Confirm core40/four per family/two per lane, at least two inspected approvals per family/20 total for proceed, max44, complete genuine labels/hashes, unchanged primary snapshots, and separate approved/overall inspectability, clarity, time, enjoyment/difficulty denominators.
- **Manual acceptance:** the human explicitly accepts the recorded audit observations, not necessarily the puzzles. If any audited approval has unresolved correctness/semantic/legibility concerns, proceed is blocked even if the model agreed with the code.
- **Out of scope:** presenting a selected audit as an unbiased population rate or upgrading primary success after repairs.

### P53. Final Evidence Report and Proceed/Revise/Reject Recommendation

- **Size:** S/M; final evidence synthesis, no new calls or puzzle edits.
- **Prerequisites:** P37-P43 and observed P46-P52 evidence, including any explicit incompleteness/blocker.
- **Files:** create `docs/FINAL_ASSESSMENT.md`; finalize `data/runs/<primary-id>/summary.json`, `data/runs/<primary-id>/results.csv`, `data/runs/<primary-id>/candidates.jsonl`, `data/runs/<primary-id>/requests.jsonl`, `data/runs/<primary-id>/report.html`, audit exports, and provenance links from immutable DB. Update progress with actual state.
- **Instructions:** report primary and secondary rates, all family/lane/difficulty tables, exclusivity/coverage, uniqueness, blind/alignment outcomes, calibration uncertainty, human approval-based denominators/disagreements/ratings/times, per-role mean/median/p95 latency and active/wall time, token/cache/reasoning usage, observed provider/model mix and identity coverage, exact actual/unknown/exposure costs, and pilot spending. Apply frozen predicates to one recommendation with failed gates/limitations/next experiment changes. Keep remediation not implemented and eventually_approved_rate null. Do not revisit thresholds to obtain proceed.
- **Verification:** `npm run report -- --run <primary-id>`; `npm run export -- --run <primary-id> --format csv`; `npm run export -- --run <primary-id> --format jsonl`; `npm run test:browser`. Reconcile all aggregates to the stored 200-slot manifest/ledger, confirm no NaN/Infinity/unknown-as-zero, and replay the decision evaluator from frozen evidence. Record commands/results honestly if a missing authorization or incomplete run makes a final artifact provisional.
- **Manual acceptance:** a reviewer can open the HTML and raw evidence offline, reproduce every reported numerator/denominator/cost, see failures and disagreements, and understand why the single recommendation follows. A failed experiment with complete trustworthy evidence is a valid outcome.
- **Out of scope:** automatic remediation, production launch, or expenditure justified by an optimistic narrative.

## 12. Dependency and Acceptance Cross-Check

| Range | Capability produced | What it must not assume |
| --- | --- | --- |
| P01-P04 | Tooling, manifest, storage, family contracts | No existing app, API adapter, or report. |
| P05-P09 | Five text engines | No natural-language solver or future reviewer. |
| P10 | Safe local scene/PNG | No real visual family or gallery. |
| P11/P13/P15/P17/P19 | Five visual formal engines | No renderer until the next phase, and no other family's renderer dependency. |
| P12/P14/P16/P18/P20 | Five checked renderers and previews | Direct PNG inspection, not the later HTML gallery. |
| P21-P22 | Cohort novelty and exact public/reveal data | No paid reviewer semantics assumed. |
| P23-P25 | Ledger, conservative transport, strict capability schemas | Local HTTP fakes only, no live compatibility claim. |
| P26-P31 | Fixed AI role adapters and verdict policy | No orchestrator or human judgment invented. |
| P32-P34 | Mock transport, slot preparation, serial cohort | Each capability accepted separately; no future workers/reports. |
| P35-P36 | Bounded workers and actual recovery | No metrics/gallery until P37/P38. |
| P37-P39 | Exact exports, static gallery, browser acceptance | No reviewer calibration or business success yet. |
| P40-P43 | Held-out fixtures, scoring, audit workflow, gates | No human approval or provider support inferred. |
| P44-P45 | Source/security provenance, then full offline release/replay | No paid run validated by mock success. |
| P46-P50 | Real compatibility, human labels, calibration, smoke, freeze | No primary outcomes/audit required before primary execution. |
| P51-P53 | Fixed primary cohort, real human audit, final decision | No repair/refill or retrospective threshold edits. |

Every implementation phase has explicit files, lower-numbered prerequisites, a focused test or evidence command, independent acceptance observations, and an out-of-scope boundary. The operating phases have explicit authorizations/human inputs, call ceilings, and blocked-state behavior. `docs/PROGRESS.md` records accepted/offline/live state rather than a single misleading all-green checklist.

Before accepting any future phase, independently check: its tests fail for the intended negative fixture; skipped tests are not passes; all newly persisted data passes strict schemas; no command invokes a not-yet-implemented feature; no solution/prose is silently repaired; failure artifacts survive; and no paid traffic occurs without separate authorization.

## 13. Reference Facts and Revalidation

External interfaces were reviewed against the following official documentation on 2026-11-03; OpenRouter default routing and provider fallback were rechecked on 2026-11-06 for version 1.1. The implementing agent must revalidate current capability data before live evidence; documentation/model names are not runtime guarantees.

- Node.js release status: https://nodejs.org/en/about/previous-releases
- OpenRouter strict structured outputs: https://openrouter.ai/docs/guides/features/structured-outputs
- Balanced default routing, Nitro/Floor, and `require_parameters`/provider fallback controls: https://openrouter.ai/docs/features/provider-routing
- Exact model endpoints and price fields: https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model.md
- Image inputs and supported MIME types: https://openrouter.ai/docs/guides/overview/multimodal/image-understanding.md
- Error bodies, HTTP-200 provider errors, truncation, and retry limits: https://openrouter.ai/docs/api_reference/errors-and-debugging.md
- Actual usage/cost: https://openrouter.ai/docs/guides/guides/usage-accounting

The base plan's mandatory cohort, families, lane comparison, deterministic SVG, independent blind review, calibration, human inspection, complete cost accounting, and final decision are retained. The narrowed puzzle rule classes, mandatory informed alignment role, unknown-call policy, explicit metrics, and split phases are intentional methodological corrections, not unresolved options for the coding agent.

## 14. Separate Critical Plan Audit

For version 1.0, two independent reviewers audited the complete 49-phase rewrite, rather than using the initial design review as its own acceptance. Both re-read the corrected 53-phase plan and then checked the final targeted corrections. They confirmed closure of the blocking contract, dependency, mathematical-test, and phase-balance findings; neither reported a remaining phase that requires splitting. The final non-blocking attribution note was incorporated as explicit novelty-only versus quality/unverified shortfall reporting. Audit result: ready for the specified offline implementation sequence, with all live/human gates still required. These are historical static document findings, not proof of implemented runtime behavior or an independent re-audit of version 1.1's routing correction.

| Finding in the Complete Draft | Correction in This Revision |
| --- | --- |
| Orchestration combined mock transport, preparation, review scheduling, and cohort integration. | P32/P33/P34 now accept mock transport, per-slot preparation, and serial cohort orchestration separately. |
| Gallery generation and browser acceptance shared one assignment. | P38 implements static output; P39 independently tests actual file-URL/CSP/desktop/mobile behavior. |
| Provenance/security design was bundled with the full release/reproduction run. | P44 owns source/security boundaries; P45 consumes them in the 200-slot release gate. |
| Visible rule ownership, fact IDs, and SVG alignment applicability were implicit. | The engine method, file owner, common namespaces, and per-modality rulesAndClues/image semantics are normative in sections 4/5/7. |
| Reduced-core policy was not repeated in four family contracts. | Every text fingerprint phase consumes section 6's internal reduced-core procedure; full specs remain intact and separately hashed. |
| Visual near-duplicate features/weights were undefined; a 0.95 Jaccard cutoff then proved ineffective on short token sets. | Sections 6/7.11 fix tokens/grouping and an operative one-feature-edit rule, retain Jaccard diagnostically, and provide a valid counting positive with score 33/35. |
| Transform fingerprints collapsed a distinct visible two-step instruction into its one-step net effect. | P13 and section 7.7 retain step count/ordered conjugated operations; effect-equivalent different instructions do not collide automatically. |
| Canonical feature ownership and modality-boundary notation were implicit. | P04 explicitly creates/tests CanonicalStructure and feature arithmetic; P43 uses complete /100, /20, and /10 boundary cases. |
| Equivalent integer strict/nonstrict inequalities could create false novelty. | Section 7.5 defines strict-to-nonstrict, coefficient-gcd/floor, negative-bound, and equality normalization tests. |
| Latency, difficulty groups, secondary infrastructure-excluded rates, and dry-run call estimates were missing. | Sections 4/9 and P02/P37/P53 restore them with exact definitions, usage coverage, and quantile rules. |
| The human-audit approval denominator could be zero/tiny and selection order was ambiguous. | Section 9.3 reserves two approvals per family, fixes family/lane loops, and requires 20 audited approvals plus explicit inspectability floors. |
| Novelty suspicion could depress approval rates without isolating that cause. | Otherwise eligible near pairs still receive reviews; metrics/decision reasons distinguish novelty-only, mixed-quality, and unverified shortfalls without rewriting first-pass results. |
| Truth family had two conflicting seed-volume requirements. | All families use 100 seeds split 34/33/33 by target level; truth reports its population subcounts without doubling the gate. |
| Formal visual engines unnecessarily depended on another family's renderer. | Their direct prerequisites are shared P04/P10 only; renderer acceptance follows its own formal engine. |
| Fixed-provider assumptions treated OpenRouter endpoint availability as an immutable protocol input. | Version 1.1 uses Balanced with provider fallback, capability/cap-field checks, serialized request tests, multi-provider price evidence, and observed identity recording; sections 8/9 and P24/P25/P36/P43/P46/P48/P50/P51 no longer pin catalog tags or invalidate calibration for normal provider churn. |
| Family acceptance test used a calibration denominator. | P43 tests the actual 9/20-vs-10/20 family boundary separately from 9/10 and 8/10 calibration gates. |
| Shorthand file paths and an undeclared mock-label CSV weakened file-level instructions. | Family paths are fully qualified and the CSV is explicitly created in P41; the mechanical file/command check has no warnings. |

An initial concern that public endpoint catalog reads required a management key was independently tested and retracted: unauthenticated read-only requests for `openai/gpt-4o` and `qwen/qwen3-coder` returned endpoint tags, limits, supported parameters, and pricing. No elevated credentials or paid inference were used. Future 403/capability changes fail closed rather than grant the agent permission to escalate access.

Mechanical validation checks all 53 consecutive phases, all 371 mandatory phase fields, prerequisite/reference ranges, focused-test file ownership and command availability, quota/call arithmetic, Markdown tables/whitespace, and line readability. The temporary validator is outside the project (`/tmp/kilo/validate-puzzle-plan.mjs`); it is not application implementation. The plan-only check and `git diff --no-index --check /dev/null AI_PUZZLE_FACTORY_EXPERIMENT_PLAN.md` currently pass with zero errors/warnings. The base and example documents remain unchanged.

Actual planning-time command: `node /tmp/kilo/validate-puzzle-plan.mjs /home/alex/ai-puzzle-factory/AI_PUZZLE_FACTORY_EXPERIMENT_PLAN.md 53`. Result: 53 phases, 371 phase-field assertions, 187 explicitly owned paths, zero errors and zero warnings. Its executable mathematical checks also establish that the three specified counting shapes are connected, the two queries answer 0/3, their feature overlap gives 33/35 and one edit, the stated one/two-step transform can have the same effect while retaining distinct instruction structure, and strict/negative-bound integer inequality normalization preserves the tested integer solutions. These checks validate the plan's examples, not any not-yet-written family engine. All implementation-phase `npm`/browser/live commands in this document are still `NOT RUN` in this planning task.

Remaining execution risks are explicit experimental limitations, not delegated architecture: remote model nondeterminism and reviewer correlation, coarse calibration confidence, incomplete natural-language/perceptual assurance, heuristic novelty false positives/negatives, native/browser installation requirements, human availability, changing provider catalogs, and possible budget overshoot/unknown billing. P46-P53 cannot be asserted complete by this static audit; they require the specified live authorization and genuine evidence.
