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

## P03. Transactional Run, Slot, Stage, and Artifact Storage — 2026-11-04

**State:** implemented, offline-verified, accepted by the user on 2026-11-04. No paid calls, runner resume, request/budget tables, or report UI exist in this phase.

**Files**

- Database: `src/storage/database.ts` (open/configure, migrations, transaction helper, writer lock, typed storage errors)
- Repository: `src/storage/repository.ts` (runs, slots, stage results, events, checkpoints, schema validation on read/write)
- Artifacts: `src/storage/artifacts.ts` (content-addressed bounded blobs, integrity checks, safe export paths)
- Migration: `src/storage/migrations/0001_runs.sql`
- Build asset copy: `scripts/copy-assets.mjs`; `package.json` build now copies migrations into `dist/`
- Tests: `tests/storage/checkpoints.test.ts`
- Documentation: `docs/experiment-protocol.md` section 11, `README.md`, this file
- Pinned dependencies: `better-sqlite3` 13.0.3, `@types/better-sqlite3` 9.6.0, `proper-lockfile` 4.1.2, `@types/proper-lockfile` 4.1.4

**Observable behavior**

- `openDatabase` enables WAL, foreign keys, a 5-second busy timeout, and `synchronous = NORMAL`; `migrate` applies `0001_runs.sql` once and is harmless on repeat.
- `createRun` stores the canonical plan manifest, its hash, the run row, all 20/200 slot rows, and a `run_created` event in one transaction. Reopening the database returns the same manifest and slots.
- `insertStageResult` commits the stage result, artifacts, stage-artifact links, the advanced slot checkpoint, and a `stage_committed` event atomically. An injected event failure leaves no stage result, no artifact, no link, and no advanced checkpoint.
- Stage results are immutable: update and delete triggers abort. Duplicate stages, backward stage transitions, invalid terminal verdict placement, and mismatched duration fields are rejected.
- Artifacts are content-addressed by SHA-256, deduplicated by `(content_hash, kind)`, bounded (JSON/raw/request/presentation 2 MiB, SVG 256 KiB, PNG 1 MiB), and verified on read. Stage payloads are also re-hashed on read.
- `proper-lockfile` excludes a competing writer with a 30-second stale timeout and 10-second update; the second writer receives `WRITER_LOCKED`.
- Export paths are accepted only beneath `data/runs/<run-id>/`; traversal, absolute paths, drive letters, backslashes, empty segments, dangling symlinks, symlinked parent components, and symbolic links are rejected.
- The built `dist/storage/database.js` can open a database and apply migrations because the build copies the SQL asset.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec vitest run tests/storage/checkpoints.test.ts` | exit 0; 18 tests passed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 3 files / 51 tests passed, build succeeded. |
| `node --input-type=module -e "import { openDatabase, migrate } from './dist/storage/database.js'; ..."` | exit 0; built runtime opened a temporary SQLite database, applied migrations, and returned `{ c: 1 }`. |
| `ls dist/storage/migrations` | `0001_runs.sql` present after build. |

**Manual acceptance steps**

1. Run `npm exec vitest run tests/storage/checkpoints.test.ts --reporter=verbose` and inspect the named tests: `creates a run atomically and reopens it with unchanged manifest and slots`, `rolls back the stage, artifact, and checkpoint on an injected failure`, `detects a competing writer and allows a new lock after release`, and `is idempotent across repeated migrations`.
2. Confirm the rollback test reports zero stage results, zero artifacts, zero stage-artifact links, and a slot still at `planned` with checkpoint 0 after the injected failure.
3. Run `npm run check` and confirm 51 tests pass and the build copies `dist/storage/migrations/0001_runs.sql`.
4. Confirm no `data/` directory or database file is created by the test suite; tests use temporary directories.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec vitest run tests/storage/checkpoints.test.ts --reporter=verbose
npm run check
test -f dist/storage/migrations/0001_runs.sql && echo "migration asset copied"
test ! -d data && echo "no data directory"
```

Expected: 18 storage tests pass, `npm run check` exits 0 with 51 tests, the migration asset is present, and no `data/` directory exists.

**Out of scope, unchanged:** request/budget tables, paid calls, runner resume, JSON-as-database, report UI, exports, and any live evidence.

## P04. Shared Family Contract, Options, and Canonicalization Primitives — 2026-11-04

**State:** implemented, offline-verified. No real family engine, renderer, model call, persistence change, or paid behavior exists in this phase. The production registry is intentionally empty.

**Files**

- Contracts: `src/families/contracts.ts` (`FamilyEngine`, `VisibleRules`, fact namespaces and fixed rule IDs, `SolveResult`, strict `CanonicalStructure` schema, D4 operation vocabulary)
- Canonicalization: `src/families/canonicalize.ts` (stable serialization and selection, feature extraction, multiset Jaccard/edit arithmetic, bounded permutation/cartesian enumeration, search counters, bitsets, reduced clue core)
- Registry: `src/families/registry.ts` (separate formal-engine and renderer maps, duplicate/invalid registration rejection, completeness gate)
- Options: `src/domain/answers.ts` (deep equality, exactly four choices, seeded A-D shuffle, value-derived correct label, strict choice-set schema)
- Tests: `tests/families/contracts.test.ts`
- Documentation: `docs/families.md`, this file

**Observable behavior**

- `CanonicalStructure` is a strict object with sorted `domainTokens`, `queryTokens`, `relationTokens`, and `geometryTokens`; family/query-kind mismatches, prose tokens, unsorted arrays, extra fields, malformed family tokens, arbitrary transform operations, and wrong matrix/counting geometry counts are rejected. Integer-valued token fields use one canonical decimal spelling, so padded values such as `at:00:01`, `k=02`, and `op00` are rejected. Counting region counts must agree with the membership geometry, and all 25 grid cells must appear exactly once.
- Feature extraction emits only `q:`, `r:`, and `g:` tokens; family/domain metadata is omitted. Multiset arithmetic reports exact removed/added counts, edit distance, intersection, union, Jaccard, and common-feature count. The mandatory counting pair (exactly two versus exactly three memberships) yields edit distance 1 and Jaccard 33/35.
- `SearchCounter` throws `SOLVER_LIMIT` at the exact cap; permutation and cartesian enumerators report `complete: false` when a collection cap stops them. `Bitset` supports finite-domain set operations.
- `reduceClueCore` canonicalizes the input, verifies a unique baseline, removes clues in reverse lexicographic order only when the independent solver still returns the same single answer, canonicalizes the retained core again, and reports removed indices/keys and evaluation count.
- `makeChoiceSet` returns exactly four A-D choices with deeply distinct values, a deterministic seeded order, and a correct label recomputed by deep value equality. Fewer/more than three distractors and duplicate values are rejected.
- Fact IDs are namespaced: local `fNNN`, SVG observation `pNNN`, derived proof `sNNN`, and fixed rule IDs `r-domain`, `r-closed`, `r-target`, `r-operations`, `r-conventions`. Merging rejects duplicate IDs and namespace mismatches; reference and local-clue coverage checks reject unknown or missing facts.
- The test-only engine demonstrates that a generated spec carries no hidden witness, a tampered spec is re-solved rather than trusted, relabeled witnesses share one canonical structure, duplicate/redundant clues do not create novelty, and a genuinely different structure does.
- Formal engines and renderers are registered separately; duplicate registrations, wrong family/modality pairs, schemas without a `parse` function, missing engine methods, text renderers, and unknown families are rejected. Registering an engine and a renderer for the same SVG family is allowed.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec vitest run tests/families/contracts.test.ts` | exit 0; 34 tests passed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 4 files / 85 tests passed, build succeeded. |

**Manual acceptance steps**

1. Run `npm exec vitest run tests/families/contracts.test.ts --reporter=verbose` and inspect the named tests `keeps the hidden witness out of the spec and re-solves tampered specs`, `canonicalizes relabelings, ignores redundant clues, and separates different structures`, `reproduces the mandatory counting one-edit pair as 33/35`, `rejects non-canonical integer spellings and inconsistent counting region counts`, and `rejects duplicate, missing, and three-choice option sets`.
2. Confirm the tampered-spec test reports a non-unique solution with no correct answer, proving the engine did not reuse a hidden witness.
3. Confirm the counting-pair test reports edit distance 1 and Jaccard 33/35, and that duplicate/redundant clues leave the canonical structure unchanged.
4. Run `npm run check` and confirm 85 tests pass with no API key or network access.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec vitest run tests/families/contracts.test.ts --reporter=verbose
npm exec tsx -- -e 'import { makeChoiceSet } from "./src/domain/answers.ts"; import { CanonicalStructureSchema } from "./src/families/contracts.ts"; const set=makeChoiceSet({correct:"x",distractors:["a","b","c"],seed:"0".repeat(64)}); if(set.choices.length!==4||set.choices.map((choice)=>choice.label).join("")!=="ABCD") process.exit(1); const structure={version:1,family:"ranking",domainTokens:["size=4"],queryKind:"full_order",queryTokens:[],relationTokens:["at:0:1","before:0:1","immediatelyBefore:1:2"],geometryTokens:[]}; if(!CanonicalStructureSchema.safeParse(structure).success) process.exit(2); console.log("P04 choice and canonical-schema checks passed")'
npm run check
```

Expected: 34 focused tests pass, `P04 choice and canonical-schema checks passed`, and `npm run check` exits 0 with 85 tests.

**Out of scope, unchanged:** real family engines, renderers, scene/PNG output, persistence changes, model calls, duplicate barrier, reports, gallery, and any live evidence.

## P05. Ranking Engine — 2026-11-04

**State:** implemented, offline-verified. Ranking is the only real family engine registered in the production registry. No model call, renderer, matching, scheduling, AI wording, or gallery exists in this phase.

**Files**

- Schema/DSL: `src/families/ranking/schema.ts`
- Construction/solver/options/rules/facts/mutations: `src/families/ranking/engine.ts`
- Reduced structural canonicalization: `src/families/ranking/canonical.ts`
- Tests: `tests/families/ranking.test.ts`
- Registry: `src/families/registry.ts` now registers only `rankingEngine`
- Documentation: `docs/families.md`, this file

**Observable behavior**

- The DSL accepts `size` 4 or 5 and 3-12 clues from `before`, `immediatelyBefore`, `at`, and `notAt`. Item IDs stay inside `0..size-1`, positions inside `1..size`, and self-relations are rejected. Visible labels are A-E; local facts are `f001` onward in stored clue order and cannot be supplied by the spec.
- `constructRankingSpec` chooses a hidden witness, samples 3-7 true non-anchor clues, adds at most five true `at` anchors until unique, and at levels 2-3 removes half/all greedy redundant clues in seeded order while retaining at least three clues. It uses at most 64 deterministic draws and returns a trace with requested/added anchors and pruning counts. The returned spec contains only `size` and `clues`.
- `enumerateSolutions` independently checks all 24 size-4 or 120 size-5 permutations and requires one full order. Unique results map to labels A-E and carry one derived `s001` proof fact; impossible cycles and missing-essential-clue ambiguity carry no correct answer or proof.
- `makeOptions` requires a unique satisfying answer, enumerates all other full orders, prefers distractors violating one or two clues, fills from higher-violation orders if needed, shuffles four code-owned A-D choices, and independently verifies that exactly one choice satisfies the spec. Option values are complete label sequences A-E.
- `visibleRules` supplies code-owned English domain, closed-world, target, four operations, and position/option conventions. `facts` supplies one local fact per clue with the code-owned clue template.
- `canonicalData` applies the reduced-core proxy, canonicalizes over item relabelings, preserves position constants/direction/adjacency/size, and emits sorted typed tokens (`before:a:b`, `immediatelyBefore:a:b`, `at:a:p`, `notAt:a:p`). It does not hash only the final permutation.
- The deterministic fixture seed `aeb49822e3461e54471ff52b50a0e08d2e338d08a47428f1b5f8a21c6a4ac8cd` at level 1 produces size 4, six clues, trace `{nonAnchorRequested:4, nonAnchorAdded:4, anchorsAdded:2, prunedClues:0, drawsUsed:11}`, unique order `B C A D`, and options with correct label C.
- The 100 fixed construction seeds produced 34/33/33 successes for levels 1/2/3, zero failures, and every success was independently solved and verified.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec vitest run tests/families/ranking.test.ts` | exit 0; 15 tests passed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 5 files / 100 tests passed, build succeeded. |

**Manual acceptance steps**

1. Run `npm exec vitest run tests/families/ranking.test.ts --reporter=verbose` and inspect `solves an explicit unique order with one full answer and a derived proof`, `returns an unsatisfiable result for an impossible cycle`, `reports ambiguity when an essential clue is missing`, `treats immediatelyBefore as the next position and positions as 1-based`, `builds four full-order choices...`, `canonicalizes item relabelings...`, and `constructs at least 95 of 100 fixed seeds...`.
2. Run the exact script below. Inspect the printed deterministic fixture: the English rules, six local facts, unique order `B C A D`, four complete orders, and correct label `C`.
3. Confirm the impossible cycle yields zero solutions, the ambiguity fixture yields more than one, and adjacency/position fixtures yield one full order.
4. Run `npm run check` and confirm 100 tests pass without an API key or network access.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec vitest run tests/families/ranking.test.ts --reporter=verbose
npm exec tsx -- -e 'import { constructRankingSpec, rankingEngine } from "./src/families/ranking/engine.ts"; const seed="aeb49822e3461e54471ff52b50a0e08d2e338d08a47428f1b5f8a21c6a4ac8cd"; const {spec,trace}=constructRankingSpec(seed,1); const result=rankingEngine.enumerateSolutions(spec); const options=rankingEngine.makeOptions(spec,result.correctAnswer,"0".repeat(64)); if(result.solutionCount!==1||JSON.stringify(result.correctAnswer)!==JSON.stringify(["B","C","A","D"])||options.correctLabel!=="C") process.exit(1); console.log(JSON.stringify({spec,trace,rules:rankingEngine.visibleRules(spec),facts:rankingEngine.facts(spec),solution:result.correctAnswer,options},null,2));'
npm run check
```

Expected: 15 focused tests pass, the fixture prints the rules/facts/solution/options described above, and `npm run check` exits 0 with 100 tests.

**Out of scope, unchanged:** matching, scheduling, truth, arithmetic, visual families, AI wording, renderers, gallery, duplicate barrier, reports, and any live evidence.

## P06. Attribute-Matching Engine — 2026-11-04

**State:** implemented, offline-verified. Matching is the second real text engine registered in the production registry. No model call, renderer, visual layout, or report exists in this phase.

**Files**

- Schema/DSL/table/solver helpers: `src/families/matching/schema.ts`
- Construction/options/rules/facts/mutations: `src/families/matching/engine.ts`
- 24-cubed canonicalization: `src/families/matching/canonical.ts`
- Tests: `tests/families/matching.test.ts`
- Registry: `src/families/registry.ts` now registers ranking and matching
- Documentation: `docs/families.md`, this file

**Observable behavior**

- The DSL has typed categories A/B/C with four items each and 4-12 cross-category `same`/`different` clues. Item IDs stay inside `0..3`; same-category clues, exact duplicates, and same-pair contradictions are rejected with explicit schema issues. Local facts are `f001` onward in stored clue order.
- The answer is a complete four-row table ordered by A item, using every A, B, and C item exactly once. `enumerateSolutions` scans all 576 B/C bijection assignments, evaluates A-B, A-C, and B-C clues, and requires one full table. Unique results carry one derived `s001` proof fact; unsat and ambiguous results carry no answer or proof.
- `constructMatchingSpec` chooses two witness permutations and six anchors, adds one true B-C same clue, one true B-C different clue, and 2-4 other true clues, for 10-12 initial clues. It then removes redundant clues in seeded order to floors 8/6/4 for levels 1/2/3. It uses at most 64 draws and returns a trace with anchor, cross-category, additional, pruning, and draw counts.
- `makeOptions` requires the unique table, scans the 576-table domain, prefers false tables reachable by one or two bijection swaps, fills from higher-swap tables if needed, and verifies that all four choices are complete tables with exactly one satisfying choice.
- `visibleRules` explicitly states that every A, B, and C item is used once and rows are ordered A1-A4. `facts` uses code-owned `same`/`different` templates.
- `canonicalData` applies `reduceClueCore`, then minimizes the retained signed, category-typed relation graph over 24^3 = 13,824 independent item relabelings across the three categories. Signs and category roles are preserved; textual labels and row order are removed.
- The deterministic fixture seed `ff4313c712da399a023d175e1b951eef819fd6603a35d443db0a38297739a060` at level 1 produces 8 clues, trace `{anchorCount:6, crossCategoryAdded:2, additionalRequested:6, additionalAdded:6, prunedClues:4, clueCountBeforePruning:12, clueCountAfterPruning:8, drawsUsed:24}`, unique table A1-B2-C3 / A2-B3-C2 / A3-B1-C4 / A4-B4-C1, and options with correct label C.
- The 100 fixed construction seeds produced 34/33/33 successes for levels 1/2/3, zero failures, and every success was independently solved and verified.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec vitest run tests/families/matching.test.ts` | exit 0; 15 tests passed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 6 files / 115 tests passed, build succeeded. |

**Manual acceptance steps**

1. Run `npm exec vitest run tests/families/matching.test.ts --reporter=verbose` and inspect `enumerates the 576-table domain and requires one complete table`, `returns unsatisfiable and ambiguous full-table results`, `uses signed cross-category B-C facts in the solver`, `builds four complete tables, prefers one/two swaps, and validates the key`, `canonicalizes independent relabelings across all three categories`, and `constructs at least 95 of 100 fixed seeds with independent uniqueness`.
2. Run the exact script below. Inspect the printed deterministic fixture: eight English facts, the unique four-row table, four complete choices, and correct label C.
3. Confirm every option table uses each A, B, and C item exactly once, and that only the labeled correct table satisfies all eight clues.
4. Run `npm run check` and confirm 115 tests pass without an API key or network access.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec vitest run tests/families/matching.test.ts --reporter=verbose
npm exec tsx -- -e 'import { constructMatchingSpec, matchingEngine } from "./src/families/matching/engine.ts"; const seed="ff4313c712da399a023d175e1b951eef819fd6603a35d443db0a38297739a060"; const {spec,trace}=constructMatchingSpec(seed,1); const result=matchingEngine.enumerateSolutions(spec); const options=matchingEngine.makeOptions(spec,result.correctAnswer,"0".repeat(64)); const expected=[{a:0,b:1,c:2},{a:1,b:2,c:1},{a:2,b:0,c:3},{a:3,b:3,c:0}]; if(result.solutionCount!==1||JSON.stringify(result.correctAnswer)!==JSON.stringify(expected)||options.correctLabel!=="C") process.exit(1); console.log(JSON.stringify({spec,trace,rules:matchingEngine.visibleRules(spec),facts:matchingEngine.facts(spec),solution:result.correctAnswer,options},null,2));'
npm run check
```

Expected: 15 focused tests pass, the fixture prints the rules/facts/unique table/options described above, and `npm run check` exits 0 with 115 tests.

**Out of scope, unchanged:** scheduling, truth, arithmetic, visual families, AI wording, renderers, gallery, duplicate barrier, reports, and any live evidence.

## P07. Scheduling/Placement Engine — 2026-11-04

**State:** implemented, offline-verified. Scheduling is the third real text engine registered in the production registry. No model call, renderer, calendar, duration, or timezone behavior exists in this phase.

**Files**

