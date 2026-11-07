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

**State:** implemented, offline-verified, and accepted by the user on 2026-11-05. This phase adds provider-facing strict schemas, explicit live-input validation, exact catalog route checks, and an offline preflight. It makes no paid call, live provider request, model selection, catalog archive, or live probe execution. **Plan v1.1 revision (2026-11-06):** the exact-provider/fallback-off behavior described in this historical entry is superseded by Balanced model-level routing; see P46.

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

**Superseded contract (2026-11-07):** the P48 alignment contract v2 removes the model-generated `overall`; the model returns fields only and the application derives the overall. The v1 prompt/schema and `overallMismatch` behavior below are historical. Current behavior is documented in the P48 alignment contract v2 entry and `docs/experiment-protocol.md`.

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

## P33. Per-Slot Preparation and Durable Checkpoints — 2026-11-05

**State:** implemented, offline-verified, and accepted by the user on 2026-11-05. This phase prepares one slot at a time through an injected transport. It makes no review, duplicate-barrier, approval, report, gallery, scheduling, or live paid call.

**Files**

- Runner: `src/runner/prepare-slot.ts`
- Tests: `tests/runner/prepare.test.ts`
- Renderer integration fix found by review: `src/families/registry.ts`, `src/families/matrix/render.ts`, `src/families/transforms/render.ts`, `src/families/paths/render.ts`, `src/families/symmetry/render.ts`, `src/families/counting/render.ts`, and fake-renderer fixtures in `tests/families/contracts.test.ts`
- Documentation: this file

**Observable behavior**

- `prepareSlot` requires a planned slot in a full or smoke run and consumes the existing P20-P27 adapters/engines without family branches.
- `spec_first` constructs one spec from the slot `spec` stream and commits `spec_ready` with the seed and construction method. `ai_spec` calls P26 once and reuses its committed `spec_ready`; a first invalid proposal is terminal, never repaired, retried as a new creative attempt, or replaced by `spec_first`.
- Independent solving, option construction, and option verification use the slot `options` stream. The formal checkpoint stores the spec, solve result, A-D choices, all three derived seeds, a content-less fingerprint, render hashes, and the renderer version. SVG slots store the source SVG, the full 1024 PNG, and the 512 preview PNG as real artifacts; text slots store no render bytes.
- The SVG scene is built with the same `options` seed as the stored choices and then checked by the family-level `assertScene` validator with the stored choice set before any hash or artifact is committed. The seedless renderer default remains `hashCanonicalJson(spec)` for previews and renderer tests.
- P27 wording/public assembly runs once from `formal_checked` and commits `presentation_ready`; the runner verifies the persisted presentation, computes the content hash, and returns a complete fingerprint with spec, structure, content, and render hashes.
- Every stage result, its artifacts, and the slot checkpoint are committed in one P03 transaction. A failure before a stage commit leaves the prior checkpoint intact; a failure after a commit leaves that durable checkpoint and then attempts one terminal checkpoint.
- Early failure returns `early_failure`, commits a terminal stage with a non-approved P31-compatible verdict (`generation_error`, `rejected`, or `inconclusive`), preserves the first failure record, links attempt raw-response artifacts, and stores a JSON preparation-evidence artifact. A terminal insert failure rolls back the terminal stage and its evidence atomically.
- Mock mode registers spec/wording scenarios by logical call from the runner, outside request DTOs, forces nonbilling admission, and keeps the real ledger path. No scenario/oracle/seed field is added to a request body. Mock success cost is known `0`.
- Ready slots remain at `presentation_ready` with a null verdict; P33 never calls blind/alignment reviewers, runs the duplicate barrier, chooses a duplicate owner, or marks a candidate approved.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/runner/prepare.test.ts --reporter=verbose` | exit 0; 1 file / 5 tests passed. |
| `npm exec -- vitest run tests/runner/prepare.test.ts tests/families/contracts.test.ts tests/families/registry.test.ts tests/render/matrix.test.ts tests/render/transforms.test.ts tests/render/paths.test.ts tests/render/symmetry.test.ts tests/render/counting.test.ts --reporter=verbose` | exit 0; 8 files / 76 tests passed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 34 files / 482 tests passed, build succeeded. |

The focused suite prepares all 20 smoke slots (one per family/lane) through the mock transport and asserts exact stage payloads, 30 mock requests (10 spec + 20 wording), 30 validated attempts, zero cost, nonbilling settled reservations, 30 stage artifacts (10 source SVG, 10 full PNG, 10 preview PNG), real SVG/PNG bytes and dimensions, family scene validation against the stored choices, no reviewer/duplicate/approval stage, and no hidden retry/regeneration. Failure tests assert an ai_spec schema failure with one spec call and no wording call, a wording refusal with formal evidence retained and a diagnostic fingerprint, raw first-response artifacts, and atomic rollback of a blocked terminal checkpoint.

**Manual acceptance steps**

1. Run the exact non-UI script below. It creates `/tmp/p33-acceptance.sqlite` with one ready slot and two early failures.
2. Inspect the ready slot with:
   `sqlite3 /tmp/p33-acceptance.sqlite "select slot_id, stage, coalesce(verdict,'null'), checkpoint_version from slots where slot_id='text-ranking-01';"`
   Expected: `text-ranking-01|presentation_ready|null|3`.
3. Inspect the failure slots with:
   `sqlite3 /tmp/p33-acceptance.sqlite "select slot_id, stage, coalesce(verdict,'null'), checkpoint_version from slots where slot_id in ('text-ranking-02','text-truth-01') order by slot_id;"`
   Expected: both `terminal|generation_error`, checkpoint versions 1 and 3.
4. Inspect the first evidence with:
   `sqlite3 /tmp/p33-acceptance.sqlite "select slot_id, json_extract(payload_json,'$.failureStage'), json_extract(payload_json,'$.failures[0].code'), json_extract(payload_json,'$.logicalCalls[0].rawResponseArtifactIds[0]') from stage_results where stage='terminal' order by slot_id;"`
   Expected: `text-ranking-02|spec_ready|SCHEMA_INVALID|2` and `text-truth-01|presentation_ready|API_ERROR|4`.
5. Confirm no cohort action occurred:
   `sqlite3 /tmp/p33-acceptance.sqlite "select count(*) from stage_results where stage in ('duplicate_checked','blind_reviewed','alignment_reviewed');"`
   Expected: `0`.
6. Confirm the ready slot is awaiting cohort checks, both failures retain their raw first response, and no candidate is approved.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
cat > /tmp/p33-acceptance.mts <<'TS'
import { rmSync } from "node:fs";
import { createBudgetAccount } from "/home/alex/ai-puzzle-factory/src/ai/budget.ts";
import { createMockTransport } from "/home/alex/ai-puzzle-factory/src/ai/mock.ts";
import { FAMILY_SPEC_JSON_SCHEMAS, WORDING_JSON_SCHEMA, strictSchemaHash } from "/home/alex/ai-puzzle-factory/src/ai/schemas.ts";
import { buildPlanManifest } from "/home/alex/ai-puzzle-factory/src/experiment/planner.ts";
import { prepareSlot } from "/home/alex/ai-puzzle-factory/src/runner/prepare-slot.ts";
import { migrate, openDatabase } from "/home/alex/ai-puzzle-factory/src/storage/database.ts";
import { createRun, getSlot, getStageResult } from "/home/alex/ai-puzzle-factory/src/storage/repository.ts";

const dbPath = "/tmp/p33-acceptance.sqlite";
rmSync(dbPath, { force: true });
const db = openDatabase(dbPath);
migrate(db);
const plan = buildPlanManifest({ runKind: "smoke" });
const createdAt = "2026-11-05T00:00:00.000Z";
const clock = { now: () => new Date(createdAt), sleep: async (): Promise<void> => {} };
const route = (role: "spec" | "wording") => {
  const responseFormat = role === "spec" ? FAMILY_SPEC_JSON_SCHEMAS.ranking : WORDING_JSON_SCHEMA;
  return { role, model: "mock/model", routingPolicy: "balanced", compatibleEndpointTags: ["mock"], compatibleProviderNames: ["Mock Provider"], outputCapField: "max_tokens", maxOutputTokens: 8192, minPromptTokens: 16384, contextLength: 131072, maxPromptTokens: null, maxCompletionTokens: 16384, supportedParameters: ["structured_outputs", "max_tokens"], pricing: { prompt: "0", completion: "0" }, requiresImage: false, imageInputDeclared: false, visionProbeRequired: false, responseFormat, schemaHash: strictSchemaHash(responseFormat), settings: {} } as const;
};
const mock = createMockTransport({ db, clock, random: () => 0 });
const runId = "123e4567-e89b-42d3-a456-426614174033";
const accountId = "p33-acceptance";
createRun(db, { runId, plan, evidenceKind: "mock", createdAt });
createBudgetAccount(db, { accountId, runId, runKind: "smoke", maxCostUsd: "0", createdAt });
const base = { db, runId, accountId, apiKey: "sk-p33-acceptance", transport: mock, routes: { spec: route("spec"), wording: route("wording") }, reservations: { spec: "0.01", wording: "0.01" }, clock };
await prepareSlot({ ...base, slotId: "text-ranking-01" });
const aiFailure = await prepareSlot({ ...base, slotId: "text-ranking-02", mockScenarioKinds: { spec: "schema_invalid" } });
const wordingFailure = await prepareSlot({ ...base, slotId: "text-truth-01", mockScenarioKinds: { wording: "refusal" } });
for (const slotId of ["text-ranking-01", "text-ranking-02", "text-truth-01"]) {
  const slot = getSlot(db, runId, slotId);
  console.log(slotId, slot.stage, slot.verdict ?? "null", slot.checkpointVersion);
}
for (const result of [aiFailure, wordingFailure]) {
  const terminal = getStageResult(db, runId, result.slotId, "terminal");
  const payload = terminal.payload as { failureStage: string; failures: Array<{ code: string }>; logicalCalls: Array<{ rawResponseArtifactIds: number[] }> };
  console.log(result.slotId, result.status, result.terminalVerdict, payload.failureStage, payload.failures.map((failure) => failure.code).join(","), payload.logicalCalls.flatMap((call) => call.rawResponseArtifactIds).join(","));
}
console.log("cohort stages", db.prepare("SELECT COUNT(*) AS count FROM stage_results WHERE run_id = ? AND stage IN ('duplicate_checked','blind_reviewed','alignment_reviewed')").get(runId));
db.close();
console.log(dbPath);
TS
npx tsx /tmp/p33-acceptance.mts
sqlite3 /tmp/p33-acceptance.sqlite "select slot_id, stage, coalesce(verdict,'null'), checkpoint_version from slots order by slot_id;"
sqlite3 /tmp/p33-acceptance.sqlite "select slot_id, json_extract(payload_json,'$.failureStage'), json_extract(payload_json,'$.failures[0].code'), json_extract(payload_json,'$.logicalCalls[0].rawResponseArtifactIds[0]') from stage_results where stage='terminal' order by slot_id;"
sqlite3 /tmp/p33-acceptance.sqlite "select count(*) from stage_results where stage in ('duplicate_checked','blind_reviewed','alignment_reviewed');"
```

Expected: the three slots print `presentation_ready null 3`, `terminal generation_error 1`, and `terminal generation_error 3`; the terminal rows show `spec_ready|SCHEMA_INVALID|2` and `presentation_ready|API_ERROR|4`; the cohort-stage count is `0`.

**Decision-reviewer:** the first static pass found two confirmed defects in the SVG path: the renderer re-derived its own option set from `hashCanonicalJson(spec)` instead of the persisted slot-options choices (High), and the production path recorded `render: pass` without invoking the family-level scene validators (Medium). The fix extends the renderer contract with an optional options seed and a family `assertScene`, forwards the slot `options` seed through all five renderers, and validates the rendered scene against the stored choice set before hashing or committing. A second pass confirmed both findings resolved and found no new material defect or regression; it noted two non-material residuals (optional `choices` parameter, and a negative test that rejected at set level), both fixed by requiring `choices` and permuting two non-correct values so only the tile-to-choice binding can fail.

**Acceptance:** accepted by the user on 2026-11-05 after the focused 5-test suite, the exact non-UI script, and the full `npm run check` evidence.

**Out of scope, unchanged:** the full smoke command, serial cohort barrier, blind/alignment reviews, concurrent workers, resume, reports, and the gallery.

## P34. Serial Cohort Barrier, Reviews, and Mock Smoke CLI — 2026-11-05

**State:** implemented, offline-verified, and accepted by the user on 2026-11-05. This phase runs only the fixed 20-slot smoke cohort with the deterministic mock transport. It does not implement full/live execution, resume, reports, HTML, the gallery, or concurrency.

**Files**

- Runner: `src/runner/review-slot.ts`, `src/runner/run.ts`
- CLI: `src/cli/experiment.ts`
- Storage integration: `src/storage/repository.ts` (`insertEvent` export and `setRunControlState`)
- Tests: `tests/runner/serial.test.ts`; updated P02 CLI expectations in `tests/experiment/planner.test.ts` and `tests/bootstrap.test.ts`
- Documentation: `README.md` and this file

**Observable behavior**

- `runSmokeMockExperiment` allocates the fixed 20-slot smoke plan, prepares each slot serially through P33, and refuses a non-mock transport, a duplicate run UUID, or a non-20-slot plan. Full, live, and resume paths are rejected by the CLI.
- The duplicate barrier runs only after all 20 preparation results exist. The full barrier result is persisted as a `duplicate_barrier` event, and every ready slot receives a `duplicate_checked` stage containing the barrier result hash and its own assessment. Early failures stay terminal and are never given a barrier or review stage.
- Confirmed exact/spec/structural duplicates skip both reviews and are rejected by P31 with the duplicate failure. Owner, unique, and near-suspected candidates run blind text/vision first and informed alignment second, once each. A blind disagreement still runs alignment; a blind transport failure still attempts alignment unless the run control has left `running` (for example a budget pause).
- `blind_reviewed` and `alignment_reviewed` stages store the parsed review, choice agreement, expected option, prompt/schema provenance, usage, cost, attempts, and any raw failure evidence. Review transport/schema failures are recorded as `API_ERROR`/`SCHEMA_INVALID` at the review stage and become P31 `MISSING_REVIEW`/inconclusive outcomes, not generation errors.
- P31 receives ready/usable/formal-passed/presentation-passed evidence, the barrier outcome, both review states, the aggregated spec+wording+review cost, and all raw failures. The terminal stage stores the complete P31 result (`verdict`, `completion`, `proceed`, `primaryFailure`, `businessBlockers`, `failures`, `rationale`) plus the duplicate outcome and owner.
- Near suspicion never skips reviews and remains inconclusive even when both reviews pass. Cost unknown adds `COST_UNKNOWN` without reversing an otherwise approved quality label.
- The run is marked `completed` only when all 20 slots are terminal with a verdict; the `run_completed` event is written first. A failure while the run is still `running` marks it `failed` and writes a sanitized `run_failed` event; a budget pause is left as paused.
- The CLI supports `npm run experiment -- --smoke --mock --seed puzzle-smoke-v1 --max-cost 0 [--db <path>]`, acquires the P03 writer lock, uses no `.env` or real key, and prints the run UUID, database path, slot/verdict counts, role counts, attempt/cost counts, and barrier summary. Reports, HTML, gallery, concurrency, and resume are absent.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/runner/serial.test.ts --reporter=verbose` | exit 0; 1 file / 8 tests passed. |
| `npm exec -- vitest run tests/storage/checkpoints.test.ts tests/ai/propose-spec.test.ts tests/ai/write-wording.test.ts tests/runner/prepare.test.ts tests/runner/serial.test.ts --reporter=verbose` | exit 0; 5 files / 50 tests passed. |
| `npm run experiment -- --smoke --mock --seed puzzle-smoke-v1 --max-cost 0` | exit 0; printed `run de497698-1254-4edd-a2be-b284a70e18e2`, 20/20 terminal, 20 approved, 70 calls, 0 unknown cost, 0 paid traffic. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 35 files / 490 tests passed, build succeeded. |

The focused suite covers the full 20-slot mock run, one ai_spec schema failure preserved while the other 19 are reviewed, a confirmed duplicate with zero review calls, a near-suspected candidate with both reviews and an inconclusive outcome, a blind disagreement followed by alignment, duplicate-UUID rejection, the CLI end-to-end run, and explicit rejection of full/live/resume/invalid-cost/mismatched-seed paths. The full run asserts 70 logical calls, 70 validated attempts, zero known cost, nonbilling settled reservations, 140 stage results, 30 P33 artifacts, barrier-before-review ordering, no report/HTML artifact, and no reviewer call on the failed slot.

**Manual acceptance steps**

1. Run the exact non-UI script below.
2. Confirm the printed run UUID and `slots 20/20 terminal`, `verdicts approved=20`, `calls spec=10 wording=20 blind_text=10 blind_vision=10 alignment_text=10 alignment_vision=10`, `attempts 70 unknown=0`, `cost status=known actual=0`.
3. Confirm SQLite reports 20 slots, 20 terminal, 20 approved, 40 review stages, a `duplicate_barrier` event, a `run_completed` event, and `control_state = completed`.
4. Confirm no `html` or report artifact/event exists and no `.env` or API key is needed.
5. Confirm the printed run UUID reopens with all 20 slots and honest outcomes; no resume, concurrency, report, HTML, or gallery behavior is present.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
cd /home/alex/ai-puzzle-factory
OUT=$(npm run --silent experiment -- --smoke --mock --seed puzzle-smoke-v1 --max-cost 0)
printf '%s\n' "$OUT"
RUN_ID=$(printf '%s\n' "$OUT" | sed -n 's/^run //p')
test -n "$RUN_ID"
sqlite3 data/experiment.sqlite "select count(*), sum(case when stage='terminal' then 1 else 0 end), sum(case when verdict='approved' then 1 else 0 end) from slots where run_id='$RUN_ID';"
sqlite3 data/experiment.sqlite "select control_state from runs where run_id='$RUN_ID';"
sqlite3 data/experiment.sqlite "select role, count(*) from logical_calls where run_id='$RUN_ID' group by role order by role;"
sqlite3 data/experiment.sqlite "select count(*) from stage_results where run_id='$RUN_ID' and stage in ('blind_reviewed','alignment_reviewed');"
sqlite3 data/experiment.sqlite "select event_type, count(*) from events where run_id='$RUN_ID' group by event_type order by event_type;"
sqlite3 data/experiment.sqlite "select count(*) from artifacts where kind in ('html','json');"
```

Expected: `20|20|20`, `completed`, role counts `spec 10 / wording 20 / blind_text 10 / blind_vision 10 / alignment_text 10 / alignment_vision 10`, review-stage count `40`, event counts `duplicate_barrier 1`, `run_completed 1`, `run_created 1`, `stage_committed 140`, and HTML/JSON artifact count `0`.

**Decision-reviewer:** the first static pass found two Low findings: the seed-mismatch CLI rejection opened/migrated/locked the default database before validation, and injected-clock stage rows mixed the real wall clock with the injected clock. The CLI now builds the fixed smoke plan before any filesystem/database/lock action, the rejection test uses a temporary `--db` path and asserts no file is created, and `insertStageResult` now defaults `created_at` to the same `finished_at` used by the injected clock so P26/P27/P33/P34 stage rows, stage events, artifacts, and the barrier/run events share one time base. A follow-up pass found the P26/P27 adapter commit sites still fell back to the wall clock; the central repository default closed that remainder. The final pass found no material findings or regressions and confirmed the focused suites remain green.

**Acceptance:** accepted by the user on 2026-11-05 after the focused suite, the exact non-UI script, and the full `npm run check` evidence.

**Out of scope, unchanged:** full/live execution, resume, cancellation, concurrency, reports, HTML, the gallery, and any paid provider request.

## P35. Bounded Concurrency and Graceful Cancellation — 2026-11-05

**State:** implemented, offline-verified, and accepted by the user on 2026-11-05. This phase adds one/two bounded workers and graceful SIGINT cancellation to the existing smoke mock runner. It does not add multi-process workers, resume, reports, HTML, or the gallery.

**Files**

- Runner: `src/runner/workers.ts`, `src/runner/cancel.ts`
- Extended runner: `src/runner/run.ts`, `src/runner/prepare-slot.ts` (yield hook), `src/runner/review-slot.ts` (yield hook)
- Mock transport: `src/ai/mock.ts` now supports up to two concurrent logical calls with per-call async context; `CONCURRENT_CALL` remains the third-call guard
- CLI: `src/cli/experiment.ts` (`--concurrency`, SIGINT handler, writer-lock compromise callback, exit 130 on cancellation)
- Tests: `tests/runner/concurrency.test.ts`; `tests/runner/serial.test.ts` CLI flag update; P02/P34 CLI message updates
- Documentation: `README.md` and this file

**Observable behavior**

- `--concurrency` accepts exactly 1 or 2; the default is 2. The runner and pool reject 0, 3, and non-integers before creating a data directory or database.
- Preparation and review use a shared bounded pool. At most two HTTP calls are in flight across roles; workers yield between bounded formal jobs and after each slot. All 20 preparation results still precede the duplicate barrier, and blind/alignment remain sequential per slot.
- The mock transport supports two concurrent logical calls with per-call scenario context, so `--concurrency 2 --mock` exercises real overlap while a third concurrent call still fails closed.
- SIGINT stops new admission immediately through the transport guard, drains active calls up to the configured 95-second default, commits only completed stages, writes a `run_cancelled` event, and leaves the run `running` with a resumable checkpoint. It does not write `run_completed` or claim success.
- Any attempt still `dispatching` after the drain window is transitioned to `uncertain`; its budget reservation is retained, not released. The cancellation event and CLI summary include the marked attempt count and the budget snapshot (`known`, `reserved`, `unknown`).
- A compromised writer lock calls the same cancellation path; `proper-lockfile` continues its 10-second refresh during normal operation, and lock-release failure does not overwrite the cancellation result.
- A cancelled CLI run prints `status cancelled`, the phase, drain result, marked-uncertain count, and exits 130. Completed runs still print `status completed` and exit 0.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/runner/concurrency.test.ts --reporter=verbose` | exit 0; 1 file / 9 tests passed. |
| `npm run experiment -- --smoke --mock --seed puzzle-smoke-v1 --concurrency 2 --max-cost 0` | exit 0; run `6732cab0-3f25-4183-acd9-4253cc9ada9f`, 20/20 terminal, 20 approved, 70 calls, 0 unknown cost, budget reserved 0. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 36 files / 499 tests passed, build succeeded. |

The focused suite asserts concurrency 0/3/non-integer rejection before any database file, a maximum in-flight count of exactly 2, 20/20 terminal slots with no starvation, identical barrier assessments/owners/verdicts at concurrency 1 and 2, SIGINT stop-admission with a `run_cancelled` event and no barrier/completion, transport-guard rejection after a compromised-lock stop, the full runner drain-timeout path with a blocked timeout scenario, `drained: "timeout"`, at least one uncertain attempt, a retained reservation with null actual cost, and no `run_completed`, a direct uncertain-marking fallback with a retained reservation, a two-worker shared-cap admission with exactly one admitted reservation and one `INSUFFICIENT_BUDGET` pause, and a 20-item pool completing every item.

**Manual acceptance steps**

1. Run the exact happy-path command above and confirm `status completed`, 20/20 terminal, 20 approved, 70 calls, and zero cost.
2. Run the exact cancellation script below. It starts the CLI and emits SIGINT after 700 ms.
3. Confirm the CLI prints `status cancelled`, `slots 0/20 terminal`, `barrier not-run`, `cancellation reason=sigint phase=preparation drained=drained marked_uncertain=0`, and exits 130.
4. Inspect `/tmp/p35-cancel.sqlite`: the run remains `running`, there is one `run_cancelled` event, no `duplicate_barrier` or `run_completed`, some slots are partially prepared, no slot is terminal, and no attempt remains `dispatching`.
5. Confirm the cancellation checkpoint is resumable and the reservations are truthful; no success message or artificial completion is present.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
cd /home/alex/ai-puzzle-factory
cat > /tmp/p35-cancel-check.mts <<'TS'
import { rmSync } from "node:fs";
import { main } from "/home/alex/ai-puzzle-factory/src/cli/experiment.ts";

const dbPath = "/tmp/p35-cancel.sqlite";
rmSync(dbPath, { force: true });
setTimeout(() => {
  process.emit("SIGINT");
}, 700);
const code = await main([
  "node",
  "experiment",
  "--smoke",
  "--mock",
  "--seed",
  "puzzle-smoke-v1",
  "--concurrency",
  "2",
  "--max-cost",
  "0",
  "--db",
  dbPath,
]);
console.log("exit", code);
TS
npx tsx /tmp/p35-cancel-check.mts
sqlite3 /tmp/p35-cancel.sqlite "select run_id, control_state from runs;"
sqlite3 /tmp/p35-cancel.sqlite "select count(*), sum(stage='terminal'), sum(stage='planned') from slots;"
sqlite3 /tmp/p35-cancel.sqlite "select event_type, count(*) from events group by event_type order by event_type;"
sqlite3 /tmp/p35-cancel.sqlite "select count(*) from request_attempts where state='dispatching';"
```

