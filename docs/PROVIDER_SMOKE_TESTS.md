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

## P48. Authorized Live Reviewer Calibration — 2026-11-06

**Status:** `LIVE-RUN COMPLETE / ALL FOUR GATES FAILED / NOT ACCEPTED`. The calibration executed exactly 80 logical review calls (40 blind + 40 alignment) with zero generation calls, produced all 40 fixture outcomes for each role, and preserved an immutable artifact. The fixed conservative gates failed in all four modality/role combinations, so this run cannot qualify a primary freeze. The prior P46 evidence and P47 labels remain accepted and unchanged.

**Authorization and run identity**

- Paid execution was explicitly authorized by the user for this implementation task; the run used the plan's default cap: `--max-cost 2`.
- Calibration ID: `962b114c-b685-4d29-b846-606fc13fbabf`.
- Pack hash: `b2de95516799894e5fe5c5b4e6eb1376c772efb14981146797004ab99877eb5f`.
- Human label hash: `be359e39350c6e79dc4aeea36651c512726151d569f39a6b35f5ce935730948b` (auditor `Lexa`, `2026-11-06T21:01:19.685Z`, 40/40 human-verified).
- Started `2026-11-06T21:29:54.320Z`; completed `2026-11-06T22:33:17.180Z`.
- Artifact directory: `data/calibration/b2de95516799894e5fe5c5b4e6eb1376c772efb14981146797004ab99877eb5f/live/962b114c-b685-4d29-b846-606fc13fbabf/`.
- Manifest: `manifest.json`, 46 files, manifest hash `541f7326e1c1f1fb551a018c1a8239e4b1ebf5a014888be107109931d181e4c3`; every file hash and byte count re-verified.
- Artifact contents: `calibration.json`, `score.json`, `requests.jsonl` (80 rows), `responses.jsonl` (80 rows), `labels.csv`, `calibration.sqlite`, and 20 PNG + 20 SVG visible images. The database is the raw ledger; the manifest covers every file.

**Live inputs and routing**

- `GENERATOR_MODEL=openai/gpt-6.1-sol`, `REVIEWER_MODEL=z-ai/glm-5.3`, `VISION_REVIEWER_MODEL=qwen/qwen3.8-max-0902`.
- All review requests used the frozen primary prompt/schema builders, model IDs, `Balanced` routing (`provider:{allow_fallbacks:true,require_parameters:true}`, no `sort`/`order`/`only`/`ignore`), and the primary review output cap of `max_tokens: 4096`.
- No provider was pinned. Observed text-review providers were `AkashML`, `Baidu`, `Cloudflare`, `CoreWeave`, `Decart`, `DigitalOcean`, `Friendli`, `InferenceNet`, `PrimeIntellect`, `Together`, and `Wafer`; the observed vision provider was `Alibaba`. Two calls exposed no provider/model identity because they timed out (`blind_text` and `alignment_vision`); the artifact records those as explicit unknown-identity entries.
- Blind and alignment requests were separate for every fixture. Blind payloads contained only the visible presentation; labels were never sent to the blind role.

**Execution and cost**

- 80/80 logical review calls executed; 0 generation calls; 80 transport attempts; 40/40 observations; no content retry, no fixture dropped, no relabeling.
- 38 calls were transport-validated; 7 of those were then rejected by calibration content validation (unknown fact IDs, contradictory overall, or invalid applicability), leaving 31 fully valid calibration responses. 40 calls ended with `finish_reason:"length"` under the 4096-token output cap; 2 calls were uncertain network timeouts. The score's 49 role-level errors comprise the 40 truncations, the 2 timeouts, and the 7 calibration-content validation errors.
- Known actual cost: **USD 1.3060874628**. Unknown calls: 2; unknown attempts: 2. No budget pause and no overshoot; the USD 2 cap was not breached.
- `npm run calibration -- --live --allow-paid --labels data/calibration/b2de95516799894e5fe5c5b4e6eb1376c772efb14981146797004ab99877eb5f/labels.human.csv --max-cost 2` exited 1 because the gates failed; the artifact was still written in full.

**Conservative score (fixed 10 defective / 10 sound denominators per modality)**

| Combination | TP | FP | TN | FN | Abstain | Errors | Conservative sensitivity (Wilson 95%) | Conservative specificity (Wilson 95%) | Gate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| text blind | 0 | 0 | 8 | 0 | 3 | 9 | 0/10 = 0.000 [0.000, 0.278] | 7/10 = 0.700 [0.397, 0.892] | FAIL |
| text alignment | 3 | 2 | 3 | 0 | 0 | 12 | 3/10 = 0.300 [0.108, 0.603] | 3/10 = 0.300 [0.108, 0.603] | FAIL |
| SVG blind | 2 | 0 | 6 | 0 | 0 | 12 | 2/10 = 0.200 [0.057, 0.510] | 6/10 = 0.600 [0.313, 0.832] | FAIL |
| SVG alignment | 0 | 0 | 4 | 0 | 0 | 16 | 0/10 = 0.000 [0.000, 0.278] | 4/10 = 0.400 [0.168, 0.687] | FAIL |

