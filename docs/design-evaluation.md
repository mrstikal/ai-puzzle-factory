# Designer human evaluation

This document is the fixed rubric for the designer protocol human-evaluation
sample. The sampler, CSV schema, and migration hashes are part of the frozen
protocol; changing this file changes `humanRubricHash` and requires new pilot
evidence before a live decision.

## Workflow

1. `npm run audit -- --design --run <design-id> --prepare`
2. Open `solve.html` and record pre-reveal observations in `labels.csv`.
3. Use `reveal.html` only after the pre-reveal observations are recorded.
4. Import the completed CSV with `npm run audit -- --design --run <design-id> --import <path>`.
5. Synthetic test labels are visibly marked and never satisfy live gates.

## Sample

The sampler selects up to ten family triplets after automatic verdicts and
final novelty annotations freeze. For each family it prefers the lowest-hash
assignment with accepted candidates in all three arms. If none exists it uses
the difficulty stratum with the most arms represented and records absent arms
as shortfalls. Up to ten additions are selected by repaired, novel,
near-baseline, least-represented-family, then least-represented-arm priority,
with candidate-hash ties. The maximum is forty candidates. The public solving
bundle contains only puzzles and opaque evaluation IDs; arm, assignment,
repair, cost, and novelty metadata live only in the private reveal bundle.

## Ratings

- Correctness: the displayed puzzle is solvable, unambiguous, and the revealed
  answer matches the visible conditions; hints and explanation steps are
  supported by visible facts.
- Clarity: 1-5. 4-5 counts as clear for the decision gate.
- Interest: 1-5 (1 repetitive/unengaging, 3 acceptable, 5 engaging/original
  within stated rules).
- Perceived difficulty: 1-5 (1 trivial, 3 moderate, 5 very hard). Appropriate
  difficulty is a separate preference, not an assumption that harder is better.
- Solve time: `<=60s`, `61-180s`, `>180s`, `not_solved`, `not_inspectable`.
- Pairwise interest, clarity, and appropriate-difficulty preferences:
  left/right/tie with a reason.

## Gates

The primary family-blocked gate is `ai_feedback` versus `baseline`;
`ai_one_shot` versus `baseline` is secondary. The proceed thresholds are fixed
in `src/reporting/design-decision.ts`: 30 core candidates inspected with no
unresolved correctness/ambiguity/legibility defect; at least 16 of 20 planned
core AI members clear and solved within 180 seconds; at least 7/10 interest
wins-or-ties and 8/10 clarity wins-or-ties for feedback versus baseline.
Missing or non-inspectable members remain in the planned denominator.

Labels are append-only. A new observation is a new revision with
`previous_revision` linking the prior revision. Import never updates or deletes
primary design attempts or verdicts. A genuine-label import requires
`synthetic=false`; `--synthetic-test` forces `synthetic=true` and is visibly
test-only.