Expected: `exit 130`; `running`; a partial slot count with `0` terminal and some planned slots; `run_cancelled 1`, `run_created 1`, and `stage_committed` events but no `duplicate_barrier` or `run_completed`; `0` dispatching attempts. The cancellation event's budget snapshot shows truthful reserved/unknown amounts.

**Decision-reviewer:** the first static pass confirmed the implementation paths and found two verification gaps against the stage line: the drain-timeout branch and the in-process two-worker shared-cap admission were not exercised. Both were fixed with focused cases: a blocking timeout scenario plus a 50 ms drain window asserts `drained: "timeout"`, an uncertain attempt, a retained reservation with null actual cost, and no `run_completed`; a two-worker `admitRequest` case against a shared `0.01` cap asserts exactly one admitted reservation, one `INSUFFICIENT_BUDGET` pause, reserved `0.01`, and no overshoot. Follow-up passes found two Low test-hygiene issues in the new drain-timeout poller (unhandled rejection, then a hidden captured cause); both were fixed by catching/awaiting the poller, asserting the captured error immediately after the run, and embedding it in the dispatching-attempt guard. The final pass found no material findings or regressions.

**Acceptance:** accepted by the user on 2026-11-05 after the focused suite, the exact non-UI script, and the full `npm run check` evidence.

**Out of scope, unchanged:** multi-process/distributed workers, full resume/reconciliation, reports, HTML, the gallery, and any paid provider request.

## P36. Crash-Safe Resume and Reconciliation — 2026-11-05

**State:** implemented, offline-verified, and accepted by the user on 2026-11-05. This phase resumes the same smoke run from committed checkpoints, reuses saved responses, and never resends an uncertain dispatch. It does not add multi-process workers, reports, HTML, or the gallery.

**Files**

- Runner: `src/runner/resume.ts`
- Extended runner: `src/runner/run.ts` (generic smoke cohort, resume mode, hooks, barrier reuse), `src/runner/prepare-slot.ts` and `src/runner/review-slot.ts` (stage-aware resume)
- Ledger/storage/transport integration: `src/ai/ledger.ts` (`getOrCreateLogicalCall`), `src/storage/artifacts.ts` (`getArtifactById`), `src/ai/openrouter.ts` (`afterResponseSaved` test hook and `replaySavedResponse`), `src/ai/mock.ts` (hook pass-through and exported oracle helper)
- Adapters: `src/ai/propose-spec.ts`, `write-wording.ts`, `review-text.ts`, `review-vision.ts`, `review-alignment.ts` now reuse an existing identical logical call and reject request/schema/model changes
- CLI: `src/cli/experiment.ts` (`--resume <run-id>`, `--ack-budget-increase`, `--operator`, writer lock, exit behavior)
- Tests: `tests/runner/resume.test.ts`, `tests/helpers/runner-child.ts`, `tests/helpers/fake-openrouter.ts` (responder)
- Documentation: `README.md` and this file

**Observable behavior**

- Resume is stage-aware. A planned slot may acquire a spec; a `spec_ready` slot skips spec; a `formal_checked` slot skips spec/formal; `presentation_ready` and review-stage slots return the persisted preparation; `terminal` early failures are preserved, and a review-committed terminal is reconstructed from the persisted `formal_checked`/`presentation_ready` checkpoints and preserved without re-running review calls. Reviews resume from `duplicate_checked`, `blind_reviewed`, or `alignment_reviewed` without re-running completed review calls.
- The adapter/ledger path uses `getOrCreateLogicalCall`, so the same run/slot/role keeps one logical-call key. A changed request body, schema hash, model, provider, output-cap field, or run kind is rejected as `CALL_CONFIG_MISMATCH`; the resume CLI reports `CONFIG_MISMATCH`.
- The resume transport distinguishes call states: `prepared`/`refused_unprocessed` may be sent; `dispatching` is transitioned to `uncertain`, its reservation is retained, and it is never sent; `response_saved`/`validated`/`failed_known`/`uncertain` replay the stored raw response without a new HTTP request. A valid saved body is revalidated and its stage commits normally.
- The duplicate barrier is reused from the persisted `duplicate_barrier` event when present; missing `duplicate_checked` stages are filled from the persisted assessments. A missing barrier is recomputed only after all 20 preparation results exist. A barrier event with an assessment gap or duplicate-checked stages without the event is rejected.
- Resume rejects a completed run, a mode mismatch, a manifest/protocol mismatch, and an active writer. A `paused_budget` run requires `--max-cost` plus `--ack-budget-increase`; the cap change is recorded with operator/old/new values, the run returns to `running`, and the existing pause event is superseded by the cap-change event.
- No slot is replaced and no new logical call is created for an existing run/slot/role. The run UUID, slot identities, stage keys, attempt keys, and reservation exposure are preserved. An uncertain request remains visible and is not replayed.
- The CLI supports `npm run experiment -- --resume <run-id> --mock [--max-cost <usd> --ack-budget-increase --operator <name>]`; `--full`, `--smoke`, `--seed`, `--dry-run`, and `--live` are rejected with resume, and invalid concurrency/cost values fail before the database is opened.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/runner/resume.test.ts --reporter=verbose` | exit 0; 1 file / 11 tests passed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 37 files / 510 tests passed, build succeeded. |
| P35 cancellation then CLI resume | cancelled run `b5edc3bc-2952-4223-9af4-6d81128676be` resumed to 20/20 terminal, 20 approved, 70 calls, `completed`, with both `run_cancelled` and `run_completed` events. |
| Intentional uncertain request then CLI resume | run `123e4567-e89b-42d3-a456-426614174090` ended 20/20 terminal, 19 approved + 1 generation_error, 67 calls, 1 unknown attempt; the uncertain attempt stayed `uncertain` and was not replayed. |

The focused suite spawns a child against a loopback fake and kills it at five crash windows: before dispatch, after acceptance/before response persistence, after response save/before validation, after the first committed presentation checkpoint, and after the first slot's review `terminal` commit. The last window produces a partially reviewed cohort; the restart reconstructs that reviewed terminal as ready and preserves it while reviewing the remaining 19. Each restart asserts no duplicate logical call, no duplicate stage, retained slot identities, the expected saved-response reuse or uncertain non-replay, the correct first-slot verdict, and the expected request count. Separate cases cover completed-run rejection, manifest/protocol mismatch, mode mismatch, stored request/model mismatch, missing run, budget-increase authorization, and active writer.

**Manual acceptance steps**

1. Run the exact cancellation-and-resume script below. It uses the P35 SIGINT script to create a partial mock run, then runs the CLI resume on the same UUID.
2. Confirm the resumed run is `completed`, has 20/20 terminal slots, 20 approved, 70 calls, and both `run_cancelled` and `run_completed` events. The UUID and slot ledger are the same.
3. Run the exact uncertain-request script below. It creates a dispatching mock call, marks it uncertain, then resumes through the CLI.
4. Confirm the resumed run is `completed` with 20/20 terminal, 19 approved + 1 generation_error, the intentionally uncertain attempt remains `uncertain`, it was not replayed, and the run has 67 calls with 1 unknown attempt.
5. Confirm no `.env`, live provider, HTML, report, gallery, multi-process worker, or slot replacement was involved.

**Exact non-UI acceptance script — cancellation and resume**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
cd /home/alex/ai-puzzle-factory
cat > /tmp/p35-cancel-check.mts <<'TS'
import { rmSync } from "node:fs";
import { main } from "/home/alex/ai-puzzle-factory/src/cli/experiment.ts";
const dbPath = "/tmp/p35-cancel.sqlite";
rmSync(dbPath, { force: true });
setTimeout(() => process.emit("SIGINT"), 700);
const code = await main(["node","experiment","--smoke","--mock","--seed","puzzle-smoke-v1","--concurrency","2","--max-cost","0","--db",dbPath]);
console.log("exit", code);
TS
npx tsx /tmp/p35-cancel-check.mts
RUN_ID=$(sqlite3 /tmp/p35-cancel.sqlite "select run_id from runs limit 1;")
test -n "$RUN_ID"
npm run experiment -- --resume "$RUN_ID" --mock --db /tmp/p35-cancel.sqlite
sqlite3 /tmp/p35-cancel.sqlite "select control_state from runs where run_id='$RUN_ID';"
sqlite3 /tmp/p35-cancel.sqlite "select count(*), sum(stage='terminal'), sum(verdict='approved') from slots where run_id='$RUN_ID';"
sqlite3 /tmp/p35-cancel.sqlite "select event_type, count(*) from events where run_id='$RUN_ID' group by event_type order by event_type;"
```

Expected: the first command exits 130 with a partial run; the resume prints the same run UUID with `status completed`, `slots 20/20 terminal`, `verdicts approved=20`; SQLite shows `completed`, `20|20|20`, and both `run_cancelled` and `run_completed` events.

**Exact non-UI acceptance script — intentional uncertain request**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
cd /home/alex/ai-puzzle-factory
cat > /tmp/p36-uncertain-acceptance.mts <<'TS'
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createBudgetAccount } from "/home/alex/ai-puzzle-factory/src/ai/budget.ts";
import { createMockTransport } from "/home/alex/ai-puzzle-factory/src/ai/mock.ts";
import { buildPlanManifest } from "/home/alex/ai-puzzle-factory/src/experiment/planner.ts";
import { prepareSlot } from "/home/alex/ai-puzzle-factory/src/runner/prepare-slot.ts";
import { mockRoute } from "/home/alex/ai-puzzle-factory/src/runner/run.ts";
import { markUnfinishedDispatchesUncertain } from "/home/alex/ai-puzzle-factory/src/runner/cancel.ts";
import { migrate, openDatabase } from "/home/alex/ai-puzzle-factory/src/storage/database.ts";
import { createRun } from "/home/alex/ai-puzzle-factory/src/storage/repository.ts";
const dbPath = "/tmp/p36-uncertain.sqlite";
rmSync(dbPath, { force: true });
const plan = buildPlanManifest({ runKind: "smoke" });
const runId = "123e4567-e89b-42d3-a456-426614174090";
const accountId = "p36-uncertain";
const db = openDatabase(dbPath);
migrate(db);
createRun(db, { runId, plan, evidenceKind: "mock", createdAt: "2026-11-05T00:00:00.000Z" });
createBudgetAccount(db, { accountId, runId, runKind: "smoke", maxCostUsd: "10", createdAt: "2026-11-05T00:00:00.000Z" });
const clock = { now: () => new Date(), sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) };
const mock = createMockTransport({ db, clock, random: () => 0, deadlineMs: 1000 });
const preparation = prepareSlot({ db, runId, slotId: "text-ranking-02", accountId, apiKey: "p36-acceptance-key", transport: mock, routes: { spec: mockRoute("spec"), wording: mockRoute("wording") }, reservations: { spec: "0.01", wording: "0.01" }, mockScenarioKinds: { spec: "timeout" }, clock });
let attemptId = "";
const deadline = Date.now() + 800;
while (Date.now() < deadline) {
  const row = db.prepare("SELECT attempt_id FROM request_attempts WHERE logical_call_id IN (SELECT logical_call_id FROM logical_calls WHERE run_id = ?) AND state = 'dispatching' LIMIT 1").get(runId) as { attempt_id: string } | undefined;
  if (row !== undefined) { attemptId = row.attempt_id; break; }
  await new Promise((resolve) => setTimeout(resolve, 10));
}
if (attemptId === "") throw new Error("no dispatching attempt");
markUnfinishedDispatchesUncertain(db, runId, new Date().toISOString());
await preparation.catch(() => undefined);
db.close();
process.stdout.write(execFileSync("npm", ["run", "--silent", "experiment", "--", "--resume", runId, "--mock", "--db", dbPath], { cwd: "/home/alex/ai-puzzle-factory", encoding: "utf8" }));
const check = openDatabase(dbPath);
console.log("slot", check.prepare("SELECT stage, verdict FROM slots WHERE run_id = ? AND slot_id = 'text-ranking-02'").get(runId));
console.log("attempt", check.prepare("SELECT state FROM request_attempts WHERE attempt_id = ?").get(attemptId));
console.log("counts", check.prepare("SELECT COUNT(*) AS count, SUM(stage = 'terminal') AS terminal, SUM(verdict = 'approved') AS approved, SUM(verdict = 'generation_error') AS generation_error FROM slots WHERE run_id = ?").get(runId));
console.log("control", check.prepare("SELECT control_state FROM runs WHERE run_id = ?").get(runId));
check.close();
TS
npx tsx /tmp/p36-uncertain-acceptance.mts
```

Expected: `status completed`, `slots 20/20 terminal`, `verdicts approved=19 ... generation_error=1`, `attempts 67 unknown=1`; SQLite shows `text-ranking-02` terminal/generation_error, the attempt `uncertain`, `20/20/19/1`, and `completed`.

**Decision-reviewer:** the first static pass found two material findings: a High resume abort when a slot had already committed its review-path `terminal` (the resume preparation reader parsed the reviewed payload with the early-failure schema), and a Medium coverage gap because the fifth child crash point fired before any review call. The fix distinguishes early-failure and reviewed terminal payloads, reconstructs a reviewed terminal from the persisted `formal_checked`/`presentation_ready` checkpoints, filters review roles out of preparation evidence, and moves the fifth crash point to `onSlotReviewed` after the first slot's terminal commit. A second pass confirmed both fixes and found only a Low stale phase-record description plus a non-material inverted parameter name; both were corrected. The final pass found no material findings and confirmed the record and rename are consistent with the implementation.

**Acceptance:** accepted by the user on 2026-11-05 after the focused suite, the exact non-UI scripts, and the full `npm run check` evidence.

**Out of scope, unchanged:** exactly-once external billing, automatic semantic repair, multi-process workers, reports, HTML, the gallery, and any paid provider request.

## P37. Exact Metrics and Machine-Readable Exports — 2026-11-05

**State:** implemented, offline-verified, and accepted by the user on 2026-11-05. This phase adds pure metric projections and controlled JSONL/CSV/asset exports over committed SQLite snapshots. It does not add the HTML gallery, calibration scoring, or business success claims.

**Files**

- Metrics: `src/reporting/metrics.ts`
- Export: `src/reporting/export.ts`
- CLIs: `src/cli/report.ts`, `src/cli/export.ts`
- Scripts: `package.json` (`report`, `export`)
- Tests: `tests/reporting/metrics.test.ts`, `tests/reporting/export.test.ts`, `tests/reporting/fixtures.ts`
- Documentation: `README.md` and this file

**Observable behavior**

- `computeRunMetrics` reads a committed run, its slots, stages, logical calls, attempts, and budget accounts. It never writes to the database.
- Counts and rates use the planned manifest denominator: planned, started, terminal, fingerprintable, formal-passed, presentation-check-passed, reviewed, approved, rejected, inconclusive, generation-error, paused, unstarted, and infrastructure-only terminal failures. The secondary approval rate excludes only terminal failures whose codes are exclusively `API_ERROR`/`MISSING_REVIEW`/`COST_UNKNOWN`; it is marked provisional when terminal < planned and the planned-denominator primary rate remains beside it.
- Review metrics report parsed/agreed/disagreed/not-applicable blind counts, ambiguity, incomplete reviews, alignment pass/fail/uncertain, per-role split, review coverage, and the conditional agreement denominator. Structural uniqueness is distinct structure hashes / fingerprintable candidates with separate fingerprint coverage.
- Cost metrics preserve unknown money as `null`, report a known lower bound, unknown attempts, reserved/unknown exposure per approval, per-role average review cost and request counts, generator/text-review/vision-review rollups, and separate end-to-end costs by preflight/calibration/smoke/full run kind. Usage metrics sum non-null prompt/completion/total/cached/reasoning tokens and report missing-field counts rather than treating null as zero.
- Latency reports mean/median/nearest-rank-p95 for HTTP attempts and logical-call elapsed time per role, per-candidate preparation/review active time from stage durations, and end-to-end wall time from first stage start to terminal. Missing end times stay null and are counted.
- Failure-code frequencies may sum above the candidate count and are reported with a separate exclusive verdict histogram. Near-duplicate evidence is split into only-near, additional-quality, and incomplete/failed-review categories by family and lane.
- Tables cover modality, family, lane, target difficulty, family-by-lane, modality-by-difficulty, and family-by-difficulty, always including planned failures/unstarted slots. Approval rates include Wilson 95% intervals; zero denominators yield null/N/A; notes mark the 6-item SVG `ai_spec` cells exploratory and state that difficulty is the requested setting, not validated human difficulty.
- `exportRun` writes `manifest.json`, `summary.json`, `candidates.jsonl`, `requests.jsonl`, `results.csv`, `puzzles/<slot-id>.json`, and `images/<slot-id>.svg|png` under `data/runs/<uuid>/`. Candidate and CSV rows preserve one row per planned slot, including missing presentations and failures. Requests include request bodies, raw response bodies, attempt metadata, cost, and reservation evidence; no API key or authorization header is exported.
- CSV string fields are formula-injection escaped (`=`, `+`, `-`, `@`, leading control/whitespace) while the JSON source remains unchanged. The export path is derived from a validated run UUID under the controlled root; unsafe paths and invalid formats are rejected. JSONL candidates/requests and CSV results can be re-imported structurally.
- The CLIs are `npm run report -- --run <run-id> [--db <path>]` and `npm run export -- --run <run-id> --format csv|jsonl|all [--db <path>]`. HTML is not generated.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/reporting/metrics.test.ts tests/reporting/export.test.ts` | exit 0; 2 files / 13 tests passed. |
| `npm run report -- --run 6732cab0-3f25-4183-acd9-4253cc9ada9f` | 20 planned/started/terminal/approved, known actual `0`, 70 attempts, finite tables and Wilson intervals. |
| `npm run export -- --run 6732cab0-3f25-4183-acd9-4253cc9ada9f --format csv` | wrote `manifest.json`, `summary.json`, `results.csv`; results has 21 lines (header + 20 slots). |
| `npm run export -- --run 6732cab0-3f25-4183-acd9-4253cc9ada9f --format all` | 45 files: 20 candidates, 70 requests, 20 puzzles, 20 images (10 SVG + 10 PNG), manifest, summary, results CSV. |
| `npm run report -- --run 123e4567-e89b-42d3-a456-426614174090 --db /tmp/p36-uncertain.sqlite` | 20 planned/terminal, 19 approved + 1 generation_error, presentation missing 1, cost unknown, actual null, known `0`, unknown attempt 1. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 39 files / 523 tests passed, build succeeded. |

The focused metrics suite uses a hand-calculated 20-slot synthetic cohort with five started slots, one approved, one rejected, two inconclusive (one near-only, one review-failure), one generation error, missing presentations, unknown cost/usage/end times, retry-inclusive call durations, multiple failure codes, and near-duplicate evidence. It asserts planned-denominator rates, infrastructure-only exclusion, review coverage, structural uniqueness, cost/usage rollups, mean/median/p95 values, tables, Wilson intervals, and a zero-start/zero-approval run without NaN/Infinity. Additional cases cover prepared/refused-unprocessed attempts as known zero money, non-terminal review-stage failures, and completed-review near findings versus unverified evidence. The export suite asserts one row per planned slot, missing/failed records, real SVG/PNG assets, request/raw-response/reservation evidence, JSONL re-import, CSV parsing, formula escaping, safe paths, invalid formats, format-specific files, non-terminal review failures, and unbilled per-slot cost agreement with `summary.json`.

**Manual acceptance steps**

1. Run the exact commands below against the completed mock run.
2. Confirm the report shows 20 planned/started/terminal/approved, known cost `0`, 70 attempts, and no unknown money; inspect the tables and missing-evidence counts.
3. Confirm the CSV has one row per planned slot and the all-format export has 20 candidates, 70 requests, 20 puzzles, and 20 images.
4. Run the report against `/tmp/p36-uncertain.sqlite` and confirm 20 planned/terminal, 19 approved + 1 generation_error, presentation missing 1, cost unknown with `actual: null` and known `0`, and the failed slot present with an empty question in CSV.
5. Confirm no HTML/report gallery exists and no API key/authorization header appears in `requests.jsonl`.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
cd /home/alex/ai-puzzle-factory
RUN_ID=6732cab0-3f25-4183-acd9-4253cc9ada9f
npm run report -- --run "$RUN_ID" > /tmp/p37-report.json
node -e "const m=require('/tmp/p37-report.json'); console.log({planned:m.counts.planned,started:m.counts.started,terminal:m.counts.terminal,approved:m.counts.approved,attempts:m.cost.attempts,known:m.cost.knownActualUsd,actual:m.cost.actualCostUsd,unknown:m.cost.unknownAttempts});"
npm run export -- --run "$RUN_ID" --format csv
npm run export -- --run "$RUN_ID" --format all
DIR="data/runs/$RUN_ID"
wc -l "$DIR/candidates.jsonl" "$DIR/requests.jsonl" "$DIR/results.csv"
ls "$DIR/images" | wc -l
ls "$DIR/puzzles" | wc -l
npm run report -- --run 123e4567-e89b-42d3-a456-426614174090 --db /tmp/p36-uncertain.sqlite > /tmp/p37-uncertain-report.json
node -e "const m=require('/tmp/p37-uncertain-report.json'); console.log({planned:m.counts.planned,terminal:m.counts.terminal,approved:m.counts.approved,generation_error:m.counts.generationError,presentation_missing:m.missing.stages.presentation,cost_status:m.cost.costStatus,actual:m.cost.actualCostUsd,known:m.cost.knownActualUsd,unknown_attempts:m.cost.unknownAttempts});"
npm run export -- --run 123e4567-e89b-42d3-a456-426614174090 --db /tmp/p36-uncertain.sqlite --format csv
grep 'text-ranking-02' data/runs/123e4567-e89b-42d3-a456-426614174090/results.csv
grep -c '^' "$DIR/results.csv"
```

Expected: report `planned 20`, `started 20`, `terminal 20`, `approved 20`, `attempts 70`, `known 0`, `actual 0`, `unknown 0`; candidates `20`, requests `70`, results `21` lines, images `20`, puzzles `20`; uncertain report `planned 20`, `terminal 20`, `approved 19`, `generation_error 1`, `presentation_missing 1`, `cost_status unknown`, `actual null`, `known 0`, `unknown_attempts 1`; the partial CSV row for `text-ranking-02` shows `cost_status` `unknown` and an empty `actual_cost_usd`, never zero.

**Decision-reviewer:** the first static pass found four material findings: candidate review active time was fabricated for candidates without review stages and its missing count was hardcoded to zero (Medium); near-duplicate evidence put completed-review quality findings into the unverified bucket (Medium); provably unbilled prepared/refused attempts still nulled run money (Medium); and failure frequencies omitted non-terminal review-stage failures (Low). The fixes require all four review stages for a review-time observation, derive missing review/wall coverage from started views, reserve `incompleteOrFailedReview` for missing or failed review evidence, share `isProvablyUnbilledAttempt` across metrics and export, and aggregate stage-level `failure` records when no terminal exists. A verification pass confirmed those four fixes but found the same unbilled-money rule still missing from exported per-slot/CSV cost fields (Medium); the shared helper is now used in `costForSlot`, with candidate/CSV/summary agreement tested. The final pass found no material findings; it noted only non-material maintainability/raw-evidence observations. Focused suite: 13 tests; full `npm run check`: 39 files / 523 tests.

**Acceptance:** accepted by the user on 2026-11-05 after the focused suite, the exact non-UI script, and the full `npm run check` evidence.

**Out of scope, unchanged:** HTML gallery, browser acceptance, calibration scoring, audit labels, business success claims, and any paid provider request.

## P38. Static Offline HTML Gallery — 2026-11-06

**State:** implemented, offline-verified, browser-checked from `file://`, and accepted by the user on 2026-11-06. This phase adds a static gallery over committed SQLite snapshots. It does not add browser automation, live execution, calibration scoring, or business success claims.

