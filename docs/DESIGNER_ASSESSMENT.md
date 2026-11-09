# Designer Assessment — AI Puzzle Factory v2.0

**Date:** 2026-11-09  
**Protocol:** `b4ec6d64e122c40ca6bf2a95e7c46057f61caea411ca6f8ce3e1206faa3cbd77`  
**Freeze:** `0c0bab2a2cf64e82924623b2bc4758f3328bf12f6df6edae3a906e4a42b31f32`  
**Primary run:** `54e458f7-1297-4397-8ddc-0d02cb0cac0b`  
**Recommendation:** **`revise`**

## 1. Scope

This experiment measures AI design inside the ten bounded puzzle DSLs (ranking, matching, scheduling, truth, arithmetic, matrix, transforms, paths, symmetry, counting). It does not measure arbitrary puzzle invention, general human readability, production readiness, or a remediation-success rate. The deterministic solver is the formal acceptance judge; the AI never supplies answers, options, SVG/XML, or code.

The final decision uses the frozen P50.2 decision evaluator and the frozen section 9.3 thresholds. No threshold, sample, prompt, model, rubric, or evaluator was changed after observing the primary cohort.

## 2. Evidence identity

| Item | Value |
| --- | --- |
| Plan hash | `0e640131fc212612e6aa3661421c1ca4ee845316a22522ead3385a8e7f0a7c0b` |
| Configuration hash | `62c5e8741c3950efbbdf8b24ca196bb3694ea38a30c71fffaf18577315f0407c` |
| Decision evaluator hash | `a210a0695ee1fb79ef5d9a28736e2f661a0c049e75156df5c6c9fa91153bc6ad` |
| Pilot run | `104e8d5b-f999-4632-8380-f2e3326f80d6` |
| Provenance archive | `c5807d1f266304356ec8e18719e639e7bd172fd6b6ae4b5a5249ce9584ab853f` |
| Price snapshot | `eec87d385441c673d3290b69194738fa31542ce3f292a31b6f72f947d7d20a04` |
| Budget addendum | `ae1cb8cf1206542e88613351c30699b08d7d6b9e2aa1f2a35d4275e3edb265bd` |
| Operator authorization | `data/p52r2-primary-authorization.json` |
| AI-assisted waiver | `data/runs/54e458f7-1297-4397-8ddc-0d02cb0cac0b/design-evaluation/human-verification-waiver.json` (`1ba276aa...`) |
| Formal decision artifact | `data/runs/54e458f7-1297-4397-8ddc-0d02cb0cac0b/decision.json` |
| Current decision hash | `2a5303ff097d97652ed64ce6f9a2c98950dddd5ab25444a2f78150c103c6ada0` (evaluated `2026-11-09T14:59:24.767Z`; regenerated on each report run) |

The formal decision hash is regenerated on every `npm run report` run because `evaluatedAt` is part of the decision body. The current run produced `revise`; the artifact is authoritative for the exact hash.

## 3. Recommendation

**`revise`.**

- All formal section 9.3 predicates pass; `failedPredicates=[]` and `strongFailures=[]`.
- The frozen decision evaluator reports `revise` because the four human predicates are incomplete: no genuine human evaluation exists, and the imported labels are synthetic test-only (`genuineHumanLabels=false`).
- The operator-authorized AI-assisted evaluation also reports `revise`: the clarity/time gate is 8/20 against the 16/20 threshold, and truth/arithmetic/paths readability observations remain. After the transform inspection, no blocking correctness defect remains, and the paired interest/clarity gates are 10/10.
- The recommendation is not `proceed` because there is no genuine human evidence and the AI-assisted clarity/time gate fails.
- The recommendation is not `reject` because there is no complete strong failure and no unresolved blocking correctness defect after the recorded inspection.

## 4. Cohort completion

