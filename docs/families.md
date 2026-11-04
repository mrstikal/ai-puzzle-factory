# Family Contracts and Implemented Families

This document records the shared contract implemented in P04 and the family engines implemented after it. P04 provides the interfaces, validation, and bounded deterministic helpers that P05-P20 use; P05 adds the real ranking engine, P06 adds attribute matching, P07 adds scheduling, P08 adds truth values, P09 adds small arithmetic constraints, P11 adds the matrix formal engine, P12 adds its renderer, P13 adds the transforms formal engine, P14 adds its renderer, P15 adds the paths formal engine, P16 adds its renderer, P17 adds the symmetry formal engine, P18 adds its renderer, P19 adds the counting formal engine, and P20 adds the counting renderer plus the strict ten-family spec union.

## Scope

P04 owns:

- `src/families/contracts.ts`: `FamilyEngine`, `VisibleRules`, fact IDs, `SolveResult`, and the strict `CanonicalStructure` schema.
- `src/families/canonicalize.ts`: stable serialization, feature extraction, multiset Jaccard/edit arithmetic, bounded permutation/cartesian enumeration, search counters, bitsets, and the reduced-clue-core helper.
- `src/families/registry.ts`: separate formal-engine and renderer registries.
- `src/domain/answers.ts`: deep option equality and seeded four-choice construction.

P04 does not implement a real family, a renderer, a model adapter, or a production placeholder. P05 registers ranking, P06 registers matching, P07 registers scheduling, P08 registers truth, P09 registers arithmetic, P11 registers the matrix engine, P12 registers the matrix renderer, P13 registers the transforms engine, P14 registers the transforms renderer, P15 registers the paths engine, P16 registers the paths renderer, P17 registers the symmetry engine, P18 registers the symmetry renderer, and P19 registers the counting engine; P20 adds and registers the final counting renderer.

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

The production registry now contains all five text engines plus the matrix engine, matrix renderer, transforms engine, transforms renderer, paths engine, paths renderer, symmetry engine, symmetry renderer, and counting engine: ranking, matching, scheduling, truth, arithmetic, matrix, transforms, paths, symmetry, and counting. The counting renderer is registered by P20.

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

### Scheduling/Placement (P07)

Files: `src/families/scheduling/schema.ts`, `src/families/scheduling/engine.ts`, `src/families/scheduling/canonical.ts`, `tests/families/scheduling.test.ts`.

- **DSL:** four events `E1-E4`, four ordered consecutive slots `1-4`, and two capacity-2 resources `R1-R2`. A spec contains 4-12 typed clues from `at`, `notAt`, `before`, `immediatelyBefore`, `usesResource`, and `notResource`. Events/resources are fixed IDs; resource assignment belongs to an event. Self order-relations, exact duplicates, and same-pair time/resource contradictions are rejected. Local facts are `f001` onward in stored clue order.
- **Meaning:** one event per slot, no overlap, exactly two events per resource. A complete answer is a four-row table ordered by event, with each slot used once and each resource used exactly twice. `enumerateSolutions` independently enumerates 4! event orders x C(4,2) resource choices = 144 schedules and evaluates both temporal and resource predicates.
- **Construction:** `constructSchedulingSpec(seed, difficulty)` chooses a witness order and a two-of-four resource choice. A three-fact `before` chain plus three true resource facts forms the unique six-fact anchor. It adds one temporal, one resource, and 2-4 other true clues, for 10-12 initial clues, then removes redundant clues in seeded order to floors 8/6/4 for levels 1/2/3. It uses at most 64 draws and returns a trace with anchor, temporal/resource, additional, pruning, and draw counts.
- **Options:** `makeOptions` requires the unique schedule and selects three false choices from the remaining 143 legal schedules. Every choice remains a legal full schedule with the same capacity-two resources; exactly one choice satisfies all clues.
- **Rules/facts:** code-owned English rules include the fixed slots, the capacity-2 resources, all six operations, and the row-order convention. Facts use the code-owned event/slot/resource templates.
- **Fingerprint:** `canonicalData` applies `reduceClueCore`, then minimizes the retained typed event/slot/resource constraint graph over 4! event x 2! resource = 48 relabelings. Ordered slot positions and the capacity vector are preserved; do not fingerprint the unpruned clue list.
- **Verification:** `npm exec vitest run tests/families/scheduling.test.ts`; `npm run check`. Focused tests cover resource-only ambiguity, temporal contradiction, exact capacity, immediately-before meaning, wrong resource despite correct time order, canonical renaming, redundant/implied facts, deterministic mutations, registry registration, and 100 fixed constructions with at least 95 independently verified successes.

### Truth Values (P08)

Files: `src/families/truth/schema.ts`, `src/families/truth/engine.ts`, `src/families/truth/canonical.ts`, `tests/families/truth.test.ts`.