**Files**

- Gallery: `src/reporting/html.ts`
- Fixed assets: `src/reporting/assets/report.css`, `src/reporting/assets/report.js`
- CLI integration: `src/cli/report.ts` (metrics stdout preserved; gallery path on stderr)
- Export reuse: `src/reporting/export.ts` (exported `buildCandidateRows`, `buildRequestRows`, `resolveRunDirectory`, `writeAtomicFile`)
- Build: `scripts/copy-assets.mjs` (copies the reporting assets into `dist/reporting/assets`)
- Tests: `tests/reporting/html.test.ts`, `tests/reporting/fixtures.ts` (optional hostile-text, live-evidence, blind-disagreement, and alignment-outcome fixture options)
- Documentation: `README.md` and this file

**Observable behavior**

- `npm run report -- --run <run-id>` still writes the exact P37 metrics JSON to stdout and now writes `data/runs/<run-id>/report.html` plus `data/runs/<run-id>/images/<slot-id>.png|svg` for every referenced artifact. The absolute gallery path is printed on stderr. The metrics are emitted before the gallery write, so a gallery write failure cannot suppress the read-only metrics contract.
- The gallery contains one card for every planned slot, including unstarted slots, early failures, review failures, and terminal failures. Each card shows its status badge, family/modality/lane/difficulty/stage badges, alignment outcome when available, public question/rules/clues/options, the local PNG (or an SVG-only fallback), visible failure records and evidence, and closed-by-default reveal sections for key/hint/explanation, proof/fingerprint/terminal payload, blind/alignment/duplicate reviews, and cost/failure/provenance details.
- Filters cover modality, family, lane, status, difficulty, and reviewer disagreement. Disagreement means a blind reviewer chose a different option or the committed `REVIEWER_DISAGREES` failure exists; an alignment non-pass is shown separately as an `alignment fail|uncertain` badge and is not treated as reviewer disagreement. Native `<select>`, `<details>`, `<button>`, and `<dialog>` controls provide keyboard-accessible filtering, reveal-all/hide-all, and full-image zoom.
- Mock/live and incomplete-run banners are derived from the committed run. The header shows planned/started/terminal/approved/rejected/inconclusive/generation-error/unstarted counts, known and actual cost with an explicit cost status, and unknown-attempt counts. A zero-attempt run renders `not applicable`, never `unknown`, for actual cost.
- All model-authored text is HTML-escaped in text and attribute contexts. The embedded `application/json` report block escapes `<`, `>`, `&`, U+2028, and U+2029, so `</script>` cannot terminate the block. The fixed CSS and JavaScript are inlined with generated SHA-256 CSP hashes; the meta CSP is `default-src 'none'; base-uri 'none'; form-action 'none'; img-src 'self' data:; style-src 'sha256-…'; script-src 'sha256-…'`. There is no fetch, CDN, stylesheet link, or remote resource. The only non-image data URI is a local favicon.
- The layout uses a responsive card grid and a 640px media query. At a 360px viewport the card and image widths stay inside the viewport with zero horizontal overflow.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/reporting/html.test.ts` | exit 0; 1 file / 11 tests passed. |
| `npm exec -- vitest run tests/reporting/metrics.test.ts tests/reporting/export.test.ts` | exit 0; 2 files / 13 tests passed after the shared fixture changes. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 40 files / 534 tests passed, build succeeded. |
| `npm run --silent report -- --run 6732cab0-3f25-4183-acd9-4253cc9ada9f` | metrics unchanged: 20 planned/started/terminal/approved, 70 attempts, known/actual `0`, unknown `0`; printed `report.html /home/alex/ai-puzzle-factory/data/runs/6732cab0-3f25-4183-acd9-4253cc9ada9f/report.html`. |
| Gallery artifact check | `report.html` 454,561 bytes, SHA-256 `11c8165ff5c980a678e3afb1a4a001aaf242f8e9c056bf1e3e465f5c40e86507`; 20 cards; 80 closed reveal sections; 20 image files (10 PNG + 10 SVG). |
| Headless Chrome `file://` check | 20 cards, 80 details closed on load, SVG card PNG loaded at 1024x1024, modality filter left 10 SVG cards, reveal-all opened 80, zoom dialog opened a 1024px image and closed, no console errors, 360px horizontal overflow `0`. |

The focused suite asserts card-per-planned-slot coverage, failure visibility, closed reveal sections, CSP hash equality for the inline CSS/JS, hostile `</script>`/attribute escaping, parseable embedded JSON, local image paths and files, all six filters, keyboard controls, mock/live/incomplete banners, per-card cost/status/provenance, alignment-versus-disagreement separation, zero-attempt cost semantics, deterministic rewrite, and invalid/unknown run rejection. It does not assert browser layout or CSP enforcement; those were checked manually in headless Chrome.

**Manual acceptance steps**

1. Run the exact commands below and open the printed `report.html` directly from the filesystem (not through a server).
2. Confirm the header shows the mock banner, 20 planned/terminal/approved cards, cost status `known`, and no incomplete banner.
3. Reveal key/hint/explanation on an approved text card and on an SVG card; confirm the key/hint/explanation appear only after opening the section.
4. Filter modality to `svg`, confirm 10 cards remain; reset; filter family, lane, status, difficulty, and disagreement and confirm card membership changes.
5. Zoom an SVG card image; confirm the full-size PNG opens and Escape or Close returns to the gallery.
6. Scroll to `text-ranking-02` (generation error) and `text-truth-01` (rejected) and confirm their failure codes and evidence are visible without opening a reveal section.
7. Resize the window to 360px wide and confirm there is no horizontal scrolling and images stay inside cards.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
cd /home/alex/ai-puzzle-factory
RUN_ID=6732cab0-3f25-4183-acd9-4253cc9ada9f
npm run --silent report -- --run "$RUN_ID" > /tmp/p38-report.json 2>/tmp/p38-report.err
cat /tmp/p38-report.err
node -e "const m=require('/tmp/p38-report.json'); console.log({planned:m.counts.planned,started:m.counts.started,terminal:m.counts.terminal,approved:m.counts.approved,attempts:m.cost.attempts,known:m.cost.knownActualUsd,actual:m.cost.actualCostUsd,unknown:m.cost.unknownAttempts});"
DIR="data/runs/$RUN_ID"
test -f "$DIR/report.html"
test "$(ls "$DIR/images" | wc -l)" -eq 20
node -e "const fs=require('fs'); const html=fs.readFileSync(process.argv[1],'utf8'); const count=(re)=>(html.match(re)||[]).length; const script=html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)[1]; const hash=require('crypto').createHash('sha256').update(script,'utf8').digest('base64'); console.log({cards:count(/<article class=\"card\"/g),details:count(/<details class=\"reveal\"/g),open:count(/<details class=\"reveal\"[^>]* open/g),filters:count(/data-filter=/g),pngPaths:count(/src=\"images\/[^\"]+\.png\"/g),cspHash:html.includes('sha256-'+hash),remote:/https?:\/\//.test(html),fetch:html.includes('fetch(')});" "$DIR/report.html"
```

Expected: metrics `planned 20`, `started 20`, `terminal 20`, `approved 20`, `attempts 70`, `known 0`, `actual 0`, `unknown 0`; `report.html` exists; 20 image files; card count `20`, details `80`, open `0`, filters `6`, PNG paths `10`, `cspHash true`, `remote false`, `fetch false`.

**Decision-reviewer:** the first static pass found three Low implementation findings and one Medium verification-record gap. The implementation findings were: the disagreement filter conflated alignment failure with blind reviewer disagreement; the report CLI emitted metrics only after the gallery write, so an unwritable output root suppressed the P37 stdout contract; and the run header rendered a zero-attempt known-zero cost as `unknown`. The fixes restrict disagreement to blind `disagreed`/`REVIEWER_DISAGREES`, add a separate alignment badge, emit metrics before the gallery write, and render `not applicable` plus an explicit cost-status item for zero attempts. The verification-record gap was the absence of a P38 entry and of direct `file://` evidence; this entry records the headless Chrome `file://` check above. A verification pass confirmed all four fixes and found no material findings; it noted only a non-material per-card cost wording inconsistency, now removed by sharing the cost formatter. Focused suite: 11 tests; full `npm run check`: 40 files / 534 tests.

**Acceptance:** accepted by the user on 2026-11-06 after the focused suite, the exact non-UI script, the full `npm run check` evidence, and the direct `file://` browser check.

**Out of scope, unchanged:** automated Playwright/browser acceptance (P39), full/live runs, calibration scoring, audit labels, business success claims, and any paid provider request.

## P39. Browser Acceptance for the Offline Gallery — 2026-11-06

**State:** implemented, browser-verified, and accepted by the user on 2026-11-06. This phase adds an independent Playwright Chromium regression suite for the P38 static gallery. It adds no report features, hosting, server, or live model call.

**Files**

- Browser config: `playwright.config.ts`
- Browser suite: `tests/browser/report.spec.ts`
- Deterministic fixture generator: `tests/browser/generate-fixture.ts`
- Fixture support: `tests/reporting/fixtures.ts` (`largeVisual` option for a 1024x1024 browser PNG and opt-in `includeIncomplete` slot; P38 fixture defaults unchanged); `tests/reporting/html.test.ts` (defensive `terminal_without_verdict` renderer/filter test)
- Tooling: `package.json`, `package-lock.json` (`@playwright/test` pinned to `1.65.0`; `test:browser` script)
- Type/lint hygiene: `tsconfig.json` includes `playwright.config.ts`; `.gitignore` excludes `test-results/`, `playwright-report/`, and `blob-report/`
- Documentation: `README.md` and this file

**Observable behavior**

- `npm run test:browser` first runs `tsx tests/browser/generate-fixture.ts`, which creates a deterministic mock SQLite fixture under `data/browser-report/` and writes the real `report.html` plus local PNG/SVG files. It then runs Playwright against the generated file.
- The suite opens the gallery directly through a `file://` URL in Chromium. No HTTP server, dev server, API key, `.env`, or live provider call is used.
- It asserts the effective 1440x900 desktop and 360x800 mobile viewports and zero horizontal document overflow. It covers all 20 planned cards, mock/incomplete banners, visible failure evidence for generation-error and rejected slots, an `incomplete` card plus its Status-filter result, unstarted cards, 80 closed reveal sections on load, keyboard reveal/reveal-all/hide-all, keyboard modality selection plus all six select filters and reset, modal full-image zoom with Escape close and a rendered zoom box of at least 600x600 with a 1:1 aspect ratio, hostile `</script>`/attribute text rendered inert, parseable embedded JSON, a restrictive CSP with a matching script hash, zero external HTTP(S) requests, zero console/page errors, zero alert dialogs, and a visible relative 1024x1024 PNG under `img-src 'self'`.
- The browser suite is separate from Vitest (`tests/browser/*.spec.ts` is not matched by the Vitest include) and is not part of `npm run check`.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec playwright install chromium` | Playwright `1.65.0`; Chromium `1254` (Chrome for Testing 158.0.8127.18) installed. |
| `npm exec -- vitest run tests/reporting/html.test.ts` | exit 0; 12 tests passed. |
| `npm run test:browser` | exit 0; 6 tests passed using 1 worker. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 40 files / 535 tests passed, build succeeded. |

**Manual acceptance steps**

1. Run the exact commands below and open the printed `report.html` through a direct `file://` URL in Chromium (desktop width). Do not use a JetBrains/VS Code live-preview server (`?_ijt=...`); it injects a reload script and may trigger Chrome DevTools workspace probes, both of which the restrictive CSP correctly blocks.
2. Confirm no key/hint/explanation/proof/review content is visible before opening any reveal section.
3. Exercise the six filters, reveal-all/hide-all, and image zoom; confirm the zoomed PNG is the local file and Escape closes the dialog.
4. Confirm the generation-error and rejected cards keep their failure codes/evidence visible.
5. Resize to 360px wide and confirm there is no horizontal scrolling and the controls remain usable.
6. Confirm no browser console errors and no external network requests appear while the page is open.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
cd /home/alex/ai-puzzle-factory
npm exec playwright install chromium
npm run test:browser
npm run check
```

Expected: Chromium installation succeeds (or reports the pinned browser already installed); `npm run test:browser` prints 6 passed; `npm run check` ends with 40 test files / 535 tests passed and a successful build. The generated gallery path is printed by the fixture generator and recorded in `data/browser-report/fixture.json` (ignored).

**Browser console note:** a report loaded through a JetBrains live-preview server can show two CSP console messages that are not gallery defects. The IDE appends an inline reload script after the 1181-line report; its hash (`sha256-C9Pc...` in the observed case) differs from the gallery script hash in the CSP (`sha256-XK2...`). Chrome DevTools may also probe `http://localhost:<port>/.well-known/appspecific/com.chrome.devtools.json`, which `default-src 'none'` blocks. The gallery's own `file://` load has zero console/page errors in the P39 suite. Allowing either injected behavior would require weakening the CSP with `unsafe-inline` or a localhost `connect-src`, which is out of scope and contrary to P38/P39.

**Decision-reviewer:** the first static pass found three Low acceptance-coverage findings: the desktop 1440x900 viewport was only configured, not asserted; the fixture could not produce an `incomplete` card (and `terminal_without_verdict` had no coverage); and zoom asserted only `naturalWidth`, not the rendered modal image size. Fixes: desktop/mobile tests now assert `page.viewportSize()`; the browser fixture includes a started non-terminal `text-matching-02` card and asserts its `incomplete` badge plus the Status filter, while the defensive `terminal_without_verdict` renderer/filter path is covered by a P38 unit test because the storage CHECK `(stage = 'terminal') = (verdict IS NOT NULL)` makes that state unreachable from a valid database; and the desktop zoom test now asserts the rendered `#zoom-image` box is at least 600x600 and square. The focused HTML suite is now 12 tests. A verification pass closed all three findings and found only a documentation-staleness residual, now corrected; no material residual findings remain.

**Acceptance:** accepted by the user on 2026-11-06 after the browser suite, the exact non-UI script, the full `npm run check` evidence, and the direct `file://` desktop/mobile observation. The IDE live-preview console messages were diagnosed as injected JetBrains/DevTools resources blocked by the intended CSP, not gallery defects.

**Out of scope, unchanged:** new report features, network hosting, live model calls, calibration scoring, audit labels, and business success claims.

## P40. Held-Out Calibration Fixture Pack and Pending Ground Truth — 2026-11-06

**State:** implemented, offline-verified, artifact-checked, and accepted by the user on 2026-11-06. This phase creates a deterministic 40-item calibration fixture pack, an answer-free gallery, and a pending human-label template. It makes no reviewer, provider, or network call and certifies no human label.

**Files**

- Pack construction: `src/calibration/fixtures.ts` (schemas, fixed calibration seeds, sound fixture builder, composition/hash validation, pack assembly)
- Visible corruptions: `src/calibration/mutations.ts` (duplicate correct option/tile, text visible-primitive mutations, matrix XOR contradiction, transform direction contradiction, closed path edge, symmetry axis contradiction, counting convention conflict)
- Output writer: `src/calibration/pack.ts` (`pack.json`, `labels.pending.csv`, answer-free `gallery.html`, local images)
- CLI: `src/cli/calibration.ts`; `package.json` adds `npm run calibration`
- Tests: `tests/calibration/fixtures.test.ts`
- Documentation: `docs/calibration-labeling.md`, `README.md`, this file
- Calibration-only scene path: `src/families/matrix/render.ts`, `src/families/transforms/render.ts`, `src/families/paths/render.ts`, `src/families/symmetry/render.ts`, `src/families/counting/render.ts` accept an optional `"calibration"` validation mode that still runs generic safe-scene/PNG validation but skips family semantic eligibility. The primary/registry path always uses the default `"full"` mode and existing renderer tests remain unchanged.

**Observable behavior**

- `npm run calibration -- --prepare` writes `data/calibration/<pack-hash>/pack.json`, `labels.pending.csv`, `gallery.html`, and `images/`. It prints the pack hash, directory, fixture counts, and output paths.
- The pack has exactly 40 fixtures: 20 sound and 20 defective; every family has two sound and two defective; modality is 20 text and 20 SVG. Calibration slot IDs use ordinals 91-94 and never collide with smoke/full slots.
- Seeds are derived from `puzzle-calibration-v1` with fixed per-fixture descriptors and are disjoint from all smoke/full spec seeds. Pack, fixture, content, PNG, and SVG hashes are deterministic; two independent builds produce identical fixture JSON and pack hash.
- Sound fixtures use the normal assembly path and have a correct blind label with alignment pass. Defective fixtures preserve the original spec, solve result/proof, choices, visible presentation, reveal data, and original hashes; they carry a separate mutation record and proposed blind/alignment outcomes.
- Every family has a duplicate-correct-option corruption. Counting duplicate fixtures regenerate the visible option text as well as the rendered tiles, so the text and image agree. Text-family corruption 2 uses accepted family test mutations and independently proves that zero or at least two offered options solve the visible presentation. Matrix contradicts a visible XOR example with zero completions; transforms adds a conflicting clockwise/counterclockwise rule for the actual quarter-turn operation and offers both resulting tiles; paths adds a wall to the unique route in the source and all option mazes; symmetry contradicts the marked axis in the public rule; counting requires both union-once and overlap-once-per-shape totals and offers both distinct counts.
- `pack.json` includes original evidence, mutation details, content/PNG/SVG/fixture hashes, proposed blind/alignment outcomes, and `humanVerified: false`, `auditor: null`, `auditorTime: null` for all 40 records. `labels.pending.csv` has 40 rows plus header; every `human_verified` cell is `false`, and auditor/time/notes are empty.
- `gallery.html` renders only visible presentations and local diagrams; it does not show sound/defective labels, expected outcomes, mutation evidence, original proof, or the answer key. It is directly usable from `file://` and contains no remote resource.
- The intentionally invalid calibration scenes bypass primary eligibility only through the explicit calibration validation mode; safe SVG/parser limits, generic scene validation, and PNG safety checks still run. No network, reviewer, provider, or paid call is made.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm run calibration -- --prepare` | exit 0; pack `b2de95516799894e5fe5c5b4e6eb1376c772efb14981146797004ab99877eb5f`; 40 fixtures (20 sound/20 defective), 20 text/20 SVG. |
| `npm exec -- vitest run tests/calibration/fixtures.test.ts` | exit 0; 10 tests passed. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 41 files / 545 tests passed, build succeeded. |
| `npm run test:browser` | exit 0; 6 P39 browser tests still passed after the renderer changes. |
| Artifact check | `labels.pending.csv` 41 lines; `gallery.html` 40 cards; 60 image files (20 visible SVG pairs + 10 defective original pairs); all 40 records pending human verification. |
| Headless Chromium `file://` gallery check | 40 cards, 20 text/20 SVG, first local PNG loaded at 1024x1024, no console errors, zero horizontal overflow at 1440 and 360. |

The focused suite checks composition, per-family balance, seed disjointness, deterministic hashes, pending human fields, duplicate option/tile consequences (including counting text/tile agreement), text/matrix/path/transform/symmetry/counting consequences, real local artifact hashes, gallery/label output, and rejection of a defective mutation that still leaves one clear valid offered answer. It does not certify human ground truth; that is P47.

**Manual acceptance steps**