Coverage was 40/40 reviewed, 40/40 blind, and 40/40 alignment; the decisive-only matrices have much smaller denominators (text blind 8 sound, text alignment 3 defective + 5 sound, SVG blind 2 defective + 6 sound, SVG alignment 4 sound) and are not a substitute for the conservative gates.

**Observed failure mechanism and limitations**

- The dominant failure is output truncation: `z-ai/glm-5.3` and `qwen/qwen3.8-max-0902` exhausted the 4096-token review cap on long alignment prompts and on some blind prompts, returning `finish_reason:"length"` and no strict-schema JSON. P46 had already observed a reasoning reviewer exhausting a 2048/4096 cap and used an 8192-token probe cap for its review probes; the primary route remains 4096, and P48 correctly used the primary limit rather than the probe limit.
- The two uncertain calls are network timeouts; their cost is unknown but bounded by the ledger's reservation/unknown-exposure records. They are counted as errors, not dropped.
- Provider identities are diagnostics only; Balanced routing may choose different providers on any later call. The calibration does not prove that future generations are reproducible, and it does not measure primary puzzle approval rates.
- Wilson intervals remain wide with ten sound and ten defective fixtures per modality. The run is complete evidence, but it is not freeze-eligible because the gates failed.
- A different reviewer model, output cap, or other configuration requires a new authorized calibration and a preserved prior result; this artifact must not be overwritten or relabeled to obtain a pass.

**Verification**

| Command | Result |
| --- | --- |
| `npm run calibration -- --live --allow-paid --labels .../labels.human.csv --max-cost 2` | exit 1; 80 review calls, 0 generation calls, 40 observations, known cost USD 1.3060874628, 2 unknown calls, all four gates false; full artifact written. |
| `npm run report -- --run 962b114c-b685-4d29-b846-606fc13fbabf` | exit 0; prints the live calibration artifact. |
| `npm exec -- vitest run tests/calibration/live.test.ts tests/calibration/score.test.ts` | exit 0; 27 tests passed. |
| Manifest re-hash of all 46 files | 0 mismatches; 20 PNG, 20 SVG, 80 request rows, 80 response rows. |

**Acceptance:** not accepted. The fixed gates failed; P48 remains open pending an explicitly authorized revised reviewer/configuration calibration. No further live call was made after this run.

### P48 revised-model preflight attempts — 2026-11-06

After the failed P48 run, the operator replaced both reviewer models with `deepseek/deepseek-v4.1-flash-1017` (text) and `minimax/minimax-m3.1-flash` (vision); the generator remained `openai/gpt-6.1-sol`. P46 live preflight was rerun twice with a fresh database and the operator's fresh `default_balanced`/no-BYOK confirmation. Both attempts failed the 3/3 strict-schema requirement, so no P48 calibration was started with these models.

| Preflight | spec | blind_text | blind_vision | Result |
| --- | --- | --- | --- | --- |
| `9e0c974b-f843-4c9f-8b73-f4fda6981a58` | `openai/gpt-6.1-sol` via `OpenAI`, schema valid, USD 0.002012 | `deepseek/deepseek-v4.1-flash-1017` via `DeepInfra`, schema invalid: `answerStatus:"no_unique_answer"` with non-null `chosenOption:"D"` and `visualLegibility:"legible"` on a text probe, USD 0.000685706 | `minimax/minimax-m3.1-flash` via `Together`, schema valid, vision interpreted, USD 0.0000888 | failed |
| `4d0ecd1f-ef50-449a-bd5f-c3b01aadd809` | `openai/gpt-6.1-sol` via `OpenAI`, schema valid, USD 0.002032 | `deepseek/deepseek-v4.1-flash-1017` via `Wafer`, schema valid, USD 0.00296723 | `minimax/minimax-m3.1-flash` via `ModelRun`, `failed_known` `LENGTH` at the 4096 output cap, USD 0.00493542 | failed |

Known cost across the two revised-model preflights: **USD 0.012721156** under the USD 0.50 P46 cap. The artifacts are `data/preflight/9e0c974b-f843-4c9f-8b73-f4fda6981a58/preflight.json` and `data/preflight/4d0ecd1f-ef50-449a-bd5f-c3b01aadd809/preflight.json`. Exact provider content, reasoning, finish reasons, usage, and schema errors are preserved in each directory's `raw-error.json`; the full raw provider responses are in the `preflight.sqlite` `artifacts` table (`raw_response`). The first attempt shows a strict-schema semantics failure; the second shows the vision model exhausting the primary 4096-token cap. The new models are not P46-qualified, and the previous P48 artifact remains the only calibration result. A further model change, a review output-cap change, or a revert to the previously schema-valid reviewers requires a new explicit authorization and a new P46/P48 sequence.

### P48 newest-model attempt — 2026-11-06

