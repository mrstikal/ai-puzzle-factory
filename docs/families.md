# Family Contracts and Implemented Families

This document records the shared contract implemented in P04 and the family engines implemented after it. P04 provides the interfaces, validation, and bounded deterministic helpers that P05-P20 use; P05 adds the real ranking engine, P06 adds attribute matching, and P07 adds scheduling.

## Scope

P04 owns:

- `src/families/contracts.ts`: `FamilyEngine`, `VisibleRules`, fact IDs, `SolveResult`, and the strict `CanonicalStructure` schema.
- `src/families/canonicalize.ts`: stable serialization, feature extraction, multiset Jaccard/edit arithmetic, bounded permutation/cartesian enumeration, search counters, bitsets, and the reduced-clue-core helper.
- `src/families/registry.ts`: separate formal-engine and renderer registries.
- `src/domain/answers.ts`: deep option equality and seeded four-choice construction.

P04 does not implement a real family, a renderer, a model adapter, or a production placeholder. P05 registers ranking, P06 registers matching, and P07 registers scheduling; later phases add the remaining engines and renderers.

## Implemented Family Engines

### Ranking (P05)

Files: `src/families/ranking/schema.ts`, `src/families/ranking/engine.ts`, `src/families/ranking/canonical.ts`, `tests/families/ranking.test.ts`.

- **DSL:** `size` is 4 or 5. The spec contains 3-12 clues from `before(a,b)`, `immediatelyBefore(a,b)`, `at(a,position)`, and `notAt(a,position)`. Item IDs are integers `0..size-1`; positions are 1-based `1..size`; `before`/`immediatelyBefore` cannot point an item at itself. Visible labels are fixed `A..E`. Local fact IDs are `f001`, `f002`, and so on in stored clue order; the spec cannot supply arbitrary fact IDs.
- **Construction:** `constructRankingSpec(seed, difficulty)` chooses a hidden witness order, builds the finite pool of true non-anchor clues and true `at` anchors, samples 3-7 non-anchor clues, adds at most five `at` anchors until the order is unique, and at levels 2-3 removes half/all greedy redundant clues in seeded order while retaining at least three clues. The returned spec contains only `size` and `clues`; the trace records requested/added anchors and pruning counts, and construction uses at most 64 deterministic draws. Difficulty 1 uses size 4; levels 2-3 use size 5.
- **Solver:** `enumerateSolutions` independently enumerates 24 permutations for size 4 or 120 for size 5, re-evaluates every clue, and requires one full order. A unique result maps the order to labels `A..E` and adds one derived `s001` proof fact. Unsatisfiable and ambiguous specs carry no correct answer or proof.
- **Options:** `makeOptions` requires the unique satisfying answer, enumerates all other full orders, prefers distractors violating one or two clues, fills from higher-violation orders if needed, shuffles four code-owned choices A-D, and independently verifies that exactly one choice satisfies the spec. Option values are complete label sequences `A..E`, not the A-D choice labels.
- **Rules:** `visibleRules` supplies code-owned English domain, closed-world, target, four operation descriptions, and position/option conventions. `facts` supplies one local fact per clue with the code-owned clue template.
- **Fingerprint:** `canonicalData` applies `reduceClueCore`, canonicalizes over item relabelings, preserves position constants/direction/adjacency/size, and emits `size=N` plus sorted typed relation tokens (`before:a:b`, `immediatelyBefore:a:b`, `at:a:p`, `notAt:a:p`). It never hashes only the final permutation.
- **Verification:** `npm exec vitest run tests/families/ranking.test.ts`; `npm run check`. The focused suite covers schema bounds, explicit unique order, impossible cycle, ambiguity, adjacency direction, positions, wrong keys, all options, relabeling/redundancy, deterministic mutations, registry registration, and 100 fixed construction seeds with at least 95 independently verified successes.

The production registry now contains ranking, matching, and scheduling. The remaining seven engines and five renderers are registered only by their owning phases.

### Scheduling/Placement (P07)

Files: `src/families/scheduling/schema.ts`, `src/families/scheduling/engine.ts`, `src/families/scheduling/canonical.ts`, `tests/families/scheduling.test.ts`.

