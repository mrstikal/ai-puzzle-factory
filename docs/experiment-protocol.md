# Experiment Protocol

Protocol version: **1.0.0**. Status: P01-P25 implemented and offline-verified; no live provider call, report, gallery, or live evidence exists yet.

This document records the deterministic planning contract and the fixed experiment gates that later phases must consume. The normative source remains [AI_PUZZLE_FACTORY_EXPERIMENT_PLAN.md](../AI_PUZZLE_FACTORY_EXPERIMENT_PLAN.md); if this summary diverges from the plan, the plan wins.

## 1. Families, modalities, and lanes

| Order | Family | Modality | Slots per family |
| ---: | --- | --- | ---: |
| 1 | `ranking` | text | 20 |
| 2 | `matching` | text | 20 |
| 3 | `scheduling` | text | 20 |
| 4 | `truth` | text | 20 |
| 5 | `arithmetic` | text | 20 |
| 6 | `matrix` | svg | 20 |
| 7 | `transforms` | svg | 20 |
| 8 | `paths` | svg | 20 |
| 9 | `symmetry` | svg | 20 |
| 10 | `counting` | svg | 20 |

Lanes are `spec_first` and `ai_spec`. The full cohort has 200 slots: 100 text, 100 svg, 120 `spec_first`, 80 `ai_spec`. Text families split 10/10 per lane; SVG families split 14/6.

## 2. Difficulty allocation

Difficulty is a generation target (`1`, `2`, `3`), not a validated psychometric score. Tuples are built first, then seed-shuffled within each family so a lane is not correlated with a single difficulty.

| Modality | Lane | Difficulty counts `(1,2,3)` |
| --- | --- | --- |
| text | `spec_first` | `(4,3,3)` |
| text | `ai_spec` | `(3,4,3)` |
| svg | `spec_first` | `(5,5,4)` |
| svg | `ai_spec` | `(2,2,2)` |

Every family therefore has difficulty totals `(7,7,6)`, and both lanes cover every difficulty.

## 3. Seeds, slot IDs, and ordering

- Full root seed: `puzzle-poc-v1`.
- Smoke root seed: `puzzle-smoke-v1`.
- Calibration construction seed (reserved for later phases): `puzzle-calibration-v1`.
- Slot IDs are stable: `<modality>-<family>-<NN>`, for example `text-ranking-01` or `svg-counting-20`.
- Full `slotOrdinal` is `1..200`; slots are grouped in family order above, with 20 per family.
- Smoke has exactly 20 slots: one `spec_first` and one `ai_spec` per family, 10 text and 10 svg. Its 50/50 SVG lane split is a coverage test, not the main cohort's 70/30 estimate.
- Smoke difficulty uses the zero-based family ordinal: `spec_first = (ordinal mod 3) + 1`, `ai_spec = next difficulty`, where next means `1 -> 2`, `2 -> 3`, `3 -> 1`.

`--seed` may only restate the fixed root seed for the selected run kind. Any other value, including the reserved `puzzle-calibration-v1` seed, is rejected for full and smoke plans. The shared `PlanManifestSchema` enforces the same rule, so a manifest loaded or reconstructed outside the builder cannot bypass it. Calibration construction uses a separate future run kind and must remain disjoint from smoke/full streams.

## 4. Random streams and PRNG

Independent streams are derived as:

```text
sha256(JSON.stringify([protocolVersion, rootSeed, slotId, purpose]))
```

Allowed purposes are `plan`, `spec`, `options`, and `layout`. The plan shuffle uses `purpose = "plan"` with the family name as the stream `slotId`.

`HashCounterPrng` uses a hash-counter construction:

```text
block_n = sha256(seed_bytes || uint64_be(n))
nextUint32() = first 4 bytes of block_n, big-endian
```

`nextInt(maxExclusive)` uses rejection sampling: `limit = floor(2^32 / maxExclusive) * maxExclusive`; draw `nextUint32()` until it is below `limit`; return `value % maxExclusive`. Bounds must be integers in `1..2^32`. `shuffle` is Fisher-Yates from the end using `nextInt`.