The operator then supplied `openai/gpt-6-luna` (text) and `google/gemini-3.5-flash-lite` (vision); the generator remained `openai/gpt-6.1-sol`. P46 preflight `732ba854-43bd-41ec-a190-708be62f01d3` passed 3/3 with strict schemas and vision interpretation: spec `openai/gpt-6.1-sol` via `OpenAI` USD 0.001712; blind_text `openai/gpt-6-luna` via `OpenAI` USD 0.0001033; blind_vision `google/gemini-3.5-flash-lite` via `Google` USD 0.0008692; total USD 0.0026845. Because P46 passed, P48 was run with the same models and the verified human labels.

P48 `1c9b373e-97ce-42a8-a078-75b341347501` completed 80/80 review calls, 0 generation calls, and 40/40 observations with known cost **USD 0.1052989** and 20 unknown-cost calls. No budget pause or overshoot. Provider mix: blind_text `openai/gpt-6-luna` via `OpenAI` (20), blind_vision `google/gemini-3.5-flash-lite` via `Google` (20), alignment_vision `google/gemini-3.5-flash-lite` via `Google` (20), alignment_text 20 calls with no observed identity. All four gates failed:

| Combination | TP | FP | TN | FN | Abstain | Errors | Conservative sensitivity | Conservative specificity | Gate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| text blind | 7 | 0 | 10 | 0 | 3 | 0 | 7/10 = 0.700 | 10/10 = 1.000 | FAIL (sensitivity) |
| text alignment | 0 | 0 | 0 | 0 | 0 | 20 | 0/10 = 0.000 | 0/10 = 0.000 | FAIL |
| SVG blind | 0 | 0 | 7 | 9 | 0 | 4 | 0/10 = 0.000 | 3/10 = 0.300 | FAIL |
| SVG alignment | 0 | 0 | 9 | 10 | 0 | 1 | 0/10 = 0.000 | 9/10 = 0.900 | FAIL (sensitivity) |

The text-alignment failures are not model answers: all 20 calls returned the provider error `Invalid JSON schema: regex lookaround is not supported. Found at $.properties.fields.properties.explanation.properties.factIds.items.pattern.` (`provider_code: invalid_json_schema`, HTTP-level 200, no observed model/provider, unknown cost). The strict alignment schema uses `FACT_ID_PATTERN` with a negative lookahead; OpenAI's structured-output schema validator rejects it. The four SVG-blind errors and one SVG-alignment error are strict-schema content failures. Even if the lookaround were removed, the text-blind 7/10 and SVG-blind/alignment 0/10 sensitivities are below the fixed 9/10 gate, so this model pair is not viable for P48.

Artifact: `data/calibration/b2de95516799894e5fe5c5b4e6eb1376c772efb14981146797004ab99877eb5f/live/1c9b373e-97ce-42a8-a078-75b341347501/` (manifest hash `82b44d5fdcb2dd2dd6616de4649ed98da3daa43ef9eca5304f172010f8df39d3`). The prior P48 and revised-model artifacts remain unchanged. A schema-portability fix and a stronger reviewer/vision model are both required before another authorized P46/P48 sequence.

### P46 contract-hardening revision and Haiku 5.5 / Gemini 3.8 Flash preflight — 2026-11-07

The P46 preflight was revised after the OpenAI `regex lookaround` failure. `FACT_ID_PATTERN` is now lookaround-free: `^(?:[fps](?:[1-9]\d{2,5}|\d[1-9]\d{1,4}|\d{2}[1-9]\d{0,3}|\d{3}[1-9]\d{0,2}|\d{4}[1-9]\d?|\d{5}[1-9])|r-(?:domain|closed|target|operations|conventions))$`. An exhaustive comparison against the previous pattern found zero mismatches over 3,332,988 accepted `f`/`p`/`s` IDs and the five `r-` IDs. `assertStrictJsonSchema` now rejects lookahead, lookbehind, backreferences, named groups, atomic groups, conditionals, inline flags, Unicode property escapes, quoted literals, unsupported anchors, and possessive quantifiers in any `pattern`/`patternProperties`, so an incompatible schema fails before a paid call.

P46 now checks all four actual review contracts, not only the blind probes: `blind_text`, `alignment_text`, `blind_vision`, and `alignment_vision`. The live plan contains five probes (spec + four reviews), each with its real strict response schema; `alignment_text` and `alignment_vision` use the actual alignment payload/schema and validate `fields.image`, modality applicability, and overall consistency. The previous `validateProbeContent` looked for `data.image` instead of `data.fields.image`; that latent bug is fixed, and text blind now rejects an image legibility status while SVG blind requires one.

The operator confirmed `default_balanced` routing with no BYOK at `2026-11-07T00:10:17.000Z`. The first five-probe run `77304e8f-18a8-4e7d-9074-d08e44887456` passed 5/5 but probed the review roles at 8192 output tokens, above the production 4096 cap. A static review confirmed that this did not certify the limit the primary/calibration path actually uses, and that the earlier P48 `LENGTH` failures had occurred after a passing P46. The probe caps were corrected: the four review roles use `defaultMaxOutputTokensFor(role)` = 4096, and spec stays at 2048 (stricter than the production 8192). The first production-cap attempt `95646c16-6bdb-412f-b8e0-c12995d443fc` paused on the spec probe because the conservative 8192 spec reservation was USD 1.536, above the USD 0.50 cap; keeping the spec probe at 2048 kept the reservation under the cap. The final production-cap run `a1ea6c1e-da12-4288-a9cf-b0d6e50440d2` passed 5/5 under the USD 0.50 cap:

