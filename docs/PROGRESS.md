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