1. Run the exact commands below and open the printed `gallery.html` directly from the filesystem in Chromium.
2. Confirm the gallery shows 40 cards (20 text, 20 SVG), local PNG/SVG diagrams, and the `PENDING HUMAN VERIFICATION` warning, with no sound/defective labels, expected outcomes, mutation evidence, or answer key.
3. Open `labels.pending.csv` and confirm 40 data rows, proposed blind/alignment outcomes, and `false` in every `human_verified` cell with empty auditor/time/notes.
4. Inspect `pack.json` for original spec/proof/choices and a separate mutation record on each defective fixture.
5. Confirm the CLI and gallery make no network or provider call.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
cd /home/alex/ai-puzzle-factory
npm run --silent calibration -- --prepare > /tmp/p40-calibration.out
cat /tmp/p40-calibration.out
HASH=$(sed -n 's/^pack_hash: //p' /tmp/p40-calibration.out)
DIR="data/calibration/$HASH"
test -f "$DIR/pack.json"
test -f "$DIR/gallery.html"
test -f "$DIR/labels.pending.csv"
test "$(wc -l < "$DIR/labels.pending.csv")" -eq 41
test "$(grep -c 'class="card"' "$DIR/gallery.html")" -eq 40
test "$(ls "$DIR/images" | wc -l)" -eq 60
node -e "const fs=require('fs'); const p=require('./'+process.argv[1]+'/pack.json'); const rows=fs.readFileSync(process.argv[1]+'/labels.pending.csv','utf8').trimEnd().split('\n'); console.log({pack:p.packHash,count:p.fixtures.length,sound:p.fixtures.filter(f=>f.variant==='sound').length,defective:p.fixtures.filter(f=>f.variant==='defective').length,text:p.fixtures.filter(f=>f.modality==='text').length,svg:p.fixtures.filter(f=>f.modality==='svg').length,pending:p.fixtures.every(f=>f.humanVerified===false&&f.auditor===null&&f.auditorTime===null),labelRows:rows.length-1,allLabelsPending:rows.slice(1).every(row=>row.endsWith(',false,,,'))});" "$DIR"
```

Expected: one `pack_hash`, 40 fixtures, 20 sound, 20 defective, 20 text, 20 SVG, `pending true`, `labelRows 40`, `allLabelsPending true`, and 60 image files. The pack hash is content-derived and may change only when the fixture implementation changes.

**Decision-reviewer:** the first static pass found three material findings. Medium: the counting duplicate fixture kept stale textual options while its rendered tiles duplicated the correct value; fixed by regenerating visible option text from the mutated choices for SVG duplicate fixtures and recording both `assets` and `options` as changed/expected fields for counting. Low: the transforms corruption explanation hard-coded R90 while the actual fixture operation was R270; fixed by deriving the description from the computed rotation label. Low: this P40 progress record was missing; added here. A verification pass confirmed all three fixes and found no material findings. It noted one non-material domain-size mismatch in two text-family family-defect fixtures (ranking/truth options sized for the larger sound-B domain while the reused adversarial test spec described the smaller sound-A domain); fixed by swapping the text-family bases so duplicate defects use sound B and family defects use sound A, making visible rules and options domain-consistent. The final pack hash reflects that change. A final verification pass on the swapped-base pack confirmed no material findings and matched the recorded hash, composition, artifact counts, and pending-label state.

**Acceptance:** accepted by the user on 2026-11-06 after the focused suite, full check, browser regression, artifact counts, and manual gallery/label inspection. The accepted pack is `b2de95516799894e5fe5c5b4e6eb1376c772efb14981146797004ab99877eb5f`; human label certification remains P47.

**Out of scope, unchanged:** P41 reviewer calibration/scoring, P47 human label certification, paid/live reviewer calls, provider selection, and business success claims.

## P41. Calibration Runner, Label Validation, and Scoring — 2026-11-06

**State:** implemented, offline-verified, mock-scored, and accepted by the user on 2026-11-06. This phase runs the calibration reviewer over the held-out pack with mock/test-only labels and scores blind/alignment behaviour. It makes no live reviewer or provider call, certifies no human label, and cannot qualify a live freeze.

**Files**

- Labels: `src/calibration/labels.ts` (31-column CSV contract, pending/mock row builders, parser, pack/fixture/hash/auditor/time/fact validation)
- Runner: `src/calibration/run.ts` (80-call mock blind+alignment runner using the same frozen prompt/schema/route/payload builders as primary, calibration ledger calls with probe keys, zero generations)
- Scoring: `src/calibration/score.ts` (four separate text/SVG blind/alignment matrices, decisive and conservative rates, all-ten denominators, Wilson intervals, coverage/abstentions/errors, fixed 9/10 and 8/10 gates)
- CLI: `src/cli/calibration.ts` (`--mock`, `--mock-mode oracle|agree|reject`, `--labels`, `--verify-labels`, `--auditor`; P40 `--prepare` retained)
- Tests: `tests/calibration/score.test.ts`
- Mock labels: `tests/fixtures/calibration/mock-labels.csv` (mock/test-only provenance, 40 rows)
- Pack writer integration: `src/calibration/pack.ts` now emits the 31-column pending template with `pack_hash`, observed fields, and provenance
- Documentation: `docs/calibration-labeling.md`, `README.md`, this file

**Observable behavior**

- `npm run calibration -- --mock --labels <path>` validates a mock/test-only label file against the current pack, runs exactly one blind and one alignment review per fixture (80 review calls, 0 generation calls), and prints the scoring report as JSON. A stderr banner marks the result as mock/test-only.
- The runner uses the same `blindTextPromptMetadata`/`buildBlindTextMessages`, `blindVisionPromptMetadata`/`buildBlindVisionMessages`, `alignmentPromptMetadata`/`buildAlignmentMessages`, strict response schemas, mock primary routes, and `buildChatRequest` as the primary review path. Calibration calls use ledger `runKind=calibration` with the fixture ID as `probeKey`; no DB run/slot is fabricated.
- Blind payloads contain only question/rules/clue texts/options; calibration truth labels, variant, mutation, expected outcomes, and fixture IDs are absent. Alignment payloads contain the original DSL/proof/key/options/inventory plus the actual visible presentation.
- Scoring reports four independent combinations: `text_blind`, `text_alignment`, `svg_blind`, `svg_alignment`. Each has a decisive-only 2x2 matrix and a conservative all-ten matrix. Conservative detection requires a compatible defect/no-unique blind issue code or an accepted failing alignment field with an accepted fact ID when specified; wrong clean answers, unrelated criticism, abstentions, errors, and missing calls do not count. An additional unrelated failing field does not add credit but does not erase a valid accepted-field detection.
- Each combination reports 10 defective and 10 sound denominators, sensitivity/specificity with Wilson 95% intervals, coverage, abstentions, and errors. Gates are fixed at 9/10 conservative sensitivity and 8/10 conservative specificity. A blind detection must be non-selected, ambiguity-present, and carry a compatible issue code, so a hedged abstention is never credited. An alignment detection must fail an accepted field with an accepted fact ID and must have at least one applicable field outside the accepted set passing, so a reject-all response is not credited while an additional unrelated failing field does not erase a correct accepted-field detection. The report is always `evidenceKind=mock`, `liveEligible=false` and includes a stable `labelsHash` over the observed/proposed label rows; mock labels must use `provenance=mock_test_only` and auditor `mock-test-only`.
- `--mock-mode oracle` follows the mock labels, `agree` selects the original correct answer/all-pass, and `reject` rejects everything. Oracle passes all gates; agree has zero sensitivity; reject has zero specificity and does not reward its unrelated criticism conservatively.
- `npm run calibration -- --verify-labels <path> --auditor <name>` validates a human label file without running reviews or filling observations. It requires 40 rows, matching pack/fixture/content/PNG/SVG/fixture hashes, complete proposed and observed labels, known defect codes/fields/fact IDs, `provenance=human`, `human_verified=true`, exact auditor identity, and a valid non-future auditor time. Mock labels are rejected for this mode.
- P40 pending CSV now includes `pack_hash`, empty observed/provenance/auditor fields, and `human_verified=false`; the P40 pack hash remains `b2de95516799894e5fe5c5b4e6eb1376c772efb14981146797004ab99877eb5f`.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/calibration/score.test.ts` | exit 0; 14 tests passed. |
| `npm run calibration -- --mock --labels tests/fixtures/calibration/mock-labels.csv` | exit 0; 80 review calls, 0 generation calls, 80 transport requests, 40 observations; all four combinations pass with 10/10 denominators and 100% oracle sensitivity/specificity. |
| `npm run calibration -- --mock --mock-mode agree --labels tests/fixtures/calibration/mock-labels.csv` | gates fail; every combination has 0 sensitivity and 1 specificity. |
| `npm run calibration -- --mock --mock-mode reject --labels tests/fixtures/calibration/mock-labels.csv` | gates fail; every combination has 0 specificity and 0 conservative sensitivity. |
| `npm run calibration -- --verify-labels <synthetic-human-test.csv> --auditor test-auditor` | validates 40 rows/hashes/auditor/time; does not run reviews. Mock labels are rejected with `--verify-labels`. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 42 files / 559 tests passed, build succeeded. |

The focused suite covers 80 calls/zero generations, blind payload isolation, four matrices, all-ten denominators, oracle/agree/reject behaviour, wrong clean answers, unrelated criticism, wrong failing fields/fact IDs, all-abstain/errors, partial runs, Wilson intervals, label/pack/fixture hash failures, mock-vs-human provenance, auditor identity/time, and incomplete observed labels.

**Manual acceptance steps**

1. Run the exact commands below.
2. Confirm the oracle report has `evidenceKind=mock`, `liveEligible=false`, 80 review calls, 0 generation calls, 40 observations, four combinations, and all gates pass.
3. Run `--mock-mode agree`; confirm zero sensitivity and specificity 1, with failing sensitivity gates.
4. Run `--mock-mode reject`; confirm zero specificity, failing gates, and zero conservative sensitivity despite the diagnostic matrix flagging defects.
5. Run `--verify-labels` with a real human label file when available; confirm it validates hashes/auditor/time without filling observations. Confirm the mock label fixture is rejected as human evidence.
6. Confirm no network, provider, or live reviewer call is made.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
cd /home/alex/ai-puzzle-factory
npm run --silent calibration -- --mock --labels tests/fixtures/calibration/mock-labels.csv > /tmp/p41-oracle.json 2>/tmp/p41-oracle.err
cat /tmp/p41-oracle.err
node -e "const s=require('/tmp/p41-oracle.json'); console.log({evidence:s.evidenceKind,live:s.liveEligible,provenance:s.provenance,calls:s.reviewCalls,generations:s.generationCalls,observations:s.observations,coverage:s.coverage,gates:s.gates});"
node -e "const s=require('/tmp/p41-oracle.json'); for (const [k,v] of Object.entries(s.combinations)) console.log(k,{matrix:v.matrix,decisive:v.decisive,conservative:v.conservative});"
npm run --silent calibration -- --mock --mock-mode agree --labels tests/fixtures/calibration/mock-labels.csv > /tmp/p41-agree.json 2>/tmp/p41-agree.err
npm run --silent calibration -- --mock --mock-mode reject --labels tests/fixtures/calibration/mock-labels.csv > /tmp/p41-reject.json 2>/tmp/p41-reject.err
node -e "for (const name of ['agree','reject']) { const s=require('/tmp/p41-'+name+'.json'); console.log(name,{allPass:s.gates.allPass,combos:Object.fromEntries(Object.entries(s.combinations).map(([k,v])=>[k,{sens:v.conservative.sensitivity,spec:v.conservative.specificity,pass:v.conservative.pass}]))}); }"
npm run --silent calibration -- --verify-labels tests/fixtures/calibration/mock-labels.csv --auditor test-auditor > /tmp/p41-verify.out 2>/tmp/p41-verify.err; test $? -ne 0
grep -q "human provenance" /tmp/p41-verify.err
npm run check
```

Expected: oracle has 80 calls, 0 generations, 40 observations, `live false`, `provenance mock_test_only`, coverage 40/40, all four gates true; agree has sensitivity 0/specificity 1 and gates false; reject has specificity 0 and gates false; `--verify-labels` rejects the mock fixture with a human-provenance error; `npm run check` ends with 42 files / 559 tests and a successful build.

**Decision-reviewer:** the first static pass found two Medium scoring findings. First, the conservative blind numerator credited responses with an accepted issue code even when the diagnostic classifier treated the same response as an abstention (for example `ambiguity=uncertain`); fixed by requiring non-selected status, `ambiguity=present`, and a compatible issue code. Second, the conservative alignment numerator discarded a correct accepted-field/fact-ID detection when the response also failed an unrelated field; fixed by crediting an accepted-field/fact-ID failure while requiring at least one applicable non-accepted field to pass, which still prevents a reject-all response from earning credit. The review also noted P47 interface gaps; a stable `labelsHash` was added to the report and `--verify-labels` output, and `scoreCalibration` now rejects nonzero generation counts. A verification pass confirmed both fixes and the label-hash/generation guard, with no material residual findings; only the wording nit above was corrected.

**Acceptance:** accepted by the user on 2026-11-06 after the focused 14-test suite, full `npm run check` (42 files / 559 tests), exact mock/verify script, oracle/agree/reject gate inspection, and label-hash validation. Mock/test-only evidence remains non-live; human label certification remains P47.

**Out of scope, unchanged:** live calibration qualification, paid/live reviewer calls, human label certification (P47), freeze issuance, and business success claims.

## P42. Deterministic Human-Audit Sample and Append-Only Imports — 2026-11-06

**State:** implemented, offline-verified, artifact-checked, and accepted by the user on 2026-11-06. This phase prepares the deterministic primary human-audit sample and imports genuine human observations as append-only evidence. It does not decide proceed/revise/reject, generate candidates, or fabricate human labels.

**Files**

- Migration: `src/storage/migrations/0003_human_labels.sql` (`human_labels` with per-slot revisions, sample/slot/label hashes, append-only UPDATE/DELETE triggers, and a slots foreign key)
- Sampling: `src/audit/sample.ts` (family then family/lane loops, two reserved approvals per family, priority fill, hash tie-breaks, shortfalls, category additions, denominators, preview mode)
- Labels/gallery/import: `src/audit/labels.ts` (21-column pending CSV, label enums, import validation, append-only insert, summary, read-only public gallery, local image copies)
- CLI: `src/cli/audit.ts`; `package.json` adds `npm run audit`
- Tests: `tests/audit/sample.test.ts`
- Documentation: `docs/human-audit.md`, `README.md`, this file
- Existing test update: `tests/storage/checkpoints.test.ts` now expects the fourth migration

**Observable behavior**

- `npm run audit -- --run <run-id> --prepare` reads a committed run and builds a deterministic sample. A full run writes `audit/sample.json`, `audit/labels.csv`, `audit/gallery.html`, `audit/images/`, and an initial `audit/summary.json`; a smoke run writes only `audit/preview.json`, `audit/preview-labels.csv`, `audit/preview-gallery.html`, and images, with `production:false`/`preview:true` and an explicit message. Smoke production audit is refused.
- The selector follows section 9.3: four core slots per family (two per lane when available), two reserved approvals per family (one per lane when both approve, otherwise two from the sole approving lane), then per-cell priority review concern, non-approved presentation, remaining approval, no-presentation failure. Ties use `sha256(rootSeed:slotId)` plus slot ID. Production sampling requires `controlState=completed`; fewer than two family approvals or fewer than two lane terminal slots produce explicit shortfalls without cross-family/lane substitution; one-lane-only approvals are disclosed. Up to one representative per globally available unsampled major verdict is appended, with at most four additions and 44 total.
- The manifest records core entries, category additions, shortfalls, family approval-lane counts, categories, total/approved sample denominators, and a stable `sampleHash`. Missing presentations remain sampled and marked not inspectable.
- The pending CSV has 21 columns covering sample/slot hashes, sample metadata, correctness, clarity, hint/explanation support, image readability, novelty, enjoyment, perceived difficulty, explicit solve time, notes, auditor, and auditor time. The per-slot automatic verdict is deliberately omitted from the public CSV and sample entries; only aggregate category/approval counts remain. No label or solving time is inferred. Pending rows leave all human fields empty.
- The read-only gallery shows only the public presentation (question, rules, clues, options, local PNG/SVG); it does not show the automatic verdict, reveal key, proof, hint, explanation, or mutation/answer metadata. It is directly inspectable offline.
- `npm run audit -- --run <run-id> --import <labels.csv>` recomputes the deterministic sample from the database and rejects a stale/tampered manifest before validating the exact sampled slot set, slot hashes, metadata, one auditor identity/time, complete label enums, noninspectable rules, text/SVG image rules, and non-future time. It inserts all rows in one transaction with the next per-slot revision. `human_labels` triggers reject UPDATE/DELETE; a later import creates revision 2+ rather than editing prior evidence. Primary runs/slots/stages/artifacts/events/verdicts are untouched.
- `audit/summary.json` reports total sampled/labelled/inspectable and approved sampled/labelled/inspectable denominators independently, plus label rows, max revision, and auditors.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/audit/sample.test.ts` | exit 0; 10 tests passed. |
| `npm run audit -- --run 6732cab0-3f25-4183-acd9-4253cc9ada9f --prepare` | exit 0; smoke preview: 20 core, 0 additions, 20 approved sampled, no production `sample.json`; 20-card preview gallery, 21-line pending CSV, 20 local images. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 43 files / 569 tests passed, build succeeded. |
| Migration idempotence | repeated `migrate` records four versions and does not duplicate them. |

The focused suite covers core40/four per family/two per lane, 20 reserved approvals, deterministic hash-tie ordering, one-lane-only approvals, insufficient family approvals, insufficient lane terminal slots, missing categories/max44, noninspectable failures, preview refusal, completed-run refusal, pending gallery/CSV output, valid append-only import, revision 2, append-only triggers, immutable primary hashes, tampered-manifest rejection, and import rejection for sample/slot mismatch, unknown/duplicate/missing slots, mock auditor, future time, noninspectable ratings, and text/SVG image-rule violations.

**Manual acceptance steps**

1. Run the exact commands below.
2. Open the printed `audit/preview-gallery.html` directly from the filesystem; confirm it is read-only, shows only public presentations and local images, and does not expose verdicts or reveal material.
3. Open `audit/preview-labels.csv`; confirm one pending row per sampled slot and empty human fields.
4. Run the focused audit test; confirm a test-only full-cohort import creates revision 1, a second import creates revision 2, UPDATE/DELETE are rejected, and primary evidence hashes are unchanged.
5. Confirm smoke `--prepare` writes only preview files and prints `production_audit: false`.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
cd /home/alex/ai-puzzle-factory
npm run --silent audit -- --run 6732cab0-3f25-4183-acd9-4253cc9ada9f --prepare > /tmp/p42-audit.out
cat /tmp/p42-audit.out
RUN_DIR=data/runs/6732cab0-3f25-4183-acd9-4253cc9ada9f/audit
test -f "$RUN_DIR/preview.json"
test -f "$RUN_DIR/preview-labels.csv"
test -f "$RUN_DIR/preview-gallery.html"
test ! -f "$RUN_DIR/sample.json"
test "$(wc -l < "$RUN_DIR/preview-labels.csv")" -eq 21
test "$(grep -c 'class="card"' "$RUN_DIR/preview-gallery.html")" -eq 20
node -e "const p=require('./data/runs/6732cab0-3f25-4183-acd9-4253cc9ada9f/audit/preview.json'); console.log({production:p.production,preview:p.preview,core:p.core.length,total:p.denominators.total.sampled,approved:p.denominators.approved.sampled,sampleHash:p.sampleHash});"
npm exec -- vitest run tests/audit/sample.test.ts
npm run check
```

Expected: `mode: preview`, `production_audit: false`, 20 core/preview slots, 20 approved sampled, no production sample file, 20 gallery cards, 21 CSV lines; focused 10 tests and full 43 files / 569 tests pass. The focused test is the exact non-UI proof for append-only import and primary immutability.

**Decision-reviewer:** the first static pass found three material findings. Medium: import trusted a mutable on-disk manifest and did not recompute the deterministic sample from the database; fixed by recomputing `selectAuditSample` during import and rejecting any sample-hash mismatch, with a tampered-manifest regression test. Low: the pending CSV/sample entries disclosed each slot's automatic verdict; fixed by removing the per-slot verdict from the public CSV and entries, while retaining only aggregate category/approval counts, and import now derives verdicts from recomputed candidates. Low: production sampling/import did not require frozen automatic verdicts; fixed by requiring `controlState=completed` for production and adding a regression test. The verification pass confirmed those three fixes, then found two Low residuals: the public manifest still exposed per-slot approval status through `sampleReason`, and the phase record still said the CSV had 22 columns. `sampleReason` was removed from the public entries and the record was corrected to 21 columns; the production gallery banner now reads `READ-ONLY AUDIT SAMPLE`. A final verification pass confirmed the residuals closed with no material residual findings. Final smoke preview sample hash: `ec60c6250f9a6d94ff7e97578f22595c038a7992c947e5e4bfe031bd06ec6b4c`.

**Acceptance:** accepted by the user on 2026-11-06 after the focused 10-test suite, full `npm run check` (43 files / 569 tests), smoke preview artifact inspection, and append-only import/primary-immutability verification. Final smoke preview sample hash: `ec60c6250f9a6d94ff7e97578f22595c038a7992c947e5e4bfe031bd06ec6b4c`.

**Out of scope, unchanged:** final proceed/revise/reject logic (P43), real human primary audit (P53), agent-generated approvals, new candidate generation, and population-accuracy claims.

## P43. Protocol Freeze and Explicit Business-Decision Evaluator — 2026-11-06

**State:** implemented, offline-verified, pure-gate tested, and accepted by the user on 2026-11-06. This phase adds the pre-run protocol freeze and the post-run proceed/revise/reject evaluator. It does not collect live evidence, approve expenditure, execute the primary cohort, or change measured outcomes.

**Files**

- Migration: `src/storage/migrations/0004_protocol_freezes.sql` (append-only hash-committed frozen protocols, USD 0.10 check, UPDATE/DELETE triggers)
- Freeze gate: `src/experiment/freeze.ts` (`canFreezeProtocol`, `verifyFrozenProtocol`, `storeFrozenProtocol`, `getFrozenProtocol`, injected provenance provider)
- Decision gate: `src/reporting/decision.ts` (`decideFinal`, every section 9.3 predicate, explicit pass/fail/not-evaluable reasons, strong-failure rejection, incomplete-evidence revise precedence, novelty/quality/missing-evidence caveats)
- CLI: `src/cli/freeze.ts`; `package.json` adds `npm run freeze`
- Tests: `tests/experiment/freeze.test.ts`
- Documentation: `docs/decision-rules.md`, `README.md`, this file
- Existing test update: `tests/storage/checkpoints.test.ts` now expects five migrations

**Observable behavior**

- `canFreezeProtocol` validates only pre-run evidence: immutable 200-slot full plan/seed/quota, live preflight with supported routes and a positive known price for every `REQUEST_ROLES` entry, price catalog and observation time, a 680-call forecast plus 160-approval projection/max/reserve with correct ordering, human-verified 40-fixture pack, live same-config calibration with 80 review calls/zero generations, four passing modality/role gates with 10/10 denominators, accepted completed live smoke coverage (20/20, 10 families, four roles, canonical smoke plan hash), configuration/prompt/schema/source/provenance agreement, and an authorized cap at least the largest forecast/reserve. It rejects mock/partial/stale/unverified evidence, plan/config drift, missing role prices, malformed/understated forecasts, insufficient cap, calibration gate/denominator failures, smoke gaps, and provenance mismatch.
- A successful freeze returns a hash-committed `FrozenProtocol`; `storeFrozenProtocol` appends it to `protocol_freezes`, whose UPDATE/DELETE triggers reject mutation. Cap amendments are recorded as caveats and do not change the USD 0.10 threshold.
- `decideFinal` evaluates the completed live 200-slot run, fixed 100 text/SVG denominators, canonical ten families and all `${family}/${lane}` cells, uniqueness/coverage, known-complete cost and USD 0.10 cost/approved, approved near-duplicate flags with required per-family and family/lane novelty/quality/missing-evidence disclosure, same-config live calibration with 10/10 denominators, completed human audit with independent total/approved inspectability denominators and cross-counter consistency, unresolved-defect/disagreement counts, routes, and the frozen protocol. Every predicate is emitted with `pass|fail|not_evaluable`, required and actual values.
- Decision precedence: incomplete/non-live/missing-audit/unknown-cost/missing-frozen evidence → `revise`; otherwise strong failure (modality approval <50%, calibration sensitivity/specificity <50%, or repeatable correctness defect >=2 in one family) → `reject`; all predicates pass → `proceed`; other borderline/failed predicates → `revise`. Incomplete runs are never reported as definitive business rejection.
- Near-duplicate approval shortfalls disclose novelty-only, additional-quality, and incomplete/failed-review categories separately without waiving the frozen approval floor. The audit is described as stratified/enriched, not an unbiased population estimate. Failed predicates and caveats are always emitted.
- `npm run freeze -- --evidence <bundle.json> [--max-run-cost <usd>] [--db <path>] [--operator <name>]` validates a JSON bundle `{ "freeze": FreezeProtocolEvidence, "final"?: FinalDecisionEvidence }`, can append a successful frozen protocol to `protocol_freezes`, and prints the freeze result and optional decision. `--smoke`/`--calibration` IDs are future-facing; P43 refuses to invent live evidence and requires `--evidence`. P44 adds verified provenance; P48/P49 supply live calibration/smoke evidence. No network or expenditure.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/experiment/freeze.test.ts` | exit 0; 18 tests passed. |
| `npm run freeze -- --help` | exit 0; documents the evidence-bundle gate and future-facing IDs. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 44 files / 587 tests passed, build succeeded. |
| Migration idempotence | repeated `migrate` records five versions; frozen protocol store/reload and UPDATE/DELETE rejection pass. |

The focused suite hand-builds a complete pass and one-predicate failures for modality 79/100 vs 80/100 and 49/100 vs 50/100, family 9/20 vs 10/20, calibration sensitivity 8/10 vs 9/10 and specificity 7/10 vs 8/10 and reject 4/10 vs 5/10, cost/cap/forecast, missing/partial audit, sparse fingerprints, novelty-only vs quality/missing evidence, stale calibration/drift/mocks, route support, repeatable correctness, missing frozen protocol, and incomplete-run precedence.

**Manual acceptance steps**