| Probe | Model | Provider | Schema | Vision | Cost |
| --- | --- | --- | --- | --- | --- |
| spec | `openai/gpt-6.1-sol` | `OpenAI` | valid | n/a | USD 0.001572 |
| blind_text | `anthropic/claude-haiku-5.5` | `Azure` | valid | n/a | USD 0.0002214 |
| alignment_text | `anthropic/claude-haiku-5.5` | `Azure` | valid | n/a | USD 0.0006208 |
| blind_vision | `google/gemini-3.8-flash` | `Google` | valid | yes | USD 0.00286425 |
| alignment_vision | `google/gemini-3.8-flash` | `Google` | valid | yes | USD 0.00567525 |

Total known cost: **USD 0.0109537**. Artifact: `data/preflight/a1ea6c1e-da12-4288-a9cf-b0d6e50440d2/preflight.json` and `preflight.sqlite`. The earlier `77304e8f...` 8192-cap run is preserved as superseded evidence. The alignment_text probe proves the lookaround-free schema is accepted by the text model; the alignment_vision probe proves the vision model processes the PNG and returns a valid alignment contract. The alignment vision prompt's contradictory `not_applicable` instruction was also fixed and is asserted for both variants in `tests/ai/preflight.test.ts`. P46 is now **P46-QUALIFIED at the production review caps** for this model pair, but this is compatibility evidence only, not a behavioral pilot or calibration.

P45 was repeated for the request-contract change: `npm exec -- vitest run tests/experiment/full-mock.test.ts` passed 4/4, and `npm run check` passed 48 files / 629 tests. The original accepted P46 artifact and the failed P48 artifacts remain unchanged.

### P48 offline SVG audit and scoring correction — 2026-11-07

The newest P48 artifact (`1c9b373e...`) was audited offline with no API calls. Image integrity passed for all 20 SVG fixtures: every visible PNG/SVG in the pack and in the run artifact matches `pngHash`/`svgHash`, every SVG contains visible A-D labels, and no request leaked `sound_or_defective`, `acceptedDefectCodes`, `mutation`, or `expected`. Blind requests contain the visible question/rules/clues/options and the actual PNG; alignment requests contain the original DSL/proof/correct option plus the **corrupted** visible presentation and the actual PNG. `cal-symmetry-04` has an unchanged image because its mutation changes only `rules` (`changedFields:["rules"]`); the contradictory "horizontal axis must be read as vertical" rule is present in the visible text, and the model ignored it. This is a model behavior failure, not a missing image or request bug.

The audit found one real scoring defect: `blindPrediction` and `conservativeBlind` required `ambiguity:"present"` for a defect, so explicit `no_unique_answer`/`cannot_determine` responses with accepted issue codes but `ambiguity:"none"` were silently classified as abstentions. The three text fixtures `cal-ranking-04`, `cal-truth-04`, and `cal-arithmetic-04` were detected correctly by `openai/gpt-6-luna` but scored as abstentions. The rule now treats `none` or `present` with issues as an explicit defect while keeping `uncertain` as an abstention. Re-scoring the stored observations without any new call changes the newest P48 text blind from 7/10 sensitivity and 3 abstentions to **10/10 sensitivity, 10/10 specificity, 0 abstentions, gate PASS**. The original P48 text blind improves only from 0/10 to 2/10 because its responses were dominated by `LENGTH` errors. Text alignment remains 20/20 provider errors (the lookaround schema issue), SVG blind remains 0/10 sensitivity / 3/10 specificity, and SVG alignment remains 0/10 sensitivity / 9/10 specificity. The original `score.json` files are preserved; corrected scores are diagnostic-only at `data/calibration/b2de955.../diagnostics/<run-id>/score-fixed.json`, outside the immutable live artifact directories.

Conclusion: the text blind model `openai/gpt-6-luna` is not the limiting factor; the scoring pipeline was. The text alignment failure was a technical schema-portability error, now fixed and P46-qualified with Haiku 5.5. The SVG 0/10 results survive the offline audit (apart from the text-only symmetry case, where the model ignored an explicit textual contradiction), so replacing the vision model is justified. A separate development pilot and a new P48 validation protocol remain pending explicit authorization.

### P48 development pilot — 2026-11-07

The operator approved an 8-case/16-call development pilot with a USD 0.10 cap, separate from P46 and the 40 calibration fixtures. The pilot used `anthropic/claude-haiku-5.5` for text and `google/gemini-3.8-flash` for SVG through the same frozen builders, strict schemas, Balanced routing, and production caps. Cases: `ranking`/`matching` sound+defective (text) and `matrix`/`paths` sound+defective (SVG), built from new slots 95/96 with code-derived truth. The pilot artifact is `data/calibration-pilot/c970ee24-600d-4008-9466-91ff353713e5/` (`pilot.json`, `score.json`, `requests.jsonl`, `responses.jsonl`, `labels.csv`, `pilot.sqlite`, 4 PNG + 4 SVG, manifest hash `02a655be5545c1df1e4dd0eaef749e2e237503de182ae0524e3fb6c3f98079e6`; 14 files, 0 hash mismatches). It is explicitly not freeze evidence.

