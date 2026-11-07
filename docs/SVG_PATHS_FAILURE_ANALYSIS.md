# SVG Paths Failure Analysis

**Date:** 2026-11-07  
**Scope:** offline forensic analysis of `cal-paths-97`, `cal-paths-98`, and `cal-paths-99` from the 6-case development pilot `2ebf4403-947f-486a-b2e4-a2f924f05e0b`.  
**Constraints for the original forensic section:** no paid API calls, no prompt/model/schema/fixture/threshold changes, no modification of existing evidence, labels, or results. The `Post-remediation result` section at the end records the separately implemented deterministic audit, the v3 prompt change, the P46 v3 preflight, the paid paths-only pilot, and the later medium-effort/Sonnet 5.5 follow-up; those changes are not part of the original diagnostic and do not alter its evidence.

**Current status (2026-11-07):** deterministic audit PASS; Sonnet 5.5 detects the duplicate and the text-only edge-list closed-route; the visual closed-route variants still fail; the four-variant diagnostic classifies the closed-route failure as **visual interpretation**; paths pilot FAIL; no v2 P48 calibration was run; total spend USD 0.4928365 of the combined USD 0.55 authorization, remaining USD 0.0571635. Details in `Post-remediation result`.

## Executive summary

| Fixture | Truth | Model result | Primary classification |
| --- | --- | --- | --- |
| `cal-paths-97` | sound, correct option A | blind A; alignment all pass | correct; no failure |
| `cal-paths-98` | `CLOSED_ROUTE_EDGE`, no valid route | blind A; alignment all pass | **model behavior failure** (missed the visible closed edge in both modes); no rendering or evaluation defect |
| `cal-paths-99` | `DUPLICATE_CORRECT_OPTION`, option B duplicates A | blind B, reasoning >2000 chars → schema error; alignment all pass | **model behavior failure** (blind selected the duplicate and did not flag it; alignment missed the duplicate) plus a **model output-format failure** (overlong reasoning); no rendering or scoring misclassification |

The exact PNG bytes sent to the model were recovered from the stored request bodies, decoded, hashed, and matched against the fixture labels and the stored image files. All request hashes and PNG hashes match. The closed edge is an 8×36 px black wall in a 1024×1024 image; it is visible in the source maze and in each option maze, and in the option mazes the wall is drawn over the blue route so the route is interrupted. The duplicate is pixel-exact: the option A and option B maze crops in `cal-paths-99` differ by **0 pixels**; only the A/B labels differ.

No rendering, PNG serialization, request serialization, or scoring-loss defect was found. The evaluation pipeline correctly rejected the overlong blind reasoning as a schema error and correctly scored the all-pass alignment responses as sound (false negatives). The only evaluation weakness is diagnostic observability: the stored call record says “blind response does not satisfy the strict schema” instead of the exact Zod issue, which is recoverable from the raw response artifact and was reproduced offline.

## Evidence chain and preservation

- Pilot artifact: `data/calibration-pilot/2ebf4403-947f-486a-b2e4-a2f924f05e0b/`
- Pilot pack hash: `7b93c87f8ea12365a78f001fc30c8f7cb5c192821bc92e9b90f1bd8f877b7479`
- Manifest: `d18f2f88723f5e8fd3ad7742569876f0d9ad0df9e84bc517b11c45adaa28e0d5`; 12 files, 0 hash mismatches.
- Stored requests: `requests.jsonl` (the request bodies include the actual base64 PNG, not only a placeholder).
- Stored responses: `responses.jsonl` (validated response or generic validation error).
- Raw responses: `pilot.sqlite` `artifacts` table, artifact IDs 7–12.
- Images: `images/cal-paths-97.png`, `cal-paths-98.png`, `cal-paths-99.png`, plus the corresponding SVGs.
- Offline analysis used a copy of `pilot.sqlite` in `/tmp/kilo/`; the pilot artifact, manifest, labels, and scores were not modified.

### Exact request and PNG verification

For every paths blind and alignment request, the stored `requestHash` equals `sha256Hex(canonicalJson(requestBody))`; the image data URL in the request body decodes to the same PNG hash as the label and the stored image file.

