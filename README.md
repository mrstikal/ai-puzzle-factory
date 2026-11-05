# AI Puzzle Factory

Auditable, offline-first proof-of-concept for generating short English multiple-choice puzzles. The normative specification is [AI_PUZZLE_FACTORY_EXPERIMENT_PLAN.md](AI_PUZZLE_FACTORY_EXPERIMENT_PLAN.md); this repository currently implements **P01-P25**: the reproducible offline toolchain, deterministic planning, transactional SQLite storage, the five formal text engines, the matrix formal engine and renderer, the transforms formal engine and renderer, the paths formal engine and renderer, the symmetry formal engine and renderer, the counting formal engine and renderer, safe scene/PNG preview infrastructure, the structural-fingerprint/deterministic duplicate barrier, visible presentation assembly with a public/reveal boundary, the transactional request ledger/budget admission layer, a locally tested OpenRouter transport with conservative retries, and strict role schemas with an offline capability preflight. Paid requests, reports, and the gallery remain out of scope.

## Requirements

- Node.js **24.22.2** LTS, pinned in [.nvmrc](.nvmrc)
- npm **11.19.1** (bundled with Node 24.22.2)
- No API key and no `.env` file are needed for any implemented command; `npm run check`, the offline `npm run experiment -- --dry-run`, and `npm run preflight -- --offline` make no network calls. The initial `npm ci` needs npm registry access unless the npm cache is already populated.

Recorded development environment for P01/P02 evidence:

- OS: Ubuntu 22.04.5 LTS on Linux 6.18.54.1-microsoft-standard-WSL2 x86_64
- Node: v24.22.2
- npm: 11.19.1

## Setup

```bash
nvm install 24.22.2
nvm use
npm ci
```

Dependencies are pinned to exact versions in `package.json` and `package-lock.json`; do not replace them with caret ranges.

## Scripts

| Script | Behavior |
| --- | --- |
| `npm run check` | Lint, typecheck, unit tests, then build. Never contacts OpenRouter and never needs a key. |
| `npm run lint` | ESLint flat config over the repository. |
| `npm run typecheck` | `tsc --noEmit` with strict ESM settings. |
| `npm run test` | Vitest unit suite with the offline network guard installed. |
| `npm run build` | Compiles `src/` to `dist/` with declarations. |
| `npm run experiment -- --help` | Prints CLI help and exits successfully. |
| `npm run experiment -- --dry-run --seed puzzle-poc-v1` | Prints the deterministic 200-slot plan manifest. No generation, database, API, or rendering. |
| `npm run experiment -- --dry-run --smoke` | Prints the deterministic 20-slot smoke plan. |
| `npm run preview -- --family scene-demo --seed preview-v1` | Renders the safe local scene demo to SVG, 1024 PNG, and 512 PNG under `data/previews` (ignored). No gallery or provider call. |
| `npm run preview -- --family counting --seed preview-v1` | Renders the P20 counting membership grid to SVG, 1024 PNG, and 512 PNG under `data/previews` (ignored). |

## Offline guarantees

- `tests/setup.ts` installs a global network guard at the socket layer (`net.Socket.prototype.connect`), so named ESM imports of `node:http`/`node:https`, redirect hops, and raw socket connections are covered. Non-loopback access fails the test; loopback targets must be registered explicitly with `allowLocalFake()` before use. The guard runs inside the Vitest worker process; spawned child processes must install their own instrumentation, as the import-side-effect probe does.
- Importing `src/cli/experiment.ts` has no filesystem or network side effects. `dotenv` is not loaded yet; it will only be loaded by live CLI entry points in later phases.
- Unknown CLI flags, conflicting flags, and the absence of an implemented execution mode fail with a non-zero exit status instead of silently choosing a mode.

## Deterministic planning (P02)

```bash
npm run experiment -- --dry-run --seed puzzle-poc-v1
npm run --silent experiment -- --dry-run --seed puzzle-poc-v1 > plan.json
```

The dry-run prints a strict `PlanManifest`: protocol version, run kind, root seed, all slot tuples, quotas, per-family/lane difficulty counts, request estimates by role, maximum transport attempts, and a canonical SHA-256 plan hash. `npm run` adds its own banner to stdout, so use `--silent` when piping the JSON. `--smoke` selects the 20-slot coverage plan; `--full` is the default. Root seeds are fixed per run kind (`puzzle-poc-v1` for full, `puzzle-smoke-v1` for smoke); `--seed` may only restate the matching value, and the reserved calibration seed is rejected. The plan is byte-identical for the same run kind and seed. `--live` is rejected because live execution is not implemented.

The protocol summary, fixed thresholds, no-replacement rule, stream derivation, and PRNG algorithm are documented in [docs/experiment-protocol.md](docs/experiment-protocol.md).

## Transactional storage (P03)