- **DSL:** three people at level 1 and four at levels 2-3. One typed statement AST per person plus a visible `exactTruthful` integer `1..N-1`. Leaves are `truthful(personId)`; operators are `not`, `and`, `or`, and `xor`; each statement is limited to depth 2, three leaves, and seven nodes. No arbitrary English, quoted statements, temporal claims, or extra person types. Local facts are `f001` onward and preserve every original statement.
- **Meaning:** a truth teller's statement is true and a liar's statement is false, so every assignment must satisfy `T[i] === evaluate(statement[i], T)` and the exact truthful count. XOR means exactly one operand is true. The answer is the complete T/F vector for all people, not a set of merely possible people.
- **Solver:** `enumerateSolutions` enumerates all 2^N <= 16 assignments, evaluates ASTs recursively, and requires one full vector. Unique results carry one derived `s001` proof fact; zero/multiple fixed points and count contradictions carry no answer or proof.
- **Construction:** `constructTruthSpec(seed, difficulty)` chooses a witness vector with an extreme truthful count (1 or N-1), builds one leaf/not anchor statement per person (3 at level 1, 4 at levels 2-3), which is unique with the count, then tries seeded one-slot binary/XOR enrichment and up to eight full random selections from the finite legal AST pool. Every candidate is independently solved; at most 64 combinations are attempted. The anchor remains the fallback, so a valid unique system is never silently repaired. Level 1 allows at most one binary statement; level 2 allows and/or; level 3 also allows xor.
- **Options:** `makeOptions` requires the unique vector and selects three false complete T/F vectors; false choices may violate the count or a statement, but always list every person. Exactly one choice satisfies the spec.
- **Rules/facts:** code-owned rules state the exact truthful count, role semantics, all four AST operators, depth/leaf/node limits, and self-reference semantics. Facts preserve every original statement as `P<i> says: ...`.
- **Fingerprint:** `canonicalData` applies `reduceClueCore` to speaker-linked statement-equivalence predicates, then canonicalizes the retained AST/operator graph over person relabelings. Commutative operands are sorted, negation is preserved, and population/exact count stay in the domain tokens. The reduced core may contain fewer than N speaker predicates; the original spec and facts always keep all N statements.
- **Verification:** `npm exec vitest run tests/families/truth.test.ts`; `npm run check`. Focused tests cover zero/multiple fixed points, exactly-one XOR, count contradictions, oversized/foreign ASTs, independent evaluation, wrong vectors, renaming/commutative forms, redundant-statement reduction, deterministic mutations, registry registration, and 100 fixed constructions across both populations with at least 95 successes.

### Small Arithmetic Constraints (P09)

Files: `src/families/arithmetic/schema.ts`, `src/families/arithmetic/engine.ts`, `src/families/arithmetic/canonical.ts`, `tests/families/arithmetic.test.ts`.

- **DSL:** three integer variables x/y/z in `0..12`, 2-5 linear constraints `sum(coeff*var) op constant`, `op` in `eq|lt|le`, coefficients `-3..3` not all zero, constants `-108..108`, and an explicit `allDifferent` Boolean. No multiplication of variables, division, modulo, implicit precedence, real-valued solutions, or rounding. Local facts are `f001` onward; negative coefficients and constants are parenthesized.
- **Meaning:** `enumerateSolutions` scans all 13^3 = 2,197 tuples, applies exact integer comparisons and optional pairwise distinctness, and requires one full tuple. Unique results carry one derived `s001` proof fact; no-integer and rank-deficient systems carry no answer or proof.
- **Construction:** `constructArithmeticSpec(seed, difficulty)` chooses a witness and an `allDifferent` choice, builds a shuffled three-equation full-rank anchor with two multi-variable equations and a unit pin equation. Levels 1/2 add two true pin inequalities with coefficient limits 1/2 and prune the pin equation, leaving the inequalities load-bearing. Level 3 uses limit 3 in the multi-variable equations and replaces the pin equation `v=c` by `v<=c` and `-v<=-c`; it rejects a draw with no retained nonredundant inequality. It prunes redundant constraints in seeded order within the 2-5 bound, records actual operators, and uses at most 64 draws. It does not claim calibrated difficulty.
- **Options:** `makeOptions` requires the unique tuple, prefers one-step coordinate perturbations, fills from the finite 2,197-tuple domain if needed, and validates exactly one satisfying choice. Tuples are always complete integer triples in the same domain.
- **Rules/facts:** code-owned rules state the domain, `allDifferent`, exact-integer comparison semantics, and the three operators. Facts display every constraint with explicit coefficients and parenthesized negatives.
- **Fingerprint:** `canonicalData` applies `reduceClueCore` to normalized rows. Strict `< c` maps to `<= c-1`; `<=` rows divide coefficients by their positive gcd and use `floor(c/g)` without flipping direction; equality rows require divisibility, divide the full row, and make the first nonzero coefficient positive. The retained coefficient/comparison graph is canonicalized over the six variable relabelings. Domain and `allDifferent` stay in the domain tokens. `2*x<11`, `2*x<=11`, and `x<=5` normalize identically without changing the visible DSL.
- **Verification:** `npm exec vitest run tests/families/arithmetic.test.ts`; `npm run check`. Focused tests cover no-integer, rank-deficient/multiple, strict-vs-nonstrict boundary, equivalent inequality fingerprints, negative bounds, `allDifferent`, forbidden nonlinear grammar, wrong keys, deterministic mutations, 100 fixed constructions, and the five-text-engine/no-visual-stub registry assertion.

### Matrix Completion (P11)

Files: `src/families/matrix/schema.ts`, `src/families/matrix/engine.ts`, `src/families/matrix/canonical.ts`, `tests/families/matrix.test.ts`.

