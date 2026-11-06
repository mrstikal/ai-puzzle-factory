# Source Provenance and Reproduction (P44)

P44 makes the local implementation identifiable and replayable without trusting a clean Git checkout or a future remote model response. It archives a hashed allowlist of the source tree, prompt assets, strict schemas, dependency/configuration files, the pinned font and its license, runtime metadata, and optional Git commit/dirty status. The archive is a local artifact under ignored `data/` paths; it is never committed or uploaded by the command.

## What is archived

The allowlist is explicit and deterministic:

| Category | Paths |
| --- | --- |
| `source` | Every regular file under `src/` except `src/ai/prompts/`, plus every regular file under `scripts/` |
| `prompt` | Every regular file under `src/ai/prompts/`; the seven required v1 assets are checked for presence |
| `config` | `.nvmrc`, `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.mjs`, `vitest.config.ts`, `playwright.config.ts` |
| `font` | `assets/fonts/DejaVuSans.ttf` |
| `license` | `assets/fonts/LICENSE.txt` |
| `schema` | A generated `schemas.json` containing the strict JSON Schema for all ten family specs, their envelopes, wording, blind review, and alignment review |
| `runtime` | Node version, platform, architecture, npm version when available, and lockfile version |
| `git` | Optional `HEAD` commit and dirty status; `null` when Git is unavailable |

The manifest stores each file's repository-relative POSIX path, category, SHA-256, and byte length. It also stores:

- `sourceHash` over all `source` file entries
- `promptHashes` keyed by the established role/family convention: `spec:<family>`, `wording`, `blind_text`, `blind_vision`, `alignment_text`, and `alignment_vision`
- `schemaHashes` keyed by the same role/family convention; the full 23-entry strict schema bundle remains in `schemas.json`
- `configHash` over all `config` file entries
- `promptBundleHash`, `schemaBundleHash`, `fontHash`, `licenseHash`, `lockfileHash`
- A `configuration` projection (`sourceHash`, `promptHashes`, `schemaHashes`, `configHash`) printed by `--archive-provenance` for the freeze bundle
- `archiveHash` over the content snapshot (files, schemas, and the hashes above; excluding `createdAt`, `runtime`, `git`, and `archiveHash` itself)
- `createdAt`, `runtime`, and optional `git`

The archive directory contains:

```text
<archive>/
  manifest.json
  schemas.json
  files/
    .nvmrc
    package.json
    ...
    src/...
    assets/fonts/DejaVuSans.ttf
    assets/fonts/LICENSE.txt
```

`schemas.json` is canonical JSON of the generated schema bundle. Every archived file is verified against its manifest hash and byte length when read. Archive writes use a temporary sibling directory and an atomic rename; an existing archive with a different `archiveHash` is rejected instead of overwritten.

## Commands

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24.22.2
cd /home/alex/ai-puzzle-factory

# Write a verified provenance archive (no evidence bundle or database needed).
npm run --silent freeze -- --archive-provenance data/provenance

# Verify the archive against the current source tree.
npm run --silent freeze -- --verify-provenance data/provenance

