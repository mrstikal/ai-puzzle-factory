# Primary Verdict Truth Table (P31)

P31 reduces one candidate's persisted evidence to a pure primary verdict. It does not schedule work, call a provider, mutate stages, or rewrite failures.

## Output contract

`reducePrimaryVerdict(input)` returns:

| Field | Meaning |
| --- | --- |
| `verdict` | Quality label: `approved`, `rejected`, `inconclusive`, `generation_error`, or `null` when the candidate has no quality verdict yet. |
| `completion` | `complete` for a quality verdict, `incomplete` for unstarted/in-progress/paused preparation. |
| `proceed` | Business authorization. True only for `approved` with no business blocker. |
| `primaryFailure` | The highest-precedence quality-deciding failure code, or null. |
| `businessBlockers` | Non-quality blockers, currently `COST_UNKNOWN`. |
| `failures` | Every input failure record, plus any derived code needed by the table. |
| `rationale` | Short deterministic explanation. |

`verdict: approved` plus `proceed: false` is intentional: cost uncertainty blocks business execution but does not reverse an otherwise valid quality label.

## Decision order

The reducer evaluates the following order and stops at the first matching row.

| Order | Condition | Verdict | Primary failure |
| --- | --- | --- | --- |
| 1 | `preparation` is `not_started`, `in_progress`, or `paused` | `null` / `incomplete` | null |
| 2 | `generation.state != usable`, or an `API_ERROR`/`SCHEMA_INVALID` failure at a generation-facing stage | `generation_error` | `API_ERROR`, then `SCHEMA_INVALID` |
| 3 | Formal or presentation check failed and a rejected-class failure exists | `rejected` | deterministic precedence |
| 4 | Formal or presentation check failed and only an inconclusive-class failure exists | `inconclusive` | inconclusive precedence |
| 5 | Formal or presentation check failed with no explanatory failure | `rejected` | null |
| 6 | Duplicate outcome is `exact_duplicate`, `spec_duplicate`, or `structural_duplicate` | `rejected` | `EXACT_DUPLICATE` or `STRUCTURAL_DUPLICATE` |
| 7 | Any rejected-class failure exists | `rejected` | deterministic precedence |
| 8 | `runControl` is `paused_budget`, `paused_operator`, `interrupted`, or `failed` and a required review is still pending | `null` / `incomplete` | null |
| 9 | Duplicate outcome is `near_suspected` | `inconclusive` | inconclusive precedence; `NEAR_DUPLICATE_SUSPECTED` only if no higher review concern |
| 10 | Blind review is missing when required, or a completed blind review is wrong/cannot solve/unclear/ambiguous/has issues | `inconclusive` | `MISSING_REVIEW`, `REVIEWER_DISAGREES`, `REVIEWER_CANNOT_SOLVE`, `VISION_REVIEW_UNCERTAIN`, `TEXT_SPEC_MISMATCH`, or `VISUAL_AMBIGUITY` |
| 11 | Alignment review is missing when required, or a completed alignment review is not `pass` | `inconclusive` | `MISSING_REVIEW`, `TEXT_SPEC_MISMATCH`, or `VISUAL_AMBIGUITY` |
| 12 | Any inconclusive-class failure remains | `inconclusive` | inconclusive precedence |
| 13 | Every required check passed and only `COST_UNKNOWN` remains | `approved` | null; `proceed=false` |
| 14 | Every required check passed with no failure | `approved` | null; `proceed=true` |
| 15 | Otherwise | `inconclusive` | inconclusive precedence or null |

## Required checks for approval

All of these must hold:

- `preparation = ready`
- `generation.state = usable`
- `formalPassed = true`
- `presentationPassed = true`
- duplicate outcome is `owner` or `unique`
- if blind is present/completed: `selected`, chosen label equals the code key, `clarity = clear`, `ambiguity = none`, `issues = 0`, and text legibility `not_applicable` or SVG legibility `legible`; if it is not completed, it must not be required
- if alignment is present/completed: `derivedOverall = pass`; if it is not completed, it must not be required
- no failure class other than `business`

A pending required check can never produce `approved`. A completed negative review is never ignored just because `required` is false; `required` controls only whether a missing review is a failure.

## Failure classes