- **DSL:** a fixed 3x3 matrix of four-bit masks with only the bottom-right cell null; `rule` is the literal `xor`. Each mask uses four fixed glyph positions; set membership is binary. Unknown rules, masks outside 0..15, and nulls outside (2,2) are rejected. Observation facts are `p001`-`p008` for the eight visible cells in row-major order.
- **Meaning:** every complete row has `third = first XOR second`; every complete column has `bottom = top XOR middle`; the missing cell must satisfy both remaining equations. `enumerateSolutions` checks all 16 candidate masks and requires exactly one completion. Empty mask 0 is explicitly drawn as an empty four-position mini-grid.
- **Construction:** `constructMatrixSpec(seed, difficulty)` draws four upper-left seed masks with populations 1-2/1-3/2-3 for levels 1/2/3, derives the other visible cells by XOR, and retries within 64 draws until the eight visible masks contain at least four distinct values and every visible row/column input pair has distinct first/second values, including the two visible inputs of the incomplete third row and third column. It records attempts, seed populations, visible distinct count, and draws used.
- **Options/checker:** `makeOptions` uses the unique correct mask plus three one-glyph toggles, and independently verifies that only one choice satisfies all six row/column equations. Every option uses the same four fixed glyph positions; color is never an identity cue.
- **Scene input:** `matrixSceneInput` exposes the typed 3x3 cells, missing-cell location, fixed glyph positions, empty-mask convention, and A-D choices without rendering SVG. No matrix renderer is registered in P11.
- **Fingerprint:** `canonicalData` preserves all eight shown masks and the missing-cell location, and minimizes the matrix over the 24 glyph-identity permutations and the matrix transpose. The canonical structure uses `cell:r:c:mask` geometry tokens with `row=xor` and `column=xor`.
- **Verification:** `npm exec vitest run tests/families/matrix.test.ts`; `npm run check`. Focused tests cover inconsistent rows/columns, unknown rule, malformed missing cell, empty mask, one-bit distractors, transpose/glyph renaming, typed scene input, deterministic mutations, and 100 fixed constructions.

### Matrix Renderer (P12)

Files: `src/families/matrix/render.ts`, `tests/render/matrix.test.ts`.

- **Layout:** a 3x3 stem grid with the bottom-right `?` missing-cell marker, explicit row/column XOR rules, a glyph legend with all four fixed shapes, and four A-D answer tiles. Every cell and option uses the same four normalized glyph positions and shape-per-glyph mapping; color is never an identity cue.
- **Glyphs:** circle, square, triangle, and diamond at fixed positions. Empty mask 0 is an outlined mini-grid with no glyphs. The missing cell is an outlined `?` cell. Stem rules use position words (`1st XOR 2nd = 3rd`, `top XOR mid = bottom`) and must not reuse bare A-D option labels.
- **Validation:** `assertMatrixScene` runs the shared scene checks and then verifies the stem grid, missing marker, legend glyphs, option grids, exact mask-to-glyph placement, identical positions/shapes, clipping, cell overlap, empty-mask emptiness, and the critical-group IDs `stem-grid`, `missing-cell`, `legend-glyphs`, and `option-A-grid`..`option-D-grid`. The correct option must be present and the missing cell must be bottom-right.
- **Preview:** `matrixRenderer` is registered in the canonical renderer registry. `npm run preview -- --family matrix --seed preview-v1` derives a 64-hex preview spec seed from the human seed, builds the checked masks, renders SVG/1024/512 files under ignored `data/previews`, and prints paths plus hashes.
- **Evidence:** focused tests render 100 seeded scenes at 512 pixels for bounds and distinct option masks, run fixed adversarial plus ten seeded removed-critical-group pixel checks (at least eight changed non-background pixels), and reject swapped glyph positions with the explicit `SWAPPED_GLYPH` code, clipped glyphs, and injected glyphs in the empty mask. Critical-group evidence also removes marks while keeping panels; empty-mask option grids are skipped for that marks-only comparison.
- **Verification:** `npm exec vitest run tests/render/matrix.test.ts`; `npm run preview -- --family matrix --seed preview-v1`; `npm run check`. Open the printed 512-pixel PNG and confirm the missing cell, both rule directions, every glyph, and A-D are distinguishable without a key cue.

### Rotation and Reflection (P13)

Files: `src/families/transforms/schema.ts`, `src/families/transforms/engine.ts`, `src/families/transforms/canonical.ts`, `tests/families/transforms.test.ts`.