There is no `Math.random()`, no shared asynchronous RNG, and no implicit consumption order across workers. Golden vectors for the seed, `nextUint32`, `nextInt(6)`, and the 0-9 shuffle are locked in `tests/experiment/planner.test.ts`.

## 5. PlanManifest

The deterministic `PlanManifest` contains:

- `protocolVersion` (`1.0.0`), `runKind` (`full` or `smoke`), and `rootSeed`;
- all slots (`slotId`, `slotOrdinal`, `family`, `modality`, `lane`, `difficulty`);
- quotas and per-family/lane difficulty counts;
- request estimates by role and `maxTransportAttempts`;
- `planHash`, the SHA-256 of canonical JSON with sorted object keys and the `planHash` field excluded; the schema recomputes and verifies it.

`--dry-run` prints this manifest only. It performs no generation, database write, model call, image rendering, filesystem write, or network access, and requires no model configuration or API key. Repeating the same run kind and seed yields byte-identical output and the same hash.

Request ceilings assume every slot reaches every role (no early failures):

| Run kind | spec | wording | blind_text | blind_vision | alignment_text | alignment_vision | Total logical | Max transport |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| full | 80 | 200 | 100 | 100 | 100 | 100 | 680 | 2040 |
| smoke | 10 | 20 | 10 | 10 | 10 | 10 | 70 | 210 |

`maxTransportAttempts = 3 × logical calls` (one initial attempt plus at most two certified unprocessed retries). These are ceilings, not promises of observed success.

## 6. RunManifest

`RunManifest` extends the plan with evidence kind (`mock` or `live`), run UUID, role/model/provider configuration, output limits (8192 tokens for spec and wording, 4096 per review), concurrency `1` or `2`, budget and price-snapshot hash, prompt/schema/source/font/dependency-lock hashes, runtime versions, fixed thresholds, calibration reference, explicit synthetic mock configuration, `redacted: true`, creation time, and `manifestHash` over the entire redacted manifest. `computeRunManifestHash` canonicalizes the manifest with `manifestHash` excluded, and the schema recomputes and verifies the field.

Invariants enforced by the schema:

- the text reviewer model must differ from the generator model;
- the vision reviewer model must differ from the generator model (it may equal the text reviewer);
- mock evidence must carry `mockConfiguration.synthetic = true`; live evidence must not carry a mock configuration;
- no API key, authorization header, environment dump, or raw secret may appear in a manifest, export, or artifact.

## 7. Fixed thresholds and decision gates

These values are frozen for this protocol version. Changing a threshold after primary observation creates a new protocol version, not a more favorable conclusion for the current run.

| Gate | Value |
| --- | --- |
| Planned cohort denominator | 200 slots (100 text, 100 SVG, 20 per family) |
| Text approval floor | at least 80/100 |
| SVG approval floor | at least 80/100 |
| Per-family approval floor | at least 10/20 |
| Structural uniqueness | at least 95% |
| Fingerprint coverage | at least 80% |
| Primary cost per approved puzzle | at most USD 0.10 |
| Default main-run budget cap | USD 10 unless separately authorized |
| Calibration sensitivity | at least 90% (at least 9/10) per modality/role |
| Calibration specificity | at least 80% (at least 8/10) per modality/role |
| Human audit core slots | at least 32 inspectable |
| Human audit approved core slots | at least 20, at least 2 per family |
| Audited approvals clear and solved within 180 s | at least 80% of inspectable audited approvals |
| Reject gate | modality approval below 50%, calibration sensitivity or specificity below 50%, or a repeatable audited correctness defect in at least two approved candidates of one family |
| Approved high-risk near-duplicate flag | not allowed for `proceed` |

Approval metrics always use the planned denominator. Incomplete runs, paused slots, and failures are reported, never silently dropped.

## 8. No-replacement and no-remediation rule