- Schema/DSL/table/solver helpers: `src/families/scheduling/schema.ts`
- Construction/options/rules/facts/mutations: `src/families/scheduling/engine.ts`
- 4! x 2! canonicalization: `src/families/scheduling/canonical.ts`
- Tests: `tests/families/scheduling.test.ts`
- Registry: `src/families/registry.ts` now registers ranking, matching, and scheduling
- Documentation: `docs/families.md`, this file

**Observable behavior**

- The DSL has four events, four ordered consecutive slots, and two capacity-2 resources. It accepts 4-12 typed clues from `at`, `notAt`, `before`, `immediatelyBefore`, `usesResource`, and `notResource`. Self order-relations, exact duplicates, and same-pair time/resource contradictions are rejected. Local facts are `f001` onward in stored clue order.
- The answer is a complete four-row table ordered by event, using every slot once and each resource exactly twice. `enumerateSolutions` independently enumerates 144 schedules (24 orders x 6 resource choices) and evaluates both temporal and resource predicates. Unique results carry one derived `s001` proof fact.
- `constructSchedulingSpec` chooses a witness order and resource choice. A three-fact `before` chain plus three true resource facts forms a unique six-fact anchor. It adds one temporal, one resource, and 2-4 other true clues, for 10-12 initial clues, then prunes redundant clues in seeded order to floors 8/6/4 for levels 1/2/3. It uses at most 64 draws and returns a trace with anchor, temporal/resource, additional, pruning, and draw counts.
- `makeOptions` requires the unique schedule and selects three false choices from the remaining 143 legal schedules. Every choice remains a legal full schedule with capacity-two resources; exactly one choice satisfies all clues.
- `visibleRules` includes fixed slots, capacity-2 resources, all six operations, and row-order conventions. `facts` uses code-owned event/slot/resource templates.
- `canonicalData` applies `reduceClueCore`, then minimizes the retained typed event/slot/resource graph over 4! x 2! = 48 relabelings. Ordered slot positions and the capacity vector are preserved.
- Removing a necessary resource fact from the unique fixture creates two complete schedules; it no longer passes even though the time order stays unique.
- The deterministic fixture seed `a2e13ce5ef5cba0e26fc056304ba4a6d0c552d61636b90c006238feeb12426ce` at level 1 produces 8 clues, trace `{anchorCount:6, temporalAdded:1, resourceAdded:1, additionalRequested:6, additionalAdded:6, prunedClues:4, clueCountBeforePruning:12, clueCountAfterPruning:8, drawsUsed:23}`, unique schedule E1-slot3-R1 / E2-slot1-R2 / E3-slot2-R2 / E4-slot4-R1, and options with correct label C.
- The 100 fixed construction seeds produced 34/33/33 successes for levels 1/2/3, zero failures, and every success was independently solved and verified.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec vitest run tests/families/scheduling.test.ts` | exit 0; 17 tests passed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 7 files / 132 tests passed, build succeeded. |

**Manual acceptance steps**

1. Run `npm exec vitest run tests/families/scheduling.test.ts --reporter=verbose` and inspect `enumerates the 144-schedule domain and requires one full schedule`, `detects resource-only ambiguity and temporal contradiction`, `detects a second complete schedule when a necessary resource fact is removed`, `builds four legal schedules, keeps capacity, and validates the key`, `canonicalizes independent event and resource relabelings`, and `constructs at least 95 of 100 fixed seeds with independent uniqueness`.
2. Run the exact script below. Inspect the printed deterministic fixture: eight English facts, the unique full schedule, four legal complete choices, and correct label C.
3. Confirm every option uses every slot once and each resource exactly twice, and that only the labeled correct table satisfies all eight clues.
4. Run `npm run check` and confirm 132 tests pass without an API key or network access.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec vitest run tests/families/scheduling.test.ts --reporter=verbose
npm exec tsx -- -e 'import { constructSchedulingSpec, schedulingEngine } from "./src/families/scheduling/engine.ts"; const seed="a2e13ce5ef5cba0e26fc056304ba4a6d0c552d61636b90c006238feeb12426ce"; const {spec,trace}=constructSchedulingSpec(seed,1); const result=schedulingEngine.enumerateSolutions(spec); const options=schedulingEngine.makeOptions(spec,result.correctAnswer,"0".repeat(64)); const expected=[{event:0,slot:3,resource:0},{event:1,slot:1,resource:1},{event:2,slot:2,resource:1},{event:3,slot:4,resource:0}]; if(result.solutionCount!==1||JSON.stringify(result.correctAnswer)!==JSON.stringify(expected)||options.correctLabel!=="C") process.exit(1); console.log(JSON.stringify({spec,trace,rules:schedulingEngine.visibleRules(spec),facts:schedulingEngine.facts(spec),solution:result.correctAnswer,options},null,2));'
npm run check
```

Expected: 17 focused tests pass, the fixture prints the rules/facts/unique schedule/options described above, and `npm run check` exits 0 with 132 tests.

**Out of scope, unchanged:** truth, arithmetic, visual families, AI wording, renderers, general calendars, durations, timezone handling, gallery, reports, and any live evidence.

## P08. Truth-Value Engine — 2026-11-04

**State:** implemented, offline-verified. Truth is the fourth real text engine registered in the production registry. No model call, renderer, English truth statements, or recursive proof system exists in this phase.

**Files**

- Schema/AST/pool/solver helpers: `src/families/truth/schema.ts`
- Construction/options/rules/facts/mutations: `src/families/truth/engine.ts`
- Speaker-linked reduced-core canonicalization: `src/families/truth/canonical.ts`
- Tests: `tests/families/truth.test.ts`
- Shared schema adjustment: `src/families/contracts.ts` now permits a reduced truth speaker subset in internal fingerprints while the DSL still requires one statement per person
- Registry: `src/families/registry.ts` now registers ranking, matching, scheduling, and truth
- Documentation: `docs/families.md`, this file

**Observable behavior**

- The DSL has three people at level 1 and four at levels 2-3, one typed statement AST per person, and a visible `exactTruthful` in `1..N-1`. AST leaves are `truthful(personId)`; operators are `not`, `and`, `or`, `xor`; each statement is limited to depth 2, three leaves, and seven nodes. Foreign AST kinds, oversized ASTs, out-of-population leaves, wrong statement counts, and invalid counts are rejected before evaluation.
- `enumerateSolutions` scans all 2^N <= 16 assignments, evaluates ASTs recursively, requires `T[i] === evaluate(statement[i], T)` for every person and the exact truthful count, and returns one complete T/F vector only when unique. XOR means exactly one operand is true.
- `constructTruthSpec` chooses a witness with count 1 or N-1, builds a leaf/not cycle that is unique with the count, then tries seeded one-slot binary/XOR enrichment and up to eight full random selections from the finite legal AST pool. Every candidate is independently solved; at most 64 combinations are attempted. The unique anchor is the fallback, so no valid unique system is silently repaired. Level 1 allows at most one binary statement; level 2 allows and/or; level 3 also allows xor.
- `makeOptions` requires the unique vector and selects three false complete T/F vectors. False choices may violate the count or a statement but always list every person; exactly one choice satisfies the spec.
- `visibleRules` states the exact truthful count, truth-teller/liar semantics, all four AST operators, depth/leaf/node limits, and self-reference semantics. `facts` preserves every original statement as `P<i> says: ...`.
- `canonicalData` applies `reduceClueCore` to speaker-linked statement-equivalence predicates, canonicalizes the retained AST/operator graph over person relabelings, sorts commutative operands, preserves negation, population, and exact count. A reduced core may contain fewer than N speaker predicates; the original spec and facts always keep all N statements.
- The deterministic fixture seed `1d515ad30b0e3dfbf5d3aed4a65d25c145b711865a9eed18e9236d92e4593c3b` at level 1 produces 3 people, count 1, pool size 207, one attempt, one binary statement, zero xor statements, three draws, unique vector P1=F / P2=F / P3=T, and options with correct label C.
- The 100 fixed construction seeds produced 34/33/33 successes for levels 1/2/3, population subcounts N=3:34 and N=4:66, zero failures, and every success was independently solved and verified.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec vitest run tests/families/truth.test.ts` | exit 0; 18 tests passed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 8 files / 150 tests passed, build succeeded. |

**Manual acceptance steps**

1. Run `npm exec vitest run tests/families/truth.test.ts --reporter=verbose` and inspect `finds one full truth vector from self-referential statements`, `detects zero and multiple fixed points and exact-count contradictions`, `evaluates exactly-one XOR in a unique vector`, `reduces a tautological statement to an internal subset while facts keep all statements`, `constructs at least 95 of 100 fixed seeds across both populations`, and `keeps the hidden witness out of the generated spec and rejects oversized ASTs before evaluation`.
2. Run the exact script below. Inspect the printed deterministic fixture: the visible exact truthful count, three statements, unique T/F vector, four complete choices, and correct label C.
3. Confirm the displayed rules and count account for every solver assumption and that the oversized/foreign AST tests fail before any evaluation.
4. Run `npm run check` and confirm 150 tests pass without an API key or network access.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec vitest run tests/families/truth.test.ts --reporter=verbose
npm exec tsx -- -e 'import { constructTruthSpec, truthEngine } from "./src/families/truth/engine.ts"; const seed="1d515ad30b0e3dfbf5d3aed4a65d25c145b711865a9eed18e9236d92e4593c3b"; const {spec,trace}=constructTruthSpec(seed,1); const result=truthEngine.enumerateSolutions(spec); const options=truthEngine.makeOptions(spec,result.correctAnswer,"0".repeat(64)); if(result.solutionCount!==1||JSON.stringify(result.correctAnswer)!==JSON.stringify([false,false,true])||options.correctLabel!=="C") process.exit(1); console.log(JSON.stringify({spec,trace,rules:truthEngine.visibleRules(spec),facts:truthEngine.facts(spec),solution:result.correctAnswer,options},null,2));'
npm run check
```

Expected: 18 focused tests pass, the fixture prints the count/statements/unique vector/options described above, and `npm run check` exits 0 with 150 tests.

**Out of scope, unchanged:** arithmetic, visual families, AI wording, renderers, unconstrained English truth statements, recursive proof systems, gallery, reports, and any live evidence.

## P09. Arithmetic-Constraint Engine — 2026-11-04

**State:** implemented, offline-verified. Arithmetic is the fifth and final real text engine registered in the production registry. No model call, renderer, visual family, or approximate numeric solver exists in this phase.

**Files**

- Schema/DSL/tuple solver/normalization helpers: `src/families/arithmetic/schema.ts`
- Construction/options/rules/facts/mutations: `src/families/arithmetic/engine.ts`
- Reduced coefficient-row canonicalization: `src/families/arithmetic/canonical.ts`
- Tests: `tests/families/arithmetic.test.ts`
- Registry: `src/families/registry.ts` now registers all five text engines
- Documentation: `docs/families.md`, this file

**Observable behavior**

- The DSL has x/y/z in `0..12`, 2-5 linear constraints `sum(coeff*var) op constant`, `op` in `eq|lt|le`, coefficients `-3..3` not all zero, constants `-108..108`, and explicit `allDifferent`. No multiplication of variables, division, modulo, implicit precedence, real-valued solutions, or rounding. Local facts use `f001` onward and parenthesize negative coefficients/constants.
- `enumerateSolutions` scans all 2,197 integer tuples, applies exact comparisons and optional pairwise distinctness, and requires one full tuple. Unique results carry one derived `s001` proof fact; no-integer and rank-deficient systems carry no answer or proof.
- `constructArithmeticSpec` chooses a witness and `allDifferent`, builds a shuffled three-equation full-rank anchor with two multi-variable equations and a unit pin equation. Levels 1/2 add two true pin inequalities with coefficient limits 1/2 and prune the pin equation, leaving the inequalities load-bearing. Level 3 uses limit 3 in the multi-variable equations and replaces the pin equation `v=c` by `v<=c` and `-v<=-c`, and rejects a draw with no retained nonredundant inequality. It prunes redundant constraints in seeded order within 2-5, records actual operators, and uses at most 64 draws. It does not claim calibrated difficulty.
- `makeOptions` requires the unique tuple, prefers one-step coordinate perturbations, falls back to the finite 2,197-tuple domain, and verifies exactly one satisfying choice.
- `visibleRules` states the domain, `allDifferent`, exact-integer semantics, and all three operators. `facts` displays every constraint with explicit coefficients and parenthesized negatives.
- `canonicalData` applies `reduceClueCore` to normalized rows. Strict `< c` maps to `<= c-1`; `<=` rows divide by the positive gcd and use `floor(c/g)` without flipping direction; equality rows require divisibility, divide the full row, and make the first nonzero coefficient positive. The retained graph is canonicalized over six variable relabelings. `2*x<11`, `2*x<=11`, and `x<=5` normalize identically without changing visible instructions.
- The deterministic fixture seed `90f786eb2f2e6b10eb05f2e3c1c222ea00199f7ceeaf091a55246c2c23f00932` at level 1 produces `allDifferent=true`, two multi-variable equations plus two load-bearing pin inequalities, x=3 / y=4 / z=11, five constraints before pruning and four after, trace operators `eq,eq,le,le`, two nonredundant inequalities, 14 draws, unique tuple `(3,4,11)`, and options with correct label C.
- The 100 fixed construction seeds produced 34/33/33 successes for levels 1/2/3, zero failures, and every success was independently solved and verified.
- All five text engines are registered; no visual engine or renderer is registered.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec vitest run tests/families/arithmetic.test.ts` | exit 0; 15 tests passed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 9 files / 165 tests passed, build succeeded. |

**Manual acceptance steps**

1. Run `npm exec vitest run tests/families/arithmetic.test.ts --reporter=verbose` and inspect `enumerates all 2,197 tuples and requires one exact integer tuple`, `detects no-integer, rank-deficient, strict-boundary, and allDifferent cases`, `builds four tuples, prefers one-step perturbations, and validates the key`, `normalizes strict/nonstrict inequalities and negative bounds without flipping direction`, `constructs at least 95 of 100 fixed seeds with independent uniqueness`, and `registers all five text engines and no visual stub`.
2. Run the exact script below. Inspect the printed deterministic fixture: the domain/allDifferent rules, four facts, unique tuple, four one-step choices, and correct label C.
3. Confirm the complete bounded search is 2,197 tuples and every choice is checked with exact integer comparisons, never numerical approximation.
4. Run `npm run check` and confirm 165 tests pass without an API key or network access.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec vitest run tests/families/arithmetic.test.ts --reporter=verbose
npm exec tsx -- -e 'import { constructArithmeticSpec, arithmeticEngine } from "./src/families/arithmetic/engine.ts"; const seed="90f786eb2f2e6b10eb05f2e3c1c222ea00199f7ceeaf091a55246c2c23f00932"; const {spec,trace}=constructArithmeticSpec(seed,1); const result=arithmeticEngine.enumerateSolutions(spec); const options=arithmeticEngine.makeOptions(spec,result.correctAnswer,"0".repeat(64)); if(result.solutionCount!==1||JSON.stringify(result.correctAnswer)!==JSON.stringify([3,4,11])||options.correctLabel!=="C") process.exit(1); console.log(JSON.stringify({spec,trace,rules:arithmeticEngine.visibleRules(spec),facts:arithmeticEngine.facts(spec),solution:result.correctAnswer,options},null,2));'
npm run check
```

Expected: 15 focused tests pass, the fixture prints the rules/facts/unique tuple/options described above, and `npm run check` exits 0 with 165 tests.

**Out of scope, unchanged:** visual families, renderers, AI wording, algebra outside the closed linear DSL, gallery, reports, and any live evidence.

## P10. Safe SVG Scene, Pinned Font, and PNG Preview Infrastructure — 2026-11-04

**State:** implemented, offline-verified. This phase adds shared rendering infrastructure only: a safe typed scene, strict SVG serializer/parser, pinned-font PNG rasterization, and a local `scene-demo` preview. No real puzzle family renderer, AI SVG, browser gallery, or report exists.

**Files**

- Scene model, validation, contrast/bounds helpers, demo, preview registry: `src/render/scene.ts`
- Safe SVG serializer and strict parser: `src/render/svg.ts`
- Pinned-font PNG rendering and preview exports: `src/render/png.ts`
- Preview CLI: `src/cli/preview.ts`
- Tests: `tests/render/safety.test.ts`
- Vendored font and license: `assets/fonts/DejaVuSans.ttf`, `assets/fonts/LICENSE.txt`
- Build/scripts: `scripts/copy-assets.mjs` copies fonts to `dist/assets`; `package.json` adds `preview` and pins `saxes@6.0.0`, `@resvg/resvg-js@2.6.2`, `pngjs@7.0.0`, and `@types/pngjs@6.0.5`

**Pinned font provenance**

- Version: DejaVu Sans 2.37.
- Official source: `https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.zip`.
- Downloaded archive SHA-256: `7576310b219e04159d35ff61dd4a4ec4cdba4f35c00e002a136f00e96a908b0a`.
- Vendored `DejaVuSans.ttf` SHA-256: `7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954`.
- Vendored `LICENSE.txt` SHA-256: `7a083b136e64d064794c3419751e5c7dd10d2f64c108fe5ba161eae5e5958a93`.
- `getResvgOptions` sets `loadSystemFonts: false`, `fontFiles: [FONT_PATH]`, and `defaultFontFamily: "DejaVu Sans"`; rendering verifies the font hash first.

**Observable behavior**

- The typed scene is a 1024x1024 viewBox with stem, legend, and four labeled option regions. Validation rejects blank scenes, out-of-bounds/clipped nodes, overlapping stem/legend/options, missing or mislabeled options, narrow strokes (<4), tiny essential marks (<12), small text (<32), and text below 4.5:1 contrast against its effective panel/backdrop. Essential graphics require 3:1 against the same backdrop.
- The serializer emits only `svg`, `g`, `rect`, `circle`, `line`, `polyline`, `polygon`, `path`, `text`, `title`, and `desc` with an explicit attribute allowlist. Text is escaped and numbers are emitted in exponent-free decimal form. The parser rejects scripts, `foreignObject`, images/links, event handlers, `style`, namespaced attributes, URLs, DOCTYPE/entities, processing instructions, comments, CDATA, unsafe path commands, duplicate IDs, wrong namespaces, wrong viewBox, and invalid layouts.
- The scene-demo has a readable stem, legend, four labeled option boxes A-D, and fixed layout. The 512-pixel preview was inspected directly; the legend mark is separated from the legend text.
- `renderScenePng` produces real PNGs at 1024 and 512 pixels with the pinned font. Repeated renders are byte-identical in this environment. Resvg bounding-box checks reject clipped content; `assertPngDimensions`, `assertRasterNonBlank`, and PNG signature checks reject blank or malformed images. Shared raster helpers compare changed pixels and enforce at least eight changed non-background pixels for critical-group removals.
- `npm run preview -- --family scene-demo --seed preview-v1` writes `data/previews/scene-demo-preview-v1.svg`, `-1024.png`, and `-512.png` (ignored by Git through `/data`) and prints source/full/preview paths plus SHA-256 hashes. Observed hashes after the final layout: full `726fab7b677dcf93e4b0dea18e1a095a946fb6e5bb5b1dbcd6c8146fa4c584e2`, preview `710b7d8151cd7b94b3c65a1531ad8ecfe025abd57be688016bfa281ffbec773a`.
- The preview registry contains only `scene-demo`; no unfinished family renderer is imported or registered. The preview CLI also resolves canonical `productionRegistry` renderers for declared SVG families, so a future family renderer is registered once and remains previewable.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec vitest run tests/render/safety.test.ts` | exit 0; 12 tests passed. |
| `npm run preview -- --family scene-demo --seed preview-v1` | exit 0; printed SVG, full PNG, preview PNG, and both SHA-256 hashes. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 10 files / 177 tests passed, build succeeded and copied `dist/assets/fonts`. |

**Manual acceptance steps**

1. Run `npm exec vitest run tests/render/safety.test.ts --reporter=verbose` and inspect the scene, parser, PNG, and CLI cases.
2. Run `npm run preview -- --family scene-demo --seed preview-v1` and open the printed SVG and 512-pixel PNG paths directly. Confirm the stem, legend, four labels A-D, and four answer boxes are readable.
3. Confirm the printed full/preview hashes match the observed values above and that the default output is under ignored `data/previews`.
4. Run `npm run check` and confirm 177 tests pass without an API key or network access.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec vitest run tests/render/safety.test.ts --reporter=verbose
npm run preview -- --family scene-demo --seed preview-v1
npm run check
```