The pilot ran 14/16 logical calls and recorded 8/8 observations with known cost **USD 0.0535287**, 0 unknown calls, and no budget breach; it paused before the `cal-paths-95` alignment_vision dispatch because the next conservative vision reservation plus the known actual cost exceeded the USD 0.10 cap. The two `cal-paths-96` calls were not executed. The pilot therefore fails its 16/16 criterion and is incomplete.

| Combination | TP | FP | TN | FN | Errors | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| text blind | 2 | 0 | 2 | 0 | 0 | PASS (2/2, 2/2) |
| text alignment | 1 | 0 | 0 | 0 | 3 | FAIL |
| SVG blind | 1 | 0 | 1 | 0 | 2 | incomplete |
| SVG alignment | 1 | 0 | 1 | 0 | 2 | incomplete |

The text-alignment errors are `alignment overall contradicts derived field statuses` on `cal-ranking-95`, `cal-matching-95`, and `cal-matching-96`: the model returned `overall:"pass"` while `explanation` (and in one case `hint`) was `uncertain`. The validator correctly rejected the contradictory response. The v1 prompt says "The overall field is advisory; code computes the authoritative overall status," while the strict schema rejects an inconsistent overall; this is a prompt/schema contradiction, so the errors are not purely model inability. A v2 prompt that states the derived overall rule explicitly is the proposed fix. The first pilot also used independent slot-95/96 bases; the code now derives each defective pilot case from the same base as its sound twin, so the existing artifact's 2/2 contrast is confounded by the base difference and future pilots will use true twins. The SVG matrix cases both passed: the vision model accepted the sound matrix and detected the contradictory-XOR defective matrix in both blind and alignment. The `cal-paths-95` blind ended with `finish_reason:"length"` at the 4096 cap; its alignment was budget-refused, and both `cal-paths-96` calls were not executed. The pilot therefore shows useful matrix evidence but does not resolve the paths cases.

The pilot is not accepted as a full behavioral pass. To finish it, a supplemental budget above USD 0.10 (or a focused paths-only pilot) is required; the text-alignment overall inconsistency also needs a decision between a stronger prompt rule and a different text model. The pre-approved fallback P46 for Claude Sonnet 5.5 remains available if the SVG paths behavior cannot be established with Gemini 3.8 Flash.

### Fallback P46 for Claude Sonnet 5.5 — 2026-11-07

The pre-approved fallback P46 `1edc248c-25db-4924-b368-c39e9cf69572` used `anthropic/claude-haiku-5.5` for text and `anthropic/claude-sonnet-5.5` for SVG under the USD 0.50 cap. It passed spec, blind_text, alignment_text, and blind_vision, but failed `alignment_vision` with `hint cannot be not_applicable`: Sonnet 5.5 set the hint field to `not_applicable`, while the alignment contract permits `not_applicable` only for the image field. Total known cost **USD 0.0165117**. Sonnet 5.5 is therefore not P46-qualified as the SVG reviewer with the current contract; Gemini 3.8 Flash remains the P46-qualified vision model. The artifact is `data/preflight/1edc248c-25db-4924-b368-c39e9cf69572/preflight.json` and `preflight.sqlite`.

### Alignment contract v2 and deterministic audit — 2026-11-07

The alignment response contract no longer asks the model for an `overall`. The model returns only `fields`; `deriveAlignmentOverall` computes `pass`/`fail`/`uncertain` from the applicable field statuses, and the strict schema rejects a model-supplied `overall` as an extra property. The text and vision prompts are versioned v2 and state: return only the fields object; do not return overall; fail if any field fails, uncertain if any field is uncertain, pass only when every applicable field passes; only the image field may be `not_applicable` in text, and no field may be `not_applicable` in SVG. `ALIGNMENT_SCHEMA_VERSION` is v2. Legacy stored alignment reviews with an `overall` remain readable through a separate storage union, but new reviews and the calibration/score path never trust a model overall. Focused tests (`review-alignment`, `preflight`, `mock`, `calibration/score`, `calibration/live`, `calibration/pilot`) pass; the full suite passes 49 files / 639 tests.

The deterministic audit confirms that `cal-matching-96` is a deliberate `duplicate_correct_option` mutation, not a production-validation hole. `ChoiceSetSchema` rejects duplicate choice values and a correct label that does not identify exactly one choice; `assertAssembledPresentation` rejects non-distinct visible option texts (`DUPLICATE_OPTION_TEXT`). A new pilot test constructs the defective visible presentation and the duplicate choice set and proves both validators reject them. The Haiku miss remains a calibration/reviewer failure, but the production pipeline would reject such a question before AI review.

