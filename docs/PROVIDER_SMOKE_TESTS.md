# Provider Smoke Tests

This file records actual provider compatibility evidence. Mock, offline, synthetic, or fixture results must never be entered here as live evidence.

## P46. Authorized Live Model/Route Compatibility Probes — 2026-11-06

**Status:** `BLOCKED / LIVE-UNVERIFIED`. No live probe was executed and no paid call was made.

**Prerequisite check (values never printed):**

| Input | Observed |
| --- | --- |
| `OPENROUTER_API_KEY` | not set in the environment |
| `.env` / `.env.local` | absent |
| `GENERATOR_MODEL` | not set |
| `REVIEWER_MODEL` | not set |
| `VISION_REVIEWER_MODEL` | not set |
| operator routing-settings confirmation | not supplied |

No provider IDs or endpoint tags are required under the revised plan. Balanced routing with provider fallback is fixed by section 8.1. The initial user instruction grants paid tests generally, but P46 cannot run without an actual inference key, the three selected model IDs, and a fresh operator confirmation that the account provider sort is default Balanced and no BYOK provider keys are configured. A mock or offline fixture is not a substitute.

**Code state:** the offline path is verified. The live CLI is now wired behind `--allow-paid`, a positive `--max-cost`, and `--routing-confirmation <path>`; it fetches the public catalog, validates Balanced model-level routes, builds the three bounded probes, and writes artifacts under ignored `data/preflight/`. It refuses to dispatch when the key, models, confirmation, route capability, budget, or role separation is missing. P46 still has no real live evidence because the required inputs are absent.

**Commands not executed:**

```bash
npm run preflight -- --live --allow-paid --max-cost 0.50 --routing-confirmation <path>
npm run report -- --run <preflight-id>
```

**Next action:** supply the key and three model IDs locally (do not send the key in chat), create a fresh operator confirmation JSON, and authorize the P46 cap of USD 0.50. Then run at most three logical probes, record requested models/Balanced policy, observed model/provider IDs or explicit unknowns, timestamps, schema results, actual costs/reservations, image interpretation, generation IDs, and exit status, and append the results here.

**Out of scope:** calibration, all-family generation smoke, and the primary experiment.