- **DSL:** a 5x5 binary source grid with 4-8 orthogonally connected occupied cells and a one- or two-step sequence from the eight declared D4 operations (`identity`, `rotate90`, `rotate180`, `rotate270`, `reflectLeftRight`, `reflectTopBottom`, `reflectMainDiagonal`, `reflectAntiDiagonal`). Coordinates are zero-based row/column with the origin at the top-left. Occupancy outside 4-8, disconnected sources, nonbinary or non-5x5 grids, unknown operations, and sequences outside one or two steps are rejected.
- **Meaning:** operations apply in the displayed order about the tile center. R90 maps `(r,c)` to `(c,4-r)`, R180 to `(4-r,4-c)`, R270 to `(4-c,r)`, left-right reflection to `(r,4-c)`, top-bottom to `(4-r,c)`, main diagonal to `(c,r)`, and anti-diagonal to `(4-c,4-r)`. `enumerateSolutions` recomputes the unique complete output from those coordinate equations and returns one answer with a derived `s001` fact; it never reuses a construction witness.
- **Construction:** `constructTransformsSpec(seed, difficulty)` grows a connected source by seeded orthogonal neighbor growth, keeps only sources whose D4 orbit has at least four distinct masks, rejects a source fixed by the chosen net transform, and verifies that three distinct false orbit outputs exist. Level 1 uses one nonidentity rotation, level 2 one reflection, and level 3 one R90/R270 rotation plus one reflection in either order with a noncommuting order check. It uses at most 64 deterministic draws and records attempts, source size, orbit size, operations, net transform, and draws used.
- **Options/checker:** `makeOptions` requires the unique output and selects three distinct false masks from the source's D4 orbit, so identical outputs are never presented as separate choices. Exactly one of the four shuffled A-D choices satisfies the independent checker. A source orbit with fewer than three false outputs is an explicit `INSUFFICIENT_DISTRACTORS` failure.
- **Rules/facts:** code-owned rules state the viewer-relative top-left origin, clockwise direction, all eight coordinate maps, the listed-order semantics, the tile center at `(2,2)`, and that choices are complete resulting patterns. Observation facts `p001` onward list occupied source cells in row-major order; the operation sequence is public rule/query data, not a hidden coordinate transcription.
- **Fingerprint:** `canonicalData` minimizes the source and ordered sequence over all eight D4 frame changes, conjugating every operation by the same frame. Geometry tokens are occupied `cell:r:c` entries; query tokens are `steps=N`, ordered `op0=...`/`op1=...`, and the derived `net=...`. A one-step instruction and a two-step instruction with the same net effect remain distinct fingerprints.
- **Mutations:** a two-step spec with distinct operations receives a reversed-order mutation; a repeated two-step sequence replaces its second operation, and a one-step spec receives a different D4 operation, in both cases chosen so the resulting answer differs when an admissible alternative exists. Both cases also receive a same-net/different-step-count mutation.
- **Verification:** `npm exec vitest run tests/families/transforms.test.ts`; `npm run check`. Focused tests cover the complete D4 map/composition/inverse/conjugation table, noncommuting R90/R270 plus reflection, disconnected and out-of-range sources, hand-checked R90 and left-right outputs, reversed-order detection, orbit options, frame-equivalent fingerprints, step-count preservation, deterministic mutations, engine registration, and 100 fixed constructions with independently verified outputs.

### Transform Renderer (P14)

Files: `src/families/transforms/render.ts`, `tests/render/transforms.test.ts`.

- **Layout:** a 1024x1024 scene with a source 5x5 grid, one or two ordered operation cards, a viewer-relative axis/clockwise legend, and four A-D option tiles. Every grid uses the same 160px scale (`28px` cells, `5px` gaps), the same center pivot marker at `(2,2)`, and the same top orientation triangle. The source and every option show complete masks in the fixed coordinate frame.
- **Operations:** rotation cards show `First`/`Then`, the operation name, and a clockwise arc for 90/180/270 degrees with an arrowhead at the declared endpoint. Reflection cards show the matching vertical, horizontal, main-diagonal, or anti-diagonal axis. Identity uses an explicit `=` mark. The legend states `Axes: top = up, right = right.`, `Clockwise: top, right, bottom, left.`, and the center-pivot/top-marker convention.
- **Validation:** `assertTransformsScene` runs shared `assertScene`, then verifies critical groups `source-grid`, `operation-sequence`, `axis-legend`, and `option-A-grid`..`option-D-grid`; exact 25-cell geometry and fills; identical grid scale; center pivot; top orientation marker; ordered operation text; clockwise-arrow endpoint, radius, angular-step, total-sweep, and arrowhead-tip direction; mirror-axis orientation; a visible pivot ring painted after its halo; and exactly one correct, four-distinct orbit option set. Explicit error codes include `MISSING_AXIS`, `REVERSED_ARROW`, `REVERSED_ORDER`, `DECORATIVE_ROTATION`, `WRONG_AXIS`, `OFF_CENTER_PIVOT`, `MISSING_ORIENTATION`, `INVISIBLE_MARKER`, and `OPTION_NOT_DISTINCT`.
- **Decorative rotations:** every `rotation-arrow`, `mirror-axis`, or `identity-mark` must belong to a declared operation card or the axis legend; any extra transform icon is rejected. Grids cannot be rotated because the top orientation marker and center pivot are fixed.
- **Preview:** `transformsRenderer` is registered in the canonical renderer registry. `npm run preview -- --family transforms --seed preview-v1` renders the default level-1 preview; `npm run preview -- --family transforms --seed preview-v3 --difficulty 3` renders a two-operation scene that demonstrates both clockwise direction and a mirror axis. Outputs are SVG/1024/512 under ignored `data/previews`.
- **Evidence:** focused tests render deterministic 1024/512 PNGs, rasterize 100 seeded scenes with bounds and pairwise-distinct option-grid crops, exercise missing-axis/reversed-arrow/decorative-rotation/off-center-pivot/wrong-axis/reversed-order/wrong-geometry/missing-operation fixtures, and run fixed plus ten seeded critical-pixel checks (at least eight changed non-background pixels). Adversarial fixtures cover a reversed arc, a counter-clockwise sweep with the same endpoints, a backwards arrowhead, a chord-like arc, an over-rotated multi-turn arc, reversed pivot paint order, invisible orientation/pivot markers, decorative rotations, and off-center pivots. Operation critical evidence removes arrows/axes while keeping card panels.
- **Verification:** `npm exec vitest run tests/render/transforms.test.ts`; `npm run preview -- --family transforms --seed preview-v1`; `npm run preview -- --family transforms --seed preview-v3 --difficulty 3`; `npm run check`. Open the printed 512-pixel PNGs and confirm the source, First/Then order, clockwise arrow, mirror axis, viewer-relative axes, same-scale A-D grids, center pivots, and top orientation markers.

