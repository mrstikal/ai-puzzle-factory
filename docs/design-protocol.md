# AI Puzzle Designer Protocol (P46)

Status: P46 implements the offline designer contract, deterministic cohort plan,
selected-family proposal schema, pre-solver bounds, prompt adapter, and dry-run
CLI. It does not execute generation, repair, solving, baseline comparison,
presentation, human evaluation, or live calls.

## Cohort plan

`buildDesignerPlanManifest` produces a deterministic manifest for three plan
kinds:

| Plan kind | Root seed | Assignments | Candidate slots | Content calls | Probes | Total calls |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `design_primary` | `puzzle-designer-v1` | 100 | 300 | 400 | 0 | 400 |
| `design_pilot` | `puzzle-designer-pilot-v1` | 20 | 60 | 80 | 2 | 82 |
| `design_mock` | `puzzle-designer-mock-v1` | 100 | 300 | 400 | 0 | 400 |

The primary and mock plans contain ten assignments per family. Each family has
four level-1, three level-2, and three level-3 assignments. The pilot plan has
two assignments per family; the first difficulty is the family ordinal modulo
three and the second is the next difficulty. Text and SVG assignments split
50/50 in the 100-assignment plans and 10/10 in the pilot.

Every assignment has three arms: `baseline`, `ai_one_shot`, and `ai_feedback`.
The baseline arm is code-owned and makes zero AI calls. The AI call ceiling is
one one-shot call plus one feedback-first call plus two repair calls per
assignment, for 400 content calls in the primary plan. The maximum client
transport-attempt count is three times the total logical-call count; OpenRouter
internal provider fallback is excluded.

Assignment IDs are stable, for example `design-text-ranking-01`. Candidate
slot IDs append the arm, for example `design-text-ranking-01-ai_feedback`.
Candidate slots use `slotKind: "designer"` and `lane: null`; they are not legacy
lanes and do not use the legacy `approved` verdict.

Seeds use SHA-256 over the protocol version, root seed, assignment ID, arm
scope, and purpose. Purposes are `options`, `layout`, `baseline`,
`dispatch-order`, and `human-order`. Shared assignment-level decisions use the
`shared` scope. The assignment seed in the manifest is the shared `options`
stream. The AI design itself is not seeded.

## Design proposal contract

A proposal is one strict JSON object:

```json
{
  "family": "ranking",
  "difficulty": 1,
  "spec": { "size": 4, "clues": [] },
  "designIntent": null,
  "presentationSkin": null
}
```

Rules:

- `family` is an exact literal for the assignment.
- `difficulty` is an exact literal for the assignment.
- `spec` is the selected family's existing strict DSL schema.
- `designIntent` is required-null. It is bounded provenance, never shown to a
  solver, reviewer, renderer, or human evaluator.
- `presentationSkin` is required-null. When skin proposals are enabled it is
  either null or a strict closed-catalog object; when disabled it must be null.
- Extra properties, answers, options, visible question/clue/hint/explanation
  prose, SVG/XML, URLs, code-like strings, and arbitrary provider fields are
  rejected.
- Family and difficulty are checked before family-specific parsing so a
  mismatched proposal reports `WRONG_FAMILY` or `WRONG_DIFFICULTY` rather than a
  generic schema error.

The wire schema is compiled from the selected-family Zod schema. It is not a
generic runtime-only schema and is not the legacy spec envelope.

## Closed presentation-skin catalog

The catalog is code-owned in `src/domain/design.ts`.

- Themes: `garden`, `space`, `ocean`, `kitchen`.
- Each theme has twelve distinct labels, at most 32 characters each.
- Entity IDs are family-specific and bounded:
  - ranking `item-0..item-4`
  - matching `person-0..3`, `pet-0..3`, `color-0..3`
  - scheduling `event-0..3`, `resource-0..1`
  - truth `person-0..3`
  - arithmetic `var-x`, `var-y`, `var-z`
  - matrix `glyph-0..3`
  - transforms `tile`, `operation-0`, `operation-1`
  - paths `start`, `goal`
  - symmetry `tile`, `axis`
  - counting `shape-0..shape-2`
- The required entity set is derived from the parsed spec: ranking size, truth
  people count, transform operation count, and counting shape count narrow the
  set. The prompt and compiled wire schema advertise exactly that
  difficulty-specific set; they never advertise the larger family-level union.
- A non-null skin must label every required entity exactly once with a distinct
  label from the chosen theme. Missing, duplicate, extra, cross-family, and
  cross-theme labels are rejected.
- Null skin means the code-owned neutral presentation labels. A skin can never
  change conditions, numbers, relations, query, options, or answers.
- `buildDesignProposalRequest` enables skin proposals by default; callers can
  disable them, in which case the wire schema requires `presentationSkin: null`.