| Fixture | Role | Stored request hash | Recomputed request hash | Decoded PNG bytes | PNG hash | Matches label/artifact |
| --- | --- | --- | --- | ---: | --- | --- |
| `cal-paths-97` | blind_vision | `96b30548c237047650f9cfd690a73863e7ab77a6af58818bfdb66856b4f4ae7b` | same | 102,550 | `30055e4cd2be9b9cd74559db548ff59c9eccd6aa9daf5b5c512c685b98855873` | yes |
| `cal-paths-97` | alignment_vision | `67dc666a89f9a102a226321f2f85915742941b1b695a1cc738d0f60ed4238bba` | same | 102,550 | `30055e4cd2be9b9cd74559db548ff59c9eccd6aa9daf5b5c512c685b98855873` | yes |
| `cal-paths-98` | blind_vision | `68d934b45ba1ccf90428acd5bd17a98b717fb31951d67771167d21ae6fc25336` | same | 102,717 | `a88ed315440d9d7d220155bce427bbff15a35881f14eccc8a3f8dc0ecd3c44c8` | yes |
| `cal-paths-98` | alignment_vision | `d6e47bc4196a55c0387eca7a0f9b3f2b6f7d2a62d24e64c1f605eb4ba451993a` | same | 102,717 | `a88ed315440d9d7d220155bce427bbff15a35881f14eccc8a3f8dc0ecd3c44c8` | yes |
| `cal-paths-99` | blind_vision | `2093edbde51acfe139a9563d521f5d38516a213e4c6042f8168b1ab94512ab7f` | same | 101,412 | `d96eb32c109aafb7be804323094cfa496c99314196eac153a3fd610d395d6363` | yes |
| `cal-paths-99` | alignment_vision | `8aa371427d14503583491e9638e67b1a3b3304eca88353faad451bb476706581` | same | 101,412 | `d96eb32c109aafb7be804323094cfa496c99314196eac153a3fd610d395d6363` | yes |

The PNGs are 1024×1024. The source maze uses 40×40 px cells; the option tiles are 448×196 px. The added closed wall is 8 px wide and 36 px of visible length after rasterization. The model receives the same PNG for the blind and alignment request of a fixture; there is no separate resized request artifact in the pipeline.

## Reconstructed fixture truth

All three fixtures share the same sound base (slot `svg-paths-97`, pack hash above). The formal spec has active cells:

`(1,0), (1,1), (2,0), (2,1), (3,0), (3,1), (3,2), (3,3)`

with start `(1,0)`, goal `(3,3)`, and seven tree edges. The unique valid route is option A:

`(1,0) → (1,1) → (2,1) → (3,1) → (3,2) → (3,3)`.

The visible options are the generic texts `See labeled tile A`, `See labeled tile B`, `See labeled tile C`, `See labeled tile D`; the actual candidate routes are rendered in the four option tiles.

### `cal-paths-97` — sound

- Expected blind: `correct`, correct label `A`; expected alignment: `pass`, no failing fields.
- Model blind: `selected A`; model alignment: all fields pass.
- Score: blind `sound`/conservative true; alignment `sound`/conservative true.
- Classification: correct; no defect.

### `cal-paths-98` — `CLOSED_ROUTE_EDGE`

- Mutation: `closed_route_edge`, `changedFields:["assets"]`; removed edge `(1,0)–(1,1)`, `routeEdgeIndex:0`; visible graph has six edges; `solutionCount:0`; no offered label is valid.
- Expected blind: `no_unique`, accepted code `CLOSED_ROUTE_EDGE`; expected alignment: `fail`, accepted failing field `assets`.
- The wall is added to the source maze and to all four option mazes. The source wall is at x=104, y=172–212 (SVG); the option A wall is at x=88, y=680–720. The option A route line is `68,700 → 108,700 → 108,740 → 108,780 → 148,780 → 188,780`; it crosses the new wall at x=88, y=700. The wall is drawn over the route (the wall crop contains 368 black pixels and no blue route pixels; in the sound image the same crop contains 32 blue route pixels).
- Pixel evidence: sound vs defective full-image difference 1,030 px; source-maze difference bbox x=100–107, y=176–211 (8×36); option A difference bbox x=84–91, y=684–719 (8×36); five added walls total.
- Model blind (raw artifact 9, provider `Google AI Studio`): `selected A`, reasoning claims “Option A is the only path that stays entirely within the active, open corridors and does not cross any walls…”. 1,039 completion tokens, 915 reasoning tokens, `finish_reason:"stop"`.
- Model alignment (raw artifact 10, provider `Google`): all fields pass; `options` reason: “The options correspond to labeled visual tiles showing distinct candidate paths, with option A matching the unique valid route”; `image` reason: “The image clearly and accurately depicts the maze structure, start S, goal G, and candidate paths A through D.” 522 completion tokens, 0 reasoning tokens.
- Root cause: **model behavior failure** — the model did not register the visible wall or the route/wall intersection in either mode. The wall is present, drawn over the route, and visible in the 1024 PNG. No overlay hides the source wall; the option overlay is the wall covering the route, which makes the defect visible rather than hidden.
- Ground truth: visible and unambiguous at the sent 1024×1024 resolution. The only unresolved visibility question is provider-side image preprocessing/downsampling (usage reports `image_tokens:0`; the provider mix for the blind call was `Google AI Studio` while the alignment call used `Google`).