- The primary cohort is exactly 200 preallocated slots: 100 text and 100 deterministic SVG, 20 per family.
- Each slot has one immutable first version. There is no paid or content repair, no automatic regeneration, and no slot replacement or refill.
- Infrastructure retries and internal constructive search are logged separately; they are not replacement candidates.
- Failed, duplicate, uncertain, unstarted, or paused slots remain in the cohort and in the planned denominator. An unstarted or paused slot is not `generation_error`.
- Remediation is deliberately deferred: this protocol reports `eventually_approved_rate = null` and `remediation_cost = 0`. It does not fabricate a remediation success rate.
- A later human discovery may block `proceed`; it cannot rewrite first-attempt approval statistics.

## 9. Stage, verdict, and run-control enums

Workflow stages: `planned -> spec_ready -> formal_checked -> presentation_ready -> duplicate_checked -> blind_reviewed -> alignment_reviewed -> terminal`.

Primary candidate verdicts: `approved`, `rejected`, `inconclusive`, `generation_error`. Run control states are separate: `running`, `paused_budget`, `paused_operator`, `interrupted`, `completed`, `failed`.

Failure records carry a code, stage, severity (`low`, `medium`, `high`, `critical`), evidence source (`deterministic`, `model`, `human`, `infrastructure`), and bounded evidence text. Candidate envelopes require a verdict exactly at `terminal`; stage-result envelopes require `finishedAt` and `elapsedMs` to be either both present or both absent.

## 10. P02 boundaries

Implemented in P02: strict shared plan/candidate/run schemas, deterministic full and smoke planning, SHA-256 stream derivation and hash-counter PRNG, `--dry-run`, and this protocol summary.

Not implemented in P02: calibration and preflight manifests (reserved for P40/P25), prompt/schema hashing, RunManifest construction or storage, persistence, provider calls, live execution, rendering, reports, and any paid behavior. `--live` is rejected explicitly.

## 11. Storage contract (P03)

- Database: `data/experiment.sqlite`, opened with WAL, `foreign_keys = ON`, `busy_timeout = 5000`, and `synchronous = NORMAL`. Migrations live in `src/storage/migrations/` and are applied once through `schema_migrations`; applying them twice is a no-op.
- Core tables: `runs`, `slots`, `stage_results`, `artifacts`, `stage_artifacts` (the stage-to-artifact link), and `events`. Request/budget tables (`logical_calls`, `request_attempts`, `budget_events`) arrive in P23; `human_labels` in P42; `protocol_freezes` in P43.
- Unique keys: `(run_id, slot_id)`, `(run_id, slot_ordinal)`, `(run_id, slot_id, stage, version=1)`, and `(content_hash, kind)` for artifacts. Stage results are immutable: update and delete triggers abort.
- A run is created atomically with its full slot plan and a `run_created` event. The stored manifest is canonical JSON; its hash must equal the plan hash and the stored protocol/run-kind/root-seed columns.
- A stage commit inserts the stage result, its artifacts, the stage-artifact links, the advanced slot checkpoint, and a `stage_committed` event in one transaction. `started_at`, `finished_at`, and `elapsed_ms` are persisted; incomplete durations are null. A terminal stage requires a verdict; a non-terminal stage cannot carry one.
- Artifacts are content-addressed by SHA-256 and bounded: JSON/raw response/request body/presentation 2 MiB, SVG 256 KiB, PNG 1 MiB. Reads verify the stored hash and byte length.
- One writer at a time: `proper-lockfile` on the database file with a 30-second stale timeout and 10-second update. A competing writer receives `WRITER_LOCKED`.
- Export paths are resolved only beneath `data/runs/<run-id>/`; absolute paths, traversal, drive letters, backslashes, empty segments, and symbolic links (including dangling links and symlinked parent components) are rejected. Exports themselves remain a later phase.
- P03 does not add request/budget tables, paid calls, runner resume, JSON-as-database, or report UI.

## 12. Novelty and duplicate barrier (P21)

P21 is a pure validation layer. It consumes a fully prepared cohort, computes immutable candidate assessments, and emits deterministic pair evidence. It does not generate, review, replace, or repair candidates.