Expected: 12 focused tests pass, the preview command prints existing SVG/full/preview paths with the observed hashes, and `npm run check` exits 0 with 177 tests. Open the printed paths directly; no gallery is involved.

**Out of scope, unchanged:** all ten real puzzle renderers, AI SVG, browser report/gallery, visual-family layouts, and any live evidence.

## P11. Matrix Specification and Formal Engine — 2026-11-04

**State:** implemented, offline-verified. Matrix is a formal SVG-family engine only; no matrix renderer, SVG layout, or gallery exists in this phase.

**Files**

- Schema/DSL/mask/solver helpers: `src/families/matrix/schema.ts`
- Construction/options/rules/facts/scene input/mutations: `src/families/matrix/engine.ts`
- Glyph/transpose canonicalization: `src/families/matrix/canonical.ts`
- Tests: `tests/families/matrix.test.ts`
- Registry: `src/families/registry.ts` registers the matrix engine (no renderer)
- Documentation: `docs/families.md`, this file
- Test hygiene: the existing P01/P02 data-directory probes now snapshot before/after contents so P10 previews under `data/previews` do not make `npm run check` fail.

**Observable behavior**

- The DSL is a fixed 3x3 matrix of four-bit masks with only the bottom-right cell null and `rule: "xor"`. Unknown rules, masks outside 0..15, and nulls outside (2,2) are rejected. Eight visible cells produce observation facts `p001`-`p008` in row-major order; the missing cell is the query.
- `enumerateSolutions` checks all 16 candidate masks against both row and column equations and requires exactly one completion. Inconsistent visible rows/columns produce zero solutions; the checker verifies all six XOR equations and the 0..15 mask domain. Glyph-placement assertions belong to P12.
- `constructMatrixSpec` draws four upper-left seed masks with populations 1-2/1-3/2-3 for levels 1/2/3, derives the remaining visible cells by XOR, and retries within 64 draws until at least four distinct visible masks and distinct first/second inputs in every visible row/column pair are satisfied, including the two visible inputs of the incomplete third row and third column. It records attempts, seed populations, visible distinct count, and draws used.
- `makeOptions` uses the unique correct mask plus three one-glyph toggles and verifies exactly one satisfying choice. Empty mask 0 has an explicit empty-cell convention.
- `matrixSceneInput` exposes typed cells, missing-cell location, four fixed glyph positions, empty convention, and A-D choices without rendering SVG. The renderer registry remains empty.
- `canonicalData` preserves all eight shown masks and the missing location, and minimizes over 24 glyph-identity permutations plus matrix transpose. The canonical structure uses `cell:r:c:mask` tokens and explicit row/column XOR query tokens.
- The deterministic fixture seed `a08380fb256a4f393e5f5140432682475edf6360453e2ecd5fbc142fe87624da` at level 1 produces cells `[[10,12,6],[1,4,5],[11,8,null]]`, trace `{attempts:3, seedPopulations:[2,2,1,1], visibleDistinctMasks:8, drawsUsed:12}`, unique missing mask 3, and options A=2 / B=7 / C=3 / D=11 with correct label C.
- The 100 fixed construction seeds produced 34/33/33 successes for levels 1/2/3, zero failures, and every success was independently solved and verified.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec vitest run tests/families/matrix.test.ts` | exit 0; 13 tests passed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 11 files / 190 tests passed, build succeeded. |

**Manual acceptance steps**

1. Run `npm exec vitest run tests/families/matrix.test.ts --reporter=verbose` and inspect the schema, solver, options, canonicalization/scene-input, construction, and registry cases.
2. Run the exact script below. The JSON shows `rule: "xor"`, the eight visible masks, the missing (2,2) cell, exactly one `valid: true` candidate (mask 3), and four one-glyph options with correct label C.
3. Confirm the intended rule is explicit in `spec.rule` and `visibleRules`; no pattern is guessed and no renderer is registered.
4. Run `npm run check` and confirm 190 tests pass without an API key or network access.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec vitest run tests/families/matrix.test.ts --reporter=verbose
npm exec tsx -- -e 'import { constructMatrixSpec, matrixEngine } from "./src/families/matrix/engine.ts"; import { checkMatrixCompletion } from "./src/families/matrix/schema.ts"; const seed="a08380fb256a4f393e5f5140432682475edf6360453e2ecd5fbc142fe87624da"; const {spec,trace}=constructMatrixSpec(seed,1); const result=matrixEngine.enumerateSolutions(spec); const options=matrixEngine.makeOptions(spec,result.correctAnswer,"0".repeat(64)); const candidates=Array.from({length:16},(_value,mask)=>({mask,valid:checkMatrixCompletion(spec,mask)})); if(result.solutionCount!==1||result.correctAnswer!==3||options.correctLabel!=="C"||candidates.filter((candidate)=>candidate.valid).length!==1) process.exit(1); console.log(JSON.stringify({spec,trace,solution:result.correctAnswer,candidates,options},null,2));'
npm run check
```

Expected: 13 focused tests pass, exactly one candidate mask (3) is valid, and `npm run check` exits 0 with 190 tests.

**Out of scope, unchanged:** matrix SVG layout/renderer, visual evidence, remaining visual families, AI wording, gallery, reports, and any live evidence.

## P12. Matrix Renderer and Visual Evidence — 2026-11-04

**State:** implemented, offline-verified. This phase adds the matrix renderer and preview only; no other visual family, HTML gallery, or provider call exists.

**Files**

- Matrix scene builder, validation, critical-group metadata, renderer registration object: `src/families/matrix/render.ts`
- Tests: `tests/render/matrix.test.ts`
- Registry: `src/families/registry.ts` registers `matrixRenderer`
- Preview CLI: `src/cli/preview.ts` resolves the canonical matrix engine/renderer and derives a 64-hex preview spec seed from the human seed
- Documentation: `docs/families.md`, this file

**Observable behavior**

- The renderer builds a 1024x1024 scene with a 3x3 stem grid, bottom-right `?` missing-cell marker, explicit `Rows: 1st XOR 2nd = 3rd.` and `Cols: top XOR mid = bottom.` rules, a four-glyph legend, and four A-D answer tiles. Glyph shapes are circle, square, triangle, and diamond at fixed normalized positions; color is never an identity cue. The scene validator rejects stem text that reuses bare answer-option labels.
- Every example and option uses the same four glyph positions and shape mapping. Empty mask 0 is an outlined mini-grid with no glyphs.
- `assertMatrixScene` validates the shared scene and then checks exact mask-to-glyph placement, the correct option is present, identical positions/shapes, missing-cell marker/position, empty-mask emptiness, grid/option clipping, cell overlap, and all critical groups `stem-grid`, `missing-cell`, `legend-glyphs`, and `option-A-grid`..`option-D-grid`. Stem rules must not contain standalone A-D labels.
- The renderer is registered in the canonical renderer registry. `npm run preview -- --family matrix --seed preview-v1` builds the checked masks, writes SVG/1024/512 previews under ignored `data/previews`, and prints paths plus hashes.
- Observed preview hashes for `preview-v1`: full `4cf25c961577c01f0cbce536ad23a865499d4c5bb8ada08f250db735a09dade8`, preview `07b8001b5567a87c0d701c5c7992dddfccc4af62524a57ab6401738b932457aa`.
- Focused tests rasterize 100 seeded scenes at 512 pixels for bounds and distinct option masks, run fixed adversarial plus ten seeded removed-critical-group pixel checks (at least eight changed non-background pixels), and reject swapped glyph positions with the explicit `SWAPPED_GLYPH` code, clipped glyphs, and injected glyphs in the empty mask. Removed-critical-group evidence is repeated with marks removed but panels kept, so the pixel delta reflects the glyphs rather than only the backing panel; empty-mask option grids are skipped for the marks-only comparison.
- The 512-pixel preview was inspected directly: the missing `?`, both rule directions, all four glyph shapes, and A-D tiles are distinguishable; no option is visually marked as the key.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec vitest run tests/render/matrix.test.ts` | exit 0; 7 tests passed. |
| `npm run preview -- --family matrix --seed preview-v1` | exit 0; printed SVG, full PNG, preview PNG, and both SHA-256 hashes. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 12 files / 197 tests passed, build succeeded. |

**Manual acceptance steps**

1. Run `npm exec vitest run tests/render/matrix.test.ts --reporter=verbose` and inspect the scene, empty-mask, swapped/clipped, 100-seed raster, removed-critical-group, and preview CLI cases.
2. Run `npm run preview -- --family matrix --seed preview-v1` and open the printed 512-pixel PNG directly. Confirm the missing cell, both row/column rules, every glyph shape, and A-D are distinguishable, with no key cue.
3. Confirm the printed full/preview hashes match the observed values above and the output is under ignored `data/previews`.
4. Run `npm run check` and confirm 197 tests pass without an API key or network access.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec vitest run tests/render/matrix.test.ts --reporter=verbose
npm run preview -- --family matrix --seed preview-v1
npm run check
```

Expected: 7 focused tests pass, the preview command prints existing SVG/full/preview paths with the observed hashes, and `npm run check` exits 0 with 197 tests. Open the printed 512-pixel PNG directly; no gallery is involved.

**Out of scope, unchanged:** other visual families, HTML gallery, AI SVG, reports, provider calls, and any live evidence.

## P13. Transform Specification and Coordinate Engine — 2026-11-04

**State:** implemented, offline-verified, accepted by the user on 2026-11-04. Transforms is a formal SVG-family engine only; no raster renderer, gallery, provider call, or live evidence exists in this phase.

**Files**

- DSL, exact D4 maps, composition/inverse/conjugation, source/answer validation: `src/families/transforms/schema.ts`
- Bounded construction, orbit options, independent solving, rules/facts, mutations: `src/families/transforms/engine.ts`
- Frame-conjugated canonical structure: `src/families/transforms/canonical.ts`
- Tests: `tests/families/transforms.test.ts`
- Registry: `src/families/registry.ts` registers the transforms engine (no transforms renderer)
- Documentation: `docs/families.md`, `README.md`, this file

**Observable behavior**

- The DSL is a strict 5x5 binary source grid with 4-8 orthogonally connected occupied cells and one or two ordered operations from the eight declared D4 transforms. Coordinates are zero-based with the origin at the top-left. Nonbinary or non-5x5 grids, disconnected sources, occupancy outside 4-8, unknown operations, and sequences outside one or two steps are rejected.
- The exact maps are `identity`, R90 `(r,c)->(c,4-r)`, R180 `(r,c)->(4-r,4-c)`, R270 `(r,c)->(4-c,r)`, left-right `(r,4-c)`, top-bottom `(4-r,c)`, main-diagonal `(c,r)`, and anti-diagonal `(4-c,4-r)`. Composition, inverses, associativity, and conjugation are tested over the complete D4 group; R180 is central while R90/R270 with any reflection is noncommuting.
- `enumerateSolutions` independently applies the listed operations to the parsed source cells and returns one complete sorted output with a derived `s001` fact, `enumeratedStates = 25`, and checker version `transforms-v1`. `verifyAnswer` recomputes the coordinate result rather than comparing against a construction witness.
- `constructTransformsSpec` grows a connected source by seeded orthogonal neighbor growth, keeps only sources with at least four distinct D4 orbit masks, rejects sources fixed by the chosen net transform, and confirms three distinct false orbit outputs exist. Level 1 uses one nonidentity rotation, level 2 one reflection, and level 3 one R90/R270 rotation plus one reflection in either order with a noncommuting check. It records attempts, source size, orbit size, operations, net transform, and draws used within 64 draws.
- `makeOptions` uses the unique output plus three distinct false masks from the source's D4 orbit, so identical outputs cannot appear as separate choices. Exactly one shuffled A-D choice satisfies the checker; an insufficient orbit is an explicit `INSUFFICIENT_DISTRACTORS` failure.
- The deterministic fixture source `[(0,0),(0,1),(1,1),(2,1)]` produces the hand-checked R90 output `[(0,4),(1,2),(1,3),(1,4)]` and left-right output `[(0,3),(0,4),(1,3),(2,3)]`. Applying `reflectLeftRight` then R90 instead of R90 then `reflectLeftRight` changes the answer to `[(3,2),(3,3),(3,4),(4,4)]`, so the reversed order is detectably wrong.
- Observation facts are `p001` onward for occupied source cells in row-major order. Code-owned rules state the viewer-relative top-left origin, clockwise direction, all eight coordinate maps, listed-order semantics, the `(2,2)` tile center, and that choices are complete resulting patterns.
- `canonicalData` minimizes the source and ordered sequence over all eight D4 frame changes, conjugating every operation by the same frame. Query tokens retain `steps=N`, ordered `op0`/`op1`, and the derived `net`; a one-step reflection and a two-step composition with the same net effect produce different fingerprints.
- Deterministic mutations reverse a two-step sequence with distinct operations, replace the second operation of a repeated two-step sequence, replace a one-step operation with a different D4 operation, and express the same net with a different step count. The replacement branches choose an operation whose resulting answer differs when an admissible alternative exists.
- The 100 fixed construction seeds produced 34/33/33 successes for levels 1/2/3 with zero failures; every success was independently solved, verified, and option-built.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec vitest run tests/families/transforms.test.ts` | exit 0; 22 tests passed. |
| `npm run lint` | exit 0; ESLint clean. |
| `npm run typecheck` | exit 0; `tsc --noEmit` clean. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 13 files / 219 tests passed, build succeeded. |

**Manual acceptance steps**

1. Run `npm exec vitest run tests/families/transforms.test.ts --reporter=verbose` and inspect the D4 algebra, schema, solver, option, canonicalization, construction, mutation, and registry cases.
2. Run the exact script below. It exits non-zero unless the fixed asymmetric source produces the hand-checked R90 and left-right outputs and the reversed step order is rejected; it prints both outputs, both two-step outputs, the rejection flag, and a level-3 construction trace.
3. Confirm the printed R90 output is `[(0,4),(1,2),(1,3),(1,4)]`, the left-right output is `[(0,3),(0,4),(1,3),(2,3)]`, and `reversedOrderRejected` is `true`.
4. Run `npm run check` and confirm 219 tests pass without an API key or network access.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec vitest run tests/families/transforms.test.ts --reporter=verbose
npm exec tsx -- -e 'import { gridFromCells, TransformsSpecSchema } from "./src/families/transforms/schema.ts"; import { constructTransformsSpec, transformsEngine } from "./src/families/transforms/engine.ts"; const source=[{row:0,column:0},{row:0,column:1},{row:1,column:1},{row:2,column:1}]; const make=(operations)=>TransformsSpecSchema.parse({source:gridFromCells(source),operations}); const r90=make(["rotate90"]); const lr=make(["reflectLeftRight"]); const forward=make(["rotate90","reflectLeftRight"]); const reversed=make(["reflectLeftRight","rotate90"]); const r90Answer=transformsEngine.enumerateSolutions(r90).correctAnswer; const lrAnswer=transformsEngine.enumerateSolutions(lr).correctAnswer; const forwardAnswer=transformsEngine.enumerateSolutions(forward).correctAnswer; const reversedAnswer=transformsEngine.enumerateSolutions(reversed).correctAnswer; const reversedOrderRejected=forwardAnswer!==null&&!transformsEngine.verifyAnswer(reversed,forwardAnswer); const expectedR90=[{row:0,column:4},{row:1,column:2},{row:1,column:3},{row:1,column:4}]; const expectedLR=[{row:0,column:3},{row:0,column:4},{row:1,column:3},{row:2,column:3}]; if(JSON.stringify(r90Answer)!==JSON.stringify(expectedR90)||JSON.stringify(lrAnswer)!==JSON.stringify(expectedLR)||!reversedOrderRejected) process.exit(1); const {trace}=constructTransformsSpec("a".repeat(64),3); console.log(JSON.stringify({r90:r90Answer,leftRight:lrAnswer,forward:forwardAnswer,reversed:reversedAnswer,reversedOrderRejected,trace},null,2));'
npm run check
```

Expected: 22 focused tests pass, the JSON shows the two hand-checked outputs, a different reversed two-step output, `reversedOrderRejected: true`, and a level-3 trace with two noncommuting operations; `npm run check` exits 0 with 219 tests.

**Acceptance:** accepted by the user on 2026-11-04 after the focused suite, exact non-UI script, and `npm run check` evidence.

**Out of scope, unchanged:** transform SVG layout/renderer, orientation markers, visual evidence, remaining visual families, AI wording, gallery, reports, provider calls, and any live evidence.

## P14. Transform Renderer and Orientation Clarity — 2026-11-04

**State:** implemented, offline-verified, accepted by the user on 2026-11-04. This phase adds the transforms SVG/PNG renderer only; no animation, free-form SVG transformations, gallery, provider call, or live evidence exists.

**Files**

- Scene construction, operation arrows/axes, grid/pivot/orientation geometry, and validation: `src/families/transforms/render.ts`
- Renderer tests: `tests/render/transforms.test.ts`
- Registry: `src/families/registry.ts` registers `transformsRenderer`
- Preview CLI: `src/cli/preview.ts` adds `--difficulty 1|2|3` (default `1`) so a two-operation scene can be previewed
- Documentation: `docs/families.md`, `README.md`, this file

**Observable behavior**

