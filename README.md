# AI Puzzle Factory

Auditable, offline-first proof-of-concept for generating short English multiple-choice puzzles. The normative specification is [AI_PUZZLE_FACTORY_EXPERIMENT_PLAN.md](AI_PUZZLE_FACTORY_EXPERIMENT_PLAN.md); this repository currently implements **P01, the reproducible offline toolchain**, and **P02, deterministic domain schemas and slot planning**, and nothing else.

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

## Scope of P01 and P02

P01 provides toolchain bootstrap: pinned runtime and dependencies, strict TypeScript, linting, tests with the network guard, build output, side-effect-free CLI help, and acceptance documentation in [docs/PROGRESS.md](docs/PROGRESS.md). P02 adds strict shared plan/candidate/run schemas, deterministic full and smoke slot planning, SHA-256-derived independent streams, a hash-counter PRNG with golden vectors, and offline `--dry-run` output. Puzzles, persistence, provider calls, rendering, reports, and the gallery remain out of scope until their own phases.