### Paths and Reachability (P15)

Files: `src/families/paths/schema.ts`, `src/families/paths/engine.ts`, `src/families/paths/canonical.ts`, `tests/families/paths.test.ts`.

- **DSL:** a 4x4 cell grid with 6-12 active cells, explicit undirected open orthogonal edges, and distinct marked start/goal cells. Active cells and edges must be sorted; edge endpoints are sorted and orthogonally adjacent. The edge count is exactly `activeCells-1`, the graph is connected and a tree, and the unique S-to-G route has 3-11 edges. Diagonal edges, duplicate edges, disconnected/cyclic graphs, start=goal, and out-of-range routes are rejected.
- **Meaning:** move between orthogonally adjacent cell centers only through drawn open corridors, without revisiting a cell. `enumerateSolutions` independently runs BFS over the parsed tree, returns the unique complete route with a derived `s001` fact, `enumeratedStates = activeCells`, and checker version `paths-v1`; it never reuses the construction spanning-tree witness.
- **Construction:** `constructPathsSpec(seed, difficulty)` grows a connected active set by seeded neighbor growth, builds a seeded randomized-DFS spanning tree, and chooses ordered endpoints with route lengths 3-5/5-7/7-11 for levels 1/2/3. Active-size targets are 6-8/7-10/9-12; a failed draw retries within 64 deterministic draws and never changes the target difficulty. Construction also requires at least three false full-grid routes. The 100 fixed fixtures produced 34/33/33 successes with zero failures.
- **Options/checker:** the correct route is the unique tree route. False routes come from `enumerateFullGridSimpleRoutes`, capped by `SearchCounter` at 200,000 visited states; each false route uses at least one closed/nonexistent corridor or inactive cell. Four choices are distinct, exactly one satisfies the independent checker, and a route cannot jump over a cell because every consecutive pair must be orthogonally adjacent.
- **Rules/facts:** code-owned rules state orthogonal movement, open corridors, no revisits, tree uniqueness, and distinct S/G markers. Observation facts `p001` onward list active cells in row-major order, open corridors in sorted edge order, and the start/goal markers.
- **Fingerprint:** `canonicalData` minimizes active cells, open edges, and marked S/G over all eight D4 frames and a translation-normalized bounding box. Tokens are `grid=4x4`; `start:r:c`/`goal:r:c`; `open:r1:c1:r2:c2`; and `active:r:c`. Geometry and topology are retained, not just route length.
- **Verification:** `npm exec vitest run tests/families/paths.test.ts`; `npm run check`. Focused tests cover disconnected/cyclic/diagonal/duplicate/unordered graphs, start=goal, route length bounds, revisit/jump routes, the 200,000-state enumeration cap, closed-edge shortcuts, four distinct options, D4/translation equivalence, different topology, deterministic mutations, engine registration, and 100 fixed constructions with independently verified options.
- **Manual acceptance:** adding an extra open edge to the fixed 6-cell tree makes the edge count 6 for 5 tree edges, so `PathsSpecSchema` rejects it as a non-tree; the visually tempting shortcut `(0,0)->(0,1)->(1,1)->(1,2)` is rejected because the `(0,1)-(1,1)` corridor is closed. No path renderer exists in P15.

### Path Renderer and Corridor/Wall Checks (P16)

Files: `src/families/paths/render.ts`, `tests/render/paths.test.ts`.

