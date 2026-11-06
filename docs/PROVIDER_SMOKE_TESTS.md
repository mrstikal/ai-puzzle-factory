# Provider Smoke Tests

This file records actual provider compatibility evidence. Mock, offline, synthetic, or fixture results must never be entered here as live evidence.

## P46. Authorized Live Model/Route Compatibility Probes — 2026-11-06

**Status:** `LIVE-VERIFIED / ACCEPTED BY USER ON 2026-11-06`. The final preflight used Balanced routing with provider fallback enabled, no provider IDs, and three successful strict-schema probes. No management credential, model substitution, or key publication occurred.

**Authorization and operator confirmation**

- User-authorized cap: USD 0.50 total; authorization record: `data/p46-authorization.json`.
- Operator: `Lexa`.
- Confirmation: `providerSort:"default_balanced"`, `byokConfigured:false`, checked at `2026-11-06T19:07:31.000Z`.
- Final preflight ID: `1f717e0d-4a63-486b-b3a3-45f7d7338a2e`.
- Artifact: `data/preflight/1f717e0d-4a63-486b-b3a3-45f7d7338a2e/preflight.json`.
- Final run cap: USD 0.45 (remaining after earlier failed probe attempts); final run actual cost: **USD 0.0251434**.

**Live inputs**

- `GENERATOR_MODEL=openai/gpt-6.1-sol`
- `REVIEWER_MODEL=z-ai/glm-5.3`
- `VISION_REVIEWER_MODEL=qwen/qwen3.8-max-0902`
- Key supplied through `.env.local`; the key value is not recorded here.
- No provider ID or endpoint tag was configured.

**Final probe results**

| Probe | Requested model | Observed provider | HTTP | Strict schema | Vision interpreted | Actual cost | Generation ID |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `preflight:spec` | `openai/gpt-6.1-sol` | `OpenAI` | 200 | valid | n/a | USD 0.001852 | `gen-1793992054-ZLa4FE6gg4aTs8OVzKuP` |
| `preflight:blind_text` | `z-ai/glm-5.3` | `Mistral` | 200 | valid | n/a | USD 0.0187394 | `gen-1793992059-bsVPBmJrmiF46KjZXACA` |
| `preflight:blind_vision` | `qwen/qwen3.8-max-0902` | `Alibaba` | 200 | valid | `visualLegibility:"legible"` | USD 0.004552 | `gen-1793992088-iGQIg1sFMdXHDkrLO4RC` |

The vision response explicitly described the actual 64x64 PNG as a 2x2 grid of colored squares (red, blue, green, yellow) with no visible rule/labels, and returned `cannot_determine` with `visualLegibility:"legible"`. This proves the image reached the model; it does not claim the probe image contains a solvable puzzle.

**Balanced routing evidence**

- All three probes used `provider:{allow_fallbacks:true,require_parameters:true}` with no `sort`, `order`, `only`, or `ignore`.
- The observed providers (`OpenAI`, `Mistral`, `Alibaba`) are diagnostics only; they were not configured and are not pinned in the request.
- The request/model/routing policy and observed provider/model identity are stored separately in the preflight ledger and artifact.

**Attempts before the successful run**

The first attempts failed closed and were fixed without weakening the routing contract:

1. A 1x1 PNG was rejected by Alibaba (`height:1 or width:1 must be larger than 10`). Fixed by rendering a real 64x64 PNG.
2. The reasoning reviewer exhausted a 2048/4096 output cap (`finish_reason:"length"`). Fixed with role-specific probe caps (spec 2048, reviews 8192) and shorter reasoning instructions.
3. The spec prompt produced invalid item indices/self-relations. Fixed by specifying integer indices 0..3 and a valid chain.
4. The vision probe timed out at the standard 90-second request deadline; the successful retry completed normally. No request-limit invariant was changed.
5. A repeated invocation initially hit the global preflight account/call uniqueness constraint. The live CLI now scopes global probe keys by preflight ID (`preflight:<id>:<role>`), reuses the existing preflight budget account only when the requested cap exactly matches the stored cap, and rejects a cap mismatch with `PREFLIGHT_CAP_MISMATCH`. Earlier retries were isolated in fresh preflight databases; no old evidence was overwritten. The artifact records the enforced account cap, not merely the requested value. A post-success repeat against the same 0.45 database (`preflight:7db948d4-68a7-4f7b-828d-9346c68be9c5:*`) was accepted with unique keys and then paused all three probes with `paused_budget` before any paid call, proving cumulative account-cap enforcement rather than a reset per invocation. A global preflight account that has recorded a pause event has no in-place reset in P46; a later live preflight needs a fresh `--db`, and the operator must track cumulative authorization manually. The live stdout now includes the probe error code/message so the admission reason is visible.

**Cost accounting**

- Final successful run: USD 0.0251434.
- Known spend across all retries: USD 0.071628282.
- Earlier failed vision attempts left bounded unknown exposure in their isolated preflight databases; no actual cost was recorded for them. Total known spend plus bounded unknown exposure remains below the USD 0.50 authorization.
- No paid call was made after the final successful probe.

**Verification**

| Command | Result |
| --- | --- |
| `npm run preflight -- --live --allow-paid --max-cost 0.45 --routing-confirmation data/p46-routing-confirmation.json --db /tmp/p46-preflight3.sqlite` | exit 0; 3/3 probes `success`, 3/3 strict schemas valid, vision interpreted, all costs known. |
| `npm run report -- --run 1f717e0d-4a63-486b-b3a3-45f7d7338a2e` | exit 0; prints the live preflight artifact with observed identities and costs. |
| `npm run check` | 47 files / 612 tests passed, build succeeded. |
| `npm run test:browser` | 6 passed. |

**Acceptance:** accepted by the user on 2026-11-06. No further live call is required for this phase.