- **DSL:** four events `E1-E4`, four ordered consecutive slots `1-4`, and two capacity-2 resources `R1-R2`. A spec contains 4-12 typed clues from `at`, `notAt`, `before`, `immediatelyBefore`, `usesResource`, and `notResource`. Events/resources are fixed IDs; resource assignment belongs to an event. Self order-relations, exact duplicates, and same-pair time/resource contradictions are rejected. Local facts are `f001` onward in stored clue order.
- **Meaning:** one event per slot, no overlap, exactly two events per resource. A complete answer is a four-row table ordered by event, with each slot used once and each resource used exactly twice. `enumerateSolutions` independently enumerates 4! event orders x C(4,2) resource choices = 144 schedules and evaluates both temporal and resource predicates.
- **Construction:** `constructSchedulingSpec(seed, difficulty)` chooses a witness order and a two-of-four resource choice. A three-fact `before` chain plus three true resource facts forms the unique six-fact anchor. It adds one temporal, one resource, and 2-4 other true clues, for 10-12 initial clues, then removes redundant clues in seeded order to floors 8/6/4 for levels 1/2/3. It uses at most 64 draws and returns a trace with anchor, temporal/resource, additional, pruning, and draw counts.
- **Options:** `makeOptions` requires the unique schedule and selects three false choices from the remaining 143 legal schedules. Every choice remains a legal full schedule with the same capacity-two resources; exactly one choice satisfies all clues.
- **Rules/facts:** code-owned English rules include the fixed slots, the capacity-2 resources, all six operations, and the row-order convention. Facts use the code-owned event/slot/resource templates.
- **Fingerprint:** `canonicalData` applies `reduceClueCore`, then minimizes the retained typed event/slot/resource constraint graph over 4! event x 2! resource = 48 relabelings. Ordered slot positions and the capacity vector are preserved; do not fingerprint the unpruned clue list.
- **Verification:** `npm exec vitest run tests/families/scheduling.test.ts`; `npm run check`. Focused tests cover resource-only ambiguity, temporal contradiction, exact capacity, immediately-before meaning, wrong resource despite correct time order, canonical renaming, redundant/implied facts, deterministic mutations, registry registration, and 100 fixed constructions with at least 95 independently verified successes.


### Attribute Matching (P06)

Files: `src/families/matching/schema.ts`, `src/families/matching/engine.ts`, `src/families/matching/canonical.ts`, `tests/families/matching.test.ts`.

- **DSL:** three typed categories A, B, and C with four items each (`A1-A4`, `B1-B4`, `C1-C4`). A spec contains 4-12 `same`/`different` clues between different categories. Item IDs are integers `0..3`; categories remain typed. Exact duplicates and same-pair contradictions are rejected with explicit schema messages. Local facts are `f001` onward in stored clue order.
- **Meaning:** each A item is paired with exactly one B item and one C item, with bijections in B and C. A complete answer is four rows ordered by A item, each using every category item once. The solver enumerates all 4! x 4! = 576 assignments and evaluates A-B, A-C, and B-C clues.
- **Construction:** `constructMatchingSpec(seed, difficulty)` chooses two witness permutations and six anchors (A0-A2 to B and C). It adds two seeded true B-C clues (one same, one different) plus 2-4 other true clues, for 10-12 initial clues, then removes redundant clues in seeded order to floors 8/6/4 for levels 1/2/3. Construction uses at most 64 draws and returns a trace with anchor, cross-category, additional, pruning, and draw counts. The spec contains only `clues`.
- **Solver:** unique/unsat/ambiguous results distinguish one complete table from a unique queried pair. Unique results carry one derived `s001` proof fact; multiple/zero solutions carry no correct answer or proof.
- **Options:** `makeOptions` requires the unique table, enumerates the 576-table domain, prefers false tables reachable by one or two bijection swaps, fills from higher-swap tables if needed, and validates that all four choices are complete tables with exactly one satisfying choice.
- **Rules/facts:** code-owned English rules explicitly state that every A, B, and C item is used once and rows are ordered A1-A4. Facts use the code-owned `same`/`different` templates.
- **Fingerprint:** `canonicalData` applies `reduceClueCore`, then minimizes the retained signed, category-typed relation graph over 24^3 = 13,824 independent relabelings of the four item IDs in each category. Signs and category roles are preserved; textual labels and row order are removed. Tokens are `same`/`different` with category-index.item endpoints.
- **Verification:** `npm exec vitest run tests/families/matching.test.ts`; `npm run check`. Focused tests cover schema diagnostics, complete/unsat/ambiguous tables, cross-category negatives, repeated category values, wrong keys, relabeling/redundancy, deterministic mutations, registry registration, and 100 fixed constructions with at least 95 independently verified successes.