- The scene is a 1024x1024 viewBox with a source 5x5 grid, one or two ordered operation cards, a viewer-relative axis/clockwise legend, and four A-D option tiles. Every grid uses the same 160px scale (`28px` cells, `5px` gaps), the same center pivot marker at `(2,2)`, and the same top orientation triangle. Source and options show complete masks in the fixed coordinate frame.
- Rotation cards show `First`/`Then`, the operation name, and a clockwise arc for 90/180/270 degrees with an arrowhead at the declared endpoint. Reflection cards show the matching vertical, horizontal, main-diagonal, or anti-diagonal axis. Identity uses an explicit `=` mark. The legend states `Axes: top = up, right = right.`, `Clockwise: top, right, bottom, left.`, and the center-pivot/top-marker convention.
- `assertTransformsScene` runs shared `assertScene`, then verifies critical groups `source-grid`, `operation-sequence`, `axis-legend`, and `option-A-grid`..`option-D-grid`; exact 25-cell geometry and fills; identical grid scale; center pivot; top orientation marker; ordered operation text; clockwise-arrow endpoint, radius, angular-step, total-sweep, and arrowhead-tip direction; visible pivot/orientation markers and paint order; mirror-axis orientation; and exactly one correct, four-distinct orbit option set.
- Explicit renderer errors include `MISSING_AXIS`, `REVERSED_ARROW`, `REVERSED_ORDER`, `DECORATIVE_ROTATION`, `WRONG_AXIS`, `OFF_CENTER_PIVOT`, `MISSING_ORIENTATION`, `INVISIBLE_MARKER`, `WRONG_GEOMETRY`, `MISSING_OPERATION`, and `OPTION_NOT_DISTINCT`.
- The clockwise-arrow validator checks endpoints, radius, per-step angular gap, total swept extent, sweep direction, and arrowhead tip direction. The pivot ring must be painted after its halo, and the pivot/orientation markers must use their visible ink/background styling. Every `rotation-arrow`, `mirror-axis`, or `identity-mark` must belong to a declared operation card or the axis legend; an extra transform icon is rejected as `DECORATIVE_ROTATION`. Grids cannot be rotated because the top orientation marker and center pivot are fixed.
- `transformsRenderer` is registered in the canonical renderer registry with version `transforms-v1`. The generic preview CLI resolves it without a special-case import.
- The preview CLI now accepts `--difficulty 1|2|3` (default `1`) and prints the selected difficulty. `--difficulty 3` renders a two-operation scene that demonstrates both clockwise direction and a mirror axis.
- Fixed preview hashes at `preview-v1`: level 1 full `6d5eaf53cd1f552b09e50033380feddc9584692df54067715f32b7e90eca53e5`, preview `662efe0d448e3849050ce13085783eadde65f2b270bce58c254430d8cdd78fb3`; level 3 full `7eeef604d17b0de83520ef6f0e18341d5e1d1e661bfd4db1ebdbc3348d393178`, preview `3b68cb49bb6fab82c4c0a1d513d79c49fe33bff80a93497c2726db4ca24051f2`.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec vitest run tests/render/transforms.test.ts` | exit 0; 6 tests passed. |
| `npm run preview -- --family transforms --seed preview-v1` | exit 0; wrote SVG/1024/512 under `data/previews` with the level-1 hashes above. |
| `npm run preview -- --family transforms --seed preview-v3 --difficulty 3` | exit 0; wrote SVG/1024/512 with the level-3 hashes above. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 14 files / 225 tests passed, build succeeded. |

**Manual acceptance steps**

1. Run the exact commands below.
2. Open `data/previews/transforms-preview-v1-512.png` (level 1) and confirm the source grid, the single operation card, the clockwise arrow, the viewer-relative axis legend, the center pivot, the top orientation marker, and four same-scale A-D grids.
3. Open `data/previews/transforms-preview-v3-512.png` and confirm the card order is visibly `1 First` then `2 Then`, the first card shows a clockwise rotation arrow, the second shows a mirror axis, and the axis legend states top/right/clockwise direction.
4. Confirm no option is visually highlighted as the key and no decorative rotation appears outside the formal operation cards.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec vitest run tests/render/transforms.test.ts --reporter=verbose
npm run preview -- --family transforms --seed preview-v1
npm run preview -- --family transforms --seed preview-v3 --difficulty 3
npm run check
```

Expected: 6 focused renderer tests pass; both preview commands exit 0 and print `family: transforms`, `preview_png:`, and the hashes above; `npm run check` exits 0 with 14 files / 225 tests. Open the printed 512-pixel PNGs; the level-1 scene shows a clockwise rotation card, and the level-3 scene shows `First`/`Then` order, a clockwise rotation, a mirror axis, and the viewer-relative axis legend.

**Acceptance:** accepted by the user on 2026-11-04 after the focused suite, both preview PNGs, and `npm run check` evidence.

**Out of scope, unchanged:** animation, free-form SVG transformations, gallery, provider calls, and any live evidence.

## P15. Path Graph and Route Engine — 2026-11-04

**State:** implemented, offline-verified, accepted by the user on 2026-11-04. This phase adds the paths formal engine only; no path renderer, shortest-path variant, arbitrarily large maze, gallery, provider call, or live evidence exists.

**Files**

- DSL, tree/route validation, BFS, full-grid path enumeration, answer checking: `src/families/paths/schema.ts`
- Bounded construction, options, rules/facts, mutations: `src/families/paths/engine.ts`
- D4/translation-normalized canonical structure: `src/families/paths/canonical.ts`
- Tests: `tests/families/paths.test.ts`
- Registry: `src/families/registry.ts` registers `pathsEngine` (no paths renderer)
- Documentation: `docs/families.md`, `README.md`, this file

**Observable behavior**

- The DSL is a 4x4 grid with 6-12 sorted active cells, sorted undirected open orthogonal edges, and distinct marked start/goal cells. Edges have sorted endpoints, the edge count is exactly `activeCells-1`, and the graph must be one connected tree. Diagonal edges, duplicate edges, disconnected/cyclic graphs, start=goal, unsorted cells/edges, and routes outside 3-11 edges are rejected.
- `enumerateSolutions` independently runs BFS over the parsed tree and returns one complete route with a derived `s001` fact, `enumeratedStates = activeCells`, and checker version `paths-v1`. `verifyAnswer` rechecks endpoints, active cells, every open corridor, no revisits, and equality with the independently recovered tree route.
- `constructPathsSpec` grows a connected active set by seeded neighbor growth, builds a seeded randomized-DFS spanning tree, and chooses ordered endpoints with route lengths 3-5/5-7/7-11 for levels 1/2/3. Active-size targets are 6-8/7-10/9-12. It retries within 64 deterministic draws and requires at least three false full-grid routes.
- `enumerateFullGridSimpleRoutes` enumerates simple S-to-G routes over the full 4x4 grid with a `SearchCounter` cap of 200,000 visited states. False options each use at least one closed/nonexistent corridor or inactive cell; a route cannot jump over a cell because every consecutive pair must be orthogonally adjacent.
- `makeOptions` uses the unique tree route plus three distinct false routes, shuffles them into A-D, and verifies exactly one choice satisfies the independent checker.
- Rules state orthogonal movement, open corridors, no revisits, tree uniqueness, and distinct S/G markers. Facts `p001` onward list active cells in row-major order, open corridors in sorted edge order, then the start and goal markers.
- `canonicalData` minimizes active cells, open edges, and marked S/G over all eight D4 frames and a translation-normalized bounding box. Tokens are `grid=4x4`, `start:r:c`, `goal:r:c`, `open:r1:c1:r2:c2`, and `active:r:c`, so geometry and topology are retained.
- The 100 fixed construction seeds produced 34/33/33 successes for levels 1/2/3 with zero failures; every success was independently solved, verified, and option-built.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec vitest run tests/families/paths.test.ts` | exit 0; 16 tests passed. |
| 100 fixed construction seeds | 34/33/33 successes, zero failures; route lengths 3-5/5-7/7-10; false-route pool 85-177 routes. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 15 files / 241 tests passed, build succeeded. |

**Manual acceptance steps**

1. Run the exact commands below.
2. Confirm the focused paths suite passes and includes the disconnected/cyclic/diagonal/duplicate/start=goal/revisit/jump/enumeration-cap/D4-translation cases.
3. Run the exact script below. Confirm `extraEdgeRejected: true`, `shortcutValid: false`, the correct route is `(0,0)->(1,0)->(1,1)->(1,2)`, and the error message says `a path tree requires exactly activeCells-1 open edges`.
4. Run `npm run check` and confirm 15 files / 241 tests pass without an API key or network access.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec vitest run tests/families/paths.test.ts --reporter=verbose
npm exec tsx -- -e 'import { PathsSpecSchema, sortPathEdges } from "./src/families/paths/schema.ts"; import { pathsEngine } from "./src/families/paths/engine.ts"; const active=[{row:0,column:0},{row:0,column:1},{row:0,column:2},{row:1,column:0},{row:1,column:1},{row:1,column:2}]; const edges=[{from:{row:0,column:0},to:{row:0,column:1}},{from:{row:0,column:0},to:{row:1,column:0}},{from:{row:0,column:1},to:{row:0,column:2}},{from:{row:1,column:0},to:{row:1,column:1}},{from:{row:1,column:1},to:{row:1,column:2}}]; const spec=PathsSpecSchema.parse({active,edges:sortPathEdges(edges),start:{row:0,column:0},goal:{row:1,column:2}}); const extraEdge={...spec,edges:sortPathEdges([...edges,{from:{row:0,column:1},to:{row:1,column:1}}])}; let extraEdgeRejected=false; let extraEdgeMessage=""; try { PathsSpecSchema.parse(extraEdge); } catch(e){ extraEdgeRejected=true; extraEdgeMessage=e instanceof Error?e.message:String(e); } const shortcut=[{row:0,column:0},{row:0,column:1},{row:1,column:1},{row:1,column:2}]; const shortcutValid=pathsEngine.verifyAnswer(spec,shortcut); const correct=pathsEngine.enumerateSolutions(spec).correctAnswer; if(!extraEdgeRejected||shortcutValid||correct===null) process.exit(1); console.log(JSON.stringify({correct,shortcut,shortcutValid,extraEdgeRejected,extraEdgeMessage},null,2));'
npm run check
```

Expected: 18 focused tests pass; the JSON shows the correct route, the shortcut route, `shortcutValid: false`, `extraEdgeRejected: true`, and the `a path tree requires exactly activeCells-1 open edges` message; `npm run check` exits 0 with 15 files / 241 tests.

**Acceptance:** accepted by the user on 2026-11-04 after the focused suite, exact non-UI script, and `npm run check` evidence.

**Out of scope, unchanged:** path SVG/PNG renderer, shortest-path variants, arbitrarily large mazes, gallery, provider calls, and any live evidence.

## P16. Path Renderer and Corridor/Wall Checks — 2026-11-04

**State:** implemented, offline-verified, accepted by the user on 2026-11-04. This phase adds the paths SVG/PNG renderer only; no maze interaction, path-drawing UI, gallery, provider call, or live evidence exists.

**Files**

- Scene construction, wall convention, route overlays, maze validation: `src/families/paths/render.ts`
- Renderer tests: `tests/render/paths.test.ts`
- Registry: `src/families/registry.ts` registers `pathsRenderer`
- Documentation: `docs/families.md`, `README.md`, this file

**Observable behavior**

- The scene is a 1024x1024 viewBox with a source 4x4 maze, a wall/route legend, and four A-D option tiles. Every maze uses the same 160px grid (`40px` cells). Active cells are light, inactive cells are muted with diagonal hatching, and all choices reuse the same maze geometry and S/G markers.
- One explicit wall convention: the outer border is always a thick black wall; every internal boundary is a wall unless both cells are active and the edge is explicitly open. Open corridors are gaps. Walls use `SCENE_INK` with an 8px stroke, remain distinct in grayscale, and are visibly thick at the 512 preview.
- Each option draws a white halo plus a blue route polyline through the chosen cell centers. Routes are painted before walls, so a segment crossing a closed boundary is interrupted by the visible wall; the correct route only crosses open gaps. The source maze has no route overlay.
- `assertPathsScene` verifies critical groups `source-maze`, `wall-legend`, and `option-A-maze`..`option-D-maze`; exact 16-cell fills and hatching; expected outer/internal walls; no wall on an open active edge; S/G halo centers, label anchors, and label positions; identical maze signatures including marker positions; route points and halo alignment at cell centers; orthogonal 40px steps; walls painted after routes; and four distinct choices with exactly one valid route.
- Explicit renderer errors include `MISSING_WALL`, `UNEXPECTED_WALL`, `WALL_PAINT_ORDER`, `CHANGED_MAZE`, `MISSING_ENDPOINT`, `CLIPPED_ENDPOINT`, `ILLEGAL_DIAGONAL`, `WRONG_ROUTE`, `MISSING_LEGEND`, and `OPTION_NOT_DISTINCT`.
- Focused evidence includes hidden-wall, clipped-endpoint, displaced-label, displaced-halo, illegal-diagonal, changed-maze-choice, wall-paint-order, missing-legend, and unexpected-wall fixtures; grayscale wall-versus-cell/corridor luminance checks; 100 seeded 512-pixel scenes with bounds and pairwise-distinct route rasters; and fixed plus ten seeded critical-group pixel checks (at least eight changed non-background pixels).
- Preview hashes at `preview-v1`: full `4e7ebcc294bcb15ecb2b3261111df2aac87abdc30e2c093dde0e9df3b4d1a80d`, preview `c90b92fc89ebcfffdefef9c7b3a6fe6dcc636d6b0e9e6269afd169dc8731d747`.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec vitest run tests/render/paths.test.ts` | exit 0; 7 tests passed. |
| `npm run preview -- --family paths --seed preview-v1` | exit 0; wrote SVG/1024/512 with the hashes above. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 16 files / 248 tests passed, build succeeded. |

**Manual acceptance steps**

1. Run the exact commands below.
2. Open `data/previews/paths-preview-v1-512.png` and confirm S/G, corridor openings, thick walls, and each highlighted route are unambiguous without looking at source JSON.
3. Confirm the source maze and all four choices use the same maze geometry and S/G markers; false routes visibly cross hatched cells or closed walls, while the correct route only crosses gaps.
4. Run `npm run check` and confirm 16 files / 248 tests pass without an API key or network access.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec vitest run tests/render/paths.test.ts --reporter=verbose
npm run preview -- --family paths --seed preview-v1
npm run check
```

Expected: 7 focused renderer tests pass; the preview command exits 0 and prints `family: paths`, `preview_png:`, and the hashes above; `npm run check` exits 0 with 16 files / 248 tests. Open the printed 512-pixel PNG and confirm the source maze, four same-maze choices, S/G markers, corridor gaps, walls, and blue routes.

**Acceptance:** accepted by the user on 2026-11-04 after the focused suite, the 512-pixel preview, and `npm run check` evidence.

**Out of scope, unchanged:** maze interaction, path-drawing UI, gallery, provider calls, and any live evidence.

## P17. Symmetry Specification and Reflection Proof — 2026-11-04

**State:** implemented, offline-verified, accepted by the user on 2026-11-04. This phase adds the symmetry formal engine only; no symmetry renderer, continuous shapes, diagonal axes, generic visual symmetry detection, gallery, provider call, or live evidence exists.

**Files**

- DSL, explicit known/unknown/empty states, reflection maps, direct completion, checker: `src/families/symmetry/schema.ts`
- Bounded construction, options, rules/facts, mutations: `src/families/symmetry/engine.ts`
- Axis-normalized canonical structure: `src/families/symmetry/canonical.ts`
- Tests: `tests/families/symmetry.test.ts`
- Registry: `src/families/registry.ts` registers `symmetryEngine` (no symmetry renderer)
- Documentation: `docs/families.md`, `README.md`, this file

**Observable behavior**

- The DSL is an 8x8 grid of `occupied`, `empty`, and `unknown` states. Vertical means left half known and right half unknown between columns 3/4; horizontal means top half known and bottom half unknown between rows 3/4. The known half has 4-10 occupied cells and explicit empty cells; the missing half is entirely unknown. Unknown is distinct from empty.
- `completeSymmetry` reflects each known occupied cell exactly once and leaves known empty cells and all other missing cells empty. It does not enumerate 2^32 images. `enumerateSolutions` returns one completion, `enumeratedStates = 64`, checker version `symmetry-v1`, and 32 derived facts `s001`-`s032` that record the forced occupied/empty source for every missing cell.
- `verifyAnswer` independently checks every known-half cell against the spec and every missing cell against its reflected pair. Altered known cells, omitted reflected cells, extra reflected cells, wrong dimensions, and malformed answers are rejected.
- `constructSymmetrySpec` uses seeded known-half subsets: level 1 vertical with 4-5 occupied, level 2 horizontal with 6-7, level 3 either axis with 8-10 and at least two connected components. It stays within 64 deterministic draws and rejects all-empty/all-filled known halves.
- `makeOptions` builds four full completions with the same known half: the correct completion, a removed required reflected cell, an added forbidden missing cell, and a required reflected cell shifted to an adjacent missing cell whose mirror is empty. The three wrong completions are distinct and fail the independent checker; exactly one choice passes.
- Rules state the fixed vertical/left and horizontal/top convention, the central axis, one reflection per known cell, the unknown-versus-empty distinction, and the unchanged known half. Facts `p001` onward list occupied known cells in row-major order, then the axis and unknown-half observation.
- `canonicalData` normalizes horizontal to vertical, minimizes over reversal along the axis, and emits `grid=8x8`, `axis=vertical`, `knownSide=left`, `reflect_half`, and sorted occupied `cell:r:c` geometry. Under the fixed known-side convention, exchanging the displayed half normalizes back to the same known-left shape and adds no candidate.
- The 100 fixed construction seeds produced 34/33/33 successes for levels 1/2/3 with zero failures; level 3 always had at least two connected components. Every success was independently completed, verified, and option-built.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec vitest run tests/families/symmetry.test.ts` | exit 0; 13 tests passed. |
| 100 fixed construction seeds | 34/33/33 successes, zero failures; level 3 components 2-9; axes level 3: 18 vertical / 15 horizontal. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 17 files / 261 tests passed, build succeeded. |

**Manual acceptance steps**

1. Run the exact commands below.
2. Confirm the focused symmetry suite passes and includes vertical/horizontal maps, bad-size/off-axis metadata, altered known half, omitted/extra reflected cells, duplicate false options, normalized-axis equivalence, and 100 constructions.
3. Run the exact script below. Confirm `answerCount: 1`, `enumeratedStates: 64`, `proofFacts: 32`, `missingCells: 32`, `allMissingCovered: true`, and `occupiedCells: 8`.
4. Run `npm run check` and confirm 17 files / 261 tests pass without an API key or network access.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec vitest run tests/families/symmetry.test.ts --reporter=verbose
npm exec tsx -- -e 'import { SymmetrySpecSchema, missingSymmetryCells, mirrorSymmetryCell } from "./src/families/symmetry/schema.ts"; import { symmetryEngine } from "./src/families/symmetry/engine.ts"; const occupied=new Set(["0:0","1:0","1:1","2:2"]); const cells=Array.from({length:8},()=>Array.from({length:8},()=>"unknown")); for(let r=0;r<8;r++){for(let c=0;c<4;c++){cells[r][c]=occupied.has(`${r}:${c}`)?"occupied":"empty";}} const spec=SymmetrySpecSchema.parse({axis:"vertical",cells}); const result=symmetryEngine.enumerateSolutions(spec); const facts=result.proof?.facts??[]; const missing=missingSymmetryCells(spec.axis); const covered=missing.every((cell,index)=>{const fact=facts[index]; const mirror=mirrorSymmetryCell(spec.axis,cell); return fact!==undefined&&fact.text.includes(`row ${cell.row+1}, column ${cell.column+1}`)&&fact.text.includes(`row ${mirror.row+1}, column ${mirror.column+1}`);}); const answer=result.correctAnswer; if(answer===null||facts.length!==32||missing.length!==32||!covered||result.enumeratedStates!==64) process.exit(1); console.log(JSON.stringify({answerCount:result.answerCount,enumeratedStates:result.enumeratedStates,proofFacts:facts.length,missingCells:missing.length,allMissingCovered:covered,occupiedCells:answer.flat().filter((value)=>value===1).length},null,2));'
npm run check
```

Expected: 13 focused tests pass; the JSON shows `answerCount: 1`, `enumeratedStates: 64`, `proofFacts: 32`, `missingCells: 32`, `allMissingCovered: true`, and `occupiedCells: 8`; `npm run check` exits 0 with 17 files / 261 tests.

**Acceptance:** accepted by the user on 2026-11-04 after the focused suite, exact non-UI script, and `npm run check` evidence.

**Out of scope, unchanged:** symmetry SVG/PNG renderer, continuous shapes, diagonal axes, generic visual symmetry detection, gallery, provider calls, and any live evidence.

