# Deterministic Presentation and Proof-Derived Explanations (P49)

Status: implemented offline. P49 provides code-owned text and visual presentation
templates, a typed proof trace with entailment checks, strategy-only hints, a
separate presentation certificate, and a design-view gallery. It makes no AI
wording, hint, explanation, or reviewer call.

## Three acceptance steps

P49 is organized as three bounded steps:

1. Text templates for question, rules, clue text, option text, and title for all
   ten families.
2. Visual templates and the presentation certificate for SVG families.
3. Proof traces, hints, and explanations derived from verified solution steps.

All three are implemented; acceptance evidence is separated below. Interim
presentations are nonterminal until the proof/certificate checks pass.

## Code-owned templates

`src/presentation/templates.ts` builds the wording bundle from:

- the verified family spec;
- `engine.visibleRules(spec)` for domain, closed world, target, operations, and
  conventions;
- `engine.facts(spec)` for text clue text and fact IDs;
- the code-owned family title and neutral entity-label set;
- a code-owned strategy hint.

Text families show one clue per code-owned fact. SVG families keep `clues` empty;
observations live in the rendered diagram. Options use the existing
`formatOptionText` code-owned formatter. Titles are family titles plus the
requested level.

The neutral label set is derived from the verified spec and the family's own
displayed labels: ranking `A`-`E` only up to the actual size; matching
`A1`-`A4`, `B1`-`B4`, `C1`-`C4`; scheduling `E1`-`E4`, `R1`-`R2`; truth `P1`-`P4`
only up to the actual people count; arithmetic `x/y/z`; matrix `G1`-`G4`;
transforms `Tile`, `op0`, `op1` only for present operations; paths `S/G`;
symmetry `Tile/Axis`; counting `A`-`C` only up to the actual shape count. These
are the family vocabulary the visible rules and observation facts use. The optional AI `presentationSkin` is validated against the
P46 closed catalog, stored separately in the design view, and never used for
conditions, numbers, relations, query, options, or the answer. The primary
comparison remains neutral.

## Proof trace and explanations

`src/presentation/explain.ts` defines a strict typed trace:

- each step has a sequential `sNNN` ID, premise fact IDs, prior step IDs, a
  typed deduction, a code-owned justification, and bounded text;
- deductions are `domain_survivors`, `forced_output`, or `complete_answer`;
- the final step establishes the unique complete answer;
- premise facts must resolve against the rule/local/observation inventory and
  every step must cite the complete required premise set;
- prior step IDs must reference only earlier steps; self, forward, duplicate, or
  circular references are rejected;
- `domain_survivors` records the checked domain size and survivor count and must
  match the independent solve;
- `forced_output` records a code-owned visual operation and must match the
  independent solve;
- `complete_answer` requires a prior verified deduction and the final answer
  hash.

Text traces use a bounded exhaustive-elimination step followed by a final answer
step. Visual traces use a forced-output step followed by the final answer step.
The explanation steps are built from those trace steps. A witness, a list of
true facts, or agreement with the unique answer alone is not accepted as a step.

Hints are code-owned strategy hints only (`hintKind: "strategy"`). They contain no
option text and no correct label. Hints and explanations are reveal-only data and
never part of the public solving DTO. `toPublicDesignView` strips the reveal.

## Presentation certificate and design view

`src/presentation/design-view.ts` builds a design view with:

- the code-owned visible question, rules, clues, options, title, and assets;
- the reveal data (correct label/value, hint, explanation steps, proof trace);
- the neutral labels and optional separate skin;
- a presentation certificate binding the spec hash, template version/hash,
  proof-trace hash, choices hash, correct label, SVG/PNG/preview hashes, and a
  certificate hash; the template hash covers the full visible payload
  (title, question, rules, clue texts/fact IDs, option texts, neutral labels,
  and hint), not just the wording template;
- mechanical checks: templates, proof trace, certificate, skin, and the unchanged
  `semantic_alignment_pending` limitation.

SVG views require `choicesSeed` so the rendered option scene matches the
certificate choices; the builder always renders and asserts the scene itself and
does not accept caller-supplied unverified assets. It renders full 1024 PNG and
512 preview PNG hashes from the existing trusted renderer. Text views carry no
image hashes. `buildDesignView` runs `assertProofTrace` through `assertDesignView`
before emitting the view. The schema and verifier cross-check the reveal hint,
explanation steps, and correct value against the certified trace, and the
context-aware verifier checks the reveal answer against the independent solve and
choices, re-derives the visible clues/options/rules/title/neutral labels from the
supplied spec and choices, and rejects a view whose visible payload no longer
matches them. `renderDesignViewGallery` emits a static, escaped gallery with one text
and one SVG card, code-owned question/rules (including operations and
conventions)/clues/options, inline trusted SVG, and a gallery-only reveal.

## Verification

```sh
npx vitest run tests/presentation/design-view.test.ts
npm run check
```

The test covers all ten families, text/SVG, valid non-baseline specs, template
determinism, every text-family operator/polarity/nesting used by family facts
(including arithmetic `lt` and `allDifferent: true`), exact fact coverage, no
answer leakage before reveal, every explanation reference, proof entailment,
witness-true but premise-incomplete deductions, circular/forward references,
exhaustive-elimination fallback, strategy hint non-spoiling, unique final answer,
neutral skin stability, spec-derived neutral labels, hostile-label escaping,
invalid skin rejection, certificate binding, reveal-to-trace tamper rejection,
visible-payload tamper rejection, spec-derived visual neutral vocabulary,
gallery rules completeness, and zero AI wording/reviewer calls. Visual DSL
operator coverage remains in the existing renderer test suites; P49 does not add
a renderer.

## Manual acceptance

Run:

```sh
npx vitest run tests/presentation/design-view.test.ts -t "manual inspection" --reporter=verbose
```

The test prints one text and one SVG design view and writes
`/tmp/p49-design-view-gallery.html`. Inspect the gallery: question, rules, clues,
and options are code-generated; the hint is a strategy hint; the explanation
follows the verified trace steps; no AI reviewer or free-form wording is
involved. The reveal is gallery-only, not a public solving DTO.

## Out of scope

AI wording, AI hints/explanations, reviewer roles, new renderers, human
evaluation, and any claim of proven human readability.