1. Run the exact commands below.
2. Inspect the focused test output; confirm the complete synthetic pass yields `proceed`, each one-predicate failure yields `revise` or `reject` with a readable failed predicate id, and incomplete evidence never yields `reject`.
3. Run `npm run freeze -- --help`; confirm the CLI requires an evidence bundle and does not claim live collection.
4. Confirm `npm run check` reports 44 files / 587 tests and five migrations.
5. Confirm no network, paid, or live evidence collection occurred.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
cd /home/alex/ai-puzzle-factory
npm exec -- vitest run tests/experiment/freeze.test.ts
npm run freeze -- --help
npm run check
```

Expected: focused 18 tests pass; freeze help exits 0 and mentions `--evidence`; full check ends with 44 files / 587 tests and a successful build. The focused suite is the exact non-UI proof of the synthetic complete pass and every one-predicate failure; no live network is needed.

**Decision-reviewer:** the first static pass found six material findings. High: smoke evidence compared its 20-slot plan hash with the full 200-slot plan hash, making genuine live freeze impossible; fixed by comparing against the canonical smoke plan hash. Medium: reject thresholds used caller-supplied modality denominators; fixed to fixed 100 denominators with an explicit denominator predicate. Medium: family and per-family audit floors iterated only supplied family keys; fixed to the canonical ten families plus a family/lane completeness predicate. Medium: audit counters were not cross-validated and `approvedInspectable` was unused; fixed with an audit denominator consistency predicate, an approved-inspectable >=20 floor, and evaluability tied to consistent counters. Medium: freeze accepted partial role prices and an unvalidated forecast; fixed by requiring all six `REQUEST_ROLES`, adding the 680-call forecast amount, and enforcing forecast/reserve/cap ordering. Low: per-family/lane novelty attribution was dropped; fixed by requiring and emitting the by-family and family/lane near-duplicate breakdown. The review also noted P44/P48/P50/P53 interface risks; P43 now requires 10/10 calibration denominators and an explicit calibration denominator predicate, persists an optional frozen protocol with `--db` under the writer lock, supports an explicit `--operator`, and marks future `--smoke`/`--calibration` IDs as non-authoritative. The verification pass confirmed the six fixes and found six residual issues: a missing writer lock on `--db`, an unguarded malformed forecast conversion, an unbounded clarity numerator, a runtime-unchecked near-duplicate family/lane disclosure, undefined `approvedCoreByFamily` semantics, and stale observable-behavior bullets. The writer lock, decimal guard, clarity/unresolved bounds, near-disclosure predicate, interface documentation, and this record were corrected. The second verification pass then found three Low residuals: a stale 583-test count in manual acceptance, a TypeError path when a near-duplicate disclosure map was entirely absent, and an unguarded lock release that could skip database cleanup. The count was corrected to 587, both near-duplicate maps now default to empty objects with a readable failed predicate, and the CLI now closes the database before a guarded lock release. A final verification pass confirmed those residuals closed with no material findings.

**Acceptance:** accepted by the user on 2026-11-06 after the focused 18-test suite, full `npm run check` (44 files / 587 tests), freeze CLI help, and synthetic complete-pass/one-predicate-failure inspection. P43 remains a pure gate: no live evidence collection, expenditure approval, or primary execution.

**Out of scope, unchanged:** actually approving live expenditure, collecting live preflight/calibration/smoke/provenance evidence (P44/P46/P48/P49), running the primary cohort, and changing measured outcomes.

## P44. Source Provenance and Artifact Security Boundary — 2026-11-06

**State:** implemented, offline-verified, artifact-checked, and accepted by the user on 2026-11-06. This phase archives and verifies the local implementation boundary and hardens exports; it does not collect live evidence, approve expenditure, run the primary cohort, or change measured outcomes.

**Files**

- Provenance: `src/experiment/provenance.ts` (allowlisted source/prompt/schema/config/font/license scan, SHA-256 manifest, strict schema bundle, runtime/Git metadata, safe archive read/write/verify, freeze provider)
- Freeze integration: `src/cli/freeze.ts` (`--archive-provenance`, `--verify-provenance`, `--provenance`, `--source-root`, verified provider for `canFreezeProtocol`)
- Export hardening: `src/reporting/export.ts` (sensitive-key removal and credential-shaped string redaction across HTML/CSV/JSONL/puzzle/manifest surfaces); `src/ai/redact.ts` exposes `isSensitiveKey`
- Tests: `tests/experiment/provenance.test.ts`, `tests/security/artifacts.test.ts`
- Documentation: `docs/reproduction.md`, `README.md`, this file
- Ignored artifact location used for acceptance: `data/provenance/` (`data/` is already ignored; no commit or upload)

**Observable behavior**

- `npm run freeze -- --archive-provenance <dir>` scans an explicit allowlist: every regular file under `src/` except `src/ai/prompts/`, every prompt asset, every file under `scripts/`, the eight configuration/lockfile paths, the pinned DejaVu font and license, and a generated strict schema bundle for all ten families plus wording/blind/alignment. It writes `manifest.json`, canonical `schemas.json`, and byte-exact `files/` copies atomically. It does not require an evidence bundle or database.
- The manifest records per-file path/category/SHA-256/byte length, `sourceHash`, role/family-keyed `promptHashes` (`spec:<family>`, `wording`, `blind_text`, `blind_vision`, `alignment_text`, `alignment_vision`), role/family-keyed `schemaHashes`, `configHash`, prompt/schema bundle hashes, font/license/lockfile hashes, `archiveHash`, `createdAt`, runtime metadata, and optional Git commit/dirty status. The full 23-entry strict schema bundle remains in `schemas.json`; `--archive-provenance` also prints the exact `configuration` projection required by a freeze bundle. `archiveHash` is content-only; runtime and Git are recorded metadata.
- `npm run freeze -- --verify-provenance <dir>` re-hashes the current source tree and reports missing, modified, extra, symlinked, secret-canary, source/config/prompt/schema/font/license/lockfile, and archive-integrity failures. `--provenance <dir>` uses the verified archive as the freeze provider; any drift rejects the freeze before database persistence. Without `--provenance`, the CLI explicitly caveats that the bundle provenance was not source-verified.
- The archive rejects `.env`/`.env.*`, `.git`, `node_modules`, `data`, `dist`, `coverage`, `test-results`, and `playwright-report` path segments; rejects symlinks in source or archive paths using a pre-open type gate plus `O_NOFOLLOW`/`O_NONBLOCK` and an opened-descriptor path check; validates relative POSIX archive paths against traversal; enumerates `files/` on read so extra unlisted files are rejected; and rejects caller-supplied secret canaries without echoing them. Role/family `promptHashes`, `schemaHashes`, and `schemas.json` always describe the running implementation; `--source-root` changes the file-inventory/verification tree, so a real archive should use the repository root. The CLI passes `OPENROUTER_API_KEY` as a canary when present. No environment dump, Git write, commit, network request, or model call occurs.
- A dirty source tree is supported: `git.dirty=true` is recorded, and replay identity comes from the copied files/hashes rather than a clean commit. Existing archives with a different `archiveHash` are rejected instead of overwritten.
- Exports drop sensitive object keys (`authorization`, `api_key`, `apikey`, `openrouter_api_key`, `x-api-key`) and redact `sk-or-v1-*`, `sk-*`, `Bearer *`, and `OPENROUTER_API_KEY=*` strings before writing HTML, CSV, JSONL, puzzle JSON, and manifest JSON. SVG/PNG artifacts are scanned for credential-shaped text and the export is refused with `UNSAFE_ARTIFACT` rather than copied; all report images are validated before any image write, so an unsafe SVG cannot leave a paired PNG behind. PNG pixels are not byte-inspectable; the SVG/source-text gate is the effective visual-content check. The public visible-presentation contract remains strict: a `reveal` key is rejected.
- Local replay uses stored raw response artifacts through `replaySavedResponse`; content, parsed content, usage, and cost classification are identical across replays, no new attempt is created, and no provider call is made. This is stored-evidence replay, not a promise of identical future remote generations.
- Export/report/replay are read-only with respect to primary run/slot/stage/artifact rows; the security test hashes those tables before and after export/report and asserts equality.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/experiment/provenance.test.ts` | exit 0; 8 tests passed. |
| `npm exec -- vitest run tests/security/artifacts.test.ts` | exit 0; 6 tests passed. |
| `npm exec -- vitest run tests/experiment/freeze.test.ts tests/reporting/export.test.ts tests/reporting/html.test.ts tests/security/artifacts.test.ts tests/experiment/provenance.test.ts` | exit 0; 5 files / 50 tests passed. |
| `npm run lint` | exit 0. |
| `npm run typecheck` | exit 0. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 46 files / 601 tests passed, build succeeded. |
| `npm run test:browser` | exit 0; 6 Playwright Chromium tests passed. |
| `npm run --silent freeze -- --archive-provenance data/provenance` | exit 0; 125 files, 7 prompt files, 15 prompt hashes, 23 schemas, 15 schema hashes, Git dirty snapshot recorded. |
| `npm run --silent freeze -- --verify-provenance data/provenance` | exit 0; `ok:true`, zero failures, same `archiveHash`. |

The focused suites cover deterministic allowlist/hash output and the role/family metadata contract; modified/missing/extra/symlink detection; `.env`/unlisted-file exclusion and secret-canary rejection; archive write/idempotence/tamper/path-traversal/symlink/extra-file rejection; missing prompt/config/font rejection; dirty and unavailable Git; verified freeze acceptance and code/hash drift rejection; path-keyed bundle rejection; archive conflict rejection; CLI archive/verify/use paths; credential redaction across HTML/CSV/JSONL/puzzle/manifest; credential-shaped image rejection and pre-write image ordering; hostile HTML/CSV escaping; SVG script/external-reference checks; closed reveal details; strict public visible-presentation parsing; replay identity; and unchanged primary evidence hashes.

**Manual acceptance steps**

1. Run the exact non-UI script below.
2. Confirm the archive command prints `"ok": true` with 64-hex `archiveHash`, `sourceHash`, and `configHash`, 125 files, 7 prompt files, 15 prompt hashes, 23 schemas, 15 schema hashes, and a Git object (dirty is acceptable).
3. Inspect `data/provenance/manifest.json`; confirm `files` categories, `promptHashes`, `schemaHashes`, `fontHash`, `licenseHash`, `lockfileHash`, `runtime`, and `git`.
4. Inspect `data/provenance/schemas.json` and `data/provenance/files/src/ai/prompts/v1/spec.txt`; confirm the schema bundle and byte-exact copies exist.
5. Confirm `data/provenance/files/.env` does not exist and the manifest does not contain `OPENROUTER_API_KEY` or a secret value.
6. Run the verify command; confirm `"ok": true` and an empty `failures` array. The focused provenance test is the exact proof for modifying, deleting, adding, or symlinking a file and for freeze drift rejection.
7. Confirm `npm run check` reports 46 files / 601 tests and a successful build, and `npm run test:browser` reports 6 passed.
8. Confirm no network, paid, Git-write, or live model operation occurred.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
cd /home/alex/ai-puzzle-factory
npm exec -- vitest run tests/experiment/provenance.test.ts tests/security/artifacts.test.ts
rm -rf data/provenance
npm run --silent freeze -- --archive-provenance data/provenance > /tmp/p44-archive.json
npm run --silent freeze -- --verify-provenance data/provenance > /tmp/p44-verify.json
node -e "const s=require('/tmp/p44-archive.json'); console.log({ok:s.provenance.ok,archiveHash:s.provenance.summary.archiveHash,sourceHash:s.provenance.summary.sourceHash,configHash:s.provenance.summary.configHash,files:s.provenance.summary.fileCount,promptFiles:s.provenance.summary.promptFileCount,promptHashes:s.provenance.summary.promptHashCount,schemas:s.provenance.summary.schemaCount,schemaHashes:s.provenance.summary.schemaHashCount,git:s.provenance.summary.git});"
node -e "const s=require('/tmp/p44-verify.json'); console.log({ok:s.provenance.ok,failures:s.provenance.failures,archiveHash:s.provenance.summary.archiveHash});"
test -f data/provenance/manifest.json
test -f data/provenance/schemas.json
test -f data/provenance/files/src/ai/prompts/v1/spec.txt
test -f data/provenance/files/assets/fonts/DejaVuSans.ttf
test ! -e data/provenance/files/.env
grep -q '"archiveHash"' data/provenance/manifest.json
grep -q '"schemaBundleHash"' data/provenance/manifest.json
npm run check
npm run test:browser
```

Expected: focused tests pass; archive and verify print `"ok": true`; manifest has the required 64-hex hashes and role/family-keyed prompt/schema maps; prompt/font copies exist; no `.env`; full check ends with 46 files / 601 tests and a successful build; browser suite reports 6 passed. The focused provenance test is the exact non-UI proof for missing/modified/extra/symlink files, secret canaries, archive tampering/traversal, dirty snapshots, and code/hash drift rejection.

**Decision-reviewer:** the first static pass found four findings. Medium: the real provenance provider returned prompt hashes keyed by prompt file path and schema hashes keyed by raw schema name, while the freeze bundle convention is role/family-keyed, so a genuine bundle could be rejected even after a clean archive verification; the P44 positive test copied its configuration from the same snapshot and could not detect the mismatch. Fixed by deriving `promptHashes`/`schemaHashes` from the production prompt metadata functions (`spec:<family>`, `wording`, `blind_text`, `blind_vision`, `alignment_text`, `alignment_vision`), adding `provenanceConfigurationFromSnapshot`, printing the exact `configuration` projection on archive/verify/use paths, documenting the bundle contract, asserting the maps against the metadata functions in the test, and adding a path-keyed/raw-schema-name negative case that expects `PROVENANCE_MISMATCH`. Low: exported SVG/PNG bytes bypassed credential redaction while documentation claimed coverage; fixed by adding `assertArtifactExportSafe`/`validateArtifactForExport`, refusing credential-shaped SVG/PNG artifacts with `UNSAFE_ARTIFACT`, and narrowing the documentation. Low: `readProvenanceArchive` verified only manifest-listed files; fixed by enumerating the archive `files/` tree and rejecting extra or missing entries, with a regression test. Low/Probable: symlink checks were lstat-then-read TOCTOU; fixed with a pre-open regular-file gate, `O_NOFOLLOW`/`O_NONBLOCK`, `fstat` and `/proc/self/fd` root containment, and descriptor-based reads. The second verification pass confirmed those four fixes and found three Low residuals. First, `writeHtmlReport` copied PNG before validating the paired SVG, so an unsafe SVG could leave a rasterized PNG on disk; fixed by validating every report image before any image write and copying SVG first, with a regression test that asserts the PNG is absent. Second, the new `readRegularFile` opened before checking the file type, so a FIFO at an allowlisted path could block; fixed with an lstat pre-open gate and `O_NONBLOCK`, and `readLockfileVersion` now uses the same reader. Third, `--source-root` file inventory could be paired with running-implementation prompt/schema hashes; documented that role/family hashes and `schemas.json` always describe the running implementation and that a real archive should use the repository root, and exposed the `configuration` projection on all CLI paths. The third verification pass found no material findings.

**Acceptance:** accepted by the user on 2026-11-06 after the focused provenance/security suites (8 + 6 tests; 5 files / 50 focused tests), full `npm run check` (46 files / 601 tests), `npm run test:browser` (6 passed), archive/verify CLI inspection, and the three decision-reviewer passes. Final archive `archiveHash` is `6c5ee807e233b280e5ac8913e414676548b7f383a9d7d44aa54751af231f12c2`; verification returned `ok:true` with zero failures.

**Out of scope, unchanged:** live preflight/calibration/smoke evidence collection (P46/P48/P49), frozen-protocol-plus-provenance packaging (P50), paid requests, primary execution, and any claim that a future remote generation is reproducible.

## P45. Full Offline Release Run and Fresh Reproduction — 2026-11-06

**State:** implemented, offline-verified, artifact/report checked, and accepted by the user on 2026-11-06. The full run is synthetic and must never be treated as live evidence or a business proceed.

**Files**

- Runner generalization: `src/runner/run.ts` (`runMockExperiment`, `runFullMockExperiment`, full 200-slot plan/account validation), `src/runner/resume.ts` (`resumeMockExperiment`, full/smoke account and plan resume; `resumeSmokeExperiment` compatibility alias)
- CLI guards: `src/cli/experiment.ts` (explicit `--full`/`--smoke` cohort, full mock execution, `--allow-paid`/`--protocol` live gate, `--resume` full/smoke, 30 s mock deadline)
- Demonstrated release fixes: `src/families/arithmetic/engine.ts` (do not solve a one-constraint nonredundancy subset), `src/families/arithmetic/canonical.ts` + `src/families/arithmetic/schema.ts` (`solveArithmeticConstraints` accepts reduced one-clue subsets during canonicalization)
- Tests: `tests/experiment/full-mock.test.ts` (new), `tests/families/arithmetic.test.ts`, `tests/runner/serial.test.ts`, `tests/bootstrap.test.ts`, `tests/experiment/planner.test.ts`
- Documentation: `README.md`, `docs/reproduction.md`, this file

**Observable behavior**

- `npm run experiment -- --full --mock --seed puzzle-poc-v1 --max-cost 0` executes the complete 200-slot synthetic cohort through the real planner, preparation, duplicate barrier, blind/alignment reviews, verdict reducer, ledger, budget, report, and export surfaces. Execution now requires an explicit `--full` or `--smoke` cohort; a bare invocation fails instead of accidentally starting 200 slots.
- The full run reaches 200/200 terminal slots with exact plan quotas (100 text / 100 SVG, 120 `spec_first` / 80 `ai_spec`, 20 per family, difficulty 70/70/60). The deterministic mock run produced 148 approved, 18 rejected, 34 inconclusive, 0 generation errors; 644 logical calls/attempts; barrier 145 unique, 11 owners, 18 structural duplicates, 34 near-suspected. All calls/attempts are `validated` with known zero cost and no unknown exposure.
- Stage records: 200 `spec_ready`, 200 `formal_checked`, 200 `presentation_ready`, 200 `duplicate_checked`, 182 `blind_reviewed`, 182 `alignment_reviewed`, 200 `terminal`. Artifacts: 644 raw responses, 100 SVG, 200 PNG; 300 stage-artifact links. Every planned slot is terminal; no duplicate `(slot, role)` calls; no duplicate terminal rows.
- Metrics: planned/started/terminal/fingerprintable/formal/presentation all 200; review coverage 1; fingerprint coverage 1; conditional review agreement 1; structural uniqueness 0.91 (182 distinct structures, 145 barrier owners); cost status known, actual USD 0. The synthetic run does not meet the business uniqueness threshold and is correctly not a proceed.
- Report/export: 200 candidate rows, 200 puzzle JSON files, 200 HTML cards, 200 CSV rows, 644 request rows, 100 SVG + 100 PNG copies. `report.html` contains the `MOCK DATA` banner, every planned slot ID, closed reveal details, and no final decision/proceed object. `summary.json` says `planned:200`, `terminal:200`, `runKind:full`, `evidenceKind:mock`.
- Concurrency 1 and 2 produce identical stable content after removing generated call/attempt UUIDs: same plan hash, slot stage/verdict, stable stage payloads, barrier payload, call/attempt role/state/cost inventory, and artifact-kind counts.
- Full mock resume is supported: cancelling a full run after four stage commits leaves a resumable checkpoint; `--resume <run-id> --mock` completes to 200 terminal slots without duplicate terminal rows or duplicate `(slot, role)` logical calls. The smoke resume behavior remains compatible through the `resumeSmokeExperiment` alias.
- Live full remains authorization-gated: `--live` requires `--allow-paid`; `--full --live` additionally requires a 64-hex `--protocol` hash. P45 validates the gate and then refuses to start paid calls; P51 executes the frozen protocol. `--allow-paid`/`--protocol` are rejected with mock/non-live commands.
- Two arithmetic release defects found by the full run are fixed: a two-constraint construction no longer calls `solveArithmetic` on a one-constraint nonredundancy subset, and canonicalization uses `solveArithmeticConstraints` so reduced one-clue subsets can be evaluated. This removed the full run's `generation_error` and fingerprint failure.

**Verification commands and results**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/experiment/full-mock.test.ts` | exit 0; 4 tests passed (two full runs + report/export + full resume), 179 s. |
| `npm exec -- vitest run tests/families/arithmetic.test.ts` | exit 0; 16 tests passed. |
| `npm exec -- vitest run tests/runner/resume.test.ts tests/runner/concurrency.test.ts tests/families/arithmetic.test.ts` | exit 0; 3 files / 36 tests passed. |
| `npm exec -- vitest run tests/runner/serial.test.ts` | exit 0; 8 tests passed. |
| `npm exec -- vitest run tests/bootstrap.test.ts tests/experiment/planner.test.ts` | exit 0; 2 files / 33 tests passed. |
| `npm run lint` | exit 0. |
| `npm run typecheck` | exit 0. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 47 files / 606 tests passed, build succeeded. |
| `npm run test:browser` | exit 0; 6 Playwright Chromium tests passed. |
| `npm run --silent experiment -- --full --mock --seed puzzle-poc-v1 --max-cost 0` | exit 0; run `ace4a2d5-31dc-466e-896f-c8cc07b331f7`, status completed, 200/200 terminal, 148/18/34/0 verdicts, 644 calls/attempts, unknown 0, cost known 0, barrier 145/18/34. |
| `npm run --silent report -- --run ace4a2d5-31dc-466e-896f-c8cc07b331f7` | exit 0; `data/runs/<id>/report.html` with 200 cards and `MOCK DATA`. |
| `npm run --silent export -- --run ace4a2d5-31dc-466e-896f-c8cc07b331f7 --format all` | exit 0; 200 puzzles, 200 candidates, 644 requests, 100 SVG + 100 PNG images. |
| Fresh copy: `rsync ... /tmp/p45-fresh && npm ci && npm exec playwright install chromium` | exit 0; 154 packages installed, native `better-sqlite3` works, Chromium available. |
| Fresh copy: `npm run check` | exit 0; 47 files / 606 tests passed, build succeeded (257 s). |
| Fresh copy: full mock CLI | exit 0; run `28a3d49b-f556-4fa8-a4d3-483dc4bc2a5f`, same 200/200, 148/18/34/0, 644 calls, barrier 145/18/34. |
| Fresh copy: `npm run report` + `npm run test:browser` | exit 0; 200 cards with `MOCK DATA`; 6 browser tests passed. |

**Manual acceptance steps**

1. Run the exact non-UI script below from `/home/alex/ai-puzzle-factory`.
2. Confirm the CLI prints `status completed`, `slots 200/200 terminal`, `generation_error=0`, `unknown=0`, `cost status=known actual=0`, and barrier `unique=145 owners=11 near=34 duplicates=18`.
3. Confirm `report.html` has 200 `<article class="card">` entries, all 200 planned slot IDs, and the `MOCK DATA` banner; confirm `summary.json` has `planned:200`, `terminal:200`, `runKind:full`, `evidenceKind:mock`.
4. Confirm 200 puzzle JSON files, 200 candidate rows, 644 request rows, 100 SVG + 100 PNG files, and no final decision/proceed object.
5. Run `npm run check` (47 files / 606 tests) and `npm run test:browser` (6 passed).
6. Run the fresh-copy reproduction block; confirm the same full-run counts and tests without `.env`, the original `data/`, or Git state.
7. Confirm no network, paid, key, live model, or business proceed occurred.