## P18. Symmetry Renderer and Unknown-State Clarity — 2026-11-04

**State:** implemented, offline-verified, accepted by the user on 2026-11-04. This phase adds the symmetry SVG/PNG renderer only; no infer-the-axis question, continuous shapes, diagonal axes, gallery, provider call, or live evidence exists.

**Files**

- Scene construction, state fills, dashed axis, completion tiles, and validation: `src/families/symmetry/render.ts`
- Renderer tests: `tests/render/symmetry.test.ts`
- Registry: `src/families/registry.ts` registers `symmetryRenderer`
- Tests: `tests/families/symmetry.test.ts` updated for the new renderer
- Documentation: `docs/families.md`, `README.md`, this file

**Observable behavior**

- The scene is a 1024x1024 viewBox with a source 8x8 tile, a state/axis legend, and four A-D completion tiles. Every tile uses the same 176px grid (`22px` cells).
- Occupied cells are ink (`#111111`), explicitly empty cells are white (`#ffffff`), and unknown cells are medium gray (`#c0c0c0`). The source shows occupied/empty known cells and an all-gray unknown half; every option is a full binary completion with no unknown cells.
- A dashed red (`#b00020`) line lies exactly between the central columns or rows. The source tile has a red axis sample and the label `axis`; the legend states `Dashed red = axis.`, `Between central cells.`, and `Known half unchanged.` Axis nodes are line segments, never cells.
- `assertSymmetryScene` verifies critical groups `source-tile`, `source-axis`, `state-legend`, and `option-A-tile`..`option-D-tile`; exactly 64 fixed cells per tile; source occupied/empty/unknown fills; option full binary fills with no unknown; identical known half in all choices; four distinct A-D completions with exactly one valid answer; at least six axis dashes on the exact central line with at least 60% coverage; a labeled source axis; and the state legend swatches plus axis legend.
- Explicit renderer errors include `CHANGED_KNOWN_HALF`, `UNKNOWN_IN_OPTION`, `MISSING_AXIS`, `WRONG_AXIS`, `MISSING_AXIS_LABEL`, `MISSING_LEGEND`, `OPTION_NOT_DISTINCT`, and `WRONG_GEOMETRY`.
- Focused evidence includes deterministic 1024/512 PNGs, unknown/empty/filled luminance contrast at 512, swapped-known-half, hidden source/option axis, unknown-in-option, off-axis dash, missing axis label, missing legend, duplicate choices, and axis-as-cell fixtures. The suite also rasterizes 100 seeded scenes with bounds and pairwise-distinct completion tiles, and runs fixed plus ten seeded critical-group pixel checks (at least eight changed non-background pixels).
- Preview hashes at `preview-v1`: full `b1ef765b49a44d95726f7b1a10d1a4daf9a5a1b52f274ecc1b0611e85117d408`, preview `85ffb5eb4bd0ae100e3622f193918aad5ad6571f18f97dd076f6a5728cb5eaf4`.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec vitest run tests/render/symmetry.test.ts` | exit 0; 6 tests passed. |
| `npm run preview -- --family symmetry --seed preview-v1` | exit 0; wrote SVG/1024/512 with the hashes above. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 18 files / 267 tests passed, build succeeded. |

**Manual acceptance steps**

1. Run the exact commands below.
2. Open `data/previews/symmetry-preview-v1-512.png` and confirm unknown gray is clearly different from empty white and filled black at 512 pixels.
3. Confirm the dashed red axis lies exactly between the central cells in the source and all four choices, and that no option changes the given known half.
4. Run `npm run check` and confirm 18 files / 267 tests pass without an API key or network access.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec vitest run tests/render/symmetry.test.ts --reporter=verbose
npm run preview -- --family symmetry --seed preview-v1
npm run check
```

Expected: 6 focused renderer tests pass; the preview command exits 0 and prints `family: symmetry`, `preview_png:`, and the hashes above; `npm run check` exits 0 with 18 files / 267 tests. Open the printed 512-pixel PNG and confirm the gray unknown half, white empty cells, black filled cells, dashed red central axis, axis label, state legend, and four full completion tiles with the same known half.

**Acceptance:** accepted by the user on 2026-11-04 after the focused suite, the 512-pixel preview, and `npm run check` evidence.

**Out of scope, unchanged:** infer-the-axis questions, continuous shapes, diagonal axes, gallery, provider calls, and any live evidence.

## P19. Counting/Membership Engine — 2026-11-04

**State:** implemented, offline-verified, accepted by the user on 2026-11-04. This phase adds the counting formal engine only; no counting renderer, arbitrary polygon/triangle/square detection, gallery, provider call, or live evidence exists.

**Files**

- DSL, connected shapes, membership masks, set/inclusion-exclusion counts, checker: `src/families/counting/schema.ts`
- Bounded construction, options, rules/facts, mutations: `src/families/counting/engine.ts`
- D4 plus shape-ID canonical structure: `src/families/counting/canonical.ts`
- Tests: `tests/families/counting.test.ts`
- Registry: `src/families/registry.ts` registers `countingEngine` (no counting renderer)
- Documentation: `docs/families.md`, `README.md`, this file

**Observable behavior**

- The DSL is a fixed 5x5 universe with two or three named shapes A/B/C. Each shape has 3-8 unique sorted orthogonally connected cells; shapes are distinct and include at least one overlapping and one exclusive cell. Queries are `unionCount`, `intersectionAll`, `exactlyOneShape`, or `exactlyKShapes(k)` with k=2/3 within the shape count. k=3 with two shapes is rejected.
- `enumerateSolutions` enumerates membership masks over all 25 cells, cross-checks with independent set and inclusion-exclusion calculations, and returns one integer answer 0..25 with `enumeratedStates = 25`, checker version `counting-v1`, and derived `s001`/`s002` facts for the query and all summary counts.
- `verifyAnswer` recomputes both membership-mask and set-based counts and rejects wrong, out-of-domain, and boundary answers.
- `constructCountingSpec` grows connected shapes from a shared anchor so overlap is guaranteed, then enforces distinct shapes and at least one exclusive cell. Level 1 uses two shapes of 3-5 cells and union; level 2 two shapes of 6-8 and intersection/exactly-one; level 3 three shapes of 4-8 and intersection/exactly-k. It stays within 64 deterministic draws, skips invalid attempts within the budget, and never reduces the shape count.
- `makeOptions` uses the correct integer plus three distinct false integers from the query's other summary counts, correct ±1, and the 0..25 domain. Exactly one choice satisfies the independent checker.
- Rules define all four operations, whole-cell counting, A/B/C labels, overlap behavior, and the 0..25 answer domain. Facts `p001` onward list each shape's cells in row-major order.
- `canonicalData` emits `grid=5x5`, `shapes=2|3`, query tokens, 25 `cell:r:c:mask` geometry tokens, and `region:mask:count` relation tokens for every non-empty mask. It minimizes over all eight D4 frames and every shape-ID permutation; counts alone cannot collapse different layouts.
- The 100 fixed construction seeds produced 34/33/33 successes for levels 1/2/3 with zero failures. Every success was independently solved, verified, and option-built.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec vitest run tests/families/counting.test.ts` | exit 0; 18 tests passed. |
| 100 fixed construction seeds | 34/33/33 successes, zero failures; level 3 queries 20 intersection / 7 exactlyK2 / 6 exactlyK3. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 19 files / 285 tests passed, build succeeded. |

**Manual acceptance steps**

1. Run the exact commands below.
2. Confirm the focused counting suite passes and includes pair/triple overlap, exclusive cells, invalid/disconnected/duplicate shapes, boundary exclusion, query differences, geometry-vs-count fingerprints, wrong keys, and 100 constructions.
3. Run the exact script below. Confirm the two-shape summary is union=7, intersectionAll=1, exactlyOne=6, exactlyK2=1; the three-shape summary is union=8, intersectionAll=1, exactlyOne=5, exactlyK2=2, exactlyK3=1; and every query's membership and set counts agree with the inclusion-exclusion union.
4. Run `npm run check` and confirm 19 files / 285 tests pass without an API key or network access.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec vitest run tests/families/counting.test.ts --reporter=verbose
npm exec tsx -- -e 'import { CountingSpecSchema } from "./src/families/counting/schema.ts"; import { countQueryByMembership, countQueryBySets, inclusionExclusionUnion, summaryCounts } from "./src/families/counting/engine.ts"; const makeCells=(values)=>values.map(([row,column])=>({row,column})).sort((a,b)=>a.row-b.row||a.column-b.column); const two=[{cells:makeCells([[0,0],[0,1],[1,0],[1,1]])},{cells:makeCells([[1,1],[1,2],[2,1],[2,2]])}]; const three=[{cells:makeCells([[0,0],[0,1],[1,0],[1,1]])},{cells:makeCells([[1,1],[1,2],[2,1],[2,2]])},{cells:makeCells([[1,1],[2,1],[2,2],[3,2]])}]; const queries=[{operation:"unionCount"},{operation:"intersectionAll"},{operation:"exactlyOneShape"},{operation:"exactlyKShapes",k:2},{operation:"exactlyKShapes",k:3}]; const run=(shapes,allowK3)=>{const rows=[]; for(const query of queries){if(query.k===3&&!allowK3) continue; const spec=CountingSpecSchema.parse({shapes,query}); const membership=countQueryByMembership(spec); const sets=countQueryBySets(spec); if(membership!==sets) process.exit(1); rows.push({query:query.operation+(query.k?`:${query.k}`:""),membership,sets});} const base=CountingSpecSchema.parse({shapes,query:{operation:"unionCount"}}); return {summary:summaryCounts(base),ieUnion:inclusionExclusionUnion(base),queries:rows};}; const result={two:run(two,false),three:run(three,true)}; console.log(JSON.stringify(result,null,2));'
npm run check
```

Expected: 18 focused tests pass; the JSON shows the two- and three-shape summaries above, every query's `membership` equals `sets`, and `ieUnion` equals the summary union (7 and 8); `npm run check` exits 0 with 19 files / 285 tests.

**Acceptance:** accepted by the user on 2026-11-04 after the focused suite, exact non-UI script, and `npm run check` evidence.

**Out of scope, unchanged:** counting SVG/PNG renderer, arbitrary polygon/triangle/square detection, gallery, provider calls, and any live evidence.

## P20. Counting Renderer and Complete Registry Gate — 2026-11-04

**State:** implemented, offline-verified; awaiting user acceptance. This phase adds the counting SVG/PNG renderer, the strict ten-family spec union, and the complete ten-engine/five-renderer registry gate. No provider call, report, gallery, or live evidence exists.

**Files**

- Renderer: `src/families/counting/render.ts`
- Strict ten-family spec union and parsers: `src/domain/spec.ts`
- Registry: `src/families/registry.ts` registers `countingRenderer`
- Tests: `tests/render/counting.test.ts`, `tests/families/registry.test.ts`
- Updated test: `tests/families/counting.test.ts` now expects the counting renderer
- Documentation: `docs/families.md`, `README.md`, this file

**Observable behavior**

- The source is a fixed 5x5 grid of 76-pixel cells. Each cell has a white fill and a fixed 8-pixel `#333333` outline.
- Every cell contains one fixed marker per actual shape. A is a square, B is a circle, and C is a triangle. Filled `#111111` means member; an outline-only glyph with `#111111` stroke means non-member. Membership is never encoded only by a translucent cell fill.
- The overlap legend renders every non-empty combination. Two-shape specs show `A`, `B`, and `AB`; three-shape specs show `A`, `B`, `AB`, `C`, `AC`, `BC`, and `ABC`. The legend states `Filled = member. Outline = not a member.`
- The stem prints the exact code-owned query, the shape labels, the marker order, and the counting convention. Four A-D tiles show distinct integers in 0..25; exactly one satisfies the independent checker.
- `assertCountingScene` validates critical groups `source-grid`, `membership-legend`, and `option-A-number`..`option-D-number`, all 25 fixed source cells, every fixed marker position and fill, the complete legend, the exact query text, and four distinct choices with one correct answer. Negative fixtures cover hidden source/legend overlaps, missing markers, missing legend, color-only cells, wrong query text, and duplicate choices.
- `src/domain/spec.ts` exposes `FAMILY_SPEC_SCHEMAS`, `FamilySpecEnvelopeSchema`, `parseFamilySpec`, `safeParseFamilySpec`, and `safeParseFamilySpecEnvelope`. The envelope is a strict discriminated union on `family` over the ten real family schemas; raw `unknown` input must be parsed before it can be accepted as a spec.
- `tests/families/registry.test.ts` asserts all ten engines and all five real renderers, matching family/modality pairs, no text renderer, non-empty visible rules and fact inventories, one unique solution, four distinct options with one correct answer, canonical family data, deterministic mutations, and a valid 1024x1024 scene from every SVG renderer at all three difficulties.
- The 100 seeded renderer fixtures rasterized with bounds and four distinct numeric choices. All seven non-empty three-shape memberships are rendered as distinct glyph combinations. Fixed and ten seeded critical-group removals changed at least eight non-background pixels.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec vitest run tests/render/counting.test.ts tests/families/registry.test.ts` | exit 0; 2 files / 11 tests passed. |
| `npm run preview -- --family counting --seed preview-v1` | exit 0; full `316be4d8fad238ddf43f764653a36af7a729b66bd82765194aece954538632b8`, preview `bc2caa8d7f4c1cfad703be8626f394cab88132ce278bb84643142fa61b9be89c`. |
| `npm run preview -- --family counting --seed preview-v1 --difficulty 3` | exit 0; full `35b8f7b2847d56b23baf9addce7720477dd23341ddb99b9cab1f2bfdd1fcc42f`, preview `d8b5c99165e014a76bb6b6e8bda8576485a034a85b26bfe9287a4654bf81a5b8`. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 21 files / 296 tests passed, build succeeded. |

**Manual acceptance steps**

1. Run the exact commands below.
2. Open `data/previews/p20-two/counting-preview-v1-512.png` and confirm all 25 cells show an A square and a B circle, filled for members and outline-only for non-members, with AB overlaps visible and the legend showing `A`, `B`, `AB`.
3. Open `data/previews/p20-three/counting-preview-v1-512.png` and confirm every cell shows three markers, the legend shows all seven combinations `A`, `B`, `AB`, `C`, `AC`, `BC`, `ABC`, and the query reads `Query: cells in exactly 2 shapes.` for the default level-3 query.
4. Confirm the four option tiles show four distinct numbers and exactly one is the independently computed count.
5. Run `npm run check` and confirm 21 files / 296 tests pass without an API key or network access.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec vitest run tests/render/counting.test.ts tests/families/registry.test.ts --reporter=verbose
npm run preview -- --family counting --seed preview-v1 --out data/previews/p20-two
npm run preview -- --family counting --seed preview-v1 --difficulty 3 --out data/previews/p20-three
npm run check
```

Expected: 11 focused tests pass; both preview commands exit 0 and print `family: counting` plus the full/preview hashes above; `npm run check` exits 0 with 21 files / 296 tests. Open `data/previews/p20-two/counting-preview-v1-512.png` and `data/previews/p20-three/counting-preview-v1-512.png` and confirm the 5x5 cell membership, the filled/outlined square/circle/triangle markers, the all-overlap legend, the exact query, and four distinct numeric choices.

**Acceptance:** accepted by the user on 2026-11-04 after the focused suite, exact non-UI script, preview inspection, and `npm run check` evidence.

**Out of scope, unchanged:** provider calls, reports, gallery, live evidence, and any arbitrary polygon/triangle/square shape detection.

## P21. Structural Fingerprints and Deterministic Duplicate Barrier — 2026-11-04

**State:** implemented, offline-verified; awaiting user acceptance. This phase adds a pure validation layer over the completed canonical data. No provider call, report, gallery, runner, or live evidence exists.

**Files**

- Fingerprints: `src/validation/fingerprints.ts`
- Deterministic barrier: `src/validation/duplicates.ts`
- Candidate assessment schemas: `src/domain/candidate.ts`
- Tests: `tests/validation/duplicates.test.ts`
- Documentation: `docs/experiment-protocol.md`, `README.md`, this file

**Observable behavior**

- Each candidate fingerprint separates `contentHash` (strict visible question/rules/clues/options/hint/explanation projection), `specHash` (complete parsed DSL in canonical JSON), `structureHash` (family `canonicalData` with its reduced core), and separate SVG/PNG render hashes. Text candidates carry no render hashes.
- Structural features use P04's `q:`, `r:`, and `g:` multiset. Raw JSON/text hashes are never used as structural fingerprints.
- The barrier requires one candidate record for every planned slot. Missing slots and `incomplete`/budget-paused slots raise `INCOMPLETE_PREPARATION`; a pause is not completion.
- Exact content, canonical spec, and structural duplicate groups are family-scoped across both lanes. For visual candidates the exact-content key also includes the PNG render hash, so a shared text shell alone cannot reject a distinct diagram. Processing is exact content -> canonical spec -> structural; the lowest eligible slot ordinal owns each group and later eligible members are rejected. Exact/spec duplicates record `EXACT_DUPLICATE`; structural duplicates record `STRUCTURAL_DUPLICATE`.
- Failed or incomplete presentations cannot own or suppress a usable candidate. Formal-passed early failures remain ineligible but contribute diagnostic pair evidence; terminal verdicts are preserved unchanged.
- Near detection is limited to the same `(family, domainTokens, queryKind)`, unequal structure hashes, at least one common feature, and multiset edit distance exactly one. Both eligible members are flagged `NEAR_DUPLICATE_SUSPECTED`; Jaccard is diagnostic only. The mandatory counting pair (`k=2` versus `k=3`) produces edit distance 1 and Jaccard 33/35.
- Exact PNG matches across visual families are a separate diagnostic pair and never change ownership.
- Assessments are frozen and self-contained: hashes, canonical structure, feature multiset, eligibility, fingerprintable flag, group-owner flag, outcome, owner, duplicate kind, near-pair IDs, failure codes, and preserved terminal verdict. Pair evidence carries comparison metrics for near pairs. `resultHash` covers the canonical result with the hash field excluded.
- Summary counters report planned/prepared/ready/early/eligible/fingerprintable/ineligible, groups by kind, duplicates by kind, near pairs, near-suspected candidates, diagnostic pairs, visual exact diagnostics, and explicit zero replacements and zero rewritten terminal failures.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec vitest run tests/validation/duplicates.test.ts` | exit 0; 1 file / 18 tests passed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 22 files / 313 tests passed, build succeeded. |

The focused suite covers content/spec/structure/render separation, relabelings, known redundant clues, nonredundant added clues, exact/spec/structural ownership across lanes, shuffled completion order, the mandatory counting one-edit pair and both flag directions, two-edit and zero-overlap negatives, different comparison scopes, identical canonical data with unequal hashes, distinct transform step sequences, visual exact-content PNG matching, exhaustive early-failure diagnostics, preserved terminal verdicts, cross-family visual exact diagnostics, incomplete-barrier refusal, immutable assessments, result-hash tampering, and zero replacements.

**Manual acceptance steps**

1. Run the exact non-UI script below.
2. Confirm the focused test `is byte-identical for the same cohort in different completion orders` passes, proving the same prepared cohort yields identical owners and flags regardless of completion order.
3. Confirm the focused test `assigns exact, spec, and structural duplicates to the lowest eligible ordinal across lanes` rejects the redundant-clue variant as a structural duplicate despite its different raw spec JSON.
4. Confirm the mandatory counting test reports both members as `NEAR_DUPLICATE_SUSPECTED` with edit distance 1 and Jaccard 33/35.
5. Confirm `npm run check` passes with 22 files / 313 tests and no API key or network access.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec -- vitest run tests/validation/duplicates.test.ts --reporter=verbose
npm run check
```