### `cal-paths-99` — `DUPLICATE_CORRECT_OPTION`

- Mutation: `duplicate_correct_option`, `changedFields:["assets"]`; option B duplicates visible correct option A; `duplicatedValueHash:0b14f82ae3c6e641f4e524bfe7e335ea4e82519736b1fb84911d1d445c2c1eaf`; correct label A.
- Expected blind: `defect`, accepted code `DUPLICATE_CORRECT_OPTION`; expected alignment: `fail`, accepted failing field `assets`.
- Structural comparison: the original choice values are distinct (A is the short route; B is a longer route). The visible B tile is A translated by +480 px: A points `68,700 108,700 108,740 108,780 148,780 188,780`; B points `548,700 588,700 588,740 588,780 628,780 668,780`.
- Visual comparison: the A and B maze crops in the sent PNG are pixel-identical — **0 differing pixels** over the 140×140 crop; the labels A and B differ outside the crop. The duplicate is exact and visible if the tiles are compared.
- Pixel evidence: sound vs duplicate full-image difference 4,488 px in the option B area (bbox x=540–635, y=652–787).
- Model blind (raw artifact 11, provider `Google`): `answerStatus:"selected"`, `chosenOption:"B"`; the reasoning is a long, self-contradictory comparison of A and B that never concludes “duplicate” or “no unique answer”. 3,316 completion tokens, 0 reasoning tokens, `finish_reason:"stop"`.
- Exact schema failure reproduced offline:

```json
[
  {
    "origin": "string",
    "code": "too_big",
    "maximum": 2000,
    "inclusive": true,
    "path": ["reasoning"],
    "message": "Too big: expected string to have <=2000 characters"
  }
]
```

- The stored call record says only `blind response does not satisfy the strict schema`; the exact issue is the overlong `reasoning` field. The response selected B (the duplicate) and did not flag the duplicate. If the reasoning had been within the 2000-character schema limit, the response would have been schema-valid and scored as a **false negative** (`sound`), not a pass.
- Model alignment (raw artifact 12, provider `Google`): all fields pass; `options` reason: “Option A uniquely matches the correct path from S to G through open corridors”; `image` reason: “The image clearly and legibly depicts the maze, start S, goal G, walls, open corridors, and candidate paths A through D.” 432 completion tokens, 0 reasoning tokens.
- Root cause: **model behavior failure** (blind selected the duplicate; alignment missed the duplicate) plus **model output-format failure** (reasoning exceeded the schema limit). No rendering/serialization defect in the PNG/SVG/request; no scoring misclassification.

## Evaluation pipeline check

- The blind parser applies `BLIND_REVIEW_RESPONSE_SCHEMA`; the overlong `reasoning` is rejected exactly at `path:["reasoning"]` with `too_big`/max 2000. The calibration record classifies the call as `error`; the pilot pass criterion requires 12/12 schema-valid calls and fails. This is conservative and correct.
- The alignment parser applies the v2 fields-only schema and derives the overall in code. All three alignment responses are schema-valid with all fields pass; the derived overall is `pass`; the score buckets are `sound`. No model finding was present in those responses, so nothing was lost.
- The scoring does not convert the schema error into a pass. The error bucket for `cal-paths-99` blind is correct. The false negatives for `cal-paths-98` blind/alignment and `cal-paths-99` alignment are model behavior, not scoring.
- **Observability gap (minor):** the stored call record/score case says only “blind response does not satisfy the strict schema”; the exact Zod issue is not recorded in the call record. The raw response artifact and the offline re-parse preserve the exact issue. This is a diagnostic-observability defect, not a scoring misclassification. A minimal improvement is to store the first Zod issue path/message in the call record or score case; the raw response remains the evidence.