- **Layout:** a 1024x1024 scene with a source 4x4 maze, a wall/route legend, and four A-D option tiles. Every maze uses the same 160px grid (`40px` cells). Active cells are light, inactive cells are muted with diagonal hatching, and the same maze geometry plus S/G markers is reused in all choices.
- **Wall convention:** the outer border is always a thick black wall; every internal boundary is a wall unless both cells are active and the edge is explicitly open. Open corridors are therefore visible as gaps. Inactive cells are separated by walls and hatched. All walls use `SCENE_INK` with an 8px stroke so they remain distinct in grayscale and at the 512 preview.
- **Routes:** each option draws a white halo and a blue route polyline through the chosen cell centers. Routes are painted before walls, so any segment crossing a closed boundary is interrupted by the visible wall; the correct route only crosses open gaps. The source maze has no route overlay.
- **Validation:** `assertPathsScene` runs shared `assertScene`, then verifies critical groups `source-maze`, `wall-legend`, and `option-A-maze`..`option-D-maze`; exact 16-cell fills and hatch; expected outer/internal walls; no wall on an open active edge; S/G halo centers, label anchors, and label positions; identical maze signatures including marker positions; route points and halo alignment at cell centers; orthogonal 40px steps; walls painted after routes; and four distinct choices with exactly one valid route. Error codes include `MISSING_WALL`, `UNEXPECTED_WALL`, `WALL_PAINT_ORDER`, `CHANGED_MAZE`, `MISSING_ENDPOINT`, `CLIPPED_ENDPOINT`, `ILLEGAL_DIAGONAL`, `WRONG_ROUTE`, `MISSING_LEGEND`, and `OPTION_NOT_DISTINCT`.
- **Evidence:** focused tests cover deterministic 1024/512 PNGs, grayscale wall-versus-cell/corridor luminance, hidden-wall, clipped-endpoint, displaced-label, displaced-halo, illegal-diagonal, changed-maze-choice, wall-paint-order, missing-legend, and unexpected-wall fixtures, plus 100 seeded scenes with bounds and pairwise-distinct route rasters. Fixed and ten seeded critical-group pixel checks remove the source/option mazes or the wall legend and require at least eight changed non-background pixels.
- **Preview:** `pathsRenderer` is registered in the canonical renderer registry (`family: "paths"`, `version: "paths-v1"`). `npm run preview -- --family paths --seed preview-v1` writes SVG/1024/512 under ignored `data/previews`; the accepted hashes are full `4e7ebcc294bcb15ecb2b3261111df2aac87abdc30e2c093dde0e9df3b4d1a80d` and preview `c90b92fc89ebcfffdefef9c7b3a6fe6dcc636d6b0e9e6269afd169dc8731d747`.
- **Manual acceptance:** open the 512-pixel PNG and confirm that S/G, corridor openings, walls, and each highlighted route are unambiguous without source JSON; false routes visibly cross hatched cells or closed walls, and the correct route only crosses gaps.
- **Verification:** `npm exec vitest run tests/render/paths.test.ts`; `npm run preview -- --family paths --seed preview-v1`; `npm run check`.

### Symmetry and Missing Part (P17)

Files: `src/families/symmetry/schema.ts`, `src/families/symmetry/engine.ts`, `src/families/symmetry/canonical.ts`, `tests/families/symmetry.test.ts`.

- **DSL:** an 8x8 grid of explicit `occupied`, `empty`, and `unknown` states. The axis is vertical between columns 3 and 4 (left half known, right half unknown) or horizontal between rows 3 and 4 (top half known, bottom half unknown). The known half contains 4-10 occupied cells; its other cells are explicitly empty. Every missing-half cell must be `unknown`. Unknown is never conflated with empty. Diagonal axes, wrong grid sizes, unknown known cells, known missing cells, and out-of-range counts are rejected.
- **Meaning:** each known occupied cell is reflected across the marked axis exactly once; known empty cells reflect to empty and all other missing cells are empty. The completion is constructed directly from the known half, never by enumerating 2^32 images. The independent checker verifies all 64 cells through reflected pairs and confirms the known half is unchanged. `enumerateSolutions` returns one completion, 32 derived facts (`s001`-`s032`), one for every missing cell with its forced occupied/empty source, `enumeratedStates = 64`, and checker version `symmetry-v1`.
- **Construction:** level 1 is vertical with 4-5 occupied cells, level 2 horizontal with 6-7, and level 3 either axis with 8-10 occupied cells and at least two connected components. A seeded subset of the known half is drawn within 64 deterministic draws; all-empty/all-filled known halves are rejected. The 100 fixed fixtures produced 34/33/33 successes with zero failures; level 3 always had at least two components.
- **Options/checker:** four full completions share the same known half. The correct completion is accompanied by a removed required reflected cell, an added forbidden missing cell, and a required reflected cell shifted to an adjacent missing cell whose mirror is empty. All are distinct, the known half is untouched, and exactly one passes the independent reflection checker.
- **Rules/facts:** code-owned rules state the fixed vertical/left and horizontal/top convention, the axis between central lines, reflection of every known cell exactly once, the difference between unknown and empty, and the unchanged known half. Observation facts `p001` onward list occupied known cells in row-major order, then the axis and the unknown half.
- **Fingerprint:** `canonicalData` normalizes the horizontal case to vertical coordinates, minimizes over reversal along the axis (row reversal after normalization), and emits `grid=8x8`, `axis=vertical`, `knownSide=left`, `reflect_half`, and sorted `cell:r:c` geometry for occupied known cells. Under the fixed known-side convention, exchanging the displayed half normalizes back to the same known-left shape, so it contributes no additional canonical candidate; the feasible axis-preserving group is the reversal pair.
- **Verification:** `npm exec vitest run tests/families/symmetry.test.ts`; `npm run check`. Focused tests cover vertical/horizontal maps, off-axis/bad-size metadata, altered known cells, omitted/extra reflected cells, duplicate false options, normalized-axis equivalence, deterministic mutations, engine registration, and 100 fixed constructions. The proof test asserts 32 forced facts and `enumeratedStates = 64`, not 2^32.
- **Manual acceptance:** every missing-half cell has a recorded forced occupied or empty counterpart in the 32 derived facts, so no unstated completion freedom remains. No symmetry renderer exists in P17.

### Symmetry Renderer and Unknown-State Clarity (P18)