Expected: the focused suite exits 0 with 18 passing tests and includes the shuffled-order, redundant-clue structural-duplicate, mandatory counting near-pair, transform-step, visual exact-content PNG, exhaustive early-failure, and incomplete-barrier cases; `npm run check` exits 0 with 22 files / 313 tests and a successful build.

**Decision-reviewer:** the first pass found three material findings (one medium, two low): a schema-valid structureless formal-passed fingerprint could surface as a raw ZodError; same-family visual exact-content grouping ignored the PNG hash; and group diagnostics omitted early-failure pairs against non-first members. All three were fixed with a canonical-structure input requirement plus typed `INVALID_FINGERPRINT` defense, a visual exact-content key that includes the PNG hash, and exhaustive diagnostic pair loops. A second pass verified the fixes and reported no material findings and no material regression.

**Acceptance:** accepted by the user on 2026-11-05 after the focused 17-test suite, the exact non-UI script, and the full `npm run check` evidence.

**Out of scope, unchanged:** generation, slot preparation, runner orchestration, reviews, primary verdict reduction, reports, gallery, provider calls, and any claim that the reduced-core proxy detects all logically equivalent clue sets.

## P22. Visible Presentation Assembly and Mechanical Semantic Checks — 2026-11-05

**State:** implemented, offline-verified; awaiting user acceptance. This phase adds the deterministic public/reveal presentation boundary. No model call, prompt builder, raw-response persistence, semantic alignment review, or HTML gallery exists.

**Files**

- Shared presentation schemas: `src/domain/presentation.ts`
- Strict wording schema and fixture wording: `src/presentation/wording.ts`
- Presentation assembly and P21 content projection: `src/presentation/assemble.ts`
- Structural presentation validation: `src/validation/presentation.ts`
- Tests: `tests/presentation/assemble.test.ts`
- Documentation: `docs/experiment-protocol.md`, `README.md`, this file

**Observable behavior**

- The wording response is strict: `question` 1..400, at most 12 `clueTexts` of 1..200 each, `hint` 1..300, and at most 8 `explanationSteps` of 1..240 with bounded fact-ID lists. Blank-only strings are rejected. HTML/script-like strings are stored verbatim as plain data.
- Code-owned `VisibleRules` and A-D option values/labels always come from the family engine. Option text is code-owned per family: ordered labels for ranking, A-to-B/C tables for matching, event-to-slot/resource tables for scheduling, truth vectors, arithmetic tuples, `See labeled tile A/B/C/D` for matrix/transforms/paths/symmetry, and the actual integer for counting.
- Text wording must cover every local `fNNN` clue fact exactly once; SVG wording must leave `clueTexts` empty. Explanation references must exist in the merged five-rule, local-or-observation, and `sNNN` proof inventory. Missing, extra, duplicate, non-local, and unknown references are rejected.
- Choices must be four ordered A-D options with exactly one independently correct option, a matching stored `correctLabel`, and a correct value equal to the independent solve result.
- `VisiblePresentation` contains only public fields (`version`, `slotId`, `family`, `modality`, `question`, `rules`, `clues`, `options`, `assets`) and never the key, hint, explanation, or proof. `RevealData` separately carries `correctLabel`, `correctValue`, `hint`, `explanationSteps`, and the solve proof.
- SVG presentations require both stored SVG and PNG hashes; text presentations require both to be null. The assembly stores the supplied hashes rather than inventing them.
- Mechanical checks are reported as `pass`; `semanticAlignment` is always `semantic_alignment_pending`. A correct-ID paraphrase, a same-ID contradiction, or possible answer leakage is retained and remains pending, never silently repaired or mechanically declared true.
- `makeFixtureWording` is deterministic and labeled `source: "fixture"` for tests/previews only. Model wording uses `source: "model"` through the same assembly checks.
- `fingerprintContentFor` exposes the exact P21 content projection from the assembled visible text/options plus the reveal hint/explanation.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/presentation/assemble.test.ts --reporter=verbose` | exit 0; 1 file / 12 tests passed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 23 files / 325 tests passed, build succeeded. |

The focused suite assembles all ten families, checks public/reveal separation, code-owned rules/options, text clue-fact coverage, missing/extra/duplicate facts, unknown proof references, every wording length bound, wrong ordered choices, wrong stored labels, malformed choice sets, HTML/script strings retained verbatim, missing/extra image hashes, invalid specs, slot mismatches, proof references, fixture determinism, the typed re-validation taxonomy, and a same-ID semantic contradiction that stays pending.

**Manual acceptance steps**

1. Run the exact non-UI script below.
2. Confirm the all-family test assembles ten presentations and that `Object.keys(visible)` contains no `correctLabel`, `correctValue`, `hint`, `explanationSteps`, or `proof`.
3. Confirm the reveal object separately contains the correct label/value, hint, explanation, and proof.
4. Confirm the same-ID contradiction test leaves `semanticAlignment` at `semantic_alignment_pending` and retains the contradictory text.
5. Confirm `npm run check` passes with 23 files / 325 tests and no API key or network access.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec -- vitest run tests/presentation/assemble.test.ts --reporter=verbose
npm run check
```

Expected: the focused suite exits 0 with 12 passing tests covering all ten families and the public/reveal, fact-coverage, length, option-order, HTML-retention, missing-asset, invalid-spec, typed re-validation, proof-reference, and semantic-pending cases; `npm run check` exits 0 with 23 files / 325 tests and a successful build.

**Decision-reviewer:** the first pass found three Low findings: exported validators leaked raw ZodError and two advertised codes were unreachable; `assemblePresentation` did not validate the spec against the family schema; and the structural validator did not enforce empty SVG `clues`. All three were fixed with typed `safeParse` conversion, reachable raw pre-parse checks, `INVALID_SPEC`, and the SVG clue rule. A second pass found one residual Low finding (unvalidated `choices` input); it was fixed with a `ChoiceSetSchema` gate. A third pass found that the new regression assertion did not discriminate that gate; a direct `choices: null` case now does. A fourth pass verified the fix and reported no material findings and no regression.

**Acceptance:** accepted by the user on 2026-11-05 after the focused 12-test suite, the exact non-UI script, and the full `npm run check` evidence.

**Out of scope, unchanged:** model wording calls, prompt construction, raw-response persistence, semantic alignment review, blind/alignment DTOs, gallery, reports, and any claim that mechanical checks prove arbitrary English semantics.

## P23. Request Ledger and Transactional Budget Admission — 2026-11-05

**State:** implemented, offline-verified; awaiting user acceptance. This phase adds durable request accounting and budget admission without HTTP. Fetch, retry timing, live price estimation, provider calls, and automatic resume remain out of scope.

**Files**

- Migration: `src/storage/migrations/0002_requests.sql`
- Logical calls, attempts, and request events: `src/ai/ledger.ts`
- Decimal accounts, reservations, settlement, and summaries: `src/ai/budget.ts`
- Tests: `tests/ai/budget.test.ts`
- Updated migration expectation: `tests/storage/checkpoints.test.ts`
- Dependency: pinned `decimal.js` 10.6.0 in `package.json`/`package-lock.json`
- Documentation: `docs/experiment-protocol.md`, `README.md`, this file

**Observable behavior**

- `logical_calls` enforces one intent per `(run, slot, role)` or per probe/role with partial unique indexes for run-scoped and global calibration/preflight probes. Requests store canonical request body/hash (64 KiB text excluding base64, 1 MiB decoded PNG, 2 MiB stored), expected schema hash, role/model/provider, output-cap field, pool, and state.
- `request_attempts` stores one to three attempts per call with request bytes/hash, HTTP status, response/generation IDs, raw-response artifact reference, finish reason, nullable prompt/completion/total/cached/reasoning tokens, price estimate, actual cost, cost status, error classification, partial-completion flag, UTC times, and elapsed milliseconds.
- States are `prepared -> dispatching -> response_saved -> validated`, with terminal `refused_unprocessed`, `failed_known`, and `uncertain`. `dispatching` is persisted before fetch. Resume classifies prepared as sendable, dispatching without a response as `uncertain_no_resend`, and saved/validated responses as reusable.
- Certified unprocessed refusals require HTTP 429 or 503 `no_eligible_provider`, no generation ID, no usage, no actual cost, and no partial completion. Other failures are never silently replayed.
- Money uses canonical decimal strings via `decimal.js`; `0.1 + 0.2` is exactly `0.3`. Admission checks `known_actual + reserved + next_reservation <= maxCost` inside one transaction. Reservations are per attempt; nonbilling reservations must be zero.
- Explicit `usage.cost = 0` settles as known zero. Missing actual cost keeps the reservation and increases `unknownExposureUsd`; unknown exposure remains visible in account and role/run-kind summaries and prevents false zero-cost reporting.
- Actual cost above reserve records `overshoot` and blocks new admissions. Cap-crossing admission records `pause`, sets a run to `paused_budget`, and returns `INSUFFICIENT_BUDGET`; later nonbilling calls are the only exception. Certified unprocessed refusals release reservations.
- Pools are separate for primary (full), smoke, calibration, and preflight. Calibration and main spending cannot share an account. Summary output groups known/reserved/unknown by role and run kind.
- `budget_events` and `request_events` are append-only with update/delete abort triggers. Logical calls, attempts, reservations, and accounts cannot be deleted.
- Cap increases require `acknowledged: true` plus an operator; the `cap_change` event stores old/new cap, time, operator, and acknowledgement. P23 does not automatically resume a paused run.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/ai/budget.test.ts --reporter=verbose` | exit 0; 1 file / 18 tests passed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 24 files / 343 tests passed, build succeeded. |

The focused suite covers unique slot/probe keys, run-kind mismatches, duplicate logical calls, prepared/dispatching crash dispositions, reservation-before-dispatch enforcement, three-attempt cap, text/PNG request bounds and hash mismatches, exact `0.1 + 0.2`, cross-process overlapping admission, explicit zero versus missing cost, unknown-kind exposure without double counting, actual overshoot and pause, unknown retention/release, insufficient-budget pause, calibration/primary separation, zero-budget nonbilling, duplicate reservations, append-only triggers, and acknowledged cap changes.

**Manual acceptance steps**

1. Run the exact non-UI script below.
2. Confirm the overlapping-admission test admits only one `0.2` reservation against a `0.3` account; the child holds the write lock, the parent waits, and the parent cannot spend the same remaining budget.
3. Confirm explicit zero settles as known `0` while a missing actual cost leaves `unknownExposureUsd = 0.2` and blocks the same remaining budget.
4. Confirm `npm run check` passes with 24 files / 343 tests and no API key or network access.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec -- vitest run tests/ai/budget.test.ts --reporter=verbose
npm run check
```

Expected: the focused suite exits 0 with 18 passing tests covering the boundary, overlapping admissions, decimal, zero/unknown, overshoot, unknown-retention, pause, calibration/main, nonbilling, append-only, cap-change, vision request bounds, run-kind, reservation-precondition, and typed busy-lock cases; `npm run check` exits 0 with 24 files / 343 tests and a successful build.

**Decision-reviewer:** the first pass found five material findings: the 64 KiB request cap incorrectly included embedded base64 (High), dispatching lacked a reservation precondition (Medium), and unknown-kind exposure, run-kind consistency, and concurrent admission handling had Low defects. All five were fixed with split text/PNG/stored bounds and SQL checks, a dispatch reservation precondition, symmetric unknown-exposure accounting, stored run-kind comparison, an immediate admission transaction with typed `BUDGET_BUSY`, and a cross-process overlap test. A second pass confirmed those fixes and found two residual Low issues: summary unknown attribution for still-reserved unknown-kind rows, and a probabilistic overlap test. Both were fixed by attributing unknown exposure at admission and by making the child hold an immediate transaction across the parent admission. A third pass confirmed the summary fix and asked for a deterministic overlap test; the child-held transaction now guarantees the deferred implementation would fail. A fourth pass verified the test and reported no material findings and no regression.

**Acceptance:** accepted by the user on 2026-11-05 after the focused 18-test suite, the exact non-UI script, and the full `npm run check` evidence.

**Out of scope, unchanged:** fetch, retries, live price estimation, provider calls, automatic resume, reports, gallery, and any claim of exactly-once billing.

## P24. OpenRouter Transport and Conservative Retry Policy — 2026-11-05

**State:** implemented, offline-verified; awaiting user acceptance. This phase adds a locally tested non-streaming transport. No paid request, live provider call, provider fallback, JSON repair, model selection, or automatic resume exists.

**Files**

- Transport: `src/ai/openrouter.ts`
- Retry policy: `src/ai/retry.ts`
- Credential redaction: `src/ai/redact.ts`
- Tests: `tests/ai/openrouter.test.ts`
- Loopback fake server: `tests/helpers/fake-openrouter.ts`
- Retry deadline persistence: `src/storage/migrations/0003_retry_not_before.sql`, `src/ai/ledger.ts`
- Documentation: `docs/experiment-protocol.md`, `README.md`, this file

**Observable behavior**

- The production host is fixed to `https://openrouter.ai/api/v1`; custom base URLs are accepted only for loopback test servers. Clock, random source, and fetch are injectable for tests.
- The transport sends the stored logical-call intent with `stream:false`, `json_schema` response format, exactly one provider route, and exactly one output-cap field. It revalidates the P23 split request bounds and canonical hash before dispatch.
- Default deadline is 90 seconds; default response cap is 2 MiB. The raw response is stored as a `raw_response` artifact before parsing or validation. Oversized responses are truncated for evidence and classified uncertain.
- API keys are never stored. Raw response text and diagnostics are redacted; request headers are not persisted.
- HTTP 200 top-level and choice-level errors are inspected. Strict finish reason `stop` plus nonempty valid JSON is required for success.
- Outcomes: `success`, `refused_unprocessed`, `failed_known`, `uncertain`, `paused_budget`, `paused_retry_after`, and `already_dispatching`.
- Only certified 429/no-provider-503 refusals are retried, at most two additional attempts. Delays are 500 ms then 1000 ms plus seeded 0–250 ms jitter; valid Retry-After up to 30 s replaces the delay; longer waits pause. Timeouts, disconnects, generic 5xx, HTTP-200 error bodies, provider errors, refusals, malformed output, and auth/payment failures are never retried.
- Refused-unprocessed reservations are released. Known failures and uncertain outcomes settle actual cost when present and retain unknown exposure otherwise. Prepared attempts remain resumable after budget pause; a dispatching attempt without a saved response is never silently resent.
- Contending connections share one prepared attempt created inside an immediate transaction. Reused reservations are checked for account, call binding, run state, pause, kind, amount, and cap; nonbilling calls keep their cap exemption. A dispatch loser releases a reservation only when this invocation created it and the attempt is still unclaimed; it never releases the winner's in-flight reservation. Missing reservations map to `RESERVATION_REQUIRED`; genuine dispatch races map to `CONCURRENT_DISPATCH`.
- A bounded read-only generation lookup updates missing actual cost/tokens and settles a matching reservation; it never regenerates content.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/ai/openrouter.test.ts --reporter=verbose` | exit 0; 1 file / 26 tests passed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 25 files / 369 tests passed, build succeeded. |

The focused suite uses a loopback fake server and covers success, prepared-attempt reservation reuse, contending shared-attempt creation, account-aware reuse rejection, reservation amount/kind policy, already-dispatching no-resend, nested malformed usage fields, API-key redaction inside content, persisted Retry-After, 429 then success, no-provider 503 with Retry-After, long Retry-After pause, 401/402/403, 500/502, HTTP-200 error body, provider rate error after generation ID, 429 with generation/usage, timeout, disconnect, content refusal, reasoning-only/length output, malformed body, invalid JSON content, missing cost, oversized response, three-attempt cap, invalid request shapes, generation reconciliation, reconciliation of known cost refusal, identical retry hashes, no hidden retries, and no credential in the database.

**Manual acceptance steps**

1. Run the exact non-UI script below.
2. Confirm the 429/no-provider tests record `refused_unprocessed` and release the reservation, while the timeout/disconnect/5xx/200-error tests record `uncertain` and retain unknown exposure.
3. Confirm no test makes more than three attempts or retries a non-allowlisted failure.
4. Confirm the saved usable response is validated and the raw response artifact exists without the API key.
5. Confirm `npm run check` passes with 25 files / 369 tests and no API key or real network access.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec -- vitest run tests/ai/openrouter.test.ts --reporter=verbose
npm run check
```

Expected: the focused suite exits 0 with 26 passing tests covering the refusal/uncertain distinction, retry allowlist, Retry-After persistence, attempt cap, raw-response/redaction, strict finish reasons, request validation, prepared-reservation reuse, account-aware reuse, reservation amount/kind policy, shared prepared attempt, already-dispatching guard, defensive response parsing, and generation reconciliation; `npm run check` exits 0 with 25 files / 369 tests and a successful build.

**Decision-reviewer:** the first pass found six material findings (two Medium, four Low) around reservation reuse, defensive response parsing, Retry-After persistence, reconciliation overwrite, partial-completion semantics, and unredacted content; all were fixed. A second pass confirmed those fixes and found two Low reuse-path issues (foreign-account reuse and non-atomic dispatch); both were fixed. A third pass found five further reuse-path issues (one Medium stranded reservation and four Low policy/error-mapping/test issues); all were fixed. A fourth pass confirmed those fixes and found three residual issues (Medium release ownership, Low sequential shared-attempt test, Low nonbilling cap exemption); all were fixed. A fifth pass reported no material findings and no regression.

**Acceptance:** accepted by the user on 2026-11-05 after the focused 26-test suite, the exact non-UI script, and the full `npm run check` evidence.

**Out of scope, unchanged:** paid requests, live provider calls, provider fallback, JSON repair, model selection, automatic resume, reports, gallery, and any claim of exactly-once billing.

## P25. Strict Role Schemas, Capabilities, and Offline Preflight — 2026-11-05

**State:** implemented, offline-verified, and accepted by the user on 2026-11-05. This phase adds provider-facing strict schemas, explicit live-input validation, exact catalog route checks, and an offline preflight. It makes no paid call, live provider request, model selection, catalog archive, or live probe execution.

**Files**

- Schemas: `src/ai/schemas.ts`
- Live inputs and request builder: `src/ai/config.ts`
- Catalog and route preflight: `src/ai/preflight.ts`
- CLI: `src/cli/preflight.ts`
- Tests: `tests/ai/preflight.test.ts`
- Recorded catalog fixture: `tests/fixtures/openrouter/catalog.json`
- Empty live-input template: `.env.example`
- Script: `package.json`
- Documentation: `README.md`, `docs/experiment-protocol.md`, this file

**Observable behavior**