### Fingerprint values

Keep four distinct values per candidate:

- `contentHash`: SHA-256 over the strict visible projection `{question, rules, clues, options, hint, explanation}`. Option labels A-D and their order are visible and included.
- `specHash`: SHA-256 over canonical JSON of the complete parsed DSL. It preserves stored clue order and stable IDs; it is not the structural fingerprint.
- `structureHash`: SHA-256 over the family `canonicalData` `CanonicalStructure`. Clue-based families use their already reduced canonical core; visual families use their normalized operations/geometry.
- `renderHashes`: separate SVG and PNG SHA-256 values for visual candidates; both are null for text.

The P04 feature multiset is extracted from the canonical structure with `q:`, `r:`, and `g:` prefixes. Raw JSON/text hashes are never called structural fingerprints.

### Eligibility and completeness

The barrier accepts every planned slot plus one candidate record per slot. It refuses to run unless every planned slot has a preparation result. `ready` means formal and presentation checks passed; `early_failure` preserves an existing terminal verdict; `incomplete` covers budget/operator pauses and is not completion. Missing or `incomplete` slots raise `INCOMPLETE_PREPARATION`. Failed or incomplete presentations cannot own or suppress a usable candidate, and terminal failures are never rewritten. Formal-passed early failures may still contribute diagnostic pair evidence.

### Exact, spec, and structural groups

Groups are family-scoped across both lanes:

- exact content duplicate: same `contentHash`; for visual candidates the same PNG render hash is also required.
- canonical spec duplicate: same `specHash`;
- structural duplicate: same `structureHash`.

Processing is sequential: exact content first, then canonical spec, then structural. In each group the lowest eligible slot ordinal owns the group; later eligible members are rejected. Exact and canonical-spec duplicates record `EXACT_DUPLICATE`; structural duplicates record `STRUCTURAL_DUPLICATE`. A rejected candidate does not become an owner in a later stage. Exact rendered content across visual families is a separate PNG-hash diagnostic and never changes ownership.

### Near policy

Near comparison is allowed only within the same `(family, domainTokens, queryKind)`. With unequal structure hashes, at least one common feature, and multiset `editDistance = max(removed, added) = 1`, both eligible members are flagged `NEAR_DUPLICATE_SUSPECTED` and first-pass approval is blocked. Unit-weight multiset Jaccard is recorded as a diagnostic, not a gate. The mandatory counting positive (`k=2` versus `k=3`) has edit distance 1 and Jaccard 33/35. Empty features and unequal hashes over identical complete canonical data are implementation errors.

Near suspicion is conservative, not a duplicate proof. Both members still receive reviews in later phases; the primary outcome remains inconclusive. Diagnostic pairs involving early failures are retained without changing their terminal verdicts. The barrier does not claim complete semantic novelty, and the reduced-core proxy does not detect all logically equivalent clue sets.

### Output

The result is a canonical, frozen `DuplicateBarrierResult`:

- one assessment per planned slot with eligibility, fingerprintable flag, group-owner flag, outcome, owner slot, duplicate kind, near-pair slot IDs, failure codes, preserved terminal verdict, and the candidate's content/spec/structure/render hashes plus canonical structure and feature multiset;
- pair evidence with kind, ordered slot IDs, family, eligibility, diagnostic flag, comparison metrics for near pairs, and bounded evidence text;
- summary counts for planned/prepared/ready/early, eligible/fingerprintable/ineligible, groups, duplicate kinds, near pairs, diagnostic pairs, visual exact diagnostics, zero replacements, and zero rewritten terminal failures;
- `resultHash` over the canonical result with the hash field excluded.

Tests: `npm exec vitest run tests/validation/duplicates.test.ts`; full gate: `npm run check`.

## 13. Visible presentation assembly (P22)

P22 defines the deterministic boundary between what a solver sees and what only the report/reveal may show.

### Wording schema

The wording response is strict and all fields are required:

```json
{
  "question": "string, 1..400 characters",
  "clueTexts": [{"factId": "fNNN", "text": "string, 1..200 characters"}],
  "hint": "string, 1..300 characters",
  "explanationSteps": [{"factIds": ["fNNN|pNNN|sNNN|r-..."], "text": "string, 1..240 characters"}]
}
```

`clueTexts` has at most 12 entries; `explanationSteps` has at most 8. Text is stored exactly as supplied, including HTML/script-like strings; it is data, not markup. Blank-only strings are rejected.

### Code-owned rules and options

`VisibleRules` (`domain`, `closedWorld`, `target`, `operations`, `conventions`) always come from the family engine, never from model prose. Option values and A-D labels come from the code-owned `ChoiceSet`; the wording response cannot alter them. Option text is code-owned:

- ranking: complete label order;
- matching: A-to-B/C table;
- scheduling: event-to-slot/resource table;
- truth: `P1=T`-style vector;
- arithmetic: `(x, y, z) = ...`;
- matrix, transforms, paths, symmetry: `See labeled tile A/B/C/D`;
- counting: the actual integer.

### Field and fact coverage

- Text: `clueTexts` must reference every local `fNNN` fact exactly once. Domain/global `r-*` rules are a separate code-owned block and cannot replace clue facts.
- SVG: `clueTexts` must be empty. The diagram holds `pNNN` observations and the rules hold the operations/query.
- Explanation references may use the full merged inventory: five rule facts, local or observation facts, and derived `sNNN` proof facts. Unknown IDs are rejected.
- Missing, extra, duplicate, or non-local clue facts are rejected. Option labels must be A-D in order, exactly one option must satisfy the independent checker, and the stored `correctLabel` must name it.

### Public/reveal boundary

`VisiblePresentation` contains only `version`, `slotId`, `family`, `modality`, `question`, `rules`, `clues`, `options`, and `assets` (`svgHash`/`pngHash`). It contains no key, hint, explanation, or proof. `RevealData` separately contains `correctLabel`, `correctValue`, `hint`, `explanationSteps`, and the solve proof. SVG presentations require both stored SVG and PNG hashes; text presentations require both to be null.

### Mechanical status and semantic pending

The assembly result records mechanical checks as `pass` and always sets `semanticAlignment` to `semantic_alignment_pending`. P22 has no English parser: a paraphrase with correct fact IDs, a same-ID contradiction, and possible answer leakage are retained as supplied and remain pending for the later informed alignment role. P22 never silently repairs, truncates, or substitutes wording, and never claims semantic truth.

### Fixture wording

`makeFixtureWording` is deterministic and labels its output `source: "fixture"`. It is only for tests and previews. Model wording uses `source: "model"` and follows the same assembly checks.

### Tests and commands

`npm exec -- vitest run tests/presentation/assemble.test.ts` covers all ten families, missing/extra/duplicate facts, unknown proof references, length bounds, wrong ordered choices, malformed choice sets, invalid specs, typed re-validation, HTML/script strings retained verbatim, missing SVG assets, slot mismatches, fixture determinism, proof references, and a same-ID contradiction that stays pending. Full gate: `npm run check`.

Out of scope: model calls, prompt construction, raw-response persistence, semantic alignment review, and the HTML gallery.

## 14. Request ledger and budget admission (P23)

P23 is durable accounting without HTTP. It implements the section 8 logical-call/attempt state machines and transactional budget admission; fetch, retry timing, live price lookup, and automatic resume remain out of scope.

### Ledger tables and keys