The paths audit confirms the pilot `cal-paths-96` PNG/SVG hashes, visible A-D labels, corrupted alignment payload, original DSL/proof, and the `CLOSED_ROUTE_EDGE` -> `assets` -> `image` scoring mapping are faithful. The `cal-paths-95` blind failure was `finish_reason:"length"` with 4079 completion tokens, of which **3931 were hidden reasoning** and only about 148 were content; the 4096 cap was consumed by reasoning, not by a long visible explanation. Gemini 3.8 Flash advertises `reasoning_effort` on all active endpoints. The request builder now supports `reasoningEffort: low|medium|high` and serializes it as `reasoning_effort`; the P46 and calibration CLIs expose `--vision-reasoning-effort <effort>`. Raising the cap to 8192 remains the second option because it increases the cost of all 80 calibration calls.

The original pilot `c970ee24...` is preserved as an incomplete diagnostic result. Its model-supplied overalls are no longer part of the v2 contract, and its independent-base contrast is confounded; it is not comparable to a new same-base pilot. A new small pilot should use new development fixtures (same-base twins), the v2 contract, and `--vision-reasoning-effort low`, focused on `alignment_text` and the paths blind/alignment cases, with a separately approved budget. P45/P46 must be repeated for the prompt/schema change before a new P48 calibration.

### P46 v2-contract preflight with low vision effort — 2026-11-07

P46 `362cfedd-10de-42aa-b6e8-e7f4f281f633` ran the five-probe v2 contract with `--vision-reasoning-effort low` under the USD 0.50 admission cap. It passed spec, blind_text, blind_vision, and alignment_vision, but failed `alignment_text` with `hint cannot be not_applicable`: Haiku 5.5 returned `hint.status:"not_applicable"` with the reason "Hint is none, so there is no hint content to check", even though the v2 prompt explicitly says the hint field must never be `not_applicable`. This is a model instruction-following failure, not a schema or scoring bug. At that point the 6-case/12-call same-base pilot was not run; it was later run as `2ebf4403...` after the separate alignment model passed P46, and failed the SVG paths combinations.

| Probe | Model | Provider | Schema | Vision | Cost |
| --- | --- | --- | --- | --- | --- |
| spec | `openai/gpt-6.1-sol` | `OpenAI` | valid | n/a | USD 0.001692 |
| blind_text | `anthropic/claude-haiku-5.5` | `Google` | valid | n/a | USD 0.0002349 |
| alignment_text | `anthropic/claude-haiku-5.5` | `Azure` | **invalid: hint cannot be not_applicable** | n/a | USD 0.0004347 |
| blind_vision | `google/gemini-3.8-flash` | `Google` | valid | yes | USD 0.0022155 |
| alignment_vision | `google/gemini-3.8-flash` | `Google` | valid | yes | USD 0.00505575 |

Total known cost: **USD 0.00963285** under the combined USD 0.25 authorization; the pilot budget remains unspent. Artifact: `data/preflight/362cfedd-10de-42aa-b6e8-e7f4f281f633/`. The next step is a separate `ALIGNMENT_TEXT_MODEL` (candidate: `google/gemini-3.8-flash`, which followed the hint rule in alignment_vision) or another text model that follows the v2 applicability contract; Haiku 5.5 remains suitable for `blind_text` only.

### V2 validation pack preparation — 2026-11-07

`npm run calibration -- --prepare-v2` built the version-2 40-fixture validation pack offline. Pack hash `c8bacdf030974d1c4c56fc3ec79cf2d43e19c8c21514da63bd26eb01cf1442dc`; directory `data/calibration-v2/c8bacdf030974d1c4c56fc3ec79cf2d43e19c8c21514da63bd26eb01cf1442dc/`; 40 fixtures (20 sound / 20 defective, 20 text / 20 SVG), slots 101-104, fixture IDs 05-08, 60 image files, `gallery.html`, `pack.json`, and `labels.pending.csv`. The v2 pack is disjoint from the v1 pack and the 95-99 development pilot. No paid call was made. Human verification of the pending labels is required before a v2 P48 calibration. `--pack-version 2` selects the v2 pack for `--accept-proposed`, `--verify-labels`, `--mock`, and `--live`; the default remains version 1, and `--prepare-v2` remains the offline builder.

### Separate alignment_text model and 6-case pilot — 2026-11-07

The operator approved a separate `ALIGNMENT_TEXT_MODEL`. The live config now routes `alignment_text` independently, defaults to `REVIEWER_MODEL` when unset, and records the selected model in the calibration/pilot artifact. The operator-delegated configuration is `REVIEWER_MODEL=anthropic/claude-haiku-5.5`, `ALIGNMENT_TEXT_MODEL=google/gemini-3.8-flash`, `VISION_REVIEWER_MODEL=google/gemini-3.8-flash`.

P46 `d21d90c7-ab0d-4938-aff6-1912de82e93c` passed **5/5** with `--vision-reasoning-effort low` under the USD 0.50 admission cap: spec GPT-6.1 Sol/OpenAI USD 0.001912; blind_text Haiku/Azure USD 0.0002534; alignment_text Gemini/Google USD 0.0055785; blind_vision Gemini/Google USD 0.00237675; alignment_vision Gemini/Google USD 0.00338325; total **USD 0.0135039**. The separate alignment_text model follows the v2 applicability contract and fixes the Haiku `hint:not_applicable` failure. Artifact: `data/preflight/d21d90c7-ab0d-4938-aff6-1912de82e93c/`.