- All ten family spec schemas, family envelopes, wording, blind review, and alignment review compile to provider-compatible strict JSON Schema. Every object has `additionalProperties: false`; `oneOf`, `const`, tuple `items`, and unsupported keywords are normalized or rejected.
- Blind review has a strict answer status, nullable choice, bounded evidence issues, and a consistency rule between status and choice. Alignment review has per-field status, cited fact IDs, and reasons; `deriveAlignmentOverall` ignores the model-reported `overall` and rejects improper `not_applicable`.
- Live inputs have no defaults. `OPENROUTER_API_KEY`, all three model IDs, and all three exact provider tags are required. Generator and text/vision reviewer model IDs must differ; vision may reuse the text reviewer, and shared correlations are reported.
- `buildChatRequest` sends `stream:false`, strict `json_schema`, exactly one provider tag with no fallbacks, and exactly one of `max_tokens`/`max_completion_tokens`. Text roles reject image parts; vision roles require a PNG data URL.
- Offline preflight resolves one exact active endpoint tag per model. It rejects missing models, base-slug wildcards, duplicate tags, inactive endpoints, missing `structured_outputs`, missing cap fields, insufficient output/context/prompt limits, missing text/image modalities, unknown/invalid/unsupported pricing, missing image pricing without a documented reserve, and unsupported settings.
- `npm run preflight -- --offline` validates the recorded fixture and prints each role's resolved model, exact endpoint, frozen cap field/value, context, prompt reserve, image declaration, vision-probe requirement, schema name, and schema hash. It uses no network and no inference key.
- Public catalog GETs accept only the inference key and fail closed on 403 with one request, no retry, and no management credential.
- Live probe construction requires explicit paid authorization, a positive cost cap, an inference key, separated routes, and an actual PNG. It builds exactly three bounded probes and is not executed in P25. `executeLiveProbePlan` creates `preflight` logical calls with `runKind: preflight` for P46.
- The CLI rejects `--live` even with `--allow-paid` and `--max-cost`; P46 owns live execution and all-family smoke.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/ai/preflight.test.ts --reporter=verbose` | exit 0; 1 file / 34 tests passed. |
| `npm run preflight -- --offline` | exit 0; 6 fixture roles resolved, `result: ok`, no network or key. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 26 files / 403 tests passed, build succeeded. |

The focused suite covers strict schema compilation for all families and review roles, schema hash stability, blind/alignment contracts, extra-field rejection, role separation, missing key/model/provider, wildcard providers, single-cap serialization, image-role binding, exact tag/base/duplicate/inactive failures, missing structured outputs/cap/image modalities, output/context/prompt limits, unknown/invalid/unsupported pricing, image reserve behavior, unsupported settings, invalid role schemas, no-network/no-key offline operation, 403 fail-closed catalog access, catalog architecture merging, live-probe authorization, non-separated live routes, and CLI flag handling.

**Manual acceptance steps**

1. Run the exact non-UI script below.
2. Confirm `npm run preflight -- --offline` prints `network: not used`, `inference_key: not required`, six `role …: ok` lines, and `result: ok`.
3. Confirm the fixture's generator chooses `cap=max_tokens:8192` while the vision route chooses `cap=max_completion_tokens:4096`.
4. Confirm the vision role prints `image=declared vision_probe=required`; the text roles print `image=not_required`.
5. Confirm the focused suite includes the negative capability cases: a multimodal-sounding model whose architecture omits `image` fails with `MISSING_IMAGE_INPUT_MODALITY`, and a base provider slug fails with `PROVIDER_TAG_BASE_WILDCARD`.
6. Confirm `npm run check` passes with 26 files / 403 tests and no API key or real network access.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm run preflight -- --offline
npm exec -- vitest run tests/ai/preflight.test.ts --reporter=verbose
npm run check
```

Expected: the offline preflight exits 0 with six resolved fixture roles and no network/key use; the focused suite exits 0 with 34 passing tests; `npm run check` exits 0 with 26 files / 403 tests and a successful build.

**Decision-reviewer:** the first pass found one confirmed Medium finding: the counting family query declared an optional `k`, so `puzzle_spec_counting` and its envelope left `query.k` out of `required` and were not provider-compatible strict schemas. The fix replaces the optional field with a two-branch discriminated union (`exactlyKShapes` requires `k` as `2 | 3`; other operations forbid `k`), tightens `assertStrictJsonSchema` and the focused test helper so every declared property must appear in `required`, and preserves the spec-level `k <= shapes` check. A second pass confirmed the defect resolved and found no new material defect or regression in the counting family, compiled schemas, or preflight.

**Acceptance:** accepted by the user on 2026-11-05 after the offline preflight, the focused 34-test suite, and the full `npm run check` evidence.

**Out of scope, unchanged:** live catalog archiving, model selection, paid probes, all-family smoke, provider fallback, reports, and the gallery.

## P26. One-Shot AI Specification Proposer — 2026-11-05

**State:** implemented, offline-verified, and accepted by the user on 2026-11-05. This phase adds one-shot strict spec proposals, family/difficulty validation, independent-engine uniqueness checks, and saved `spec_ready` evidence. It makes no live provider call, paid request, wording call, option generation, or fallback to programmatic construction.

**Files**

- Adapter: `src/ai/propose-spec.ts`
- Prompt assets: `src/ai/prompts/v1/spec.txt`, `src/ai/prompts/v1/family-guidance.json`
- Tests: `tests/ai/propose-spec.test.ts`
- Ledger integration: `src/ai/ledger.ts` (`recordRequestEvent`)
- Build assets: `scripts/copy-assets.mjs` copies prompts into `dist/ai/prompts/`
- Documentation: `README.md`, `docs/experiment-protocol.md`, this file

**Observable behavior**

- The adapter builds the P25 family envelope response schema with fixed family, IDs/domain, and difficulty guidance. The request uses role `spec`, the exact resolved model/provider/cap, and no slot/seed metadata.
- The system prompt carries `prompt_version: v1`, `prompt_hash`, `schema_name`, `schema_version: v1`, and `schema_hash`. The same metadata is stored in a `proposal_metadata` request event, `logical_calls.expected_schema_hash`, and the `spec_ready` payload.
- Exactly one content proposal is accepted. The adapter rejects supplied answers, answer keys, options, prose, hints, explanations, SVG/HTML, and arbitrary constraint strings; strict family schemas reject every extra field.
- The requested family must match the response envelope; the requested difficulty bounds are enforced per family before and after the independent engine check.
- The parsed spec is passed to the independent `productionRegistry` engine. Exactly one solution and one answer are required; unsat, multiple solutions, and solver exhaustion are explicit failures.
- On success, `spec_ready` stores the spec, family/difficulty, prompt/schema metadata, logical call/attempt IDs, model/provider/cap, usage/cost, and formal counts. The answer and proof are returned to the caller but are not stored in the public stage payload.
- On failure, the slot remains `planned`, no `spec_ready` stage is written, and the raw response artifact, attempt, and cost remain queryable. No programmatic fallback or hidden second content proposal occurs.
- The build copies prompt assets into `dist/ai/prompts/`.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/ai/propose-spec.test.ts --reporter=verbose` | exit 0; 1 file / 11 tests passed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 27 files / 414 tests passed, build succeeded and copied prompt assets. |

The focused suite covers valid and invalid responses for all ten families, wrong family, out-of-domain IDs, extra answer/options/prose, unsat/multiple solutions, refusal/truncation, one saved content proposal without hidden retry, all per-family difficulty bounds, symmetry axis binding, the two-constraint level-3 arithmetic edge case, route-role rejection, prompt/schema metadata stability, paths 4x4 guidance, saved raw response/cost, and `spec_ready` provenance. All responses come from the local fake; no real network or paid call was made.

**Manual acceptance steps**

1. Run the exact non-UI script below.
2. Confirm the focused suite reports 11 passing tests, including `rejects an invalid schema for every family and leaves the slot planned`, `rejects refusal and truncation with one saved content proposal`, `binds the symmetry axis to the requested difficulty`, and `reports a two-constraint level-3 arithmetic spec as a typed difficulty failure`.
3. Confirm `npm run check` reports 27 files / 414 tests and a successful build.
4. Confirm `dist/ai/prompts/v1/spec.txt` and `dist/ai/prompts/v1/family-guidance.json` exist after the build.
5. Confirm the focused test asserts that a malformed first proposal leaves the slot at `planned`, saves the raw response artifact and cost, writes no `spec_ready` stage, and sends exactly one request.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec -- vitest run tests/ai/propose-spec.test.ts --reporter=verbose
npm run check
ls -l dist/ai/prompts/v1/spec.txt dist/ai/prompts/v1/family-guidance.json
```

Expected: the focused suite exits 0 with 11 passing tests; `npm run check` exits 0 with 27 files / 414 tests and a successful build; both prompt assets exist under `dist/ai/prompts/v1/`. No live provider call or paid request is made.

**Decision-reviewer:** the first pass found four confirmed defects: the paths guidance stated a 5x5 grid instead of the DSL's 4x4 grid (Medium); symmetry did not bind level 1 to a vertical axis or level 2 to a horizontal axis (Low); `FORBIDDEN_FIELD` omitted the logical call/attempt/result evidence (Low); and a two-constraint level-3 arithmetic spec could escape as an untyped Zod error during the nonredundancy check (Low). Fixes corrected the paths guidance, added the symmetry axis rules to guidance and validation, passed ledger evidence into `FORBIDDEN_FIELD`, and padded a one-constraint subset with a duplicate before solving while converting residual check failures into `DIFFICULTY_OUT_OF_BOUNDS`. Regression tests cover the paths 4x4 text, symmetry axis binding, forbidden-field evidence, and the two-constraint arithmetic case. A second pass confirmed all four findings resolved and found no new material defect or regression; it recorded one pre-existing arithmetic construction edge outside the P26 proposer path as an out-of-scope pointer for the owning family phase.

**Acceptance:** accepted by the user on 2026-11-05 after the focused 11-test suite, the exact non-UI script, and the full `npm run check` evidence.

**Out of scope, unchanged:** wording, option generation, provider fallback, JSON repair, live experimentation, reports, and the gallery.

## P27. AI Wording, Hint, and Explanation Adapter — 2026-11-05

**State:** implemented, offline-verified, and accepted by the user on 2026-11-05. This phase adds one strict wording call per eligible slot, original wording persistence, P22 mechanical assembly, and `presentation_ready` evidence. It makes no live provider call, paid request, blind review, alignment review, repair loop, or fallback wording generation.

**Files**

- Adapter: `src/ai/write-wording.ts`
- Prompt asset: `src/ai/prompts/v1/wording.txt`
- Tests: `tests/ai/write-wording.test.ts`
- Documentation: `README.md`, `docs/experiment-protocol.md`, this file

**Observable behavior**

- The adapter requires a `formal_checked` slot, a resolved `wording` route with no image requirement, a validated spec/solve/choices, and presentation assets for SVG. It runs a P22 preflight with fixture wording before making any model request.
- The request uses the P25 `puzzle_wording` strict schema and supplies the validated spec, visible rules, local/rule/proof fact inventory, local fact IDs, proof, correct option, and all option values/texts. The generator may see the key because it writes reveal-only hint/explanation text.
- The adapter reads the slot's stored `formal_checked` stage evidence (`spec`, `solveResult`, `choices`), rejects caller artifacts that differ from it, and independently re-enumerates solutions before sending the request.
- The system prompt carries `prompt_version: v1`, `prompt_hash`, `schema_name: puzzle_wording`, `schema_version: v1`, and `schema_hash`. A `wording_metadata` request event stores the same provenance with family/modality/difficulty; `logical_calls.expected_schema_hash` stores the schema hash.
- Exactly one wording content proposal is accepted. No repair, truncation, templated substitution, second wording prompt, or programmatic wording fallback occurs.
- Missing/duplicate clue facts, unsupported explanation fact IDs, SVG clue-text transcription, invalid option facts, and invalid assets fail P22 mechanical checks. The slot stays `formal_checked`, no `presentation_ready` is written, and the raw response, attempt, and cost remain queryable.
- Swapped fact text, fact-ID-preserving negation drift, answer leakage into the question, and HTML/script-like strings are stored as plain text and remain `semantic_alignment_pending`; they are neither falsely passed nor rejected by a nonexistent English parser.
- Success commits `presentation_ready` with the original wording, assembled visible/reveal presentation, family/modality/difficulty, and prompt/schema provenance. Text and SVG lanes use the same stored presentation shape.
- A second call on the same slot is refused without a request.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/ai/write-wording.test.ts --reporter=verbose` | exit 0; 1 file / 8 tests passed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 28 files / 422 tests passed, build succeeded and copied `wording.txt`. |

The focused suite covers all ten families, both lanes, text/SVG stored shapes, missing/duplicate facts, unsupported explanation references, SVG clue transcription, negation drift, answer leakage, HTML/script text, invalid wording schema, empty reasoning-only response, exactly one call per slot, second-call refusal, route/stage guards, formal-evidence mismatch rejection, saved raw response/cost, and prompt/schema provenance. All responses come from the local fake; no real network or paid call was made.

**Manual acceptance steps**

1. Run the exact non-UI script below.
2. Confirm the focused suite reports 8 passing tests, including the all-family/both-lane shape test, the mechanical/semantic wording cases, and the formal-evidence mismatch rejection.
3. Confirm `npm run check` reports 28 files / 422 tests and a successful build.
4. Confirm `dist/ai/prompts/v1/wording.txt` exists after the build.
5. Confirm the focused test asserts that bad wording leaves the slot `formal_checked`, saves the raw response and cost, writes no `presentation_ready`, and that semantic drift/leakage remains `semantic_alignment_pending`.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec -- vitest run tests/ai/write-wording.test.ts --reporter=verbose
npm run check
ls -l dist/ai/prompts/v1/wording.txt
```

Expected: the focused suite exits 0 with 8 passing tests; `npm run check` exits 0 with 28 files / 422 tests and a successful build; the wording prompt exists under `dist/ai/prompts/v1/`. No live provider call or paid request is made.

**Decision-reviewer:** the first pass found two confirmed defects: the wording request payload omitted the validated spec (Medium), and the adapter did not bind caller artifacts to the slot's stored `formal_checked` evidence or independently re-enumerate solutions (Low). The payload now includes the spec, and the adapter reads the stored `formal_checked` spec/solve/choices, rejects mismatching caller artifacts, and independently re-enumerates the solution before requesting wording. Regression tests parse the captured request payload and compare its `spec` to the stored evidence, and cover the formal-evidence mismatch. A second pass confirmed both findings resolved and found no new material defect or regression; it noted only non-material residuals (generic mismatch error code, the future P33 `formal_checked` payload key contract, and asset hashes remaining caller-supplied).

**Acceptance:** accepted by the user on 2026-11-05 after the focused 8-test suite, the exact non-UI script, and the full `npm run check` evidence.

**Out of scope, unchanged:** blind reviewers, alignment reviewers, repair loops, paid calls, reports, and the gallery.

## P28. Blind Text Reviewer and Leakage Tests — 2026-11-05

**State:** implemented, offline-verified, and accepted by the user on 2026-11-05. This phase adds a public-only blind text review boundary. It makes no live provider call, paid request, vision review, informed semantic review, or stage commit; it performs the code-key comparison only after parsing, never sends the key in the request, and does not retry content.

**Files**

- Adapter: `src/ai/review-text.ts`
- Prompt asset: `src/ai/prompts/v1/blind-text.txt`
- Tests: `tests/ai/review-text.test.ts`
- Documentation: `README.md`, `docs/experiment-protocol.md`, this file

**Observable behavior**

- The adapter accepts `presentation_ready` or `duplicate_checked`, reads the stored `presentation_ready` assembled presentation, validates it with P22, requires the presentation's slot/family/modality to match the reviewed slot, and requires a text presentation. SVG slots are rejected for the vision phase.
- The model input is exactly the public allowlist: question, visible rules, clue texts without fact IDs, and four A-D option labels/texts. It never contains slot ID, family, modality, assets, spec/DSL, witness, solution, correct label/value, hidden layout parameters, hint, explanation, proof, fact IDs, lane, or another review.
- Fixed role instructions treat puzzle text as untrusted data, forbid obeying embedded directions that alter review policy/output, and require independent solving plus ambiguity assessment. This is defense-in-depth, not proof of prompt-injection immunity.
- The request uses the P25 `puzzle_blind_review` strict schema and a resolved `blind_text` route without image input. The exact allowlisted input is saved in the logical call; the raw response is saved before parsing.
- The strict schema enforces `selected` with a non-null A-D choice and `no_unique_answer`/`cannot_determine` with null. Text reviews additionally require `visualLegibility: not_applicable`.
- The request builder never sees the code key. After parsing, the adapter compares the selected option with the stored presentation's code key outside the builder and records `agreed`, `disagreed`, or `not_applicable`. Wrong choices, uncertainty, and disagreement are retained as review evidence; no second content prompt is sent.
- A successful parse records a `blind_text_review` request event with the input hash, parsed review, choice agreement, and prompt/schema provenance. Refusal, invalid JSON, and invalid review responses retain raw response, attempt, and cost without a workflow stage.
- No workflow stage is written; P34 commits `blind_reviewed` after the text and vision reviews.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/ai/review-text.test.ts --reporter=verbose` | exit 0; 1 file / 8 tests passed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 29 files / 430 tests passed, build succeeded and copied `blind-text.txt`. |

The focused suite covers all text families and both lanes, exact public payload deep-equality, hidden canaries for slot/lane/spec/key/hint/proof/previous review/fact IDs, every answer-status/null relation, wrong choice, uncertainty, text legibility, refusal, invalid JSON, no retry after disagreement, `duplicate_checked` acceptance, stored-slot mismatch rejection, route/stage guards, exact saved request/raw response, choice agreement, and prompt/schema provenance. All responses come from the local fake; no real network or paid call was made.

**Manual acceptance steps**

1. Run the exact non-UI script below.
2. Confirm the focused suite reports 8 passing tests, including the exact public allowlist/canary test, the answer-status/null matrix, and `duplicate_checked`/mismatched-slot handling.
3. Confirm `npm run check` reports 29 files / 430 tests and a successful build.
4. Confirm `dist/ai/prompts/v1/blind-text.txt` exists after the build.
5. Confirm the captured fake request contains exactly the human-visible question and four choices plus fixed role instructions, with no expected label or reveal material.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec -- vitest run tests/ai/review-text.test.ts --reporter=verbose
npm run check
ls -l dist/ai/prompts/v1/blind-text.txt
```

Expected: the focused suite exits 0 with 8 passing tests; `npm run check` exits 0 with 29 files / 430 tests and a successful build; the blind-text prompt exists under `dist/ai/prompts/v1/`. No live provider call or paid request is made.

**Decision-reviewer:** the first pass found four confirmed defects: the stage gate rejected the plan-ordered `duplicate_checked` slot (High); the blind choice was never compared with the code key or persisted as agreement evidence (Medium); the slot-id canary checked the wrong identifier (Low); and the reviewed slot was not bound to the stored presentation's slot/family/modality (Low). Fixes accept `presentation_ready` or `duplicate_checked`, compare the choice with the stored key outside the request builder and record `agreed`/`disagreed`/`not_applicable`, bind the presentation to the reviewed slot, and strengthen the canary/mismatch tests. A second pass confirmed all four findings resolved and found no new material code defect; it flagged one stale phase-summary sentence, now corrected, and recorded that P34 must enforce barrier-before-review ordering because P28 accepts both `presentation_ready` and `duplicate_checked`.

**Acceptance:** accepted by the user on 2026-11-05 after the focused 8-test suite, the exact non-UI script, and the full `npm run check` evidence.

**Out of scope, unchanged:** vision review, informed semantic review, paid calls, reports, and the gallery.

## P29. Blind Vision Reviewer Using the Actual PNG — 2026-11-05

**State:** implemented, offline-verified, and accepted by the user on 2026-11-05. This phase adds the actual-PNG blind vision review boundary. It makes no live provider call, paid request, stage commit, generator-vision call, external image URL, or content retry.

**Files**