## Deterministic validators and production safety

- `ChoiceSetSchema` rejects duplicate choice values and a correct label that does not identify exactly one choice; `assertAssembledPresentation` rejects duplicate visible option texts. The text/matching duplicate fixtures are caught by these validators.
- The paths duplicate is a **deliberate visible-asset mutation**: the original choice values A and B are distinct, the visible option texts are generic (`See labeled tile A/B/C/D`), and the duplicate exists only in the rendered option tiles. The normal production renderer draws the option tiles from the distinct choice values, so it would not produce this duplicate from the normal input. The calibration mutation bypasses the normal renderer to test the reviewer’s visual comparison. This is not a hole in the normal production input validation, but a rendered-tile duplicate check (hash the rendered option tiles) would be a reasonable production hardening if the renderer can ever receive duplicate assets from another source. The implemented `src/calibration/asset-audit.ts` now performs this check on the actual serialized SVG/PNG and remains separate from the model score.
- The closed-route mutation is likewise a deliberate visible-asset mutation: the DSL and original choices remain the sound version; the visible image has an extra wall. The normal deterministic pipeline does not compare the rendered image to the DSL; the alignment reviewer is expected to do that comparison. The calibration tests the reviewer’s visual/structural alignment, not a production validation hole.
- No production validator was changed in this task.

## Ground truth assessment

- The closed edge is visible and unambiguous at the sent 1024×1024 resolution: an 8×36 px black wall, 368 black pixels in the wall crop, drawn over the option A route so the route is interrupted. The source maze wall has no route/option overlay; the option wall covers the route, not the reverse.
- The duplicate is visible and unambiguous: the A/B maze crops are pixel-identical (0 diff); only the labels differ. A human comparing the tiles can see the duplicate.
- The pilot labels are code-derived (`provenance:"mock_test_only"`, `human_verified:false`), not independent human labels. The formal mutation details and the pixel evidence independently support the expected truth. The v2 labels are a separate delegated-review set; they do not change the pilot evidence.
- Unresolved human questions:
  1. Does the provider’s vision preprocessing preserve the 8 px wall at the model’s actual input resolution? The sent PNG is 1024×1024, but provider-side resizing is not recorded (`image_tokens:0`); the blind providers differed (`Google AI Studio` for `cal-paths-98`, `Google` for the others). This remains open after the medium/Sonnet follow-up.
  2. Is an 8 px wall in a 40 px cell salient enough for the intended reviewer, or should the paths fixture use a larger wall/zoom (a fixture change requiring a new protocol version)? This remains open and is the leading candidate for the closed-route fix.
  3. Should the blind/alignment prompts explicitly require pairwise option-tile comparison and route-edge-versus-wall verification (a prompt change requiring a new P45/P46/pilot)? Addressed by the v3 prompts; the follow-up shows the v3 prompts did not fix the closed-route, while Sonnet detected the duplicate.
  4. Should the reasoning-length schema remain 2000 characters, or should the model be given a stricter instruction/short output budget? The v3 prompts now require a short final rationale; the Sonnet duplicate-only response was short and schema-valid, and the 2000-character schema remains unchanged. The old `cal-paths-99` generic record is historical; new runs record the exact Zod issue.

## Minimal recommended fixes

These are the original pre-remediation recommendations; the implemented audit and the v3/medium/Sonnet results are recorded in `Post-remediation result`. Item 3 was executed with Sonnet 5.5 under the current v3 contract: it detected the duplicate but not the closed-route.

1. **No change in this diagnostic task.** Do not change prompts, model settings, schemas, fixtures, or thresholds based on these three cases.
2. **Evaluation observability only:** include the first exact Zod issue (path/message) in the calibration call record/score case. The raw response is already preserved; this is not a scoring change and does not affect the pass criterion.
3. **Next model test:** evaluate a stronger SVG reviewer (the previously mentioned Claude Sonnet 5.5 reserve) under the current v3 P46 contract and a paths-focused pilot. This was executed; Sonnet detected the duplicate but still missed the closed-route. Do not replace Gemini solely from these three cases; the failures are consistent with a capability/formatting gap, but the sample is tiny.
4. **Alternative paths diagnostic:** test a paths-specific prompt or a larger/zoomed wall rendering as a new configuration. A prompt or fixture change requires a new P45/P46/pilot and must not be retrofitted into the existing evidence. The closed-route case remains the unresolved target.
5. **Optional production hardening:** hash the rendered option tiles and reject a duplicate rendered tile; compare rendered walls to the DSL. The implemented audit now performs the rendered option-crop duplicate check and the rendered-scene/DSL validation; it remains separate from the model score. The normal renderer uses distinct choice values, so this is hardening, not a fix for the calibration mutation.
6. **Preserve** the pilot artifact, manifest, labels, scores, P46 artifacts, and v2 pack/labels unchanged.

