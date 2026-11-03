# Implementation Progress

This file records implemented phases, exact verification commands, observed results, and manual acceptance evidence. It is not evidence of live or human-validated results.

## P01. Reproducible Offline Toolchain — 2026-11-03

**State:** implemented, offline-verified, accepted by the user on 2026-11-03. No live or paid behavior exists in this phase.

**Environment recorded for this evidence**

- OS: Ubuntu 22.04.5 LTS, Linux 6.18.54.1-microsoft-standard-WSL2 x86_64
- Node.js: v24.22.2 (installed through nvm; pinned in `.nvmrc`)
- npm: 11.19.1
- Pinned dependency versions are in `package.json`/`package-lock.json` without caret ranges.

**Files**

- Toolchain: `package.json`, `package-lock.json`, `.nvmrc`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.mjs`, `vitest.config.ts`
- CLI: `src/cli/experiment.ts` (help only; side-effect-free import)
- Tests: `tests/setup.ts` (network guard), `tests/bootstrap.test.ts`
- Documentation: `README.md`, `docs/PROGRESS.md`
- `.gitignore`: appended ignores for node_modules, build/test output, generated data, logs, and secrets; existing entries preserved

**Observable behavior**

- `npm run experiment -- --help` prints usage, the P01 scope note, and exits 0.
- Invoking the CLI without a mode, or with an unknown flag, prints an explicit error and exits non-zero.
- Importing `src/cli/experiment.ts` neither creates `data/` nor performs fetch/HTTP/HTTPS/net.connect calls (child-process probe).
- Vitest installs a global guard at the socket layer (`net.Socket.prototype.connect`) plus fetch and default-export HTTP(S) wrappers: non-loopback connections are denied, loopback targets are denied until registered with `allowLocalFake()`, and redirects, named ESM imports, and raw sockets are covered.
- `npm run check` performs lint, typecheck, unit tests, and build without an API key or network access.
- The built ESM entry point `dist/cli/experiment.js` runs directly under Node with correct `.js` specifiers.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm ci` | exit 0; 136 packages installed from the lockfile. npm reported 11 moderate advisories in the development dependency tree and a warning that esbuild's postinstall is not covered by `allowScripts`; install, tests, and build still completed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 1 file / 12 tests passed, build succeeded. |
| `npm exec vitest run tests/bootstrap.test.ts` | exit 0; 12 tests passed: guard denies non-loopback, unregistered loopback, redirect hops, named-import HTTP, and raw sockets; registered local fake works; CLI help/flags/import probe behave as documented. |
| `npm run experiment -- --help` | exit 0; help lists only `--help` plus the P01 scope note. |
| `node dist/cli/experiment.js --help` | exit 0. |
| `node dist/cli/experiment.js` | exit 1; stderr: `no experiment execution mode is implemented yet; only --help is available in P01`. |
| `npm run experiment -- --not-an-experiment-option` | exit non-zero; stderr contains `unknown option`. |

**Manual acceptance steps**

1. With Node 24.22.2 active (`nvm use`), run `npm ci` in a clean checkout. It must complete without an `.env` file or API key.
2. Run `npm run check`. It must finish successfully without contacting a remote host; only the repository's toolchain files and ignored build output (`dist/`, `node_modules/`) appear.
3. Run `npm run experiment -- --help`. The help must show only `--help` and state that manifests, generation, persistence, and paid execution arrive in later phases.
4. Run `npm run experiment` with no arguments. It must fail explicitly instead of starting any work.

**Out of scope, unchanged:** manifests, slot planning, puzzles, persistence, API/provider calls, rendering, reports, gallery.

## P02. Domain Schemas, Seed Streams, and Slot Planner — 2026-11-03

**State:** implemented, offline-verified, accepted by the user on 2026-11-03. No generation, persistence, provider call, rendering, or paid behavior exists in this phase.

**Files**

- Domain schemas: `src/domain/experiment.ts` (families, lanes, quotas, difficulty tuples, `PlanManifest`, fixed thresholds, `RunManifest`), `src/domain/candidate.ts` (stage, verdict, run-control, failure enums and generic candidate/stage envelopes)
- Determinism: `src/util/random.ts` (SHA-256 stream derivation, hash-counter PRNG, unbiased bounded integers, seeded shuffle), `src/util/hash.ts` (canonical JSON and content hashing)
- Planner: `src/experiment/planner.ts` (full/smoke slot construction, quotas, difficulty counts, request ceilings, canonical plan hash, serialization)
- CLI: `src/cli/experiment.ts` (adds `--dry-run`, `--full`/`--smoke`, `--mock`/`--live`, `--seed`, conflict rejection)
- Tests: `tests/experiment/planner.test.ts`; updated `tests/bootstrap.test.ts` for the P02 help surface
- Documentation: `docs/experiment-protocol.md`, `README.md`, this file

**Observable behavior**