The v2 pending labels were reviewed by Kilo on the operator's explicit delegation, audited against the pack truth and visible artifacts, accepted with `--accept-proposed --pack-version 2 --auditor "Lexa (delegated to Kilo)"`, and verified. `labels.human.csv` has pack hash `c8bacdf...`, labels hash `2c4e2e45728a0d48492e905137ab9de2be76509f3c8dff0e4726e9ec0237fec5`, 40 rows, provenance `human`, `human_verified:true`, auditor `Lexa (delegated to Kilo)`, and per-row notes disclosing that this was operator-delegated review by Kilo, not independent human inspection. The calibration artifact labels block records `reviewMethod` (`independent_human`, `operator_delegated_ai`, or `code_derived`; the v2 labels are `operator_delegated_ai`, the pilot labels are `code_derived`) and the unique notes; a freeze requiring independent human verification must reject or explicitly caveat a non-`independent_human` method. The operator can re-review the labels independently.

The new 6-case/12-call pilot `2ebf4403-947f-486a-b2e4-a2f924f05e0b` completed 12/12 calls and 6/6 observations with known cost **USD 0.0629549**, 0 unknown, and no budget breach. Results:

| Combination | TP | FP | TN | FN | Errors | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| text blind | 2 | 0 | 1 | 0 | 0 | PASS (2/2 defective, 1/1 sound) |
| text alignment | 2 | 0 | 1 | 0 | 0 | PASS (2/2 defective, 1/1 sound) |
| SVG blind | 0 | 0 | 1 | 1 | 1 | FAIL |
| SVG alignment | 0 | 0 | 1 | 2 | 0 | FAIL |

Text is now fully green: Haiku blind and Gemini alignment detect the ranking no-valid and duplicate defects and accept the sound case. SVG paths remain failing: `cal-paths-97` sound passed; `cal-paths-98` (`CLOSED_ROUTE_EDGE`) was classified as sound in both blind and alignment; `cal-paths-99` (`DUPLICATE_CORRECT_OPTION`) had a blind strict-schema error and was classified as sound in alignment. The model's blind reasoning for paths-98 asserted that option A was the only valid route, missing the closed edge; paths-99's blind used 3316 completion tokens and still failed the strict schema. Artifact: `data/calibration-pilot/2ebf4403-947f-486a-b2e4-a2f924f05e0b/`, manifest hash `d18f2f88723f5e8fd3ad7742569876f0d9ad0df9e84bc517b11c45adaa28e0d5`, 12 files, 0 hash mismatches.

An earlier pilot attempt `3e1cb2e5-04f3-4eeb-8a82-c9bfe72d0888` was aborted by the shell timeout at 11/12 calls (one dispatching vision call, known cost USD 0.05684915, unknown exposure bounded by the reservation). It has no final manifest and is not used as a result. After that run the total known spend across the P46/pilot attempts was USD 0.1429408; the subsequent deterministic-audit/v3 experiment is recorded below.

### Deterministic paths asset audit and vision prompt v3 — 2026-11-07

The existing paths validator, applied to the actual serialized pilot SVG/PNG, rejects both deliberate mutations:

| Fixture | Existing `assertPathsScene` | Independent PNG audit | Raster |
| --- | --- | --- | --- |
| `cal-paths-97` | PASS | 4 distinct option crops; 1 valid option | 0 pixel difference |
| `cal-paths-98` | `UNEXPECTED_WALL` | 4 distinct option crops; 0 valid options | 0 pixel difference |
| `cal-paths-99` | `WRONG_ROUTE` | 3 distinct option crops; duplicate A/B; 2 valid options | 0 pixel difference |

The audit is implemented in `src/calibration/asset-audit.ts` and `tests/calibration/asset-audit.test.ts`; `npm run calibration -- --audit-assets` runs it over the in-memory pilot pack. It parses the serialized SVG with `parseScene`, calls `pathsRenderer.assertScene` with the original spec/choices, re-renders and compares the actual PNG with `assertRasterEquivalent`, hashes normalized `option-*-maze` crops without A-D labels, and requires exactly one valid option. It is a separate deterministic evidence channel: it does not change the model score and does not rewrite the pilot's false negatives.

The vision prompts were revised to v3 (`src/ai/prompts/v3/blind-vision.txt`, `alignment-vision.txt`): systematic all-option route tracing, pairwise tile comparison, route-vs-wall verification, duplicate/no-valid handling, a short final reasoning field, and the clarification that reporting a defective image is not adjudication. P46 `2082fa49-994b-4e45-85c4-7b59a11da941` passed 5/5 with the same models and low vision effort, total USD 0.01422115.