**Exact non-UI acceptance script**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
cd /home/alex/ai-puzzle-factory
npm exec -- vitest run tests/experiment/full-mock.test.ts tests/families/arithmetic.test.ts
npm run --silent experiment -- --full --mock --seed puzzle-poc-v1 --max-cost 0 | tee /tmp/p45-run.txt
RUN_ID=$(awk '/^run /{print $2}' /tmp/p45-run.txt)
npm run --silent report -- --run "$RUN_ID"
npm run --silent export -- --run "$RUN_ID" --format all
node -e "const fs=require('fs'); const id=process.argv[1]; const h=fs.readFileSync('data/runs/'+id+'/report.html','utf8'); console.log({runId:id,cards:(h.match(/<article class=\"card\"/g)||[]).length,mock:h.includes('MOCK DATA')});" "$RUN_ID"
node -e "const s=require('./data/runs/'+process.argv[1]+'/summary.json'); console.log({planned:s.planned.total,terminal:s.counts.terminal,verdicts:s.failures.verdictHistogram,evidenceKind:s.run.evidenceKind,runKind:s.run.runKind});" "$RUN_ID"
test -f "data/runs/$RUN_ID/report.html"
test "$(ls "data/runs/$RUN_ID/puzzles" | wc -l)" -eq 200
test "$(grep -o '<article class="card"' "data/runs/$RUN_ID/report.html" | wc -l)" -eq 200
grep -q "MOCK DATA" "data/runs/$RUN_ID/report.html"
npm run check
npm run test:browser
```

Expected: focused full-mock/arithmetic tests pass; the full run prints the exact 200/200 and 148/18/34/0 counts; report/export contain 200 puzzles/cards and 644 request rows; the report is `MOCK DATA`; `npm run check` is 47 files / 606 tests with a successful build; browser is 6 passed. Missing native/browser setup or a skipped test is a failed/unverified gate, not a pass.

**Fresh-copy reproduction**

```bash
rm -rf /tmp/p45-fresh
mkdir -p /tmp/p45-fresh
rsync -a --exclude node_modules --exclude data --exclude .git --exclude .env ./ /tmp/p45-fresh/
cd /tmp/p45-fresh
test ! -e .env
npm ci
npm exec playwright install chromium
npm run check
npm run --silent experiment -- --full --mock --seed puzzle-poc-v1 --max-cost 0
npm run test:browser
```

The fresh copy completed with 47 files / 606 tests, the same full-run counts (`200/200`, `148/18/34/0`, `644` calls, barrier `145/18/34`), 200 report cards, and 6 browser tests. `npm ci` needed registry/cache access; the Chromium install is the documented native/browser tooling step. A missing dependency or skipped test means the reproduction is unverified, not accepted.

**Decision-reviewer:** the first static pass confirmed one Low-severity CLI documentation defect: `--help` advertised `default: full` for cohort selection and `--mock` as executing the selected cohort, while the execution guard required an explicit `--full` or `--smoke`; an operator following the help could not start the advertised default. Fixed by scoping the default to `--dry-run` (`default: full for --dry-run`), stating `--mock execute an explicit --full or --smoke offline synthetic cohort`, aligning the `--full` option description, and pinning the phrase in `tests/bootstrap.test.ts`. The reviewer rejected three hypotheses: the pre-existing resume `--max-cost` equal-cap abort (not introduced by P45 and explicit/safe), the arithmetic one-constraint guard counting a redundant inequality (anchor equations leave a free variable, so the guard agrees with the exact solver), and canonicalization emitting an invalid one-relation core (the baseline uniqueness check remains and the new internal solver handles reduced subsets). The verification pass confirmed the help/execution contract is consistent and closed the finding with no residual material findings. Coverage note, not a defect: the full-run cancellation test cancels during preparation; smoke review-phase crash/resume tests remain the recovery proof for that phase.

**Acceptance:** accepted by the user on 2026-11-06 after the focused full-mock/arithmetic suites, `npm run check` (47 files / 606 tests), `npm run test:browser` (6 passed), the CLI full run/report/export inspection, and the fresh-copy reproduction (47 files / 606 tests, same 200/200 and 148/18/34/0 counts, 6 browser tests). The synthetic report remains `MOCK DATA`; no business proceed was produced. After the plan v1.1 Balanced-routing revision, P45 was repeated: `tests/experiment/full-mock.test.ts` 4 passed and `npm run check` 47 files / 612 tests passed; the full-run counts were unchanged.

**Out of scope, unchanged:** paid compatibility, live preflight/calibration/smoke evidence (P46/P48/P49), frozen-protocol-plus-provenance packaging (P50), live full execution (P51), and any business proceed claim. Acceptance is offline-verified and live-unverified.

## P46. Authorized Live Model/Route Compatibility Probes — 2026-11-06

**State:** `LIVE-VERIFIED / ACCEPTED BY USER ON 2026-11-06`. The plan v1.1 Balanced-routing correction is implemented, the three authorized live probes succeeded, and no provider ID was pinned. P45 remains accepted; P46 is accepted.

**Files**

- Routing/config: `src/ai/config.ts` (model-only live inputs, Balanced request policy, Nitro/Floor rejection), `src/ai/openrouter.ts` (strict Balanced provider object, observed model/provider identity, model-mismatch pause, replay-path enforcement), `src/ai/local-env.ts` (loads `.env.local` then `.env` for CLI runs; skipped under Vitest)
- Catalog/preflight: `src/ai/preflight.ts` (dynamic active-endpoint validation, model-level routes, `max_tokens` preference, conservative multi-provider pricing with live-only conditional-override handling, Decimal pricing-derived reservations, probe schema/vision validation, no provider pinning), `src/cli/preflight.ts` (live path behind `--allow-paid`, `--max-cost`, and `--routing-confirmation`; 64x64 PNG; role-specific probe caps; existing preflight account reuse), `src/cli/report.ts` (reads `data/preflight/<id>/preflight.json` when `--run <preflight-id>` has no DB run)
- Ledger/storage: `src/ai/ledger.ts`, `src/storage/migrations/0005_balanced_routing.sql` (`routing_policy`, `observed_model`, `observed_provider`)
- Domain/reporting/freeze: `src/domain/experiment.ts` (model-only roles, routing policy/confirmation schemas), `src/reporting/metrics.ts` (observed provider/model mix and identity coverage), `src/reporting/export.ts`/`html.ts`, `src/experiment/freeze.ts` (roles/policy bound into the frozen protocol)
- Tests: `tests/ai/preflight.test.ts` (37), `tests/ai/openrouter.test.ts` (28), `tests/experiment/freeze.test.ts` (18), `tests/reporting/metrics.test.ts` (8), plus config/planner/ledger/export/html/runner updates
- Docs/env: `docs/PROVIDER_SMOKE_TESTS.md`, `docs/experiment-protocol.md`, `.env.example`, `README.md`, this entry

**Observable behavior**

- No provider IDs or endpoint tags are required. `GENERATOR_MODEL`, `REVIEWER_MODEL`, and `VISION_REVIEWER_MODEL` are the only model inputs; `OPENROUTER_API_KEY` is the only secret input and is loaded from `.env.local` by the live CLI. Generator must differ from both reviewers; the vision reviewer may reuse the text reviewer.
- Every request sends `provider:{allow_fallbacks:true,require_parameters:true}` with no `sort`, `order`, `only`, or `ignore`. Model slugs ending in `:nitro` or `:floor` are rejected.
- Preflight examines every active catalog endpoint for the configured model, requires at least one compatible active endpoint, prefers `max_tokens` when available, otherwise `max_completion_tokens`, and uses conservative multi-provider pricing (maximum per field, Decimal strings, full-context fallback when image price is absent). Live preflight may use conditional pricing overrides conservatively; offline preflight still rejects them. Provider tags are diagnostics only.
- Each transport attempt stores the requested routing policy/model and separately observed model/provider identity. A contradictory observed model marks the attempt failed, pauses the run with `paused_operator`, and blocks later admissions; the saved-response replay path applies the same check.
- The live CLI requires a fresh operator confirmation JSON with `providerSort:"default_balanced"` and `byokConfigured:false`; future, stale, conflicting, BYOK, or missing confirmations block before any paid call. Live preflight validates each probe's parsed content against the role strict schema and requires the vision probe to report actual image legibility rather than `not_applicable`. Repeated live preflights in one database use unique `preflight:<id>:<role>` probe keys and reuse the global preflight account only when the requested cap equals the stored cap; the artifact records the enforced cap. Once that global account records a pause event, P46 has no in-place reset: a later live preflight needs a fresh `--db` and manual cumulative-authorization tracking. Live stdout includes the probe error code/message. Offline preflight keeps strict pricing rejection and never enables the live-only override/image-reserve allowances.
- `FrozenProtocol` now contains the role model IDs and Balanced/default-sort/no-BYOK policy and computes `routesHash` from them, so the persisted protocol binds the checked configuration.
- The final live preflight `1f717e0d-4a63-486b-b3a3-45f7d7338a2e` used `operator=Lexa`, cap USD 0.45 for the final retry (USD 0.50 total authorization recorded in `data/p46-authorization.json`), and succeeded 3/3:
  - spec: `openai/gpt-6.1-sol` observed via `OpenAI`, HTTP 200, strict schema valid, USD 0.001852, generation `gen-1793992054-ZLa4FE6gg4aTs8OVzKuP`.
  - blind_text: `z-ai/glm-5.3` observed via `Mistral`, HTTP 200, strict schema valid, USD 0.0187394, generation `gen-1793992059-bsVPBmJrmiF46KjZXACA`.
  - blind_vision: `qwen/qwen3.8-max-0902` observed via `Alibaba`, HTTP 200, strict schema valid, `visualLegibility:"legible"`, USD 0.004552, generation `gen-1793992088-iGQIg1sFMdXHDkrLO4RC`. The response explicitly described the 64x64 PNG's 2x2 colored grid.
- Final run actual cost USD 0.0251434; known spend across all retries USD 0.071628282, with bounded unknown exposure below the USD 0.50 cap. No paid call was made after the successful run.
- `npm run report -- --run 1f717e0d-4a63-486b-b3a3-45f7d7338a2e` reads the preflight artifact and prints the observed identities and costs.
- P45 was repeated after the routing correction: full mock remains 200/200 terminal, 148/18/34/0, 644 calls/attempts, barrier 145/18/34, and 4 full-mock tests passed.

**Verification**

| Command | Result |
| --- | --- |
| `npm run preflight -- --live --allow-paid --max-cost 0.45 --routing-confirmation data/p46-routing-confirmation.json --db /tmp/p46-preflight3.sqlite` | exit 0; 3/3 probes success, 3/3 strict schemas valid, vision interpreted, all costs known. |
| `npm run report -- --run 1f717e0d-4a63-486b-b3a3-45f7d7338a2e` | exit 0; prints the live preflight artifact. |
| Repeat `preflight --live --allow-paid --max-cost 0.45 --routing-confirmation ... --db /tmp/p46-preflight3.sqlite` | exit 1 as expected; unique `preflight:<id>:<role>` keys accepted, all three probes `paused_budget` with zero paid calls, proving cumulative cap enforcement. |
| `npm run check` | exit 0; ESLint clean, `tsc --noEmit` clean, Vitest 47 files / 612 tests passed, build succeeded. |
| `npm run test:browser` | exit 0; 6 Playwright Chromium tests passed. |
| `npx vitest run tests/experiment/full-mock.test.ts` | exit 0; 4 tests passed after the routing revision. |
| `npx vitest run tests/ai/preflight.test.ts` | exit 0; 37 tests passed. |
| `npx vitest run tests/ai/openrouter.test.ts` | exit 0; 28 tests passed. |
| `npx vitest run tests/experiment/freeze.test.ts` | exit 0; 18 tests passed. |
| `npx vitest run tests/reporting/metrics.test.ts` | exit 0; 8 tests passed. |

**Decision-reviewer:** the first routing-revision pass confirmed six defects: live preflight did not validate strict probe schemas or image interpretation; the paid preflight reserved a flat USD 0.01 instead of conservative pricing; freeze validated roles/policy but did not bind them into the persisted protocol; conservative pricing used binary floats and could emit exponent notation; confirmation freshness accepted future timestamps; observed model identity was recorded but never compared. All six were fixed and covered by tests. The second pass confirmed the fixes and found one Low residual: the model-mismatch transition recorded `reason:"ok"` in the request-event audit trail; fixed by passing the effective classification to the failed/uncertain transitions and asserting the event payload. The third pass found one Low residual: the resume replay path did not apply the mismatch check; fixed with the same comparison, forced failed outcome, `paused_operator` pause, effective classification, and a replay test. The fourth pass found no material findings. A final live-support review then found four Medium/Low issues: the reused preflight account cap, not `--max-cost`, was the enforced limit while the artifact recorded the requested value; repeated live preflights in one database still collided on the global probe-key index; the offline CLI accidentally enabled the live-only pricing allowances; and a failed live preflight printed the offline header. All four were fixed: exact-cap account reuse with `PREFLIGHT_CAP_MISMATCH` and enforced-cap artifacts, unique `preflight:<id>:<role>` keys, strict offline defaults, and a mode-aware live failure header. The verification pass confirmed those fixes and found two Low residuals: a dead vision-interpretation key comparison and no in-place recovery after a global preflight pause. The dead guard was fixed by matching on probe role, and the pause permanence was documented with the live error code/message surfaced on stdout.

**Manual acceptance:** inspect `data/preflight/1f717e0d-4a63-486b-b3a3-45f7d7338a2e/preflight.json` and confirm the three probe rows above, the observed providers, strict-schema validity, vision interpretation, generation IDs, and costs. No further live call is required.

**Acceptance:** accepted by the user on 2026-11-06 after the three live probes succeeded 3/3 with valid strict schemas, vision interpretation, observed providers OpenAI/Mistral/Alibaba, and known final-run cost USD 0.0251434 (total known spend USD 0.071628282 under the USD 0.50 cap). No further live call is required.

**Out of scope, unchanged:** calibration, all-family generation smoke, primary experiment, and any live claim beyond these three compatibility probes.

## P47. Human Verification of All Calibration Labels — 2026-11-06

**State:** `HUMAN-VERIFIED / ACCEPTED BY USER ON 2026-11-06`. The auditor Lexa completed all 40 labels and `--verify-labels` accepted the file; the agent did not inspect/solve fixtures on behalf of the auditor or fill observations. P46 and P47 are accepted.

**Files**

- `data/calibration/b2de95516799894e5fe5c5b4e6eb1376c772efb14981146797004ab99877eb5f/pack.json` (unchanged)
- `data/calibration/b2de95516799894e5fe5c5b4e6eb1376c772efb14981146797004ab99877eb5f/labels.pending.csv` (preserved pending template)
- `data/calibration/b2de95516799894e5fe5c5b4e6eb1376c772efb14981146797004ab99877eb5f/labels.human.csv` (human-completed: 40/40 verified, labels hash `be359e39350c6e79dc4aeea36651c512726151d569f39a6b35f5ce935730948b`, auditor Lexa, time `2026-11-06T21:01:19.685Z`)
- `data/calibration/b2de95516799894e5fe5c5b4e6eb1376c772efb14981146797004ab99877eb5f/gallery.html` (visible-only gallery for human inspection)
- `docs/calibration-labeling.md` (P47 human gate instructions)
- `docs/PROGRESS.md` (this entry)

**Observable behavior**

- `npm run calibration -- --prepare` deterministically rebuilt the current pack: 40 fixtures, 20 sound/20 defective, pack hash `b2de95516799894e5fe5c5b4e6eb1376c772efb14981146797004ab99877eb5f`.
- The preserved `labels.pending.csv` still has the header plus 40 pending rows and SHA-256 `c976ff71e8acc7aca581dc25149526f6019739c5fdf32efdd0e52a71317a673a`. The human file has 40/40 completed rows: 20 sound / 20 defective, 20 text / 20 SVG, all 10 families, provenance `human`, `human_verified=true`, auditor `Lexa`, one auditor time, and no empty observed blind/alignment results. All 40 observed blind and alignment results match the proposed evidence, so no P40 revision was required.
- `npm run calibration -- --verify-labels .../labels.human.csv --auditor Lexa` now exits 0 with `labels_verified:true`, `fixtures:40`, labels hash `be359e...`, provenance `human`, and `human_verified:true`.
- The human must inspect/solve all 40 actual presentations, including rasterized PNGs, and verify proposed ground truth and mutation evidence. To avoid 240 manual cells, the human fills only `observed_blind_result` for each of the 40 rows as the per-row attestation. `npm run calibration -- --accept-proposed --labels <labels.human.csv> --auditor Lexa` then fills the remaining dependent `observed_*` cells from proposed evidence (40 human-attested / 108 machine-filled / 92 empty in the current pack), and marks `provenance=human`, `human_verified=true`, and the auditor/time. The helper refuses the pending template, mock fixtures, already-attested files, and any row without a human blind result. The human must run it only after review; the agent must not run it on the real file. Any faulty/ambiguous fixture must return to P40 for a new pack hash and fresh human verification; a disagreeing observed value cannot be forced through `--verify-labels`.

**Verification**

| Command | Result |
| --- | --- |
| `npm run calibration -- --prepare` | exit 0; 40 fixtures, 20 sound/20 defective, pack hash `b2de955...` |
| `npm exec -- vitest run tests/calibration/fixtures.test.ts tests/calibration/score.test.ts` | exit 0; 2 files / 25 tests passed |
| `npm run calibration -- --verify-labels .../labels.human.csv --auditor Lexa` | exit 0; 40/40 verified, labels hash `be359e...`, auditor Lexa, human provenance |
| `npm run calibration -- --accept-proposed --labels /tmp/p47-helper-test.csv --auditor Lexa` | exit 0; 40 reviewed rows, 40 human-attested cells, 108 machine-filled cells, 92 empty cells; temp copy verified by `--verify-labels` |
| `npm exec -- vitest run tests/calibration/score.test.ts` | exit 0; 15 tests passed, including accept-proposed helper |
| `npm run check` | exit 0; 47 files / 613 tests passed after the accept-proposed helper was added. |

**Manual acceptance:** the human auditor explicitly accepted all 40 sound/defective labels and expected blind/alignment outcomes for the displayed pack version; `--verify-labels` accepted the file with one auditor/time and human provenance. The agent validated completeness, hashes, and structural consistency only.

**Exact human verification commands**

```bash
npm run calibration -- --verify-labels \
  data/calibration/b2de95516799894e5fe5c5b4e6eb1376c772efb14981146797004ab99877eb5f/labels.human.csv \
  --auditor Lexa
npm exec -- vitest run tests/calibration/fixtures.test.ts tests/calibration/score.test.ts
```

Expected after human completion: `labels_verified: true`, 40 fixtures, matching pack hash, stable label-set hash, one auditor/time, and human provenance. Missing/uncertain labels or a disagreement with the pack remain blocked; do not overwrite proposed truth.

**Decision-reviewer:** the first static pass found seven issues in the initial convenience helper: it could stamp unreviewed rows as human-verified; it accepted mock/pending inputs and could overwrite the pending template; fill/preserve counts were row-level; per-row auditor/time was overwritten; an explicit empty correct label was treated as blank; the printed labels hash could differ from the serialized file; and the docs described a disagreement override that `--verify-labels` rejects. All were fixed: the helper now requires a non-empty `observed_blind_result` on every row, rejects pending/mock/already-attested inputs, writes through a temporary file and validates the re-parsed artifact, computes the printed hash from the re-parsed file, preserves non-empty dependent cells and per-row times, uses the single required auditor, handles defective rows without a correct label, and documents that disagreements block and require a new P40 pack. A verification pass then found two Low residuals: the counters did not distinguish human-authored from machine-filled cells, and a human-entered defect code on a `correct` row was silently discarded. The counters now report human-attested / machine-filled / empty cells, and a contradictory defect-code entry is preserved so `--verify-labels` rejects it. The focused helper test and a temp reviewed-copy CLI run pass; the real human file remains empty. A final verification pass found no material findings. P47 is accepted.

**Acceptance:** accepted by the user on 2026-11-06 after the human-completed 40/40 label file, `--verify-labels` exit 0 with labels hash `be359e39350c6e79dc4aeea36651c512726151d569f39a6b35f5ce935730948b`, focused 25 tests, and full `npm run check` 47 files / 613 tests. No further human label work is required.

**Out of scope, unchanged:** automatic human approval, reviewer calls, tuning to reviewer answers, live calibration qualification (P48), and any live claim beyond the human-verified label file.

## P48. Authorized Live Reviewer Calibration — 2026-11-06

**State:** `LIVE-RUN COMPLETE / ALL FOUR GATES FAILED / NOT ACCEPTED`. The live runner, immutable artifact, CLI guards, report lookup, and tests are implemented. The first authorized live calibration executed exactly 80 review calls and 0 generation calls, produced 40/40 fixture outcomes, and preserved the full evidence, but the fixed conservative gates failed in all four combinations. P48 is therefore not accepted and cannot qualify a primary freeze. P46 and P47 remain accepted; the prior P47 label file is unchanged.

**Files**

- Live runner: `src/calibration/live.ts` (shared request builders/validators, 80-call preparation, budget/ledger execution, provider mix, coverage, budget-breach detection, incomplete/paused handling)
- Artifacts: `src/calibration/live-artifacts.ts` (immutable `calibration.json`, `score.json`, `requests.jsonl`, `responses.jsonl`, `labels.csv`, `calibration.sqlite`, 20 PNG + 20 SVG, verified `manifest.json`)
- Shared calibration path: `src/calibration/run.ts` (exported builders/parsers used by both mock and live), `src/calibration/score.ts` (`evidenceKind=live`, `liveEligible`, executed-role coverage)
- CLI/report: `src/cli/calibration.ts` (`--live`, `--allow-paid`, `--max-cost`, `--labels`, `--auditor`, `--out`, human-label validation before spend, full-route preflight, provenance before spend, `reportCommand`), `src/cli/report.ts` (`--calibration-root`, live artifact lookup)
- Preflight helper: `src/ai/preflight.ts` (exported prompt-token estimate)
- Tests: `tests/calibration/live.test.ts` (11 tests: 80-call execution, budget pause, overshoot, invalid content without retry, text/SVG legibility rejection, missing provider identity, artifact manifest, live score eligibility, report root, CLI guards), `tests/calibration/score.test.ts` (unchanged mock coverage plus live eligibility)
- Live evidence: `data/calibration/b2de95516799894e5fe5c5b4e6eb1376c772efb14981146797004ab99877eb5f/live/962b114c-b685-4d29-b846-606fc13fbabf/`
- Docs: `docs/PROVIDER_SMOKE_TESTS.md` (P48 actual results), `docs/calibration-labeling.md` (live command/artifact/gate instructions), `README.md` (live command and status), this entry

**Observable behavior**

- `npm run calibration -- --live --allow-paid --labels <verified-labels-path> --max-cost <usd>` validates the human labels, fetches the live catalog, runs the full six-role preflight, requires every route to resolve, builds the provenance snapshot, then creates a fresh UUID run directory and SQLite ledger under `data/calibration/<pack-hash>/live/<calibration-id>/`.
- Exactly 80 logical calls are prepared before any dispatch: one blind and one alignment request per fixture, in pack order, using the same prompt/schema builders, model IDs, Balanced routing policy, and primary limits as the mock/primary path. A non-80 preparation, missing label, missing/mismatched PNG/SVG, or route mismatch fails before spending.
- Each call is a separate request; the blind payload contains only the visible presentation. Labels never enter the blind request. The runner does not retry wrong content and never drops a fixture; transport retries remain limited to the certified unprocessed-refusal path.
- The budget account is created with the authorized cap. A budget pause, admission refusal, or post-loop overshoot/pause event marks the run `paused_budget` and `liveEligible=false`. The artifact records known cost, unknown calls/attempts, provider/model mix including missing-identity entries, and the budget summary.
- The artifact is written after the ledger is checkpointed and closed; `manifest.json` hashes every file. `npm run report -- --run <calibration-id>` reads `calibration.json`; a custom `--out` root is reported as `reportCommand` and can be resolved with `--calibration-root`.
- The first live run (`962b114c-b685-4d29-b846-606fc13fbabf`) executed 80/80 review calls, 0 generation calls, 80 transport attempts, and 40/40 observations. Known cost was USD 1.3060874628; 2 calls had unknown cost (network timeouts). No budget pause or overshoot occurred.
- 38 calls were transport-validated; 7 of those were rejected by calibration content validation, leaving 31 fully valid calibration responses. 40 calls ended with `finish_reason:"length"` at the primary 4096-token review cap; 2 calls were uncertain network timeouts. The score reports 49 role-level errors and 3 abstentions. All four conservative gates failed:
  - text blind: sensitivity 0/10, specificity 7/10;
  - text alignment: sensitivity 3/10, specificity 3/10;
  - SVG blind: sensitivity 2/10, specificity 6/10;
  - SVG alignment: sensitivity 0/10, specificity 4/10.
- The dominant cause is output truncation under the primary 4096 cap. P46 had already observed a reasoning reviewer exhausting a 2048/4096 cap and used an 8192-token probe cap for its review probes; the primary route remains 4096, and P48 correctly exercised the primary limit. A different reviewer model, output cap, or other configuration requires a new explicitly authorized calibration and a preserved prior result; the current artifact must not be overwritten or relabeled.

**Verification**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/calibration/live.test.ts tests/calibration/score.test.ts` | exit 0; 27 tests passed. |
| `npm run typecheck` | exit 0. |
| `npm run lint` | exit 0. |
| `npm run calibration -- --live --allow-paid --labels data/calibration/b2de955.../labels.human.csv --max-cost 2` | exit 1 as expected for failed gates; 80 review calls, 0 generation calls, 40 observations, known cost USD 1.3060874628, 2 unknown calls, all four gates false; full artifact written. |
| `npm run report -- --run 962b114c-b685-4d29-b846-606fc13fbabf` | exit 0; prints the live calibration artifact. |
| Manifest re-hash of all 46 files | 0 mismatches; 20 PNG, 20 SVG, 80 request rows, 80 response rows; manifest hash `541f7326e1c1f1fb551a018c1a8239e4b1ebf5a014888be107109931d181e4c3`. |