P03 adds a local SQLite source of truth at `data/experiment.sqlite` (ignored by Git): WAL, foreign keys, migrations, a single-writer lock, atomic run/slot creation, immutable stage results, content-addressed bounded artifacts, events, and safe export-path resolution. The storage layer is a library; no CLI command writes a database yet. The contract is documented in [docs/experiment-protocol.md](docs/experiment-protocol.md#11-storage-contract-p03).

## Novelty and duplicate barrier (P21)

P21 adds a pure validation layer: `src/validation/fingerprints.ts` computes distinct content, canonical-spec, reduced-structure, and SVG/PNG render hashes plus the P04 feature multiset; `src/validation/duplicates.ts` runs the deterministic barrier over a fully prepared cohort. Exact content, canonical-spec, and structural duplicate groups keep the lowest eligible slot ordinal as owner across both lanes; later eligible members are rejected. Near detection is exactly one multiset feature edit with nonempty overlap, Jaccard is diagnostic, and both eligible members are flagged `NEAR_DUPLICATE_SUSPECTED`. Early failures remain ineligible and cannot own or suppress a usable candidate, but diagnostic pairs are retained. The barrier refuses missing or budget-paused preparation and never replaces a slot or rewrites a terminal verdict. See [docs/experiment-protocol.md](docs/experiment-protocol.md#12-novelty-and-duplicate-barrier-p21).

## Visible presentation assembly (P22)

P22 adds the deterministic public/reveal boundary. `src/presentation/wording.ts` defines the strict wording response (`question`, `clueTexts`, `hint`, `explanationSteps`) and a clearly labeled fixture generator. `src/presentation/assemble.ts` combines code-owned `VisibleRules`, code-owned A-D option values/text, the wording, the independent solve proof, and stored SVG/PNG hashes into a `VisiblePresentation` plus a separate reveal object. Text wording must cover every local clue fact exactly once; SVG wording must leave `clueTexts` empty; explanation references must exist in the full rule/local-or-observation/proof inventory. The public DTO never contains the key, hint, explanation, or proof. Mechanical checks report `pass`, while semantic alignment remains `semantic_alignment_pending`; a correct-ID paraphrase or contradiction is never mechanically declared true. See [docs/experiment-protocol.md](docs/experiment-protocol.md#13-visible-presentation-assembly-p22).

## Request ledger and budget admission (P23)

P23 adds durable accounting without HTTP. `src/ai/ledger.ts` stores one logical call per `(run, slot, role)` or probe key and one-to-three transport attempts with request intent, state transitions, raw-response references, usage, generation ID, cost, and append-only request events. `src/ai/budget.ts` uses `decimal.js` money and SQLite transactions to admit requests only when `known_actual + reserved + next_reservation <= maxCost`, to reserve per attempt, settle explicit actual costs, retain unknown exposure, release certified unprocessed refusals, record overshoot, and pause a run at the budget boundary. Pools are separate for primary, smoke, calibration, and preflight; role and run-kind totals are reported separately. A zero budget admits nothing unless the transport is explicitly nonbilling. See [docs/experiment-protocol.md](docs/experiment-protocol.md#14-request-ledger-and-budget-admission-p23).

## OpenRouter transport and retry policy (P24)

P24 adds a locally tested transport, not a paid live call. `src/ai/openrouter.ts` sends one non-streaming request from the stored logical-call intent, enforces a 90-second deadline and 2 MiB response cap, stores the redacted raw response before parsing, validates the request shape and strict finish reason, and maps outcomes to the P23 ledger and budget. `src/ai/retry.ts` allows at most two additional attempts only for certified unprocessed refusals (429, or 503 no eligible provider) with no generation ID, usage, cost, or partial completion; it waits 500 ms then 1000 ms plus seeded jitter, honors Retry-After up to 30 seconds, and pauses longer waits. `src/ai/redact.ts` removes API keys from persisted raw responses and diagnostics. A bounded GET generation lookup can settle a missing actual cost; it never regenerates content. See [docs/experiment-protocol.md](docs/experiment-protocol.md#15-openrouter-transport-and-conservative-retry-policy-p24).

## Strict role schemas and offline preflight (P25)

P25 adds provider-compatible strict JSON Schema compilation for all ten family specs, wording, blind review, alignment review, and family envelopes; blind and alignment response schemas are now defined. `src/ai/config.ts` requires explicit live model/provider/key inputs with no defaults, enforces generator/text-reviewer/vision-reviewer role separation, freezes the selected output-cap field, and builds requests with exactly one of `max_tokens` or `max_completion_tokens`. `src/ai/preflight.ts` resolves an exact endpoint tag (including variant suffixes) from recorded catalog data, rejects base-slug and duplicate-tag matches, checks `structured_outputs`, cap/context/prompt limits, pricing, settings, and model-level image modalities, and names each missing capability. `npm run preflight -- --offline` validates `tests/fixtures/openrouter/catalog.json` without network or an inference key. Live probe construction and execution exist behind explicit paid authorization and a positive budget, but P25 does not execute them; P46 owns live probes. See [docs/experiment-protocol.md](docs/experiment-protocol.md#16-strict-role-schemas-and-offline-preflight-p25).

## Safe rendering infrastructure (P10)

P10 adds a typed 1024x1024 scene model, a strict SVG serializer/parser with an explicit tag/attribute allowlist, and deterministic PNG rasterization using the vendored DejaVu Sans 2.37 font with system fonts disabled. The local `scene-demo` contains a stem, legend, and four labeled option boxes; it is preview infrastructure, not a puzzle family renderer. Preview outputs default to `data/previews/` and are ignored by Git. The full contract and font hashes are recorded in [docs/PROGRESS.md](docs/PROGRESS.md#p10-safe-svg-scene-pinned-font-and-png-preview-infrastructure--2026-11-04).

## Scope of P01-P25

P01 provides toolchain bootstrap: pinned runtime and dependencies, strict TypeScript, linting, tests with the network guard, build output, side-effect-free CLI help, and acceptance documentation in [docs/PROGRESS.md](docs/PROGRESS.md). P02 adds strict shared plan/candidate/run schemas, deterministic full and smoke slot planning, SHA-256-derived independent streams, a hash-counter PRNG with golden vectors, and offline `--dry-run` output. P03 adds transactional SQLite storage for runs, slots, stage results, artifacts, and events, with migrations, writer exclusion, content addressing, and rollback-safe checkpoints. P04-P09 add shared family contracts and the five formal text engines (ranking, matching, scheduling, truth, arithmetic). P10 adds safe scene/SVG/PNG preview infrastructure. P11 adds the matrix formal engine with explicit XOR, one-bit options, and glyph/transpose canonicalization. P12 adds the matrix SVG/PNG renderer with a 3x3 stem, missing-cell marker, glyph legend, A-D tiles, critical-group validation, and matrix previews. P13 adds the transforms formal engine with exact D4 coordinate maps, connected orbit-gated sources, ordered one/two-step sequences, orbit-based options, and frame-conjugated canonicalization. P14 adds the transforms renderer with fixed-scale 5x5 grids, center pivots, top orientation markers, ordered operation arrows/axis cards, a viewer-relative axis legend, and critical-pixel evidence. P15 adds the paths formal engine with a connected 4x4 tree, marked endpoints, independent BFS route recovery, full-grid false-route enumeration, and D4/translation-normalized topology fingerprints. P16 adds the paths renderer with one explicit wall convention, identical mazes and S/G markers in all choices, highlighted routes painted under walls, blocked-edge negatives, and 512-pixel grayscale checks. P17 adds the symmetry formal engine with explicit known/unknown/empty states, vertical/horizontal axes, direct forced reflection proofs, three missing-half distractors, and axis-preserving canonicalization. P18 adds the symmetry renderer with a visibly unknown gray half, dashed labeled red axis, identical known half in all choices, full completion tiles, state legend, and 512-pixel contrast checks. P19 adds the counting formal engine with a 5x5 universe, two or three connected named shapes, membership-mask enumeration, independent set/inclusion-exclusion counts, four query operations, four numeric choices, and D4 plus shape-ID canonicalization. P20 adds the counting renderer with a fixed 5x5 membership grid, filled/outlined square/circle/triangle markers, an all-overlap legend, the exact query, four numeric choices, the final complete registry gate, and `src/domain/spec.ts` as a strict ten-family spec union. P21 adds `src/validation/fingerprints.ts` and `src/validation/duplicates.ts`: separate content/spec/structure/render hashes, reduced-core structural features, the one-feature-edit near policy, deterministic lowest-ordinal ownership across lanes, early-failure diagnostics, and immutable assessments. P22 adds `src/presentation/wording.ts`, `src/presentation/assemble.ts`, `src/validation/presentation.ts`, and `src/domain/presentation.ts`: the strict wording schema, code-owned rules/targets/options, text clue-fact coverage, explanation-reference checks, a reveal-free `VisiblePresentation`, separate key/hint/explanation/proof reveal data, stored SVG/PNG hashes, and `semantic_alignment_pending` instead of an automatic semantic pass. P23 adds `src/storage/migrations/0002_requests.sql`, `src/ai/ledger.ts`, and `src/ai/budget.ts`: durable logical-call/attempt state machines, unique nullable slot/probe keys, decimal money, transactional reservations, settlement, unknown exposure, append-only budget events, paused-budget/overshoot handling, and separate primary/smoke/calibration/preflight accounting. P24 adds `src/ai/openrouter.ts`, `src/ai/retry.ts`, `src/ai/redact.ts`, and a local fake server: non-streaming fetch, deadline/byte caps, raw-response persistence before validation, credential redaction, top-level/choice error inspection, strict finish reasons, allowlisted 429/no-provider retries with Retry-After, and bounded generation-ID usage reconciliation. P25 adds `src/ai/schemas.ts`, `src/ai/config.ts`, `src/ai/preflight.ts`, `src/cli/preflight.ts`, `tests/ai/preflight.test.ts`, and `tests/fixtures/openrouter/catalog.json`: strict provider schemas for all families and review roles, explicit live inputs with role separation, exact endpoint-tag/cap/context/pricing checks, offline fixtures, and authorization-gated live probe construction that P25 never executes. Paid requests, provider fallback, JSON repair, model selection, live probes, reports, and the gallery remain out of scope until their own phases.