| Item | Value |
| --- | ---: |
| Assignments | 100 |
| Candidate slots | 300 |
| Terminal candidates | 300 |
| Accepted | 289 |
| Rejected | 7 |
| Inconclusive | 0 |
| Generation errors | 4 |
| Missing/refilled | 0 |
| AI logical calls | 210 |
| Design attempts | 310 |
| Transport requests | 210 |
| Known cost | USD `2.564292225` |
| Unknown cost exposure | 0 |
| Reserved at finish | 0 |
| Authorized cap | USD 12 |
| Budget pauses/overshoots | 0 |
| Wall time | 1,705,347 ms (about 28.4 minutes) |

No candidate was lost. Failed, rejected, and generation-error slots remain in the cohort; none were refilled or replaced.

## 5. Three-arm results

| Arm | Planned | Final accepted | Rejected | Generation errors | Repaired | Novel | Distinct structures | Known cost | HTTP p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 100 | 100 | 0 | 0 | 0 | 0 | 97 | USD 0 | n/a |
| AI one-shot | 100 | 91 | 7 | 2 | 0 | 76 | 84 | USD `1.228717` | 31,320 ms |
| AI feedback | 100 | 98 | 0 | 2 | 10 | 80 | 86 | USD `1.335576` | 32,501 ms |

Feedback first-attempt acceptance was 88/100; final acceptance was 98/100, a 10 percentage-point lift. All 10 repairable first failures were repaired. One-shot first/final acceptance was 91/100.

## 6. Modality and family cells

### Modality

| Arm | Text accepted | SVG accepted |
| --- | ---: | ---: |
| Baseline | 50/50 | 50/50 |
| AI one-shot | 48/50 | 43/50 |
| AI feedback | 48/50 | 50/50 |

The frozen decision predicate reports the all-arm modality strata as 146/150 text and 143/150 SVG; those are not feedback-only denominators. The feedback-only cells are 48/50 and 50/50.

### Family (feedback arm)

| Family | Accepted | Novel |
| --- | ---: | ---: |
| arithmetic | 10/10 | 10 |
| counting | 10/10 | 10 |
| matching | 10/10 | 6 |
| matrix | 10/10 | 6 |
| paths | 10/10 | 9 |
| ranking | 9/10 | 7 |
| scheduling | 9/10 | 7 |
| symmetry | 10/10 | 10 |
| transforms | 10/10 | 9 |
| truth | 10/10 | 6 |

All families have at least 3 novel final accepted candidates. Baseline accepted 10/10 in every family.

### Difficulty (accepted)

| Arm | D1 | D2 | D3 |
| --- | ---: | ---: | ---: |
| Baseline | 40/40 | 30/30 | 30/30 |
| AI one-shot | 40/40 | 27/30 | 24/30 |
| AI feedback | 40/40 | 30/30 | 28/30 |

## 7. Repairs and failures

- Feedback repairable first failures: 10 (9 paths, 1 counting); repaired accepted: 10/10.
- One-shot paths: 4/10 accepted, 6 rejected; one-shot counting: 9/10 accepted, 1 rejected.
- Feedback paths: 10/10 accepted (9 repaired); feedback counting: 10/10 accepted (1 repaired).
- Failure-code distribution: one-shot 7 `SCHEMA_INVALID` + 2 `GENERATION_ERROR`; feedback 10 `SCHEMA_INVALID` first attempts + 2 `GENERATION_ERROR`. No `SOLVER_LIMIT` inconclusive outcomes.
- All failures, repairs, and costs are visible in `design-attempts.jsonl`, `requests.jsonl`, and the HTML report.

## 8. Novelty and structural diversity

| Arm | Novel | Baseline duplicate | Near baseline | Novelty unknown | Distinct final structures |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline | 0 | 100 | 0 | 0 | 97 |
| AI one-shot | 76 | 9 | 6 | 0 | 84 |
| AI feedback | 80 | 13 | 5 | 0 | 86 |

Frozen and cohort reference coverage is complete; no candidate has `novelty_unknown`. Novelty is a structural proxy against the baseline corpus, not semantic originality or a formal rejection.

## 9. Cost, latency, and usage