**Decision-reviewer:** the first static pass found five Low findings: a final-call budget overshoot was not reflected in the success verdict; provider-mix null identities were dropped and totals did not reconcile; `coverage.reviewed` counted observation rows rather than executed role reviews; the report CLI could not locate a non-default `--out` artifact; and a budget-refused prepared attempt was counted as unknown-cost exposure. All five were fixed (post-loop budget events, unknown-identity mix entries, executed-role coverage, `--calibration-root`, prepared-state exclusion) and covered by tests. The verification pass confirmed four fixes and one Low residual on the report-root workflow; the residual was fixed with a `reportCommand` hint, documented `--out`/`--calibration-root` pairing, and an offline report-root test. The final verification pass found no material findings.

**Revised-model attempt:** after the failed P48 run, the operator replaced the reviewers with `deepseek/deepseek-v4.1-flash-1017` and `minimax/minimax-m3.1-flash`. Two fresh P46 live preflights were run with a new operator confirmation (`data/p48-routing-confirmation.json`) and a USD 0.50 cap. Both failed 3/3: `9e0c974b-f843-4c9f-8b73-f4fda6981a58` had a text-reviewer schema violation (`answerStatus:"no_unique_answer"` with `chosenOption:"D"` and `visualLegibility:"legible"` on a text probe); `4d0ecd1f-ef50-449a-bd5f-c3b01aadd809` had a valid text response but the vision reviewer ended `failed_known` with `LENGTH` at the primary 4096 cap. Known cost was USD 0.012721156 under the USD 0.50 cap. No P48 calibration was started with the new models; the previous P48 artifact remains the only calibration result. The new models are not P46-qualified.

**Newest-model attempt:** the operator then supplied `openai/gpt-6-luna` (text) and `google/gemini-3.5-flash-lite` (vision). P46 `732ba854-43bd-41ec-a190-708be62f01d3` passed 3/3 (strict schemas valid, vision interpreted; total USD 0.0026845). P48 `1c9b373e-97ce-42a8-a078-75b341347501` then completed 80/80 review calls, 0 generation calls, and 40/40 observations with known cost USD 0.1052989 and 20 unknown-cost calls; no budget pause/overshoot. All four gates failed: text blind 7/10 sensitivity, 10/10 specificity (3 abstentions); text alignment 20/20 provider errors; SVG blind 0/10 sensitivity, 3/10 specificity (4 strict-schema errors); SVG alignment 0/10 sensitivity, 9/10 specificity (1 strict-schema error). The text-alignment errors are the provider rejection `Invalid JSON schema: regex lookaround is not supported. Found at $.properties.fields.properties.explanation.properties.factIds.items.pattern.` (`invalid_json_schema`); `FACT_ID_PATTERN` contains a negative lookahead that OpenAI structured outputs reject. Even with that pattern fixed, the text-blind and SVG sensitivities are below the fixed 9/10 gate, so this model pair is not viable. The artifact is `data/calibration/b2de955.../live/1c9b373e-97ce-42a8-a078-75b341347501/` with manifest hash `82b44d5fdcb2dd2dd6616de4649ed98da3daa43ef9eca5304f172010f8df39d3`; prior artifacts remain unchanged.

**Manual acceptance:** not granted. The human must confirm the actual scores and limitations, and all four sensitivity/specificity gates must pass before a primary freeze. The current run fails all four gates; P48 remains open. The next step requires an explicit user decision and authorization for a revised reviewer/configuration calibration (for example, a higher primary review output cap or a different reviewer model) while preserving this result; do not edit the fixture labels or thresholds.

**Out of scope, unchanged:** primary-candidate generation, remediation, claims of precise reviewer accuracy, and any live run beyond the authorized P48 calibration.

## P48 contract hardening and offline diagnostics — 2026-11-07

**State:** `CONTRACT-HARDENED / P46-QUALIFIED FOR HAIKU 5.5 + GEMINI 3.8 FLASH / PILOT PENDING`. The original P48 artifacts remain unchanged. P48 is still not accepted because the SVG and text-alignment gates have not been calibrated with the new model pair.

**Files**

- Contract/schema: `src/families/contracts.ts` (lookaround-free `FACT_ID_PATTERN`), `src/ai/schemas.ts` (`UNSUPPORTED_SCHEMA_PATTERN`, recursive pattern compatibility checks, `patternProperties` handling).
- P46: `src/ai/preflight.ts` (five live probes: spec + blind_text + alignment_text + blind_vision + alignment_vision; real alignment probe payloads; corrected `validateProbeContent` for `fields.image`, modality legibility, alignment overall/applicability), `src/cli/preflight.ts` (alignment probe caps).
- Calibration scoring: `src/calibration/score.ts` (explicit defects with `ambiguity:"none"` or `"present"` now count; `"uncertain"` remains abstention).
- Tests: `tests/ai/preflight.test.ts` (39 tests, including five-probe plan, alignment contracts, pattern rejection), `tests/calibration/score.test.ts` (17 tests, including SVG request/image fidelity and the ambiguity fix).
- Evidence/docs: `docs/PROVIDER_SMOKE_TESTS.md`, `README.md`, this entry.

**Observable behavior**

- `FACT_ID_PATTERN` is now lookaround-free and exactly equivalent to the previous pattern: an exhaustive comparison found 0 mismatches over 3,332,988 accepted `f`/`p`/`s` IDs and the five `r-` IDs. `assertStrictJsonSchema` rejects lookaround, backreferences, named groups, atomic groups, conditionals, inline flags, Unicode property escapes, quoted literals, unsupported anchors, and possessive quantifiers before any paid call.
- P46 now exercises all four actual review contracts. The live plan has five probes; `alignment_text` uses the real alignment payload/schema with text image `not_applicable`, and `alignment_vision` requires an applicable image field and a consistent overall. The previous `data.image` path bug and the missing text-legibility check are fixed.
- P46 probes the four review roles at the production 4096 cap (spec stays at 2048, stricter than the production 8192). The earlier 5/5 run `77304e8f-18a8-4e7d-9074-d08e44887456` used 8192 review caps and is superseded because it did not certify the production limit. The first production-cap attempt `95646c16-6bdb-412f-b8e0-c12995d443fc` paused on the spec probe (the conservative 8192 spec reservation was USD 1.536, above the USD 0.50 cap); keeping the spec probe at 2048 kept it under the cap. The final production-cap run `a1ea6c1e-da12-4288-a9cf-b0d6e50440d2` passed 5/5 under USD 0.50: spec `openai/gpt-6.1-sol`/OpenAI USD 0.001572; blind_text `anthropic/claude-haiku-5.5`/Azure USD 0.0002214; alignment_text Haiku/Azure USD 0.0006208; blind_vision `google/gemini-3.8-flash`/Google USD 0.00286425; alignment_vision Gemini/Google USD 0.00567525; total USD 0.0109537. The alignment_text probe proves the lookaround-free schema is accepted; the alignment_vision probe proves the PNG is processed and the alignment contract is valid.
- Reviewer follow-up: the probe caps now match the production review caps; the diagnostic re-scores were moved outside the immutable live artifact directories and both manifests re-verified at 46/46 files with 0 hash mismatches; the alignment-vision prompt's contradictory `not_applicable` instruction is fixed and asserted for both variants.
- Offline SVG audit of P48 `1c9b373e...`: all 20 visible PNG/SVG hashes match the pack and run artifact, all SVG option labels A-D are present, blind/alignment requests contain the visible presentation and no truth labels, and alignment requests contain the original DSL/proof plus the corrupted visible presentation. `cal-symmetry-04` has an unchanged image because its mutation changes only `rules`; the contradictory rule is in the visible text, and the model ignored it.
- Scoring correction: explicit `no_unique_answer`/`cannot_determine` responses with accepted issue codes but `ambiguity:"none"` were being dropped as abstentions. After the fix, re-scoring the stored newest P48 observations without new calls yields text blind **10/10 sensitivity, 10/10 specificity, 0 abstentions, gate PASS** (previously 7/10, 3 abstentions). The original P48 text blind improves from 0/10 to 2/10 because its responses were dominated by `LENGTH`. Text alignment remains 20/20 provider errors; SVG blind remains 0/10 sensitivity / 3/10 specificity; SVG alignment remains 0/10 sensitivity / 9/10 specificity. Corrected scores are diagnostic-only at `data/calibration/b2de955.../diagnostics/<run-id>/score-fixed.json`, outside the immutable live artifact directories; original `score.json` files and manifests are unchanged.
- The audit separates implementation from model behavior: text blind is not model-limited (the scoring was), text alignment was a schema-portability error (now fixed), and the SVG 0/10 results survive the audit (the model ignored a text-only contradiction and missed image defects), so the vision model replacement is justified.

**Verification**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/ai/preflight.test.ts` | 39 passed. |
| `npm exec -- vitest run tests/calibration/score.test.ts` | 17 passed. |
| `npm exec -- vitest run tests/experiment/full-mock.test.ts` | 4 passed (P45 repeat after the request-contract change). |
| `npm run check` | 48 files / 629 tests passed; lint, typecheck, build passed. |
| `npm run preflight -- --live --allow-paid --max-cost 0.50 --routing-confirmation data/p46-routing-confirmation-0010.json --db /tmp/p46-preflight-haiku-gemini-prodcap2.sqlite` | exit 0; five probes at the production review caps, all schema valid, vision interpreted, total USD 0.0109537. |
| Offline P48 re-score | no API calls; newest text blind 10/10, text alignment 0/10 (provider errors), SVG blind 0/10, SVG alignment 0/10; original artifacts unchanged. |

**Manual acceptance:** P46 is qualified for the Haiku 5.5 / Gemini 3.8 Flash pair. The separate development pilot and any new P48 validation set/protocol remain pending explicit user authorization and recording. P48 is not accepted.

**Out of scope, unchanged:** primary-candidate generation, remediation, claims of precise reviewer accuracy, and any live run beyond the authorized P46 preflight.

## P48 development pilot — 2026-11-07

**State:** `PILOT INCOMPLETE / NOT ACCEPTED / NOT FREEZE EVIDENCE`. The operator approved 8 cases / 16 calls with a USD 0.10 cap. The pilot ran 14/16 calls and recorded 8/8 observations; it paused before the `cal-paths-95` alignment_vision dispatch because the next conservative vision reservation plus the known actual cost exceeded the cap. The two `cal-paths-96` calls were not executed. P48 remains not accepted.

**Files**

- Pilot pack/labels: `src/calibration/fixtures.ts` (`buildCalibrationPilotPack`, new slots 95/96, `ranking`/`matching`/`matrix`/`paths`), `src/calibration/pilot.ts` (`buildCalibrationPilotLabels`, `calibrationPilotPass`).
- Runner/artifact: `src/calibration/live.ts` (`expectedCalls` support), `src/calibration/live-artifacts.ts` (`mode:"pilot"`, `pilot.json`, pilot limitations, `freezeEligible:false`).
- CLI/tests: `src/cli/calibration.ts` (`--pilot`, cap enforcement at USD 0.10, separate `data/calibration-pilot/<id>/`), `tests/calibration/pilot.test.ts` (3 tests), `tests/calibration/live.test.ts` (pilot guards).
- Evidence: `data/calibration-pilot/c970ee24-600d-4008-9466-91ff353713e5/` with `pilot.json`, `score.json`, `requests.jsonl`, `responses.jsonl`, `labels.csv`, `pilot.sqlite`, 4 PNG + 4 SVG, and `manifest.json` (14 files, manifest hash `02a655be5545c1df1e4dd0eaef749e2e237503de182ae0524e3fb6c3f98079e6`, 0 hash mismatches).

**Observable behavior**

- Pilot cases are code-derived development cases, disjoint from the 40 calibration fixtures and from any future v2 set. Truth is code-derived (`provenance:"mock_test_only"`, `humanVerified:false`) and the artifact is explicitly `freezeEligible:false`.
- Text blind: 2 TP / 2 TN / 0 errors, PASS (2/2 defective, 2/2 sound).
- Text alignment: 1 TP / 0 TN / 3 errors. `cal-ranking-95`, `cal-matching-95`, and `cal-matching-96` returned `overall:"pass"` while `explanation` (and once `hint`) was `uncertain`; the validator rejected the contradiction. The v1 prompt says "The overall field is advisory; code computes the authoritative overall status," while the strict schema rejects an inconsistent overall; this is a prompt/schema contradiction, so the errors are not purely model inability. A v2 prompt that states the derived overall rule explicitly is the proposed fix. The first pilot also used independent slot-95/96 bases; the code now derives each defective pilot case from the same base as its sound twin, so the existing artifact's 2/2 contrast is confounded by the base difference and future pilots will use true twins.
- SVG blind/alignment: `cal-matrix-95` and `cal-matrix-96` both passed in both modes (1 TP / 1 TN each); the vision model detected the contradictory-XOR matrix defect. `cal-paths-95` blind ended `finish_reason:"length"` at the 4096 cap; its alignment was budget-refused; both `cal-paths-96` calls were not executed. The paths cases are unresolved.
- Known cost: **USD 0.0535287**, 0 unknown calls, no budget breach. The pilot paused at 14/16 and therefore fails its 16/16 criterion. The cap was not exceeded; the conservative vision reservation plus known actual cost exceeded the approved USD 0.10 admission bound.

**Verification**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/calibration/pilot.test.ts` | 3 passed. |
| `npm exec -- vitest run tests/calibration/live.test.ts tests/calibration/pilot.test.ts` | 16 passed. |
| `npm run check` | 49 files / 635 tests passed; lint, typecheck, build passed. |
| `npm run calibration -- --pilot --allow-paid --max-cost 0.10` | exit 1; 14/16 calls, 8/8 observations, known cost USD 0.0535287, status `paused_budget`, pilotPass false, artifact and manifest written. |
| Pilot manifest re-hash | 14/14 files, 0 hash mismatches; 4 PNG + 4 SVG, 14 request/response rows. |

**Manual acceptance:** not granted. The pilot is incomplete and does not resolve the paths cases. A supplemental budget above USD 0.10 (or a focused paths-only pilot) is required to finish the paths evidence; the text-alignment overall inconsistency needs a decision between a stronger prompt rule and a different text model. The pre-approved fallback P46 for Claude Sonnet 5.5 remains available if the SVG paths behavior cannot be established with Gemini 3.8 Flash.

**Fallback P46:** the pre-approved Sonnet 5.5 fallback `1edc248c-25db-4924-b368-c39e9cf69572` (Haiku 5.5 text, Sonnet 5.5 SVG) passed spec, blind_text, alignment_text, and blind_vision but failed `alignment_vision` with `hint cannot be not_applicable`; Sonnet set the hint field to `not_applicable`, which the contract allows only for image. Known cost USD 0.0165117. Sonnet 5.5 is not P46-qualified; Gemini 3.8 Flash remains the qualified vision model. The fallback artifact is `data/preflight/1edc248c-25db-4924-b368-c39e9cf69572/`.

**Out of scope, unchanged:** primary-candidate generation, remediation, claims of precise reviewer accuracy, and any live run beyond the approved pilot/P46 scope.

## P48 alignment contract v2 and deterministic audit — 2026-11-07

**State:** `ALIGNMENT CONTRACT V2 IMPLEMENTED / OFFLINE AUDIT COMPLETE / NEW PILOT PENDING BUDGET`. The model no longer generates `overall`; the application derives it from field statuses. The deterministic duplicate-option guard and the paths PNG/scoring audit are verified offline. The original pilot `c970ee24...` remains an incomplete diagnostic artifact and is not comparable to a new same-base pilot. P48 is still not accepted.

**Files**

- Alignment contract: `src/ai/schemas.ts` (fields-only `ALIGNMENT_REVIEW_RESPONSE_SCHEMA`, legacy stored union, v2 JSON schema), `src/ai/review-alignment.ts` (v2 prompt/schema versions, app-derived overall, no model overall, `modelOverall:null`, `overallMismatch:false` compatibility), `src/runner/review-slot.ts` (stored union; completed payload no longer requires a model overall), `src/calibration/run.ts` and `src/calibration/score.ts` (derive overall from fields; no model-overall check), `src/ai/preflight.ts` (fields-only alignment probes, derived overall/applicability).
- Prompts: `src/ai/prompts/v2/alignment-text.txt`, `src/ai/prompts/v2/alignment-vision.txt`; `src/experiment/provenance.ts` requires the v2 alignment prompts.
- Reasoning effort: `src/ai/config.ts` (`reasoningEffort: low|medium|high` -> `reasoning_effort`), `src/cli/preflight.ts` and `src/cli/calibration.ts` (`--vision-reasoning-effort`).
- Tests: `tests/ai/review-alignment.test.ts`, `tests/ai/preflight.test.ts`, `tests/ai/mock.test.ts`, `tests/calibration/score.test.ts`, `tests/calibration/live.test.ts`, `tests/calibration/pilot.test.ts`, `tests/experiment/provenance.test.ts`.
- Docs: `docs/PROVIDER_SMOKE_TESTS.md`, this entry, `README.md`.

**Observable behavior**

- The model returns only `fields`; a model-supplied `overall` is an extra property and is rejected. `deriveAlignmentOverall` is authoritative. Legacy stored alignment reviews with `overall` remain readable through the storage union, but new reviews never trust a model overall.
- The v2 text prompt requires text `image:not_applicable`, forbids `not_applicable` on question/rulesAndClues/options/hint/explanation, and instructs the model not to return overall. The v2 vision prompt requires `image` applicable and forbids `not_applicable` on all other fields.
- The deterministic audit proves `cal-matching-96` is a deliberate `duplicate_correct_option` mutation: `ChoiceSetSchema` rejects duplicate choice values and an ambiguous correct label, and `assertAssembledPresentation` rejects duplicate visible option texts. The production pipeline would reject such a question before AI review; the Haiku miss still counts against calibration.
- The paths audit proves the `cal-paths-96` PNG/SVG hashes, visible A-D labels, corrupted alignment payload, original DSL/proof, and `CLOSED_ROUTE_EDGE` -> `assets` -> `image` scoring mapping are faithful. The `cal-paths-95` blind `LENGTH` used 4079 completion tokens, 3931 of them hidden reasoning and only about 148 content; the 4096 cap was consumed by reasoning.
- Gemini 3.8 Flash advertises `reasoning_effort` on all active endpoints. The request builder now supports `reasoningEffort` and the P46/calibration CLIs expose `--vision-reasoning-effort`; a low-effort paths pilot is the targeted next test. Raising the cap to 8192 remains the second option because it increases the cost of all 80 calibration calls.

**Verification**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/ai/review-alignment.test.ts tests/ai/preflight.test.ts tests/ai/mock.test.ts tests/calibration/score.test.ts tests/calibration/live.test.ts tests/calibration/pilot.test.ts` | 94 passed. |
| `npm exec -- vitest run tests/calibration/pilot.test.ts` | 7 passed, including the duplicate-validator and paths-fidelity audits. |
| `npm run check` | 49 files / 639 tests passed; lint, typecheck, build passed. |
| No paid calls were made for the contract v2 or deterministic audit. | The original pilot and P46 artifacts remain unchanged. |

**Manual acceptance:** the offline contract fix and deterministic audit are complete. P45/P46 must be repeated for the prompt/schema change, and a new same-base pilot with new development fixtures, the v2 contract, and `--vision-reasoning-effort low` requires a separately approved budget. P48 remains not accepted.

**Out of scope, unchanged:** primary-candidate generation, remediation, claims of precise reviewer accuracy, and any live run beyond the approved pilot/P46 scope.

## P48 v2 pack preparation and P46 v2 result — 2026-11-07

**State:** `V2 PACK PREPARED / P46 V2 FAILED ON ALIGNMENT_TEXT / PILOT NOT RUN`. The version-2 40-fixture validation pack and pending labels are ready offline. The five-probe v2 P46 failed `alignment_text` because Haiku 5.5 set `hint:not_applicable` despite the v2 contract, so the new 6-case/12-call same-base pilot was not executed. P48 remains not accepted.

**Files**

- V2 pack: `src/calibration/fixtures.ts` (`CALIBRATION_PACK_VERSION_V2`, `buildCalibrationPackV2`, version union), `src/domain/experiment.ts` (two- or three-digit slot IDs), `src/cli/calibration.ts` (`--prepare-v2`), `tests/calibration/fixtures-v2.test.ts`.
- New pilot: `src/calibration/fixtures.ts` (6 cases: ranking sound/no-valid/duplicate and paths sound/closed-route/duplicate, same-base twins at slots 97-99), `src/calibration/pilot.ts` (label-count-aware pass criterion), `src/cli/calibration.ts` (12 calls, USD 0.25 cap), `tests/calibration/pilot.test.ts`.
- P46 artifact: `data/preflight/362cfedd-10de-42aa-b6e8-e7f4f281f633/`.
- V2 pack artifacts: `data/calibration-v2/c8bacdf030974d1c4c56fc3ec79cf2d43e19c8c21514da63bd26eb01cf1442dc/`.
- Docs: `docs/PROVIDER_SMOKE_TESTS.md`, `docs/experiment-protocol.md`, `README.md`, this entry.

**Observable behavior**

- `npm run calibration -- --prepare-v2` produced a 40-fixture version-2 pack at slots 101-104 / fixture IDs 05-08, 20 sound / 20 defective, 20 text / 20 SVG, with 60 image files, `gallery.html`, `pack.json`, and `labels.pending.csv`. It is disjoint from the v1 pack (slots 91-94) and the development pilot (slots 95-99). No paid call was made.
- `--pack-version 1|2` now selects the pack for `--accept-proposed`, `--verify-labels`, `--mock`, and `--live`; the default remains version 1. The v2 pending labels can therefore be accepted, verified, mock-scored, or used by a v2 live calibration without another code change.
- P46 `362cfedd-10de-42aa-b6e8-e7f4f281f633` used the v2 fields-only contract and `--vision-reasoning-effort low`. Spec, blind_text, blind_vision, and alignment_vision passed; alignment_text failed with `hint cannot be not_applicable` (Haiku 5.5 via Azure). Known cost USD 0.00963285 under the combined USD 0.25 authorization; the pilot budget remains unspent.
- The new pilot was implemented; it was later run as `2ebf4403-947f-486a-b2e4-a2f924f05e0b` and failed the SVG paths combinations (see the next section): 6 development cases (3 text: sound/no-valid/duplicate; 3 paths: sound/closed-route/duplicate), same-base twins, 12 calls, v2 contract, low vision reasoning effort, USD 0.25 cap, separate `data/calibration-pilot/<id>/` artifact.
- The v2 pending labels require P47-like human verification before a v2 P48 calibration.

**Verification**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/calibration/fixtures-v2.test.ts` | 1 passed; 40 fixtures, version 2, slots 101-104, IDs 05-08, disjoint from v1. |
| `npm exec -- vitest run tests/calibration/pilot.test.ts` | 7 passed; 6 cases/12 calls, same-base twins, duplicate/paths audits, label-count-aware pass. |
| `npm run check` | 50 files / 644 tests passed; lint, typecheck, build passed. |
| `npm run calibration -- --prepare-v2` | exit 0; pack hash `c8bacdf030974d1c4c56fc3ec79cf2d43e19c8c21514da63bd26eb01cf1442dc`; pending labels written. |
| `npm run preflight -- --live --allow-paid --max-cost 0.50 --routing-confirmation data/p46-routing-confirmation-1709.json --vision-reasoning-effort low --db /tmp/p46-preflight-v2-low.sqlite` | exit 1; 4/5, alignment_text `hint cannot be not_applicable`, total USD 0.00963285. |
| `npm run calibration -- --pilot ...` | at that point not run; later run as `2ebf4403...` (see next section). |