## Protocol phases and tests to repeat

- **Vision-model swap only (no prompt/schema change):** P46 live preflight with the new `VISION_REVIEWER_MODEL` (five probes, current v3 contract, production caps), a paths-focused pilot, then a new P48 v2 calibration. P45 full mock is not required unless code/schema/prompt changes. The follow-up executed the Sonnet 5.5 P46 and paths pilot; it detected the duplicate but not the closed-route, and no P48 was reached.
- **Prompt or schema change:** P45 full mock, P46, paths-focused pilot, then P48 v2. The v2 pack and labels remain unless fixtures change.
- **Fixture change (larger wall/zoom/new paths cases):** new calibration pack version and labels (P40/P41/P45/P46/P47/P48); the existing v1/v2 artifacts stay preserved.
- **Evaluation observability change only:** rerun the affected calibration tests and `npm run check`; if the artifact/call-record schema changes, a new calibration evidence run is required for the new format.
- **This diagnostic task:** no paid calls; existing offline checks were run:
  - `npm run check` — 50 files / 644 tests passed at the time of the original diagnostic; the later remediation full suite passed 51 files / 649 tests (see `Post-remediation result`). Lint, typecheck, build passed.
  - `npm exec -- vitest run tests/calibration/pilot.test.ts` — 7 passed.
  - `npm exec -- vitest run tests/calibration/fixtures-v2.test.ts` — 1 passed.
  - Offline PNG/request/schema reconstruction — all six request hashes match, all six decoded PNG hashes match the labels and stored images, and the exact `cal-paths-99` blind schema issue is `reasoning` too_big/max 2000.
  - Pilot manifest re-hash — 12/12 files, 0 hash mismatches.
  - V2 pack/labels — 40 rows, labels hash `2c4e2e45728a0d48492e905137ab9de2be76509f3c8dff0e4726e9ec0237fec5`, unchanged by this task.

## Post-remediation result — 2026-11-07

The deterministic asset audit recommended above is implemented in `src/calibration/asset-audit.ts`, covered by `tests/calibration/asset-audit.test.ts`, and exposed as `npm run calibration -- --audit-assets`. It parses the serialized SVG with `parseScene`, calls `pathsRenderer.assertScene(scene, originalSpec, originalChoices)`, re-renders the parsed scene and compares the actual PNG with `assertRasterEquivalent`, hashes normalized `option-*-maze` crops without the A-D labels, detects exact duplicate crops, and requires exactly one valid option. The audit is a separate deterministic channel: it does not change the model score, does not rewrite the pilot's false negatives, and does not narrow the calibration denominators.

Actual audit results on the pilot assets:

| Fixture | Existing scene validator | PNG/raster | Option crops | Valid options |
| --- | --- | --- | --- | --- |
| `cal-paths-97` | PASS | raster-equivalent | 4 distinct | 1 |
| `cal-paths-98` | `UNEXPECTED_WALL` | raster-equivalent | 4 distinct | 0 |
| `cal-paths-99` | `WRONG_ROUTE` | raster-equivalent | 3 distinct; duplicate A/B | 2 |

The vision prompts were revised to v3 (`src/ai/prompts/v3/blind-vision.txt`, `alignment-vision.txt`) to require systematic all-option route tracing, pairwise tile comparison, route-vs-wall verification, distractor tolerance, duplicate/no-valid handling, and a short final reasoning field; the alignment prompt also states that reporting a defective image is not adjudication. The v3 prompt change is a new configuration and invalidates the earlier vision calibration evidence.