Files: `src/families/symmetry/render.ts`, `tests/render/symmetry.test.ts`.

- **Layout:** a 1024x1024 scene with a source 8x8 tile, a state/axis legend, and four A-D completion tiles. Every tile uses the same 176px grid (`22px` cells). The source shows the known half as filled/empty and the missing half as gray unknown; each option is a full binary completion with the same known half.
- **State convention:** occupied cells are ink (`#111111`), explicitly empty cells are white (`#ffffff`), and unknown cells are medium gray (`#c0c0c0`). All cells have a gray border. Unknown gray is never used in completion options, so it cannot be mistaken for empty or filled.
- **Axis:** a dashed red (`#b00020`) line lies exactly between the central columns (vertical) or rows (horizontal). The source tile has a red axis sample plus the label `axis`; the legend also states `Dashed red = axis.`, `Between central cells.`, and `Known half unchanged.` The axis is drawn as line segments, not a cell, so it cannot create counted cells.
- **Validation:** `assertSymmetryScene` runs shared `assertScene`, then checks critical groups `source-tile`, `source-axis`, `state-legend`, and `option-A-tile`..`option-D-tile`; exactly 64 fixed cells per tile; source occupied/empty/unknown fills; option full binary fills with no unknown; identical known half in all choices; exactly one valid completion among four distinct A-D answers; at least six axis dashes on the exact central line with at least 60% coverage; a labeled source axis; and the three state swatches plus axis legend. Error codes include `CHANGED_KNOWN_HALF`, `UNKNOWN_IN_OPTION`, `MISSING_AXIS`, `WRONG_AXIS`, `MISSING_AXIS_LABEL`, `MISSING_LEGEND`, `OPTION_NOT_DISTINCT`, and `WRONG_GEOMETRY`.
- **Evidence:** focused tests cover deterministic 1024/512 PNGs, unknown/empty/filled luminance contrast at 512, swapped-known-half, hidden source/option axis, unknown-in-option, off-axis dash, missing axis label, missing legend, duplicate choices, and axis-as-cell fixtures. The suite also rasterizes 100 seeded scenes with bounds and pairwise-distinct completion tiles, and runs fixed plus ten seeded critical-group pixel checks (at least eight changed non-background pixels).
- **Preview:** `symmetryRenderer` is registered in the canonical renderer registry (`family: "symmetry"`, `version: "symmetry-v1"`). `npm run preview -- --family symmetry --seed preview-v1` writes SVG/1024/512 under ignored `data/previews`; the accepted hashes are full `b1ef765b49a44d95726f7b1a10d1a4daf9a5a1b52f274ecc1b0611e85117d408` and preview `85ffb5eb4bd0ae100e3622f193918aad5ad6571f18f97dd076f6a5728cb5eaf4`.
- **Manual acceptance:** open the 512-pixel PNG and confirm unknown gray is clearly different from empty white and filled black, the exact dashed red axis lies between central cells in the source and all choices, and no option changes the given known half. No infer-the-axis question or gallery exists.
- **Verification:** `npm exec vitest run tests/render/symmetry.test.ts`; `npm run preview -- --family symmetry --seed preview-v1`; `npm run check`.

### Counting and Inclusion-Exclusion (P19)

Files: `src/families/counting/schema.ts`, `src/families/counting/engine.ts`, `src/families/counting/canonical.ts`, `tests/families/counting.test.ts`.

- **DSL:** a fixed 5x5 universe with two or three named shapes A/B/C. Each shape has 3-8 unique sorted orthogonally connected cells. Shapes must be distinct and include at least one overlapping cell and one exclusive cell. Queries are `unionCount`, `intersectionAll`, `exactlyOneShape`, or `exactlyKShapes(k)` with k=2/3 within the actual shape count; k=3 with two shapes is rejected. Shapes are not inferred from arbitrary polygons, triangles, or squares.
- **Meaning:** count whole cells whose membership count matches the query. Membership is enumerated over all 25 cell masks, and the answer is cross-checked with independent set/inclusion-exclusion calculations. The answer domain is integer 0..25. `enumerateSolutions` returns one answer, `enumeratedStates = 25`, checker version `counting-v1`, and derived `s001`/`s002` facts for the query answer and all summary counts.
- **Construction:** level 1 uses two shapes of 3-5 cells and `unionCount`; level 2 uses two shapes of 6-8 cells and `intersectionAll`/`exactlyOneShape`; level 3 uses three shapes of 4-8 cells and `intersectionAll`/`exactlyKShapes`. Shapes grow as connected sets from a shared anchor, so overlap is guaranteed; distinctness and at least one exclusive cell are enforced. Construction stays within 64 deterministic draws; invalid attempts are skipped within the budget and the shape count is never reduced. The 100 fixed fixtures produced 34/33/33 successes with zero failures.
- **Options/checker:** the correct integer is accompanied by three distinct false integers drawn from the query's other summary counts and correct ±1, then the 0..25 domain. Four distinct rendered numbers are required, and exactly one satisfies the independent checker.
- **Rules/facts:** code-owned rules define all four operations, whole-cell counting, shape labels A/B/C, overlap behavior, and the 0..25 answer domain. Observation facts `p001` onward list each shape's cells in row-major order.
- **Fingerprint:** `canonicalData` emits `grid=5x5`, `shapes=2|3`, query tokens `operation=...` and optional `k=...`, 25 `cell:r:c:mask` geometry tokens, and `region:mask:count` relation tokens for every non-empty mask. It minimizes over all eight D4 frames and every shape-ID permutation. Counts alone are insufficient because the full spatial membership grid is retained.
- **Verification:** `npm exec vitest run tests/families/counting.test.ts`; `npm run check`. Focused tests cover pair/triple overlaps, exclusive cells, invalid/disconnected/duplicate shapes, boundary-count exclusion, query differences, geometry-vs-count fingerprints, wrong keys, deterministic mutations, P19 engine registration, and 100 fixed constructions.
- **Manual acceptance:** independently computed membership counts and set/inclusion-exclusion values agree for every query on the fixed two- and three-shape fixtures. P20 adds the counting renderer.