**Manual acceptance:** the v2 pack is ready for human labeling. P46 is not qualified for `alignment_text` with Haiku 5.5; the next step is a separate `ALIGNMENT_TEXT_MODEL` (candidate: `google/gemini-3.8-flash`, which followed the hint rule in alignment_vision) and a new P46, then the approved 6-case/12-call pilot. The remaining combined budget is USD 0.24036715.

**Out of scope, unchanged:** primary-candidate generation, remediation, claims of precise reviewer accuracy, and any live run beyond the approved pilot/P46 scope.

## P48 separate alignment_text model and 6-case pilot — 2026-11-07

**State:** `TEXT CONFIG PASSES / SVG PATHS FAILS / PILOT NOT ACCEPTED`. The separate `ALIGNMENT_TEXT_MODEL` fixes the Haiku applicability failure and the 6-case pilot passes both text combinations. Both SVG paths combinations fail; Gemini 3.8 Flash missed the closed-route and duplicate paths defects. P48 remains not accepted.

**Files**

- Live config: `src/ai/config.ts` (`alignmentText` model, `ALIGNMENT_TEXT_MODEL`, `alignment_text_reviewer` role, fallback to `REVIEWER_MODEL`, role separation/correlations), `src/cli/preflight.ts` and `src/cli/calibration.ts` (model IDs, alignment_text route), `src/calibration/live-artifacts.ts` (artifact records the alignment text model).
- Tests: `tests/ai/preflight.test.ts` (alignment text override/fallback/separation), `tests/calibration/live.test.ts` (artifact model projection).
- Evidence: P46 `data/preflight/d21d90c7-ab0d-4938-aff6-1912de82e93c/`; v2 labels `data/calibration-v2/c8bacdf.../labels.human.csv`; pilot `data/calibration-pilot/2ebf4403-947f-486a-b2e4-a2f924f05e0b/`; aborted pilot `data/calibration-pilot/3e1cb2e5-04f3-4eeb-8a82-c9bfe72d0888/`.
- Docs: `docs/PROVIDER_SMOKE_TESTS.md`, `README.md`, this entry.

**Observable behavior**

- P46 `d21d90c7-ab0d-4938-aff6-1912de82e93c` passed 5/5 with Haiku blind_text, Gemini alignment_text, Gemini vision, and low vision reasoning effort; total USD 0.0135039. The alignment_text probe now follows the v2 hint/image applicability contract.
- The v2 pending labels were reviewed by Kilo on the operator's explicit delegation, audited against the pack truth and visible artifacts, accepted with `--accept-proposed --pack-version 2 --auditor "Lexa (delegated to Kilo)"`, and verified. `labels.human.csv` has 40 rows, labels hash `2c4e2e45728a0d48492e905137ab9de2be76509f3c8dff0e4726e9ec0237fec5`, provenance `human`, `human_verified:true`, and per-row notes disclosing that this was not independent human inspection. The calibration artifact labels block records `reviewMethod` (`independent_human`, `operator_delegated_ai`, or `code_derived`; the v2 labels are `operator_delegated_ai`, the pilot labels are `code_derived`) and the unique notes. A freeze requiring independent human verification must reject or explicitly caveat a non-`independent_human` method; the operator can re-review the labels independently.
- Pilot `2ebf4403-947f-486a-b2e4-a2f924f05e0b` completed 12/12 calls and 6/6 observations at USD 0.0629549. Text blind and text alignment both pass 2/2 defective and 1/1 sound. SVG paths fail: `cal-paths-97` sound passes; `cal-paths-98` `CLOSED_ROUTE_EDGE` is classified as sound in both blind and alignment; `cal-paths-99` `DUPLICATE_CORRECT_OPTION` has a blind strict-schema error (3316 completion tokens) and is classified as sound in alignment. `schemaValidCalls` is false, so the pilot is not accepted.
- The earlier pilot attempt `3e1cb2e5-04f3-4eeb-8a82-c9bfe72d0888` was aborted by the shell timeout at 11/12 calls (known cost USD 0.05684915, one dispatching vision call with unknown exposure bounded by its reservation). It has no final manifest and is not used as a result.
- Total known spend across the P46/pilot attempts at that point was USD 0.1429408; the later v3 experiment and current remaining budget are recorded in the next section.

**Verification**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/ai/preflight.test.ts tests/calibration/live.test.ts` | 56 passed. |
| `npm run check` | 50 files / 644 tests passed; lint, typecheck, build passed. |
| `npm run preflight -- --live --allow-paid --max-cost 0.50 --routing-confirmation data/p46-routing-confirmation-1738.json --vision-reasoning-effort low --db /tmp/p46-preflight-alignment-gemini.sqlite` | exit 0; 5/5, total USD 0.0135039. |
| `npm run calibration -- --accept-proposed --pack-version 2 --labels .../labels.human.csv --auditor "Lexa (delegated to Kilo)"` | exit 0; 40 rows, labels hash `2c4e2e...`, provenance human, human_verified true. |
| `npm run calibration -- --verify-labels .../labels.human.csv --pack-version 2 --auditor "Lexa (delegated to Kilo)"` | exit 0; 40 fixtures verified. |
| `npm run calibration -- --pilot --allow-paid --max-cost 0.18 --vision-reasoning-effort low` | exit 1; 12/12 calls, 6/6 observations, USD 0.0629549; text combinations pass, SVG combinations fail. |
| Pilot manifest re-hash | 12/12 files, 0 hash mismatches. |

**Manual acceptance:** the text configuration is accepted for the next stage; the SVG paths configuration is not. The next step is a stronger SVG reviewer (the previously mentioned Claude Sonnet 5.5 reserve) under the v2 P46 and a paths-focused pilot, or a paths prompt/image investigation. The v2 labels' operator-delegated provenance must be independently re-reviewed before any freeze that requires human verification.

**Out of scope, unchanged:** primary-candidate generation, remediation, claims of precise reviewer accuracy, and any live run beyond the approved pilot/P46 scope.

## P48 deterministic paths audit and vision prompt v3 — 2026-11-07

**State:** `DETERMINISTIC AUDIT PASSES / V3 PROMPT-ONLY EXPERIMENT FAILED / NO MODEL SWAP`. The existing paths validator rejects both deliberate mutations when applied to the actual serialized SVG/PNG, and the new audit is separate from the model score. The v3 vision prompts passed P46 but the prompt-only paths pilot did not fix the behavior: the sound blind selected the wrong option, the closed-route case was still classified as sound in both modes, and the duplicate case was budget-refused. The pilot remains FAIL; no model swap was performed.

**Files**

- Deterministic audit: `src/calibration/asset-audit.ts` (parse serialized SVG, `pathsRenderer.assertScene`, raster equivalence, normalized option crop hashes, duplicate groups, valid-option count), `tests/calibration/asset-audit.test.ts`, `src/cli/calibration.ts` (`--audit-assets`).
- Exact diagnostics: `src/calibration/run.ts` (`formatZodIssues`; blind/alignment schema errors now include the exact issue path/message).
- Vision prompt v3: `src/ai/prompts/v3/blind-vision.txt`, `src/ai/prompts/v3/alignment-vision.txt`, `src/ai/review-vision.ts`, `src/ai/review-alignment.ts`, `src/experiment/provenance.ts`, tests `review-vision`, `review-alignment`, `provenance`.
- Paths-only pilot: `src/calibration/fixtures.ts` (`buildPathsPilotPack`, slots 105-107 / IDs 09-11), `src/calibration/pilot.ts` (skip empty combinations), `src/cli/calibration.ts` (`--pilot-set paths`, 6 calls), `src/calibration/live-artifacts.ts` (`pilotSet`).
- Evidence: P46 v3 `data/preflight/2082fa49-994b-4e45-85c4-7b59a11da941/`; paths pilot `data/calibration-pilot/7fad3123-4b0b-4912-b043-7c03b11b6c3c/`.
- Docs: `docs/SVG_PATHS_FAILURE_ANALYSIS.md`, `docs/PROVIDER_SMOKE_TESTS.md`, `docs/experiment-protocol.md`, `README.md`, this entry.

**Observable behavior**

- `npm run calibration -- --audit-assets` and `tests/calibration/asset-audit.test.ts` reproduce the existing-validator results on the actual assets: `cal-paths-97` PASS with 4 distinct crops and 1 valid option; `cal-paths-98` `UNEXPECTED_WALL` with 4 distinct crops and 0 valid options; `cal-paths-99` `WRONG_ROUTE` with 3 distinct crops, duplicate A/B, and 2 valid options; all three are raster-equivalent (0 pixel difference). The audit is a separate deterministic evidence channel and does not rewrite the model's false negatives.
- The vision prompts are versioned v3. The blind prompt requires all-option route tracing, pairwise tile comparison, route-vs-wall verification, distractor tolerance, duplicate/no-valid handling, and a short final reasoning field. The alignment prompt requires exactly one valid option, allows intentional wall-crossing distractors, fails `options`/`image` for an invalid or duplicated correct option, and clarifies that reporting a defective image is not adjudication. The fields-only alignment schema and image/hint applicability rules are unchanged.
- P46 v3 `2082fa49-994b-4e45-85c4-7b59a11da941` passed 5/5 with the same models and low vision effort; total USD 0.01422115.
- The prompt-only paths pilot `7fad3123-4b0b-4912-b043-7c03b11b6c3c` used new same-base paths cases at slots 105-107 and the v3 prompts. It ran 5/6 calls and 3/3 observations at USD 0.01868025, paused on the `cal-paths-11` blind budget reservation, and failed: `cal-paths-09` sound blind selected A while the alignment named D as the unique valid route; `cal-paths-10` closed-route was classified as sound in both modes; `cal-paths-11` duplicate blind was budget-refused and its alignment was not executed. The pilot pass is false.
- The v3 prompt change invalidates the earlier vision calibration evidence under the reviewer-change rule. The full suite passed 51 files / 646 tests at that point; the later medium/Sonnet changes passed 51 files / 649 tests.
- At that point total known spend was USD 0.1758422 (USD 0.1429408 + P46 v3 USD 0.01422115 + paths pilot USD 0.01868025); the later medium/Sonnet experiments are recorded in the next section.

**Verification**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/calibration/asset-audit.test.ts` | 1 passed; 97 pass, 98 `UNEXPECTED_WALL`, 99 `WRONG_ROUTE` + duplicate A/B, all raster-equivalent. |
| `npm run calibration -- --audit-assets` | exit 0; pack `7b93c87f...`; 97 pass, 98 fail/0 valid, 99 fail/3 distinct/duplicate A,B/2 valid. |
| `npm exec -- vitest run tests/calibration/pilot.test.ts tests/ai/review-vision.test.ts tests/ai/review-alignment.test.ts tests/experiment/provenance.test.ts` | 35 passed. |
| `npm run check` | 51 files / 646 tests passed; lint, typecheck, build passed. |
| `npm run preflight -- --live --allow-paid --max-cost 0.50 --routing-confirmation data/p46-routing-confirmation-1920.json --vision-reasoning-effort low --db /tmp/p46-preflight-v3.sqlite` | exit 0; 5/5, total USD 0.01422115. |
| `npm run calibration -- --pilot --pilot-set paths --allow-paid --max-cost 0.08 --vision-reasoning-effort low` | exit 1; 5/6 calls, 3/3 observations, USD 0.01868025, `paused_budget`, pilot pass false. |

**Manual acceptance:** the deterministic audit is accepted as a separate production-hardening/diagnostic channel; it does not change the model score. The v3 prompt-only experiment is recorded as a failed/incomplete paths experiment; at that point no model swap had been performed. The later medium-effort and Sonnet 5.5 experiments are recorded in the next section. Any prompt/schema/fixture change requires the corresponding P45/P46/pilot/P48 repeat. The v2 labels' operator-delegated provenance must be independently re-reviewed before a freeze that requires human verification.

**Out of scope, unchanged:** primary-candidate generation, remediation, claims of precise reviewer accuracy, and any live run beyond the approved pilot/P46 scope.

## P48 medium-effort and Sonnet 5.5 paths experiments — 2026-11-07

**State:** `CLOSED-ROUTE STILL MISSED / DUPLICATE DETECTED BY SONNET / PATHS PILOT FAIL / NO V2 P48`. The medium-effort Gemini experiment and the Sonnet 5.5 model experiment both missed the closed-route defect in both modes. Sonnet 5.5 detected the duplicate defect in both blind and alignment in a focused duplicate-only diagnostic. The deterministic audit still catches both mutations independently of the model. The current paths pilot remains FAIL and no v2 P48 calibration was run.

**Files**

- New development cases: `src/calibration/fixtures.ts` (`buildPathsPilotPackV2` slots 108-110 / IDs 12-14; `buildPathsDuplicatePilotPack` sound+duplicate; `buildPathsDuplicateOnlyPilotPack` duplicate-only), `src/cli/calibration.ts` (`--pilot-set paths-medium`, `--pilot-set paths-duplicate`, `--pilot-set paths-duplicate-only`, `--audit-set`), `tests/calibration/pilot.test.ts`, `tests/calibration/asset-audit.test.ts`.
- Evidence: medium P46 `data/preflight/54e397f7-e62e-4091-bb89-fd4ba22e9a86/`; medium paths pilot `data/calibration-pilot/94c76bf7-28e0-49d0-b594-1efa45cb347c/`; Sonnet P46 `data/preflight/5684cc06-24d5-46e5-8711-94630f6bf903/`; Sonnet paths pilot `data/calibration-pilot/a39eed3c-b171-49e9-be03-810a2dd7586e/`; Sonnet duplicate-only `data/calibration-pilot/38798cfa-15bb-46ec-adfc-aed80d326ae1/`.
- Docs: `docs/PROVIDER_SMOKE_TESTS.md`, `docs/SVG_PATHS_FAILURE_ANALYSIS.md`, `README.md`, this entry.

**Observable behavior**

- Medium-effort Gemini P46 `54e397f7...` passed 5/5 at USD 0.0171879. The paths-medium pilot `94c76bf7...` ran 4/6 calls at USD 0.035466 and paused: `cal-paths-12` sound was correct, `cal-paths-13` closed-route was classified as sound in blind (alignment budget-refused), and `cal-paths-14` duplicate was not executed.
- Sonnet 5.5 P46 `5684cc06...` passed 5/5 at USD 0.0223404. The paths-medium pilot `a39eed3c...` ran 5/6 calls at USD 0.109458 and paused: `cal-paths-12` sound was correct, `cal-paths-13` closed-route was classified as sound in both blind and alignment, and `cal-paths-14` duplicate was budget-refused.
- The focused Sonnet duplicate-only diagnostic `38798cfa...` completed 2/2 calls at USD 0.046904. `cal-paths-14` blind returned `no_unique_answer` with `duplicate_options`; alignment returned `options:fail` and `image:fail`; both score buckets are `defective`/conservative true. The pilot pass is false only because the focused pack intentionally has no sound case; this is a diagnostic, not a calibration pass.
- The closed-route defect remains undetected by both Gemini 3.8 Flash and Sonnet 5.5 in both modes. The duplicate defect is detectable by Sonnet 5.5 under the v3 prompts. The deterministic audit catches both mutations and remains separate from the model score.
- At that point total known spend was USD 0.4071985 (USD 0.1758422 + medium P46/pilot USD 0.0526539 + Sonnet P46/pilot USD 0.1787024); the combined authorization is USD 0.55 (USD 0.25 + USD 0.30), leaving USD 0.1428015. The full suite passed 51 files / 649 tests at that point; the targeted diagnostic is in the next section.
- No v2 P48 calibration was run. The next step is a paths-specific closed-edge asset/prompt experiment or a new calibration contract that assigns structural defects to the deterministic validator and narrows the AI reviewer role; the current paths pilot remains FAIL.

**Verification**

| Command | Result |
| --- | --- |
| `npm run preflight -- --live --allow-paid --max-cost 0.50 --routing-confirmation data/p46-routing-confirmation-1938.json --vision-reasoning-effort medium --db /tmp/p46-preflight-v3-medium.sqlite` | exit 0; 5/5, USD 0.0171879. |
| `npm run calibration -- --pilot --pilot-set paths-medium --allow-paid --max-cost 0.10 --vision-reasoning-effort medium` | exit 1; 4/6 calls, USD 0.035466, paused; paths-13 closed-route missed. |
| `npm run preflight -- --live --allow-paid --max-cost 0.50 --routing-confirmation data/p46-routing-confirmation-1941.json --db /tmp/p46-preflight-sonnet-v3.sqlite` | exit 0; 5/5, USD 0.0223404. |
| `npm run calibration -- --pilot --pilot-set paths-medium --allow-paid --max-cost 0.25` | exit 1; 5/6 calls, USD 0.109458, paused; paths-13 closed-route missed. |
| `npm run calibration -- --pilot --pilot-set paths-duplicate-only --allow-paid --max-cost 0.18` | exit 0; 2/2 calls, USD 0.046904; duplicate blind and alignment both `defective`/conservative true. |
| `npm run check` | 51 files / 649 tests passed; lint, typecheck, build passed. |

**Manual acceptance:** the deterministic audit is accepted as the production-hardening/diagnostic channel. At that point the paths reviewer was not accepted: visual closed-route detection failed with both tested models; the duplicate was detected by Sonnet 5.5. The targeted four-variant diagnostic is in the next section. No v2 P48 calibration has been run; any new prompt/model/fixture/contract change requires a new authorized experiment and the corresponding P45/P46/pilot/P48 repeat.

**Out of scope, unchanged:** primary-candidate generation, remediation, claims of precise reviewer accuracy, and any live run beyond the approved pilot/P46 scope.

## P48 targeted four-variant paths diagnostic — 2026-11-07

**State:** `VISUAL INTERPRETATION / RULES LOGIC OK / PATHS PILOT FAIL / NO V2 P48`. The targeted diagnostic on `cal-paths-13` with Sonnet 5.5 shows that the text-only open-edge variant D correctly returns `no_unique_answer`/`no_correct_option`, while the original image control A, the explicit per-edge procedure B, and the zoomed-crop variant C all select an offered route. The rules/logic formulation is sound; the remaining failure is visual interpretation of the closed edge. The diagnostic is not calibration evidence and the paths pilot remains FAIL.

**Files**

- Diagnostic implementation: `src/calibration/paths-diagnostic.ts` (four variant requests, crops, runner, classification, artifact writer), `src/cli/paths-diagnostic.ts`, `tests/calibration/paths-diagnostic.test.ts`, `package.json` (`paths-diagnostic` script).
- Evidence: `data/paths-diagnostic/03992846-9d26-4588-b00d-edbf08cbb5f7/` (A/B, paused at C on the admission reservation), `data/paths-diagnostic/64877ad9-8b6c-48fa-81ed-c001e6f77e0e/` (C/D, completed), and the combined report `data/paths-diagnostic/combined-2026-11-07.json`.
- Docs: `docs/SVG_PATHS_FAILURE_ANALYSIS.md`, `docs/PROVIDER_SMOKE_TESTS.md`, `README.md`, this entry.

**Observable behavior**

- Variant A: original PNG + original v3 blind prompt, Sonnet 5.5, `selected C`; the original failure is reproduced.
- Variant B: original PNG + explicit per-edge verification procedure, `selected D`; the procedure does not fix the visual failure.
- Variant C: full original PNG + 4x zoom of the source edge (1,1)-(2,1) and option C edge, `selected D`; the visual detail does not fix it.
- Variant D: text-only open-edge list, no image, `no_unique_answer` with issue `no_correct_option`; the logical decision is correct.
- Combined classification: **visual interpretation** (D succeeds, A fails; B/C fail). The rules/logic are not the blocker; the model does not visually resolve the closed edge even with the explicit procedure or zoomed crops.
- The first diagnostic run paused at C because the three-image reservation plus the known A/B cost exceeded the USD 0.25 admission cap; the focused C/D run completed under the same cap with no additional model or prompt change. The first artifact labels that C as `schema_error`; new runs use the distinct `budget_refused`/`transport_error` buckets, and the CLI now caps new runs at the remaining envelope (USD 0.05 admission/actual). The diagnostic artifacts are separate from calibration and are `calibrationEligible:false`/`freezeEligible:false`.
- Costs: A/B USD 0.040836; C/D USD 0.044802; diagnostic total USD 0.085638. Total known spend is USD 0.4928365 (USD 0.4071985 + USD 0.085638); the combined authorization is USD 0.55, leaving USD 0.0571635. The full suite passed 52 files / 651 tests. No v2 P48 calibration was run.

**Verification**

| Command | Result |
| --- | --- |
| `npm exec -- vitest run tests/calibration/paths-diagnostic.test.ts` | 2 passed; four variants/crops/classification. |
| `npm run paths-diagnostic -- --allow-paid --max-cost 0.25` | first run; A `selected C`, B `selected D`, C budget-refused, D not executed; USD 0.040836. |
| `npm run paths-diagnostic -- --allow-paid --max-cost 0.25 --max-actual-cost 0.10 --variants C,D` | exit 0; C `selected D`, D `no_unique_answer`/`no_correct_option`; USD 0.044802. |
| `npm run check` | 52 files / 651 tests passed; lint, typecheck, build passed. |

**Manual acceptance:** the four-variant diagnostic is accepted as a separate diagnostic; it is not calibration evidence. The classification is visual interpretation; the rules/logic are sound. The next step is a closed-edge visual-representation experiment (larger/contrast/zoom as a new fixture configuration) or a new calibration contract that assigns structural defects to the deterministic validator and narrows the AI reviewer role. No v2 P48 calibration has been run.

**Out of scope, unchanged:** primary-candidate generation, remediation, claims of precise reviewer accuracy, and any live run beyond the approved pilot/P46/diagnostic scope.