P46 v3 `2082fa49-994b-4e45-85c4-7b59a11da941` passed 5/5 with the same models and low vision effort, total USD 0.01422115. The prompt-only paths pilot `7fad3123-4b0b-4912-b043-7c03b11b6c3c` used new same-base paths cases at slots 105-107 (sound/closed-route/duplicate) and the v3 prompts. It ran 5/6 calls and 3/3 observations at USD 0.01868025, paused on the `cal-paths-11` blind budget reservation, and failed:

- `cal-paths-09` sound: blind selected A; the alignment named D as the unique valid route. The sound blind is wrong.
- `cal-paths-10` closed-route: classified as sound in both blind and alignment; the closed edge was still missed.
- `cal-paths-11` duplicate: blind budget-refused; alignment not executed; the duplicate case is untested by the v3 prompt experiment.

The prompt-only experiment therefore did not fix the paths behavior. No model swap was performed at that point, and the current pilot remains FAIL.

### Medium-effort and Sonnet 5.5 follow-up

The next measured experiments changed one configuration at a time on new same-base paths cases at slots 108-110 (fixture IDs 12-14: sound, closed-route, duplicate) with the v3 prompts.

| Experiment | P46 | Paths pilot | Result |
| --- | --- | --- | --- |
| Gemini 3.8 Flash, medium effort | `54e397f7-e62e-4091-bb89-fd4ba22e9a86` 5/5, USD 0.0171879 | `94c76bf7-28e0-49d0-b594-1efa45cb347c` 4/6 calls, USD 0.035466, `paused_budget` | paths-12 sound correct; paths-13 closed-route missed; paths-14 duplicate untested |
| Sonnet 5.5, default effort | `5684cc06-24d5-46e5-8711-94630f6bf903` 5/5, USD 0.0223404 | `a39eed3c-b171-49e9-be03-810a2dd7586e` 5/6 calls, USD 0.109458, `paused_budget` | paths-12 sound correct; paths-13 closed-route missed; paths-14 duplicate untested |
| Sonnet 5.5, duplicate-only focused diagnostic | same P46 | `38798cfa-15bb-46ec-adfc-aed80d326ae1` 2/2 calls, USD 0.046904, `completed` | duplicate blind and alignment both `defective`/conservative true; `pilotPass:false` only because the focused pack has no sound case (not a calibration pass) |

The closed-route defect remains undetected by both Gemini 3.8 Flash and Sonnet 5.5 in the visual modes. The duplicate defect is detected by Sonnet 5.5 in both blind and alignment under the v3 prompts (`no_unique_answer`/`duplicate_options` blind; `options:fail`/`image:fail` alignment). At that point total known spend was USD 0.4071985; the targeted four-variant diagnostic below isolates the closed-route failure.

### Targeted four-variant closed-route diagnostic — 2026-11-07

The operator approved one final targeted diagnostic on the single problematic case `cal-paths-13`, using Sonnet 5.5 and the same image/prompt contract. The variants change the information or procedure available to the model and are explicitly **not calibration evidence** (`calibrationEligible:false`, `freezeEligible:false`).

| Variant | Change | Result |
| --- | --- | --- |
| A | original PNG + original v3 blind prompt (control) | `selected C` (control failure reproduced) |
| B | original PNG + explicit per-edge verification procedure | `selected D` (procedure did not help) |
| C | full original PNG + 4x zoom of the source edge (1,1)-(2,1) and the option C edge | `selected D` (visual detail did not help) |
| D | text-only open-edge list; no image | `no_unique_answer`, issue `no_correct_option` (logical decision correct) |

A/B are in `data/paths-diagnostic/03992846-9d26-4588-b00d-edbf08cbb5f7/`; the first run paused at C on the admission reservation after A/B, so C/D were completed in the focused run `data/paths-diagnostic/64877ad9-8b6c-48fa-81ed-c001e6f77e0e/`. The combined machine-readable report is `data/paths-diagnostic/combined-2026-11-07.json`. The combined result is **D succeeds, A fails, B/C fail**: the primary classification is **visual interpretation**. The first artifact labels the budget-refused C as `schema_error` because the distinct `budget_refused`/`transport_error` buckets were added after that run; its `error` field records `BUDGET_NOT_ADMITTED: INSUFFICIENT_BUDGET`. New runs use the distinct buckets. The diagnostic CLI now caps new runs at the remaining envelope (admission and actual guard USD 0.05); the completed runs used the earlier 0.25 admission cap and 0.10 actual guard. The rules/logic formulation is sound (D returns `no_unique_answer` with `no_correct_option`), the explicit edge-check procedure does not fix the visual failure, and the zoomed source/option-C crop does not fix it either. The image variants still select an offered route, while the edge-list variant correctly concludes that no route is valid.