- Total known AI cost: USD `2.564292225`; unknown exposure 0; reserved 0; cap USD 12.
- One-shot: USD `1.228717` for 100 calls, USD `0.013502` per final accepted, USD `0.016167` per novel accepted, 702,689 tokens.
- Feedback: USD `1.335576` for 110 calls, USD `0.013628` per final accepted, USD `0.016695` per novel accepted, 785,630 tokens.
- Baseline: zero AI calls, zero AI cost, 0 tokens.
- Provider mix: one-shot Google 98 / Google AI Studio 2; feedback Google 109 / Google AI Studio 1.
- Model mix: `google/gemini-3.8-flash` for all 210 AI calls.
- Latency: one-shot HTTP p95 31,320 ms; feedback HTTP p95 32,501 ms; active mean 44,025 ms and 45,357 ms; wall time 1,705,347 ms.
- No NaN, Infinity, or unknown-as-zero values were found in the reconciled metrics.

## 10. Human and AI-assisted evaluation

The prepared sample is `32ca68eaa5f75c70184b2825b944789d9e0a587a7142f8f40d9d7818a2637929`: 10 assignment-matched triplets (30 core candidates), 10 additions, 40 puzzles, no shortfalls, no missing families. The public bundle hides arms; the private bundle contains all three.

The operator explicitly waived genuine human verification and authorized AI-assisted evaluation as the substitute. The AI-assisted labels are synthetic (`synthetic=true`, auditor `ChatGPT (synthetic AI assessment; not a human)`) and are not human observations. The waiver and raw evidence are under `data/runs/54e458f7.../design-evaluation/`.

| Measure | AI-assisted value |
| --- | ---: |
| Core inspected | 30/30 |
| Core AI members clear and solved within 180 s | 8/20 |
| Raw defect notes (all 40) | 24 |
| AI notes: potential blocking transform defects | 4 (items 19, 20, 21 core; 33 addition) |
| AI notes: observational notes | 20 |
| Paired interest | 1 win + 9 ties = 10/10 |
| Paired clarity | 0 wins + 10 ties = 10/10 |
| Individual difficulty ratings (all 40) | 2: 16, 3: 16, 4: 8; mean 2.8 |
| Paired difficulty, all within-triplet (30) | 2 left, 2 right, 26 ties |
| Paired difficulty, feedback vs baseline (10) | 1 win + 9 ties = 10/10 |
| Pre-reveal selections | 32/40 |
| Pre-reveal matches | 30 |
| Pre-reveal mismatches | 2 (XOR items 16 and 18) |
| Pre-reveal blanks | 8 |
| Proof metadata passes | 40/40 |

The raw 24 defect notes must not be presented as 24 confirmed defects: the AI draft used `defect_notes` for observations as well as potential defects. The four conservative transform legibility flags were inspected in Chromium; the source-side text “Top marker = viewer up” is visible and not overlapped, and the orientation is repeated in the second instruction block. This is an agent inspection, not human verification or a device-matrix test.

Difficulty ratings and preferences are synthetic AI judgments, not measured human difficulty; ties dominate the pairwise results, and the 30-pair table is not a feedback-vs-baseline denominator. The feedback-vs-baseline difficulty comparison is the 10-pair row.

The AI-assisted conclusion is `revise`: clarity/time fails at 8/20, and truth/arithmetic/paths readability observations remain. After inspection, no blocking correctness defect remains; paired interest/clarity are 10/10. The formal frozen decision is also `revise`, with `failedPredicates=[]`, `strongFailures=[]`, and `genuineHumanLabels=false`.

Limitations: solve-time categories are AI guesses, not observations; visual puzzles were not all independently formalized and solved pixel-by-pixel; a single AI evaluator produced the labels; the transform inspection is one Chromium render; ranking items 2 and 3 are publicly identical despite separate arms, so their tie is not independent diversity evidence.

## 11. Frozen section 9.3 predicates

