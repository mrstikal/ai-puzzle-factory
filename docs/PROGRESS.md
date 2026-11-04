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

Expected: 16 focused tests pass; the JSON shows the correct route, the shortcut route, `shortcutValid: false`, `extraEdgeRejected: true`, and the `a path tree requires exactly activeCells-1 open edges` message; `npm run check` exits 0 with 15 files / 241 tests.

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
