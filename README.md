# AI Puzzle Factory

Auditable, offline-first proof-of-concept for generating short English multiple-choice puzzles. The normative specification is [AI_PUZZLE_FACTORY_EXPERIMENT_PLAN.md](AI_PUZZLE_FACTORY_EXPERIMENT_PLAN.md); this repository currently implements **P01-P15**: the reproducible offline toolchain, deterministic planning, transactional SQLite storage, the five formal text engines, the matrix formal engine and renderer, the transforms formal engine and renderer, the paths formal engine, and safe scene/PNG preview infrastructure. The remaining visual puzzle renderers, provider calls, reports, and the gallery remain out of scope.

## Requirements

- Node.js **24.22.2** LTS, pinned in [.nvmrc](.nvmrc)
- npm **11.19.1** (bundled with Node 24.22.2)
- No API key and no `.env` file are needed for any implemented command; `npm run check` and the offline `npm run experiment -- --dry-run` make no network calls. The initial `npm ci` needs npm registry access unless the npm cache is already populated.

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

## Safe rendering infrastructure (P10)

P10 adds a typed 1024x1024 scene model, a strict SVG serializer/parser with an explicit tag/attribute allowlist, and deterministic PNG rasterization using the vendored DejaVu Sans 2.37 font with system fonts disabled. The local `scene-demo` contains a stem, legend, and four labeled option boxes; it is preview infrastructure, not a puzzle family renderer. Preview outputs default to `data/previews/` and are ignored by Git. The full contract and font hashes are recorded in [docs/PROGRESS.md](docs/PROGRESS.md#p10-safe-svg-scene-pinned-font-and-png-preview-infrastructure--2026-11-04).

## Scope of P01-P15

P01 provides toolchain bootstrap: pinned runtime and dependencies, strict TypeScript, linting, tests with the network guard, build output, side-effect-free CLI help, and acceptance documentation in [docs/PROGRESS.md](docs/PROGRESS.md). P02 adds strict shared plan/candidate/run schemas, deterministic full and smoke slot planning, SHA-256-derived independent streams, a hash-counter PRNG with golden vectors, and offline `--dry-run` output. P03 adds transactional SQLite storage for runs, slots, stage results, artifacts, and events, with migrations, writer exclusion, content addressing, and rollback-safe checkpoints. P04-P09 add shared family contracts and the five formal text engines (ranking, matching, scheduling, truth, arithmetic). P10 adds safe scene/SVG/PNG preview infrastructure. P11 adds the matrix formal engine with explicit XOR, one-bit options, and glyph/transpose canonicalization. P12 adds the matrix SVG/PNG renderer with a 3x3 stem, missing-cell marker, glyph legend, A-D tiles, critical-group validation, and matrix previews. P13 adds the transforms formal engine with exact D4 coordinate maps, connected orbit-gated sources, ordered one/two-step sequences, orbit-based options, and frame-conjugated canonicalization. P14 adds the transforms renderer with fixed-scale 5x5 grids, center pivots, top orientation markers, ordered operation arrows/axis cards, a viewer-relative axis legend, and critical-pixel evidence. P15 adds the paths formal engine with a connected 4x4 tree, marked endpoints, independent BFS route recovery, full-grid false-route enumeration, and D4/translation-normalized topology fingerprints. Visual family renderers, provider calls, reports, and the gallery remain out of scope until their own phases.