- Adapter: `src/ai/review-vision.ts`
- Prompt asset: `src/ai/prompts/v1/blind-vision.txt`
- PNG safety helper: `src/render/png.ts` (`assertPngNoTextMetadata`)
- Tests: `tests/ai/review-vision.test.ts`
- Documentation: `README.md`, `docs/experiment-protocol.md`, this file

**Observable behavior**

- The adapter accepts `presentation_ready` or `duplicate_checked`, requires the stored `presentation_ready` assembled presentation, binds its slot/family/modality to the reviewed SVG slot, and rejects text slots before any request.
- It loads the full 1024 PNG artifact by the stored `assets.pngHash`, verifies `image/png` media type, byte hash, 1 MiB limit, 1024x1024 dimensions, and absence of `tEXt`/`zTXt`/`iTXt`/`eXIf` PNG text metadata. The stored PNG bytes are sent unchanged.
- The request uses the P25 `puzzle_blind_review` strict schema and a resolved `blind_vision` route that requires image input. The image is a Chat Completions `image_url` data URL containing the actual PNG.
- The textual input is only the public question, visible rules, clue texts without fact IDs, and four A-D option labels/texts plus fixed role instructions. It never contains slot ID, family, modality, assets, PNG hash, raw SVG, scene graph, hidden scene IDs, spec/DSL, witness, solution, correct label/value, hint, explanation, proof, fact IDs, lane, or previous review.
- The strict schema enforces status/choice consistency. Visual legibility must be `legible` or `unclear`; `not_applicable` is rejected. Unreadable, wrong-choice, and uncertain reviews are retained as evidence without claiming the correct answer proves visual correctness.
- The request builder never sees the code key. After parsing, the adapter compares the selected option with the stored key outside the builder and records `choiceAgreement` (`agreed`/`disagreed`/`not_applicable`).
- The exact request is saved in the logical call; the raw response is saved before parsing. A `blind_vision_review` event stores the input hash, PNG hash/byte length, parsed review, choice agreement, and prompt/schema provenance.
- Missing, corrupt, metadata-bearing, oversized, or wrong-shape PNG assets fail before any request. Oversized bytes are rejected by the artifact storage limit; the adapter also retains a defensive size check.
- No workflow stage is written; P34 commits `blind_reviewed` after text and vision reviews.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/ai/review-vision.test.ts --reporter=verbose` | exit 0; 1 file / 7 tests passed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 30 files / 437 tests passed, build succeeded and copied `blind-vision.txt`. |

The focused suite covers all five visual families, byte-identical PNG input, source-hash agreement, MIME/1024 shape, missing/corrupt/metadata-bearing/oversized/wrong-shape PNG failures, hidden SVG/scene/key/hint/proof/previous-review canaries, unreadable/wrong/uncertain reviews, refusal/invalid JSON, legibility rules, route/stage guards, and prompt/schema provenance. All responses come from the local fake; no real network or paid call was made.

**Manual acceptance steps**

1. Run the exact non-UI script below.
2. Confirm the focused suite reports 7 passing tests, including the five-visual-family byte-identical PNG test and the PNG safety failures.
3. Confirm `npm run check` reports 30 files / 437 tests and a successful build.
4. Confirm `dist/ai/prompts/v1/blind-vision.txt` exists after the build.
5. Confirm the captured fake request image decodes byte-for-byte to the saved full PNG and the textual input contains no raw SVG, scene graph, hidden layout, key, hint, proof, or image audit metadata.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec -- vitest run tests/ai/review-vision.test.ts --reporter=verbose
npm run check
ls -l dist/ai/prompts/v1/blind-vision.txt
```

Expected: the focused suite exits 0 with 7 passing tests; `npm run check` exits 0 with 30 files / 437 tests and a successful build; the blind-vision prompt exists under `dist/ai/prompts/v1/`. No live provider call or paid request is made.

**Decision-reviewer:** the static review found no material defects. It confirmed the PNG metadata check covers `tEXt`/`zTXt`/`iTXt`/`eXIf`, the sent image is hash/shape-verified and byte-identical, the textual input is public-only, oversized PNGs are blocked at the artifact store, and no verdict claims visual correctness. It recorded non-material residuals only: `PNG_TOO_LARGE` is defense-in-depth because the artifact limit is equal, the captured-request assertion originally read the ledger copy (now strengthened to read the captured fake HTTP request directly), and P30 must repeat the PNG metadata check for its own image role.

**Acceptance:** accepted by the user on 2026-11-05 after the focused 7-test suite, the exact non-UI script, and the full `npm run check` evidence.

**Out of scope, unchanged:** generator vision, external image URLs, live route assumptions, paid calls, reports, and the gallery.

## P30. Informed Alignment Reviewer — 2026-11-05

**State:** implemented, offline-verified, and accepted by the user on 2026-11-05. This phase adds the stateless informed alignment reviewer for text and SVG. It makes no live provider call, paid request, stage commit, blind-review reuse, wording rewrite, adjudication, or primary-answer change.

**Files**

- Adapter: `src/ai/review-alignment.ts`
- Prompt assets: `src/ai/prompts/v1/alignment-text.txt`, `src/ai/prompts/v1/alignment-vision.txt`
- Tests: `tests/ai/review-alignment.test.ts`
- Tooling: `eslint.config.mjs` ignores `.kilo/**` so Agent Manager worktrees do not break the root lint gate
- Documentation: `README.md`, `docs/experiment-protocol.md`, this file

**Observable behavior**

- The adapter accepts `presentation_ready`, `duplicate_checked`, or `blind_reviewed`, requires stored `formal_checked` and `presentation_ready` stage results, binds them to the slot/family/modality, and rejects `alignment_reviewed` or later.
- It verifies visible rules, options, correct label, and correct value against the formal spec/choices/solve result before requesting.
- The payload contains DSL, proof, correct option/value, actual visible question/rules/clues/options, hint, explanation steps, merged rule/local/proof inventory, and the actual full PNG for SVG. Model-authored wording/hint/explanation are explicitly untrusted data.
- No blind review, blind reasoning, blind request hash, previous checks, or prior conversation is included. The role is `alignment_text` or `alignment_vision`; cost is separate from blind solving.
- Text uses a text-only route; SVG uses a route requiring image input and the actual 1024 PNG with media-type/hash/1 MiB/dimension checks and a repeated `assertPngNoTextMetadata`.
- The response uses the P25 `puzzle_alignment_review` strict schema. Cited fact IDs are validated against the supplied inventory; unknown citations are rejected.
- `deriveAlignmentOverall` enforces applicability and computes the authoritative overall: text image must be `not_applicable`, all other fields and SVG image must be pass/fail/uncertain. A model `overall: pass` with a failed field yields derived `fail` and `overallMismatch: true`; it cannot override the field.
- `concerns` stores non-pass/non-N/A fields as model evidence; `deterministicEvidence` separately stores inventory fact IDs, proof, correct label/value, and option values. The report data identifies model allegations as model evidence, not formal proof.
- Refusal, invalid JSON, invalid schema, unknown citations, and improper N/A retain raw response/attempt/cost where a call was made; no second content prompt is sent. No workflow stage is written.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/ai/review-alignment.test.ts --reporter=verbose` | exit 0; 1 file / 11 tests passed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 31 files / 448 tests passed, build succeeded and copied both alignment prompts. |

The focused suite covers text and SVG valid reviews, actual PNG input, model-authored contradiction retained as model evidence, changed visual option, SVG rules/observation mismatch with empty clueTexts, model overall pass with a failed field, improper N/A, uncertain status, unknown fact citations, refusal/invalid JSON/invalid schema, missing formal evidence, wrong routes, already-reviewed slots, blind request hash preservation, and prompt/schema provenance. All responses come from the local fake; no real network or paid call was made.

**Manual acceptance steps**

1. Run the exact non-UI script below.
2. Confirm the focused suite reports 11 passing tests, including the contradiction/model-evidence case, `overall pass` with a failing field, and the blind-hash preservation test.
3. Confirm `npm run check` reports 31 files / 448 tests and a successful build.
4. Confirm `dist/ai/prompts/v1/alignment-text.txt` and `dist/ai/prompts/v1/alignment-vision.txt` exist after the build.
5. Confirm the fake contradiction passes fact-ID coverage but fails informed alignment, and the result separates `modelEvidence`/`concerns` from `deterministicEvidence`.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec -- vitest run tests/ai/review-alignment.test.ts --reporter=verbose
npm run check
ls -l dist/ai/prompts/v1/alignment-text.txt dist/ai/prompts/v1/alignment-vision.txt
```

Expected: the focused suite exits 0 with 11 passing tests; `npm run check` exits 0 with 31 files / 448 tests and a successful build; both alignment prompts exist under `dist/ai/prompts/v1/`. No live provider call or paid request is made.

**Decision-reviewer:** the first pass found one confirmed Low defect: the alignment-text prompt did not state the code-enforced mandate that the text image field must be `not_applicable`, so a schema-valid but nonconforming review could lose the whole paid review. The prompt and protocol now state the mandate explicitly, and the prompt metadata test asserts the wording. The reviewer also noted non-material residuals: the SVG test read the ledger copy rather than the captured fake request (now strengthened), the event timestamp uses request start time, and P34 owns the stage-ordering gate. A second pass confirmed the finding resolved and found no new material defect or regression.

**Acceptance:** accepted by the user on 2026-11-05 after the focused 11-test suite, the exact non-UI script, and the full `npm run check` evidence.

**Out of scope, unchanged:** adjudication, rewriting the presentation, changing the primary answer, paid calls, reports, and the gallery.

## P31. Pure Primary-Verdict Reducer — 2026-11-05

**State:** implemented, offline-verified, and accepted by the user on 2026-11-05. This phase adds a pure exhaustive verdict reducer and the documented truth table. It makes no provider call, paid request, stage mutation, scheduling decision, human adjudication, or rate calculation.

**Files**

- Reducer: `src/validation/verdict.ts`
- Tests: `tests/validation/verdict.test.ts`
- Truth table: `docs/verdict-table.md`
- Failure-code schema: `src/domain/candidate.ts` (`MISSING_REVIEW`)
- Documentation: `README.md`, `docs/experiment-protocol.md`, this file

**Observable behavior**

- The reducer is pure: it validates a strict evidence envelope and returns a quality verdict without mutating input or storage.
- Precedence: unstarted/in-progress/paused preparation -> no quality verdict (`null`, `incomplete`); no usable generation or a generation-facing `API_ERROR`/`SCHEMA_INVALID` -> `generation_error`; deterministic formal/presentation/duplicate failures -> `rejected`; a paused/interrupted/failed run with a required review still pending -> no quality verdict (`null`, `incomplete`) after known generation/rejected outcomes; only model/near-duplicate/missing-review concerns -> `inconclusive`; approval only after every required check passes. Review-stage `API_ERROR`/`SCHEMA_INVALID` are inconclusive, not generation errors.
- `SOLVER_LIMIT` is inconclusive, not a deterministic rejection; `TEXT_SPEC_MISMATCH`/`EXPLANATION_MISMATCH` are model allegations unless `source: deterministic`.
- Every input failure is preserved. `primaryFailure` follows the documented class precedence; `MISSING_REVIEW` is derived for a required blind/alignment review that did not complete. A completed negative review is considered even when `required` is false; review codes win over `NEAR_DUPLICATE_SUSPECTED`.
- Approval requires ready preparation, usable generation, formal/presentation pass, owner/unique duplicate outcome, a completed blind review selecting the code key with clear wording/no ambiguity/no issues (and `legible` for SVG), and a completed alignment review with `derivedOverall: pass`.
- `COST_UNKNOWN` blocks business `proceed` without reversing an otherwise valid `approved` quality label: `verdict: approved`, `proceed: false`, `primaryFailure: null`, `businessBlockers: [COST_UNKNOWN]`.
- Paused/incomplete candidates are never converted to `generation_error` merely to make a run look complete.
- The truth table documents every decision row, failure class, primary-failure precedence, and edge case without requiring a later runner to invent policy.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/validation/verdict.test.ts --reporter=verbose` | exit 0; 1 file / 20 tests passed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 32 files / 468 tests passed, build succeeded. |

The focused suite covers every verdict, every failure code, correct reviewer with invalid spec, incorrect reviewer on valid spec, blind/alignment conflict, missing vision, exact duplicate ownership, near-pairs on both members, paused/incomplete stages, budget-paused pending review, review-stage API/schema failures, near-pair/review precedence, completed negative reviews marked not required, pending-check approval prohibition, cost-unknown distinction, deterministic vs model mismatch sources, precedence preservation, and reducer purity. No network or paid call is made.

**Manual acceptance steps**

1. Run the exact non-UI script below.
2. Confirm the focused suite reports 20 passing tests.
3. Confirm `npm run check` reports 32 files / 468 tests and a successful build.
4. Read `docs/verdict-table.md` and confirm each edge case has one unambiguous row/class and primary-failure precedence.
5. Confirm `approved` with `COST_UNKNOWN` keeps the quality label but sets `proceed: false`; confirm paused/incomplete never becomes `generation_error`.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec -- vitest run tests/validation/verdict.test.ts --reporter=verbose
npm run check
sed -n '1,220p' docs/verdict-table.md
```

Expected: the focused suite exits 0 with 20 passing tests; `npm run check` exits 0 with 32 files / 468 tests and a successful build; the truth table clearly covers all verdicts, failure classes, precedence, cost distinction, review-stage failures, near-pair/review precedence, and incomplete/paused/failed review handling.

**Decision-reviewer:** the first pass found two confirmed defects and two probable defects: generation-class `API_ERROR`/`SCHEMA_INVALID` at review stages were misreported as `generation_error`; the truth table contradicted the near-duplicate primary precedence; a budget-paused review stage could not be represented and became a complete `inconclusive`; and a completed negative review was ignored when `required:false`. Fixes made failure classification stage-aware, aligned the truth table with review precedence, added `runControl` so paused pending reviews stay incomplete, and derive/consider completed negative reviews regardless of `required`. A second pass confirmed those four resolved but found three residual Low gaps: `failed` run-control was not treated like paused, the exported static failure-class map remained stage-blind, and review-stage `API_ERROR`/`SCHEMA_INVALID` were absent from inconclusive primary precedence. Those are fixed by including `failed`, removing the stage-blind exported map in favour of the stage-aware `failureClass`, and adding the two codes to inconclusive precedence; regression tests cover each. A third pass confirmed those residuals but found one further pause-ordering gap: the run-control pause branch preceded known generation/rejected outcomes. The reducer now reports generation/rejection first and only then marks a paused/failed pending-review slot incomplete; a regression test covers both cases. A fourth pass confirmed the pause-ordering fix and found no new material defect or regression.

**Acceptance:** accepted by the user on 2026-11-05 after the focused 20-test suite, the exact non-UI script, and the full `npm run check` evidence.

**Out of scope, unchanged:** human overwriting of primary verdicts, rate calculation, paid calls, reports, and the gallery.

## P32. Deterministic Mock Transport and Role Scenarios — 2026-11-05

**State:** implemented, offline-verified, and accepted by the user on 2026-11-05. This phase adds a test/simulation transport only. It makes no live provider call, paid request, runner, scheduling decision, duplicate barrier, or experiment execution.

**Files**

- Mock transport: `src/ai/mock.ts`
- Fixture: `tests/fixtures/mock/role-responses.json`
- Tests: `tests/ai/mock.test.ts`
- Live-factory guard: `src/ai/openrouter.ts` (`MOCK_NOT_ALLOWED`)
- Documentation: `README.md`, `docs/experiment-protocol.md`, this file

**Observable behavior**

- `createMockTransport({ db, ... })` wraps the real OpenRouter transport and ledger path, exposes `isMock`, captured requests, a scenario registry keyed by logical call, and clear helpers.
- Scenarios name role/family/difficulty/seed/kind. Registration cross-checks role/family/difficulty against the logical call and slot; mismatches fail closed. Valid spec/wording content is built from the real family engines/templates; blind/alignment content uses the mock fixture and prefers the slot's stored presentation key for its hidden oracle, with canonical choice ordering as content-level fallback.
- Successful/failing chat responses carry `id: mock-...`, `model: mock/model`, `provider: mock`, and zero synthetic usage/cost. The real transport persists raw responses and the real ledger transitions the call, so mock evidence is visibly not live.
- Scenario kinds cover `valid`, `wrong_answer`, `schema_invalid`, `refusal`, `http_error`, and `timeout`. Wrong-answer applies only to review roles; timeout produces an uncertain/network-timeout result.
- Scenarios are keyed by logical call, so identical request bodies can produce different registered responses. Missing/duplicate scenarios and concurrent calls fail closed.
- Captured requests are real public role request bodies; the suite drives the real blind `reviewText` adapter and asserts its public payload, while other roles are content-level checked. Requests never contain oracle, expected-option, scenario, or key data. Blind request allowlists are unchanged.
- The mock transport uses an injected fetch and a synthetic key; no global fetch, network, or real credential is used.
- The live transport factory rejects `mock`, `mockRegistry`, `mockScenario`, `mockOracle`, and `oracle` options with `MOCK_NOT_ALLOWED`.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/ai/mock.test.ts --reporter=verbose` | exit 0; 1 file / 9 tests passed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 33 files / 477 tests passed, build succeeded. |

The focused suite covers every family/role valid content, repeated-seed stability, zero synthetic usage/cost, mock identity, keyed scenarios with identical request bodies, canonical oracle labels, registration cross-checks, wrong-answer/schema-invalid/refusal/HTTP-error/timeout through the transport, a real blind adapter request, missing scenarios, live-factory mock rejection, no global fetch, and unchanged blind request allowlists. No network or paid call is made.

**Manual acceptance steps**

1. Run the exact non-UI script below.
2. Confirm the focused suite reports 9 passing tests, including every-family/role valid content, the keyed-scenario test, and the real blind adapter request.
3. Confirm `npm run check` reports 33 files / 477 tests and a successful build.
4. Inspect `tests/fixtures/mock/role-responses.json` and confirm hidden oracle data is not present in any request body; the mock module derives it.
5. Confirm captured simulated requests contain real public request fields only, and mock responses are visibly `mock-...`/`mock/model`/`mock` with zero cost.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
npm exec -- vitest run tests/ai/mock.test.ts --reporter=verbose
npm run check
sed -n '1,160p' tests/fixtures/mock/role-responses.json
```

Expected: the focused suite exits 0 with 9 passing tests; `npm run check` exits 0 with 33 files / 477 tests and a successful build; the fixture contains role templates/failure bodies but no request oracle; no live network or paid call is made.

**Decision-reviewer:** the first pass found three confirmed defects: the blind oracle used the scenario seed instead of the canonical choice ordering (Medium); `registerScenario` did not cross-check role/family/difficulty against the logical call/slot (Low); and the captured-request/allowlist verification used placeholder requests and did not exercise the other roles or failure kinds through the transport (Low). Fixes use `hashCanonicalJson(spec)` for oracle choice ordering, reject scenario/call mismatches at registration, and add a real `reviewText` adapter request plus wrong/schema/refusal/HTTP/timeout transport coverage. A second pass confirmed those three resolved but found one Low residual: the oracle still fell back to the scenario seed when the slot key was available. The mock now prefers the slot's stored `presentation_ready` key, and the adapter test registers a different scenario seed to prove the stored key wins. A third pass confirmed the residual resolved and found only a stale README oracle sentence, now corrected to match the protocol and progress documents.

**Acceptance:** accepted by the user on 2026-11-05 after the focused 9-test suite, the exact non-UI script, and the full `npm run check` evidence.

**Out of scope, unchanged:** slot orchestration, duplicate barrier, experiment execution, paid calls, reports, and the gallery.