### Counting Renderer and Complete Registry Gate (P20)

Files: `src/families/counting/render.ts`, `src/domain/spec.ts`, `tests/render/counting.test.ts`, `tests/families/registry.test.ts`.

- **Grid:** the source is a fixed 5x5 grid of 76-pixel cells. Each cell has a white fill and a fixed 8-pixel `#333333` outline. Every cell always contains one fixed marker position per actual shape (two for a two-shape spec, three for a three-shape spec).
- **Markers:** shape A is a square, shape B is a circle, and shape C is a triangle. A member marker is filled with `#111111`; a non-member marker is an outline-only glyph with `#111111` stroke and no fill. Shape identity and membership are therefore encoded by fixed glyph shape, fixed position, and fill/outline, never by a translucent cell fill alone.
- **Legend:** a dedicated overlap legend renders every non-empty membership combination. Two-shape specs show `A`, `B`, and `AB`; three-shape specs show all seven: `A`, `B`, `AB`, `C`, `AC`, `BC`, and `ABC`. The legend states `Filled = member. Outline = not a member.`
- **Query/options:** the stem prints the exact code-owned query phrase, such as `Query: cells in exactly 2 shapes.`, plus the shape labels and marker order. Four A-D tiles show distinct integers in 0..25; exactly one satisfies `checkCountingAnswer`.
- **Validation:** `assertCountingScene` runs shared `assertScene`, then checks critical groups `source-grid`, `membership-legend`, and `option-A-number`..`option-D-number`; exactly 25 fixed source cells; exactly one fixed marker per shape per cell; member fill versus non-member outline; white cell fill and fixed outline; every legend sample and label; the exact query text; and four distinct choices with exactly one correct answer. Error codes include `MISSING_MARKER`, `WRONG_MARKER`, `MISSING_LEGEND`, `WRONG_QUERY`, `COLOR_ONLY_ENCODING`, `OPTION_NOT_DISTINCT`, and `WRONG_GEOMETRY`.
- **Spec union:** `src/domain/spec.ts` exposes `FAMILY_SPEC_SCHEMAS`, `FamilySpecEnvelopeSchema`, `parseFamilySpec`, and `safeParseFamilySpecEnvelope`. The envelope is a strict discriminated union on `family` over the ten real family schemas; raw `unknown` input must be parsed before it can be accepted as a spec.
- **Registry gate:** `tests/families/registry.test.ts` asserts all ten engines and all five real renderers, matching family/modality pairs, no text renderer, non-empty visible rules and fact inventories, one unique solution, four distinct options with one correct answer, canonical family data, deterministic mutations, and a valid 1024x1024 scene from every SVG renderer at all three difficulties.
- **Evidence:** focused tests cover all seven non-empty three-shape memberships, hidden source/legend overlaps, missing markers, missing legend, color-only cells, wrong query text, duplicate choices, deterministic 1024/512 PNGs, grayscale luminance checks at 512 pixels, 100 seeded scenes, and fixed plus ten seeded critical-group pixel checks.
- **Preview:** `npm run preview -- --family counting --seed preview-v1` writes SVG/1024/512 under ignored `data/previews`; the accepted hashes are full `316be4d8fad238ddf43f764653a36af7a729b66bd82765194aece954538632b8` and preview `bc2caa8d7f4c1cfad703be8626f394cab88132ce278bb84643142fa61b9be89c`.

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

The schema also rejects malformed family tokens: ranking clues outside the declared size, matching endpoints without canonical integer category/item notation, scheduling events/slots/resources outside their bounds, truth speaker indices outside the population or duplicate speakers, arithmetic rows outside the declared coefficient/constant bounds, matrix cells outside the 3x3 visible set, arbitrary D4 operations, path edges that are not sorted orthogonal edges of the active tree, symmetry cells outside the declared known half, and counting masks outside `0..2^shapes-1`. Counting region counts must equal the number of geometry cells carrying the same membership mask, and all 25 grid cells must appear exactly once. Truth relation tokens may contain a reduced subset of speaker predicates for internal fingerprinting. The DSL still requires one statement per person; the reduced core is not a replacement DSL with missing public statements.

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

Registration does not import a future family or placeholder renderer. The production registry contains the five text engines, matrix, the matrix renderer, transforms, the transforms renderer, paths, the paths renderer, symmetry, the symmetry renderer, counting, and the counting renderer; P20 completes the ten-engine/five-renderer gate.