Costs: A/B USD 0.040836; C/D USD 0.044802; diagnostic total USD 0.085638. Total known spend is now **USD 0.4928365** (USD 0.4071985 + USD 0.085638); the combined authorization is USD 0.55, leaving **USD 0.0571635**. The full suite passed 52 files / 651 tests. No v2 P48 calibration was run. The next step is a closed-edge visual-representation experiment (larger/contrast/zoom as a new fixture configuration) or a new calibration contract that assigns structural defects to the deterministic validator and narrows the AI reviewer role; the deterministic audit remains the production-hardening/diagnostic channel.

## File references

- `data/calibration-pilot/2ebf4403-947f-486a-b2e4-a2f924f05e0b/pilot.json`
- `data/calibration-pilot/2ebf4403-947f-486a-b2e4-a2f924f05e0b/score.json`
- `data/calibration-pilot/2ebf4403-947f-486a-b2e4-a2f924f05e0b/requests.jsonl`
- `data/calibration-pilot/2ebf4403-947f-486a-b2e4-a2f924f05e0b/responses.jsonl`
- `data/calibration-pilot/2ebf4403-947f-486a-b2e4-a2f924f05e0b/labels.csv`
- `data/calibration-pilot/2ebf4403-947f-486a-b2e4-a2f924f05e0b/pilot.sqlite` (raw response artifacts 7–12)
- `data/calibration-pilot/2ebf4403-947f-486a-b2e4-a2f924f05e0b/images/cal-paths-97.png`, `cal-paths-98.png`, `cal-paths-99.png` and the corresponding SVGs
- `data/calibration-pilot/2ebf4403-947f-486a-b2e4-a2f924f05e0b/manifest.json`
- `data/preflight/2082fa49-994b-4e45-85c4-7b59a11da941/` (v3 P46)
- `data/calibration-pilot/7fad3123-4b0b-4912-b043-7c03b11b6c3c/` (v3 prompt-only paths pilot)
- `data/preflight/54e397f7-e62e-4091-bb89-fd4ba22e9a86/` (medium-effort P46)
- `data/calibration-pilot/94c76bf7-28e0-49d0-b594-1efa45cb347c/` (medium-effort paths pilot)
- `data/preflight/5684cc06-24d5-46e5-8711-94630f6bf903/` (Sonnet 5.5 P46)
- `data/calibration-pilot/a39eed3c-b171-49e9-be03-810a2dd7586e/` (Sonnet paths pilot)
- `data/calibration-pilot/38798cfa-15bb-46ec-adfc-aed80d326ae1/` (Sonnet duplicate-only diagnostic)
- `data/paths-diagnostic/03992846-9d26-4588-b00d-edbf08cbb5f7/` (four-variant diagnostic; A/B, paused at C)
- `data/paths-diagnostic/64877ad9-8b6c-48fa-81ed-c001e6f77e0e/` (focused C/D diagnostic; completed)
- `data/calibration-v2/c8bacdf030974d1c4c56fc3ec79cf2d43e19c8c21514da63bd26eb01cf1442dc/labels.human.csv` (separate v2 evidence; unchanged)
- `src/calibration/asset-audit.ts`, `tests/calibration/asset-audit.test.ts` (deterministic audit)
- `src/calibration/paths-diagnostic.ts`, `src/cli/paths-diagnostic.ts`, `tests/calibration/paths-diagnostic.test.ts` (targeted four-variant diagnostic)
- `package.json` (`paths-diagnostic` script)
- `src/ai/prompts/v3/blind-vision.txt`, `src/ai/prompts/v3/alignment-vision.txt` (v3 vision prompts)
- `src/calibration/fixtures.ts` (pilot pack builders, deterministic reconstruction)
- `src/cli/calibration.ts` (`--audit-assets`, `--audit-set`, `--pilot-set`)
- `src/ai/schemas.ts` (blind/alignment schemas; exact offline re-parse)
- `src/calibration/score.ts` (score buckets; no changes)
- `docs/PROVIDER_SMOKE_TESTS.md`, `docs/PROGRESS.md`, `README.md` (current totals and experiment records)