- `logical_calls` stores one intent per `(run, slot, role)` or per probe key/role. Partial unique indexes enforce slot calls, run-scoped probes, and global calibration/preflight probes while allowing nullable slot/probe columns.
- `request_attempts` stores one to three attempts per logical call, each with request hash/body, expected schema hash, role/model/provider, HTTP/generation/response IDs, raw-response artifact reference, finish reason, nullable token fields, price estimate, actual cost, cost status, error classification, partial-completion flag, UTC times, and monotonic elapsed latency.
- `request_events` is append-only and records call/attempt creation, state transitions, validation, refusal, uncertainty, and usage reconciliation.
- Request bodies are canonical JSON stored without credentials. Text JSON excluding embedded base64 is capped at 64 KiB; an embedded PNG data URL is capped at 1 MiB decoded; the stored body is capped at 2 MiB. A supplied request hash must match the canonical body; retries reuse the same bytes. Only PNG data URLs are accepted.

### Logical-call and attempt states

`prepared -> dispatching -> response_saved -> validated`, with terminal alternatives `refused_unprocessed`, `failed_known`, and `uncertain`. `dispatching` is persisted before fetch. A prepared call may be sent on resume; a dispatching call without a saved response is classified `uncertain_no_resend` and is never silently resent. Saved responses and validated outputs are reused.

A refusal is certified unprocessed only for HTTP 429 or HTTP 503 with `no_eligible_provider`, no generation ID, no usage fields, no actual cost, and no partial completion. All other timeouts, disconnects, generic 5xx, HTTP-200 error bodies, provider errors, partial output, and malformed success bodies are not safely unprocessed. Attempt count is capped at three; retry timing belongs to P24.

### Decimal money and admission

- Money is stored and compared as canonical decimal strings via `decimal.js` 10.6.0. No floating-point arithmetic is used. `0.1 + 0.2` is exactly `0.3`.
- Admission is one immediate SQLite write transaction: `known_actual + reserved + next_reservation <= maxCost`. Every potentially billed attempt needs an active reservation before dispatch; nonbilling reservations must be explicitly zero.
- A zero-budget account admits no call unless the caller sets `nonBilling: true`. Pools are separate: primary (full), smoke, calibration, and preflight. Accounts are unique per run/pool or per global pool.
- `usage.cost = 0` is a known zero when explicitly supplied; an absent actual cost is `unknown`, keeps the reservation, and increases `unknownExposureUsd`. Unknown exposure remains visible in account and role/run-kind summaries.
- Actual cost above the reservation records an `overshoot` event and blocks new admissions. Any admission that would cross the cap records a `pause` event, sets a run to `paused_budget`, and returns `INSUFFICIENT_BUDGET`; later nonbilling calls are the only exception. An unknown reservation does not itself block later slots when the remaining reserved budget still fits.
- Certified unprocessed refusals release their reservation and reduce any unknown exposure. Settling a reservation with an actual cost releases its reservation, adds the actual to known spending, and keeps overshoot evidence.
- Raising a cap requires explicit acknowledgement plus an operator identity. The `cap_change` budget event stores old/new cap, time, operator, and acknowledgement. P23 does not automatically resume a paused run; automatic resume is out of scope.

### Append-only evidence

`budget_events` records account creation, admission/nonbilling admission, reservation creation/release/settlement, unknown exposure, overshoot, pause, and cap change. Update/delete triggers abort. Logical calls, attempts, reservations, and accounts cannot be deleted. Summary output groups known, reserved, and unknown exposure by role and run kind.

### Tests and commands

`npm exec -- vitest run tests/ai/budget.test.ts` covers unique slot/probe keys, prepared/dispatching crash dispositions, three-attempt cap, request body limits/hashes, exact decimal money, cross-process overlapping admission, explicit zero versus missing cost, actual overshoot, unknown retention/release, insufficient-budget pause, calibration/primary separation, zero-budget nonbilling, duplicate reservations, append-only triggers, and acknowledged cap changes. Full gate: `npm run check`.

Out of scope: fetch, retry scheduling, live price estimation, automatic resume, provider fallback, and any claim of exactly-once billing.

## 15. OpenRouter transport and conservative retry policy (P24)

P24 is a locally tested transport, not a paid live call. The production host is fixed to `https://openrouter.ai/api/v1`; a custom base URL is accepted only for loopback fake servers. The clock, random source, and fetch implementation are injectable for tests.

### Request and response bounds

