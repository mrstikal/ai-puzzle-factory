# Implementation Progress

This file records implemented phases, exact verification commands, observed results, and manual acceptance evidence. It is not evidence of live or human-validated results.

## P01. Reproducible Offline Toolchain — 2026-11-03

**State:** implemented, offline-verified. No live or paid behavior exists in this phase.

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