## Family Engine Contract

Each family implements `FamilyEngine<S, A>`:

| Member | Contract |
| --- | --- |
| `family`, `modality` | Must match the fixed family/modality table in `src/domain/experiment.ts`. |
| `schema` | Strict Zod schema for the family DSL. Raw API input is parsed before use. |
| `generateSpec(seed, difficulty)` | Bounded deterministic construction. The returned spec never carries the hidden witness. |
| `enumerateSolutions(spec)` | Independent exhaustive or constructive check. It must not trust a generator witness. Reaching a state cap is a failure, not a uniqueness proof. |
| `verifyAnswer(spec, answer)` | Independent predicate over the full answer, not a comparison with a hidden key. |
| `makeOptions(spec, answer, seed)` | Exactly four distinct code-owned choices, labeled A-D after a seeded shuffle. |
| `visibleRules(spec)` | Code-owned `domain`, `closedWorld`, `target`, `operations`, and optional `conventions`. |
| `facts(spec)` | Local or observation facts in the `fNNN` or `pNNN` namespace. Rule facts are separate. |
| `canonicalData(spec)` | Reduced canonical structure used for structural fingerprints. |
| `testMutations(spec)` | Deterministic positive/negative fixtures for later calibration and tests. |

`SolveResult` reports `solutionCount`, `answerCount`, `correctAnswer`, a proof containing derived facts and a witness, `enumeratedStates`, and `checkerVersion`. A unique result requires one answer and a proof. An unsatisfiable result carries no answer or proof. Proof facts use the derived `sNNN` namespace.

Construction and checking are separate. A generator may choose a witness internally, but the returned spec contains only the DSL. `enumerateSolutions` and `verifyAnswer` re-evaluate the DSL. A tampered spec therefore cannot inherit a hidden witness.

## Visible Rules and Fact IDs

`VisibleRules` is code-owned and is always shown from the start. It is not model prose and is not a repair inserted after generation.

| Rule field | Fixed fact ID |
| --- | --- |
| `domain` | `r-domain` |
| `closedWorld` | `r-closed` |
| `target` | `r-target` |
| `operations` | `r-operations` |
| `conventions` | `r-conventions` |

Text clue facts use `f001`, `f002`, and so on in accepted stored clue order. SVG observation facts use `p001`, `p002`, and so on in deterministic row/column/operation order. Derived proof facts use the separate `s001` namespace. `mergeFactInventory` merges groups, rejects duplicate IDs and namespace mismatches, and returns a deterministic sorted inventory. `assertFactReferences` rejects unknown explainable references. `assertLocalClueFactCoverage` requires each local fact exactly once for text wording.

## Canonical Structure

`CanonicalStructure` is a strict object:

```text
{
  version: 1,
  family,
  domainTokens: string[],
  queryKind,
  queryTokens: string[],
  relationTokens: string[],
  geometryTokens: string[]
}
```

All token arrays are lexicographically sorted. Tokens are typed code-owned strings with exact integer values and relation names; they contain no prose, seeds, option labels, or model text. Every integer-valued token field uses one canonical decimal spelling: unsigned fields accept `0` or a nonzero digit followed by digits, signed fields accept `0` or an optional minus followed by a nonzero digit and digits, and padded values such as `00`, `01`, `-0`, or `op00` are rejected. Domain/query constants are separate tokens, not one unparsed configuration string.

The schema enforces the table in plan section 7.11:

| Family | Query kind | Query | Relations | Geometry |
| --- | --- | --- | --- | --- |
| ranking | `full_order` | empty | nonempty | empty |
| matching | `full_table` | empty | nonempty | empty |
| scheduling | `full_schedule` | empty | nonempty | empty |
| truth | `full_truth_vector` | empty | nonempty | empty |
| arithmetic | `full_tuple` | empty | nonempty | empty |
| matrix | `xor_matrix` | nonempty | empty | exactly 8 cells |
| transforms | `apply_D4` | nonempty | empty | nonempty |
| paths | `S_to_G_route` | nonempty | nonempty | nonempty |
| symmetry | `reflect_half` | empty | empty | nonempty |
| counting | `membership_count` | nonempty | nonempty | exactly 25 cells |

