# Experiment Protocol

Protocol version: **1.0.0**. Status: P02 planning layer implemented and offline-verified; no puzzle generation, persistence, provider call, rendering, or live evidence exists yet.

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