- `npm run experiment -- --dry-run --seed puzzle-poc-v1` prints a strict 200-slot `PlanManifest` and exits 0, with no data directory, database write, model call, image rendering, or network access.
- Full quotas: 200 slots, 100 text, 100 SVG, 120 `spec_first`, 80 `ai_spec`, 20 per family, text 10/10 and SVG 14/6 per lane.
- Full difficulty tuples: text `spec_first` (4,3,3), text `ai_spec` (3,4,3), SVG `spec_first` (5,5,4), SVG `ai_spec` (2,2,2); every family totals (7,7,6).
- Full request ceilings: spec 80, wording 200, blind_text 100, blind_vision 100, alignment_text 100, alignment_vision 100, total 680 logical calls, 2040 maximum transport attempts.
- Smoke: 20 slots, 10 text/10 SVG, 10 `spec_first`/10 `ai_spec`, one slot per family and lane, 70 logical calls, 210 maximum transport attempts.
- The full plan with root seed `puzzle-poc-v1` has canonical plan hash `e7dbe198a948731eb4fd5b030a5d30dcf96aa8b7dfa639cbb6a5f38c4226e273`.
- Repeating the same run kind and seed yields identical output; different purposes, slots, or root seeds derive different 32-byte stream seeds.
- `--full --smoke`, `--mock --live`, `--live`, and a run without `--dry-run` fail explicitly with non-zero exit status.
- `RunManifest` rejects shared generator/reviewer models, mock evidence without a synthetic configuration, live evidence with a mock configuration, extra fields, and a `manifestHash` that does not match the canonical redacted manifest. Candidate envelopes require a verdict only at `terminal`; stage envelopes pair `finishedAt` with `elapsedMs`.
- Root seeds are fixed per run kind; `--seed` may only restate the matching value. The reserved `puzzle-calibration-v1` seed is rejected for full and smoke plans by both the builder and `PlanManifestSchema`.
- `PlanManifestSchema` recomputes and verifies `planHash`; `RunManifestSchema` recomputes and verifies `manifestHash` over the canonical redacted manifest.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec vitest run tests/experiment/planner.test.ts` | exit 0; 21 tests passed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 2 files / 33 tests passed, build succeeded. |
| `npm run experiment -- --dry-run --seed puzzle-poc-v1` | exit 0; 200-slot manifest printed (npm banner included on stdout). |
| `npm run --silent experiment -- --dry-run --seed puzzle-poc-v1` | exit 0; pure JSON suitable for piping. |
| `npm run experiment -- --dry-run --smoke` | exit 0; 20 slots, `puzzle-smoke-v1`, 70 logical calls, 210 maximum attempts. |
| `npm run experiment -- --dry-run --full --smoke` | exit 1; `--full and --smoke are mutually exclusive`. |
| `npm run experiment -- --dry-run --mock --live` | exit 1; `--mock and --live are mutually exclusive`. |
| `npm run experiment -- --dry-run --live` | exit 1; live execution is not implemented. |
| `npm run experiment -- --seed puzzle-poc-v1` | exit 1; only `--dry-run` is implemented. |
| `npm run experiment -- --dry-run --seed puzzle-calibration-v1` | exit 1; root seed for full plans is fixed to `puzzle-poc-v1`. |
| `npm run experiment -- --dry-run --smoke --seed puzzle-poc-v1` | exit 1; root seed for smoke plans is fixed to `puzzle-smoke-v1`. |

**Manual acceptance steps**

1. With Node 24.22.2 active, run `npm run experiment -- --dry-run --seed puzzle-poc-v1` and inspect the JSON: 200 slots, 100 text, 100 SVG, 120 `spec_first`, 80 `ai_spec`, 20 per family, text 10/10, SVG 14/6.
2. Confirm every family's difficulty totals are (7,7,6), both lanes cover all difficulties, and the request estimate is 680 total with 2040 maximum transport attempts.
3. Run the same command again and confirm identical output and plan hash.
4. Run `npm run experiment -- --dry-run --smoke` and confirm 20 slots, 10/10 text/SVG, 10/10 lanes, one slot per family and lane, 70 total calls, 210 maximum attempts.
5. Confirm no `data/` directory, database file, generated puzzle, or image was created.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm run --silent experiment -- --dry-run --seed puzzle-poc-v1 > /tmp/p02-full.json
npm run --silent experiment -- --dry-run --smoke > /tmp/p02-smoke.json
node -e 'const p=require("/tmp/p02-full.json"); const s=require("/tmp/p02-smoke.json"); if(p.slots.length!==200||p.quotas.textSlots!==100||p.quotas.svgSlots!==100||p.quotas.specFirstSlots!==120||p.quotas.aiSpecSlots!==80) process.exit(1); if(p.requestEstimate.totalLogicalCalls!==680||p.requestEstimate.maxTransportAttempts!==2040) process.exit(2); if(s.slots.length!==20||s.requestEstimate.totalLogicalCalls!==70||s.requestEstimate.maxTransportAttempts!==210) process.exit(3); if(p.planHash!=="e7dbe198a948731eb4fd5b030a5d30dcf96aa8b7dfa639cbb6a5f38c4226e273") process.exit(4); console.log("P02 plan checks passed")'
test ! -d data && echo "no data directory"
npm run check
```

Expected: `P02 plan checks passed`, `no data directory`, and `npm run check` exit 0 with 33 tests.

**Out of scope, unchanged:** family implementations, puzzle generation, persistence, API/provider calls, rendering, reports, gallery, calibration/preflight manifests.