- The request is the stored logical-call body. It must be non-streaming (`stream: false`), use `json_schema` response format, name exactly one provider route with no fallbacks, and send exactly one of `max_tokens`/`max_completion_tokens`.
- The stored request body is revalidated by the P23 split bounds: 64 KiB text excluding base64, 1 MiB decoded PNG, 2 MiB stored. Only PNG data URLs are accepted.
- The default request deadline is 90 seconds. The default response cap is 2 MiB. Oversized responses are truncated for evidence and classified uncertain.
- A supplied request hash must match the canonical body. Every retry reuses the same attempt bytes.

### Persistence and redaction

- The raw response is stored as a `raw_response` artifact before JSON parsing or content validation. Parsing extracts fields defensively so a malformed unrelated nested field does not discard a generation ID, content, or cost.
- The API key is never stored. Raw response text and error messages are redacted before persistence or reporting; request headers are not stored.
- HTTP status, generation ID, finish reason, usage tokens, actual cost, error classification, and raw-response artifact ID are written to the P23 attempt.

### Outcome classes

- `success`: HTTP 200, no top-level or choice error, finish reason `stop`, nonempty content, and valid JSON.
- `refused_unprocessed`: HTTP 429 or HTTP 503 with no eligible provider, no generation ID, no usage, no actual cost, and no partial completion. The reservation is released and a retry may be allowed.
- `failed_known`: auth/payment/forbidden responses, non-JSON or invalid-JSON content, refusal/content-filter, reasoning-only, length truncation, missing content, invalid finish reason, and malformed bodies. The actual charge is settled when present; otherwise the reservation remains unknown. No retry.
- `uncertain`: timeouts, disconnects, generic 5xx, HTTP-200 error bodies, provider errors after a generation ID, a 429 with generation/usage/partial output, and oversized responses. The reservation remains unknown and no retry occurs.
- `paused_budget`: no reservation was admitted; the prepared attempt may be resumed later.
- `paused_retry_after`: a certified refusal returned Retry-After above 30 seconds; the refusal is recorded and the run must pause rather than shorten the wait.
- `already_dispatching`: a dispatching attempt has no saved response and must not be silently resent.

### Retry policy

Only certified unprocessed refusals are retried, at most two additional attempts (three total). The first retry waits 500 ms plus 0–250 ms seeded jitter; the second waits 1000 ms plus jitter. A valid Retry-After up to 30 seconds replaces the computed delay; above 30 seconds the transport pauses. Timeouts, disconnects, generic 5xx, HTTP-200 error bodies, provider errors, refusals, malformed output, and auth/payment failures are never retried automatically.

### Generation reconciliation

A bounded read-only `GET /generation?id=...` lookup may update a missing actual cost and token usage for an attempt with a generation ID. It updates the P23 ledger and settles the matching reservation when one is still reserved/unknown. It never replays or regenerates content.

### Tests and commands

`npm exec -- vitest run tests/ai/openrouter.test.ts` uses a loopback fake server and covers 429/no-provider 503, short and long Retry-After, 401/402/403, 500/502, HTTP-200 error bodies, provider errors after generation IDs, 429 with generation/usage, timeouts, disconnects, content refusal, reasoning-only/length output, malformed and non-JSON content, missing cost, oversized responses, a saved usable response, identical retry hashes, the three-attempt cap, no hidden retries, invalid request shapes, generation reconciliation, and credential absence from the database. Full gate: `npm run check`.

Out of scope: paid requests, provider fallback, JSON repair, model selection, automatic resume, and any live network evidence.

## 16. Strict role schemas and offline preflight (P25)

P25 defines the provider-facing schemas and validates an exact route before any live call. It does not select a model, contact OpenRouter, or execute a paid probe.

### Strict JSON Schema