| Predicate | Observed | Threshold | Status |
| --- | --- | --- | --- |
| Cohort completion | 100 assignments / 300 candidates | complete | pass |
| Feedback final acceptance overall | 98/100 (98.00%) | >= 60% | pass |
| Feedback final acceptance text | 146/150 (all-arm strata) | >= 50% | pass |
| Feedback final acceptance SVG | 143/150 (all-arm strata) | >= 50% | pass |
| One-shot first acceptance | 91/100 (91.00%) | >= 40% | pass |
| Repair capability | 10/10 repaired; lift 10.00 pp | >= 20% and >= 5 pp | pass |
| Novelty overall | 80/100 (80.00%) | >= 30% | pass |
| Novelty per family | all families >= 3 | >= 3 per family | pass |
| Distinct feedback structures | 86 | >= 50 | pass |
| Reference coverage | frozen/cohort complete | complete | pass |
| Cost per novel accepted | USD 0.016695 | <= USD 0.50 | pass |
| Human correctness | 30/30 inspected; 24 raw defect notes | 30/30; 0 unresolved | incomplete (synthetic) |
| Human clarity/time | 8/20 | >= 16/20 | incomplete (synthetic) |
| Paired interest | 10/10 wins or ties | >= 7/10 | incomplete (synthetic) |
| Paired clarity | 10/10 wins or ties | >= 8/10 | incomplete (synthetic) |

`failedPredicates=[]`; `strongFailures=[]`. The four human predicates are incomplete because the labels are synthetic, not because a formal gate failed.

## 12. Why `revise`

- The primary cohort is complete, trustworthy, and reproducible: 300/300 terminal candidates, all costs known, no budget pause, and a protocol/config match.
- The formal frozen evaluator cannot recommend `proceed` without genuine human labels. The operator waived genuine human verification, but the labels remain synthetic and the frozen evaluator correctly treats them as test-only.
- The operator-authorized AI-assisted evaluation independently fails the clarity/time gate at 8/20 and records readability observations for truth, arithmetic, and paths.
- There is no complete strong failure, and the four conservative transform legibility flags did not reproduce as blocking defects in the inspected render. Therefore `reject` is not supported.
- A future `proceed` would require either genuine human evaluation under the original P54 protocol or a new documented protocol that explicitly changes the human-evidence rule, plus presentation improvements for the observed readability issues. This report does not claim a remediation-success rate.

## 13. Reproducibility

| Command | Result |
| --- | --- |
| `npm run report -- --run 54e458f7-1297-4397-8ddc-0d02cb0cac0b --protocol b4ec6d64...` | `revise`; `failedPredicates=[]`, `strongFailures=[]`, `genuineHumanLabels=false`; writes `report.html` and `decision.json`. |
| `npm run export -- --run 54e458f7... --format csv` | writes `results.csv`. |
| `npm run export -- --run 54e458f7... --format jsonl` | writes `candidates.jsonl`, `design-attempts.jsonl`, `requests.jsonl`. |
| `npm run test:browser` | 10/10 passed. |
| `npm run check` | lint, typecheck, 64 files / 805 tests, build — pass. |
| Aggregate reconciliation | 300 slots / 300 terminal; 300 candidates; 310 design attempts; 210 requests; cost `2.564292225`; unknown 0; protocol/config match. |

Raw evidence: `data/runs/54e458f7-1297-4397-8ddc-0d02cb0cac0b/` with `candidates.jsonl`, `design-attempts.jsonl`, `requests.jsonl`, `results.csv`, `summary.json`, `manifest.json`, `report.html`, `decision.json`, `puzzles/`, `images/`, and `design-evaluation/`. Provenance: `data/protocols/b4ec6d64.../protocol.json`, `provenance/`, `budget-forecast-addendum.json`, `price-snapshot.json`.

## 14. Out of scope

Automatic remediation, production launch, arbitrary puzzle generation, reintroducing AI reviewers, changing thresholds after observation, refilling failed assignments, and claiming human readability from solver correctness.