The prompt-only paths pilot `7fad3123-4b0b-4912-b043-7c03b11b6c3c` used new same-base paths cases at slots 105-107 (sound/closed-route/duplicate), the v3 prompts, and the same Gemini model/effort. It ran 5/6 calls and 3/3 observations at USD 0.01868025 and paused on the `cal-paths-11` blind budget reservation. `cal-paths-09` sound: blind selected A while the alignment named D as the unique valid route; `cal-paths-10` closed-route: classified as sound in both modes; `cal-paths-11` duplicate: blind budget-refused, alignment not executed. The pilot pass is false. The v3 prompt-only experiment therefore did not fix the paths behavior and no model swap was performed. The v3 prompt change invalidates the earlier vision calibration evidence under the reviewer-change rule; the full suite after the change passed 51 files / 646 tests at that point.

At that point total known spend was **USD 0.1758422** (USD 0.1429408 + P46 v3 USD 0.01422115 + paths pilot USD 0.01868025); the subsequent medium/Sonnet experiments are recorded below. The current paths pilot remains FAIL.

### Medium-effort and Sonnet 5.5 paths experiments — 2026-11-07

The next measured experiments changed one configuration at a time on the new same-base paths cases at slots 108-110 (fixture IDs 12-14: sound, closed-route, duplicate), with the v3 prompts.

| Experiment | P46 | Paths pilot | Result |
| --- | --- | --- | --- |
| Gemini 3.8 Flash, medium effort | `54e397f7-e62e-4091-bb89-fd4ba22e9a86` 5/5, USD 0.0171879 | `94c76bf7-28e0-49d0-b594-1efa45cb347c` 4/6 calls, USD 0.035466, `paused_budget` | paths-12 sound correct; paths-13 closed-route missed; paths-14 duplicate untested |
| Sonnet 5.5, default effort | `5684cc06-24d5-46e5-8711-94630f6bf903` 5/5, USD 0.0223404 | `a39eed3c-b171-49e9-be03-810a2dd7586e` 5/6 calls, USD 0.109458, `paused_budget` | paths-12 sound correct; paths-13 closed-route missed; paths-14 duplicate untested |
| Sonnet 5.5, duplicate-only focused diagnostic | same P46 | `38798cfa-15bb-46ec-adfc-aed80d326ae1` 2/2 calls, USD 0.046904, `completed` | duplicate blind and alignment both `defective`/conservative true; `pilotPass:false` only because the focused pack has no sound case (not a calibration pass) |

The closed-route defect remains undetected by both Gemini 3.8 Flash and Sonnet 5.5 in both modes. The duplicate defect is detected by Sonnet 5.5 in both blind and alignment under the v3 prompts (`no_unique_answer`/`duplicate_options` blind; `options:fail`/`image:fail` alignment). The deterministic audit still catches both mutations independently of the model. The v3 prompt/medium/Sonnet changes invalidate the earlier vision calibration evidence; no v2 P48 calibration was run.

At that point total known spend was **USD 0.4071985** (USD 0.1758422 + medium P46/pilot USD 0.0526539 + Sonnet P46/pilot USD 0.1787024); the combined authorization is USD 0.55 (USD 0.25 + USD 0.30), leaving USD 0.1428015. The full suite passed 51 files / 649 tests at that point. The subsequent targeted diagnostic is below.

### Targeted four-variant paths diagnostic — 2026-11-07

The operator approved one final targeted diagnostic on `cal-paths-13` with Sonnet 5.5. The variants change the information/procedure available to the model and are explicitly not calibration evidence (`calibrationEligible:false`, `freezeEligible:false`).

| Variant | Change | Result |
| --- | --- | --- |
| A | original PNG + original v3 blind prompt (control) | `selected C` (control failure reproduced) |
| B | original PNG + explicit per-edge verification procedure | `selected D` (procedure did not help) |
| C | full original PNG + 4x zoom of the source edge (1,1)-(2,1) and option C edge | `selected D` (visual detail did not help) |
| D | text-only open-edge list; no image | `no_unique_answer`, issue `no_correct_option` (logical decision correct) |

A/B are in `data/paths-diagnostic/03992846-9d26-4588-b00d-edbf08cbb5f7/`; the first run paused at C on the admission reservation after A/B, so C/D were completed in `data/paths-diagnostic/64877ad9-8b6c-48fa-81ed-c001e6f77e0e/`. The combined report is `data/paths-diagnostic/combined-2026-11-07.json`. The combined result is **D succeeds, A fails, B/C fail**: the primary classification is **visual interpretation**. The rules/logic are sound; the explicit edge-check procedure and the zoomed crop do not fix the visual failure. The first artifact labels the budget-refused C as `schema_error`; new runs use the distinct `budget_refused`/`transport_error` buckets. The diagnostic CLI now caps new runs at the remaining envelope (USD 0.05 admission/actual).

Costs: A/B USD 0.040836; C/D USD 0.044802; diagnostic total USD 0.085638. Total known spend is now **USD 0.4928365** (USD 0.4071985 + USD 0.085638); the combined authorization is USD 0.55, leaving **USD 0.0571635**. The full suite passed 52 files / 651 tests. No v2 P48 calibration was run. The next step is a closed-edge visual-representation experiment (larger/contrast/zoom as a new fixture configuration) or a new calibration contract assigning structural defects to the deterministic validator and narrowing the AI reviewer role.