- `src/ai/schemas.ts` compiles every family spec, a family envelope, wording, blind review, and alignment review from Zod with `z.toJSONSchema` and normalizes the result for provider strict mode.
- Normalization removes `$schema`, rewrites `definitions`/`$ref` to `$defs`, converts `oneOf` to `anyOf`, converts `const` to a single-value `enum`, rewrites tuple `items` to an `anyOf` array with fixed `minItems`/`maxItems`, and rejects unsupported keywords.
- Every object schema has `additionalProperties: false`; every declared property must be listed in `required`. Conditional fields are modeled as explicit discriminated-union branches rather than optional properties.
- Schema hashes cover the full `{name, strict, schema}` response-format object.
- Blind review returns `answerStatus`, nullable `chosenOption`, bounded reasoning, clarity, ambiguity, confidence, visual legibility, and bounded issue evidence. A selected answer requires a non-null option; any other status requires null.
- Alignment review returns `pass|fail|uncertain|not_applicable` per field plus cited fact IDs and reasons. Code derives the overall status from fields; the model-reported `overall` is never authoritative. `not_applicable` is valid only for the text family image field.

### Live inputs and request shape

- Required live inputs are `OPENROUTER_API_KEY`, `GENERATOR_MODEL`, `GENERATOR_PROVIDER`, `REVIEWER_MODEL`, `REVIEWER_PROVIDER`, `VISION_REVIEWER_MODEL`, and `VISION_REVIEWER_PROVIDER`. Every value is empty in `.env.example`; there is no default key or model.
- The generator model must differ from both reviewer models. The vision reviewer may reuse the text reviewer, and shared model/provider correlations are reported.
- The selected `outputCapField` is `max_tokens` when that exact endpoint advertises it, otherwise `max_completion_tokens`; otherwise the route is rejected. The serialized request contains exactly one cap field and never both or neither.
- Text roles cannot carry image parts; vision roles require a PNG data URL. Settings are absent by default and must be advertised by the exact endpoint when configured.
- Request limits remain 90 seconds, 2 MiB response, 64 KiB input text excluding base64, and 1 MiB PNG.

### Catalog resolution and route validation

- A recorded catalog fixture stores model-level `architecture.input_modalities`, endpoint `tag`, `provider_name`, `status`, context/output/prompt limits, `supported_parameters`, and pricing.
- Resolution requires exact tag equality and one active entry (`status === 0`). A base slug that only prefixes variant tags, a missing tag, or duplicate exact tags is rejected.
- `structured_outputs` and one cap field must be advertised by the entry. The requested cap must not exceed the entry's `max_completion_tokens`.
- The context must fit the output cap plus a conservative prompt reserve: 16,384 text tokens or 32,768 vision tokens. A declared `max_prompt_tokens` must also fit that reserve.
- Prompt and completion prices must be present non-negative decimal USD strings. Conditional `overrides` are unsupported offline. A vision route requires an image price or an explicit conservative per-role reserve.
- Image support comes from the enclosing model's `input_modalities`; a multimodal-sounding model name is never evidence. The PNG probe remains mandatory before live vision use.
- `GET /api/v1/models` and endpoint reads are public and use only the inference key when one is supplied. A 403 fails closed with no retry and no management credential.

### Paid gates

- Live probe construction requires explicit `allowPaid`, a positive `maxCostUsd`, a nonempty inference key, three separated resolved routes, and an actual PNG for the vision probe.
- The plan builds exactly three bounded probes: generator/spec, text reviewer/blind, and vision reviewer/blind. Execution creates `preflight` logical calls with `runKind: preflight` and a unique probe key.
- P25 exposes only `npm run preflight -- --offline`. The CLI rejects `--live` even with paid flags; P46 owns live execution and all-family smoke.

### Tests and commands

`npm exec -- vitest run tests/ai/preflight.test.ts` covers schema compilation and strictness, blind/alignment contracts, role separation, missing inputs, exact tag/base/duplicate/inactive failures, structured-output/cap/image/pricing/settings failures, cap serialization, 403 fail-closed behavior, offline no-network/no-key operation, and live probe authorization. Full gate: `npm run check`.

Out of scope: live catalog archiving, model selection, paid probes, all-family smoke, reports, and the gallery.