The schema also rejects malformed family tokens: ranking clues outside the declared size, matching endpoints without canonical integer category/item notation, scheduling events/slots/resources outside their bounds, truth speaker coverage errors, arithmetic rows outside the declared coefficient/constant bounds, matrix cells outside the 3x3 visible set, arbitrary D4 operations, path edges that are not sorted orthogonal edges of the active tree, symmetry cells outside the declared known half, and counting masks outside `0..2^shapes-1`. Counting region counts must equal the number of geometry cells carrying the same membership mask, and all 25 grid cells must appear exactly once.

Serialization uses canonical JSON over the validated object. `selectCanonicalStructure` chooses the lexicographically smallest serialization after the family applies its allowed relabelings or geometric frame changes. `canonicalStructureHash` hashes that serialization. Structural fingerprints therefore never hash the raw spec, the answer alone, option order, seeds, lane, difficulty label, or clue prose.

## Feature Arithmetic

`extractStructureFeatures` emits:

- `q:<query token>` for query tokens,
- `r:<relation token>` for relation tokens,
- `g:<geometry token>` for geometry tokens.

Family and domain tokens are omitted so constant metadata does not inflate similarity. Duplicate tokens remain a multiset count.

For feature multisets `A` and `B`:

```text
removed        = sum(max(countA - countB, 0))
added          = sum(max(countB - countA, 0))
editDistance   = max(removed, added)
intersection   = sum(min(countA, countB))
union          = sum(max(countA, countB))
jaccard        = intersection / union
```

A substitution costs one edit because `removed = added = 1`. Empty/empty has `jaccard = 1` and `editDistance = 0`; one empty side has `jaccard = 0`. The plan treats empty features or unequal structural hashes with identical complete canonical data as implementation errors, so P21 must reject those cases before applying the one-edit policy. P04 supplies arithmetic only; P21 owns the near-duplicate flag.

The mandatory counting example is covered in tests: three 5x5 shapes, otherwise identical level-3 specs querying exactly two versus exactly three memberships, produce 33 common features out of 35 (`jaccard = 33/35`, `editDistance = 1`).

## Bounded Search

`SearchCounter` enforces a finite state limit and throws `SolverLimitError` rather than returning a partial result as proof. `collectPermutations`, `minimizeOverPermutations`, `collectCartesianProduct`, and `minimizeOverCartesianProduct` report `complete: false` when a collection cap stops enumeration. `countPermutations` and `countCartesianProduct` are exact safe-integer counters.

`Bitset` provides finite-domain set operations used by family solvers and cached clue bitsets. `reduceClueCore` implements the section 6 proxy:

1. Canonicalize the complete typed clue list with the family-supplied `normalize`.
2. Sort by `clueKey` and verify the independent solver returns exactly one solution.
3. Visit clues in reverse lexicographic order.
4. Remove a clue only when the independent solver still returns the same single complete answer.
5. Canonicalize the retained core again and report removed indices/keys and evaluation count.

`reduceClueCore` does not prove complete logical equivalence. It is an irredundant-core proxy. Families should cache per-clue bitsets inside their `solve` callback rather than rerunning an expensive domain scan for every clue.

## Options

`makeChoiceSet` accepts one correct value and exactly three distractors. It rejects fewer or more than three distractors, duplicate values under deep equality, and a missing correct value. It shuffles the four values with the hash-counter PRNG and assigns A-D in the stored order. `correctLabel` is recomputed from deep value equality after shuffling. `ChoiceSetSchema` and `verifyChoiceSet` re-check the four labels, distinct values, and unique correct label.

Rendered distinctness is a presentation check owned by P22; P04 checks semantic distinctness only.

## Registry

`FamilyRegistry` keeps formal engines and SVG renderers in separate maps. `registerEngine` and `registerRenderer` reject duplicates, wrong family/modality pairs, engine schemas without a `parse` function, missing engine methods, empty renderer versions, and renderers for text families. Registering an engine and a renderer for the same SVG family is allowed because they are separate capabilities. `assertComplete` checks all ten engines and, when requested, all five renderers.

Registration does not import a future family or placeholder renderer. The production registry contains ranking, matching, and scheduling and is filled by the owning phases.