# Use the verified archive as the freeze provenance provider.
npm run --silent freeze -- --evidence <bundle.json> --provenance data/provenance
```

`--source-root <dir>` selects a different file-inventory tree for archive, verification, or freeze. The default is the current working directory. The role/family `promptHashes`, `schemaHashes`, and `schemas.json` are always derived from the running implementation's prompt/schema modules, not from `--source-root`; use the repository root for a real archive. `--archive-provenance`, `--verify-provenance`, and `--provenance` are mutually exclusive with each other where the command would be ambiguous; archive/verify modes do not read an evidence bundle or open the database.

When `--provenance` is used, the command re-hashes the current source tree before evaluating the freeze. A missing, modified, or extra allowlisted file, a symlink, a changed prompt/schema/config/font/lockfile hash, or an invalid archive stops the freeze with the verification failure list. When `--provenance` is omitted, the CLI reports that provenance came from the evidence bundle and should be replaced with a verified archive before a real freeze.

**Freeze bundle contract.** `configuration.sourceHash`, `configuration.configHash`, `configuration.promptHashes`, and `configuration.schemaHashes` must equal the `configuration` projection printed by `--archive-provenance` (and stored in the manifest). The prompt/schema maps use the same role/family keys as the prompt metadata functions, not prompt file paths or raw schema names. The P44 tests assert this equality against the metadata functions and assert that a path-keyed/raw-schema-name map is rejected with `PROVENANCE_MISMATCH`. P48/P49 evidence producers must build their bundle configuration from the archive projection rather than inventing a second key convention.

## Security boundary

- `.env`, `.env.*`, `.git`, `node_modules`, `data`, `dist`, `coverage`, `test-results`, and `playwright-report` path segments are rejected wherever they appear in the allowlist. The archive never reads environment variables as file content.
- Symbolic links in the source tree or archive path are rejected; symlinked directories are not followed.
- Archive paths are validated as relative POSIX paths without empty, `.`, `..`, absolute, drive-letter, backslash, or NUL segments. The resolved path must remain under the archive root. Reads use `O_NOFOLLOW` plus an opened-descriptor path check, and archive reads enumerate `files/` so extra unlisted files are rejected, not silently accepted.
- Callers may pass secret canaries (the CLI passes `OPENROUTER_API_KEY` when set); if a canary appears in an allowlisted file, the snapshot is rejected without echoing the secret.
- The command performs no Git write operation, no commit, no network request, and no model call. A dirty working tree is supported and recorded as `git.dirty=true`; replay identity comes from the copied files and hashes, not from a clean commit.
- Exports drop sensitive object keys (`Authorization`, `api_key`, `apikey`, `openrouter_api_key`, `x-api-key`) and redact credential-shaped strings before writing HTML, CSV, JSONL, puzzle JSON, and manifest JSON. SVG and PNG artifacts are scanned for credential-shaped text and the export is refused with `UNSAFE_ARTIFACT` rather than copying a suspected secret. All image artifacts for a report are validated before any image is written, so an unsafe SVG cannot leave a paired PNG behind. PNG pixel content is not inspectable by byte-pattern scanning; the SVG/source-text gate is the effective visual-content check.

## Deterministic replay

The archive plus SQLite run evidence identifies the exact local implementation and the stored model responses. Local replay uses the saved raw response artifact through `replaySavedResponse`; it does not call the provider again and returns the same content, parsed content, usage, and cost classification. This is replay of stored evidence, not a promise that a future remote generation with the same prompt would return identical text.

To reproduce locally:

1. Keep the provenance archive and the run database/artifacts together.
2. Verify the archive with `--verify-provenance` before replay.
3. Use the existing `--resume <run-id> --mock` path to reuse saved responses without a new request.
4. Compare the replayed response content and hashes with the stored request/attempt rows; the primary run, slot, stage, and artifact rows must remain unchanged.

## Full offline release (P45)

P45 completes the full 200-slot synthetic release path. `npm run experiment -- --full --mock --seed puzzle-poc-v1 --max-cost 0` uses the deterministic mock transport, the real plan/barrier/preparation/review/verdict/ledger pipeline, and the real report/export surfaces. The report is always labeled `MOCK DATA`; it is not live evidence and cannot produce a business proceed. The full run currently reaches 200/200 terminal slots with 148 approved, 18 rejected, 34 inconclusive, 0 generation errors, 644 calls/attempts, and a 145-unique/18-structural-duplicate/34-near-suspected barrier. Concurrency 1 and 2 produce identical stable content apart from generated call/attempt UUIDs. Full mock resume is supported for a cancelled run and must finish at 200 terminal slots without duplicate terminal rows.

Two arithmetic release defects were found by the full run and fixed: a two-constraint construction no longer calls the two-constraint solver on a one-constraint nonredundancy subset, and canonicalization uses an internal solver that accepts reduced one-clue subsets. The focused regression lives in `tests/families/arithmetic.test.ts`; the full release test lives in `tests/experiment/full-mock.test.ts`.

Live full execution remains authorization-gated: `--live` requires `--allow-paid`; `--full --live` additionally requires a 64-hex `--protocol` hash. P45 validates the gate but does not start paid calls; P51 executes the frozen protocol.

## P44 manual acceptance

Run the exact script below. It uses the repository's existing synthetic tests rather than a full paid run.

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
```

Expected:

- Focused provenance/security tests pass.
- Archive and verify commands print `"ok": true`.
- `manifest.json` has 64-hex `archiveHash`, `sourceHash`, `configHash`, `promptBundleHash`, `schemaBundleHash`, `fontHash`, `licenseHash`, and `lockfileHash`; `promptHashes`/`schemaHashes` use role/family keys.
- The archive contains prompt and font copies and no `.env`.
- `npm run check` ends with a successful build and all tests passing.
- No network, provider, paid, Git-write, or live model operation occurs.

The focused tests are the exact non-UI proof for missing/modified/extra/symlink files, secret canaries, archive path traversal and tampering, dirty snapshots, code/hash drift rejection, credential-redacted HTML/CSV/JSONL/SVG exports, the public/reveal boundary, replay identity, and unchanged primary run/stage/artifact rows.

## P45 manual acceptance and fresh-copy reproduction

Run the exact script below from the repository root. It creates a full synthetic run in the default `data/experiment.sqlite`, then opens the report/export surfaces.

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

Expected: the focused full-mock/arithmetic tests pass; the run prints `status completed`, `slots 200/200 terminal`, `generation_error=0`, `unknown=0`, and `cost status=known actual=0`; the report/export contain 200 puzzle files and 200 HTML cards; the summary says `planned: 200`, `terminal: 200`, `evidenceKind: "mock"`, `runKind: "full"`; `npm run check` passes with the full suite and build; `npm run test:browser` passes. Missing native/browser setup or a skipped test is a failed/unverified gate, not a pass.

Fresh-copy reproduction without `.env`:

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

The fresh copy must reproduce the same focused/full/browser results without reading the original `data/`, `.env`, or Git state. `npm ci` needs registry access unless the npm cache is populated; the Chromium install is the documented native/browser tooling step. A missing dependency or skipped test means the reproduction is unverified, not accepted.

## Out of scope

P45 does not prove paid compatibility or live success. Acceptance is offline-verified and live-unverified, not a business proceed. P46/P48/P49 supply live preflight, calibration, and smoke evidence; P50 combines provenance with the frozen protocol; P51 executes live full.