| Class | Codes | Consequence |
| --- | --- | --- |
| `generation_error` | `SCHEMA_INVALID`, `API_ERROR` at generation-facing stages | `generation_error` |
| `rejected` | `UNSAT`, `MULTIPLE_SOLUTIONS`, `MULTIPLE_ANSWERS`, `DUPLICATE_OPTION`, `SVG_RENDER_INVALID`, `EXACT_DUPLICATE`, `STRUCTURAL_DUPLICATE` | `rejected` |
| `rejected` when `source=deterministic` | `TEXT_SPEC_MISMATCH`, `EXPLANATION_MISMATCH` | `rejected` |
| `inconclusive` | `SOLVER_LIMIT`, `NEAR_DUPLICATE_SUSPECTED`, `TEXT_SPEC_MISMATCH` (model), `EXPLANATION_MISMATCH` (model), `REVIEWER_DISAGREES`, `REVIEWER_CANNOT_SOLVE`, `VISION_REVIEW_UNCERTAIN`, `MISSING_REVIEW`, `VISUAL_AMBIGUITY`, `SCHEMA_INVALID`/`API_ERROR` at `blind_reviewed` or `alignment_reviewed` | `inconclusive` |
| `business` | `COST_UNKNOWN` | quality label unaffected; `proceed=false` |

`TEXT_SPEC_MISMATCH` and `EXPLANATION_MISMATCH` are model allegations by default. They become deterministic rejection only when the failure record's source is `deterministic`.

Generation-facing stages are `planned`, `spec_ready`, `formal_checked`, `presentation_ready`, `duplicate_checked`, and `terminal`. The review stages `blind_reviewed` and `alignment_reviewed` are not generation-facing; `API_ERROR`/`SCHEMA_INVALID` recorded there are inconclusive.

## Primary-failure precedence

- Generation: `API_ERROR`, `SCHEMA_INVALID`.
- Rejected: `UNSAT`, `MULTIPLE_SOLUTIONS`, `MULTIPLE_ANSWERS`, `DUPLICATE_OPTION`, `SVG_RENDER_INVALID`, `EXACT_DUPLICATE`, `STRUCTURAL_DUPLICATE`, `TEXT_SPEC_MISMATCH`, `EXPLANATION_MISMATCH`.
- Inconclusive: `REVIEWER_DISAGREES`, `REVIEWER_CANNOT_SOLVE`, `VISION_REVIEW_UNCERTAIN`, `MISSING_REVIEW`, `NEAR_DUPLICATE_SUSPECTED`, `SOLVER_LIMIT`, `TEXT_SPEC_MISMATCH`, `EXPLANATION_MISMATCH`, `VISUAL_AMBIGUITY`, `API_ERROR`, `SCHEMA_INVALID` (when classified inconclusive).

Every input failure is preserved in `failures` even when another code decides the verdict. `primaryFailure` selects the highest-precedence code in the chosen class.

## Edge cases

- **Correct reviewer, invalid spec:** formal/presentation failure plus `UNSAT` is `rejected`; the correct blind answer cannot upgrade it.
- **Incorrect reviewer, valid spec:** `REVIEWER_DISAGREES` is `inconclusive`, not `rejected`.
- **Blind/alignment conflict:** blind pass plus alignment `fail` is `inconclusive`.
- **Missing vision:** an SVG blind review that is not completed is `inconclusive` with `MISSING_REVIEW`, never `approved`.
- **Exact duplicate ownership:** the non-owner is `rejected` with `EXACT_DUPLICATE`; the owner can be `approved` if its own checks pass.
- **Near-pair suspicion:** both members are `inconclusive` with `NEAR_DUPLICATE_SUSPECTED`.
- **Paused/incomplete slot:** a slot with preparation `not_started`/`in_progress`/`paused` is `null`/`incomplete`, not `generation_error`. A run paused, interrupted, or failed with a required review still pending is also incomplete, but only after known generation/rejected outcomes have been reported.
- **Review-stage API/schema failure:** `API_ERROR`/`SCHEMA_INVALID` at `blind_reviewed` or `alignment_reviewed` is `inconclusive`, not `generation_error`; the missing review yields `MISSING_REVIEW` as primary.
- **Near pair plus review concern:** verdict is `inconclusive`; the review code wins primary precedence over `NEAR_DUPLICATE_SUSPECTED`.
- **Completed negative review marked not required:** its failure is still derived; it cannot be approved.
- **Cost unknown:** `approved` quality label remains, `proceed` is false, `businessBlockers` contains `COST_UNKNOWN`.
- **Solver limit:** `SOLVER_LIMIT` is `inconclusive`; a formal check that did not complete is not a deterministic disproof.