## Bounds

Global DSL bounds are enforced by the existing family schemas. P46 adds the
pre-solver level rules below.

| Family | Level 1 | Level 2 | Level 3 |
| --- | --- | --- | --- |
| ranking | size 4 | size 5 | size 5 |
| matching | no additional structural proxy | same | same |
| scheduling | no additional structural proxy | same | same |
| truth | 3 people; at most one binary statement; no xor | 4 people; and/or allowed; no xor | 4 people; and/or/xor allowed |
| arithmetic | max absolute coefficient 1 | max absolute coefficient 2 | max absolute coefficient 3; at least one inequality present |
| matrix | no additional structural proxy | same | same |
| transforms | exactly one nonidentity rotation | exactly one reflection | one quarter-turn rotation and one reflection, noncommuting |
| paths | active cells 6-12; route target checked after solving | active cells 6-12; route target checked after solving | active cells 6-12; route target checked after solving |
| symmetry | vertical axis | horizontal axis | either axis; at least two known occupied components |
| counting | two shapes; unionCount | two shapes; intersectionAll or exactlyOneShape | three shapes; intersectionAll or exactlyKShapes |

Matching, scheduling, and matrix levels are requested difficulty targets
without an additional structural admission proxy. Paths route length and
arithmetic inequality nonredundancy are checked after solving by P47.

## Prompt and request identity

The prompt asset is `src/ai/prompts/designer-v1/design.txt` and starts with
`PUZZLE_DESIGN_PROMPT_VERSION: v1`.

The system message contains the designer instructions and proposal metadata.
The user message contains only:

- assignment ID, family, and difficulty;
- global bounds, level rules, and allowed operators;
- the selected family DSL schema;
- the selected response schema;
- the closed skin catalog when skin proposals are enabled, otherwise null.

The prompt never contains a baseline spec, witness, answer, options, or human
feedback. It asks for a complete DSL structure, not a fixed parameter template.

One-shot and feedback attempt 0 use the same serialized request, response
schema, and prompt hash. The arm is ledger metadata only and is not part of the
request. Changing family, difficulty, or skin mode changes the prompt hash;
changing family, difficulty, or skin mode also changes the schema hash.

## Configuration

`readDesignerLiveEnvironment` requires only:

- `OPENROUTER_API_KEY`
- `DESIGNER_MODEL`

Optional validated settings:

- `DESIGNER_TEMPERATURE` (0..2)
- `DESIGNER_SEED` (integer 0..2147483647)
- `DESIGNER_REASONING` (`true` or `false`)
- `DESIGNER_REASONING_EFFORT` (`low`, `medium`, `high`)
- `DESIGNER_MAX_OUTPUT_TOKENS` (positive integer, default 8192)

It does not call `readLiveEnvironment` and does not require generator or
reviewer models. Legacy `readLiveEnvironment` keeps its original reviewer
separation contract.

Shared request-builder seams support the designer roles `design`,
`design_repair_1`, and `design_repair_2`. The legacy `REQUEST_ROLES` array,
probe-role array, ledger role parser, mock scenario parser, and preflight probe
counts are unchanged. Designer ledger roles and designer mock scenarios arrive
with P47 and P50.1; until then the legacy parsers explicitly reject them rather
than relabeling a designer call.

## CLI

```sh
npm run designer -- --dry-run --seed puzzle-designer-v1
npm run designer -- --dry-run --pilot
npm run designer -- --dry-run --mock
```

The CLI prints the deterministic plan manifest and exits. Bare execution,
reviewer flags, calibration flags, live/paid flags, and non-fixed seeds are
rejected. P46 implements offline dry-run only.

## Verification

```sh
npx vitest run tests/ai/design-proposal.test.ts
npx tsc -p tsconfig.json --noEmit
npx eslint src/domain/design.ts src/design/assignments.ts src/design/bounds.ts src/ai/config.ts src/ai/schemas.ts src/ai/design-proposal.ts src/cli/design.ts tests/ai/design-proposal.test.ts
```

The test file covers every family and difficulty, wrong family/difficulty,
global schema bounds, pre-solver level boundaries, null and non-null decorative
fields, closed skin mappings, forbidden content, request/schema/prompt hashes,
strict-schema compilation failure, designer-only configuration, legacy role
seams, exact manifest counts, and the dry-run CLI.

## Out of scope

- Repair loop and repair prompts (P47)
- Attempt ledger and SQL migration for designer roles (P47)
- Solver diagnostics, route-length and inequality-essentiality checks (P47)
- Baseline comparison and structural comparator (P48)
- Presentation rendering and assets (P49)
- Human sampler, metrics, decision thresholds, and mock scenarios (P50)
- Live calls, capability preflight, and frozen protocol execution (P51)
