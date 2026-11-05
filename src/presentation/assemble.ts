import {
  ChoiceSetSchema,
  deepEqual,
  type ChoiceLabel,
  type ChoiceSet,
} from "../domain/answers.js";
import { FingerprintContentSchema, type FingerprintContent } from "../domain/candidate.js";
import {
  PresentationAssetsSchema,
  WordingBundleSchema,
  type AssembledPresentation,
  type PresentationAssets,
  type VisiblePresentation,
} from "../domain/presentation.js";
import type { Family } from "../domain/experiment.js";
import type { FamilyEngine, SolveResult } from "../families/contracts.js";
import {
  FactContractError,
  SolveResultSchema,
  assertFactReferences,
  assertLocalClueFactCoverage,
  mergeFactInventory,
  ruleFacts,
} from "../families/contracts.js";
import { ArithmeticTupleSchema, tupleText } from "../families/arithmetic/schema.js";
import { CountingAnswerSchema } from "../families/counting/schema.js";
import { MatchingTableSchema } from "../families/matching/schema.js";
import { MatrixAnswerSchema } from "../families/matrix/schema.js";
import { PathRouteSchema } from "../families/paths/schema.js";
import { RankingAnswerSchema } from "../families/ranking/schema.js";
import { ScheduleTableSchema } from "../families/scheduling/schema.js";
import { SymmetryAnswerSchema } from "../families/symmetry/schema.js";
import { TransformAnswerSchema } from "../families/transforms/schema.js";
import { TruthVectorSchema, truthVectorText } from "../families/truth/schema.js";
import {
  PresentationError,
  assertAssembledPresentation,
} from "../validation/presentation.js";

export interface AssemblePresentationInput<S, A> {
  readonly slotId: string;
  readonly engine: FamilyEngine<S, A>;
  readonly spec: S;
  readonly solveResult: SolveResult<A>;
  readonly choices: ChoiceSet<A>;
  readonly wording: unknown;
  readonly assets?: unknown;
}

function optionTextError(error: unknown): never {
  if (error instanceof PresentationError) {
    throw error;
  }
  throw new PresentationError(
    "INVALID_OPTION_VALUE",
    "option value does not satisfy its family answer schema",
    { cause: error },
  );
}

function formatMatchingTable(value: unknown): string {
  const table = MatchingTableSchema.parse(value);
  return table
    .map((row) => `A${row.a + 1}->B${row.b + 1}/C${row.c + 1}`)
    .join("; ");
}

function formatScheduleTable(value: unknown): string {
  const table = ScheduleTableSchema.parse(value);
  return [...table]
    .sort((left, right) => left.event - right.event)
    .map((row) => `E${row.event + 1}->slot ${row.slot}/R${row.resource + 1}`)
    .join("; ");
}

export function formatOptionText(
  family: Family,
  label: ChoiceLabel,
  value: unknown,
): string {
  try {
    switch (family) {
      case "ranking":
        return RankingAnswerSchema.parse(value).join(" ");
      case "matching":
        return formatMatchingTable(value);
      case "scheduling":
        return formatScheduleTable(value);
      case "truth":
        return truthVectorText(TruthVectorSchema.parse(value));
      case "arithmetic":
        return tupleText(ArithmeticTupleSchema.parse(value));
      case "matrix":
        MatrixAnswerSchema.parse(value);
        return `See labeled tile ${label}`;
      case "transforms":
        TransformAnswerSchema.parse(value);
        return `See labeled tile ${label}`;
      case "paths":
        PathRouteSchema.parse(value);
        return `See labeled tile ${label}`;
      case "symmetry":
        SymmetryAnswerSchema.parse(value);
        return `See labeled tile ${label}`;
      case "counting":
        return String(CountingAnswerSchema.parse(value));
      default: {
        const exhaustive: never = family;
        throw new PresentationError(
          "INVALID_OPTION_VALUE",
          `unsupported family ${String(exhaustive)}`,
        );
      }
    }
  } catch (error) {
    optionTextError(error);
  }
}

function factError(error: unknown): never {
  if (error instanceof FactContractError) {
    const code =
      error.code === "UNKNOWN_FACT_ID"
        ? "UNKNOWN_FACT_REFERENCE"
        : "FACT_COVERAGE_MISMATCH";
    throw new PresentationError(code, error.message, { cause: error });
  }
  throw error;
}

function assertSlotMatchesEngine(
  slotId: string,
  family: Family,
  modality: "text" | "svg",
): void {
  const [slotModality, slotFamily] = slotId.split("-");
  if (slotModality !== modality || slotFamily !== family) {
    throw new PresentationError(
      "INVALID_SLOT",
      "slot ID must match the engine family and modality",
    );
  }
}

function assertChoices<S, A>(
  engine: FamilyEngine<S, A>,
  spec: S,
  solveResult: SolveResult<A>,
  choices: ChoiceSet<A>,
): void {
  const labels = choices.choices.map((choice) => choice.label).join("");
  if (labels !== "ABCD" || choices.choices.length !== 4) {
    throw new PresentationError(
      "INVALID_OPTION_SET",
      "choices must be four ordered A-D options",
    );
  }
  const correct = choices.choices.filter((choice) =>
    engine.verifyAnswer(spec, choice.value),
  );
  if (correct.length !== 1) {
    throw new PresentationError(
      "INVALID_OPTION_SET",
      `choices must contain exactly one correct option, found ${correct.length}`,
    );
  }
  const correctChoice = correct[0];
  if (correctChoice === undefined) {
    throw new PresentationError("INVALID_OPTION_SET", "missing correct option");
  }
  if (choices.correctLabel !== correctChoice.label) {
    throw new PresentationError(
      "INVALID_OPTION_SET",
      "stored correctLabel does not name the correct option",
    );
  }
  if (!deepEqual(correctChoice.value, solveResult.correctAnswer)) {
    throw new PresentationError(
      "INVALID_OPTION_SET",
      "correct option value does not match the independent solve result",
    );
  }
}

function assertAssets(
  modality: "text" | "svg",
  assets: PresentationAssets,
): void {
  if (modality === "text") {
    if (assets.svgHash !== null || assets.pngHash !== null) {
      throw new PresentationError(
        "UNEXPECTED_IMAGE_ASSET",
        "text presentation must not carry SVG or PNG hashes",
      );
    }
    return;
  }
  if (assets.svgHash === null || assets.pngHash === null) {
    throw new PresentationError(
      "MISSING_IMAGE_ASSET",
      "SVG presentation requires both stored SVG and PNG hashes",
    );
  }
}

export function assemblePresentation<S, A>(
  input: AssemblePresentationInput<S, A>,
): AssembledPresentation {
  const wording = WordingBundleSchema.safeParse(input.wording);
  if (!wording.success) {
    throw new PresentationError(
      "INVALID_WORDING",
      "wording response does not satisfy the strict wording schema",
      { cause: wording.error },
    );
  }
  const assets = PresentationAssetsSchema.safeParse(
    input.assets ?? { svgHash: null, pngHash: null },
  );
  if (!assets.success) {
    throw new PresentationError(
      "INVALID_PRESENTATION",
      "presentation assets do not satisfy the hash schema",
      { cause: assets.error },
    );
  }
  assertSlotMatchesEngine(input.slotId, input.engine.family, input.engine.modality);
  const parsedSpec = input.engine.schema.safeParse(input.spec);
  if (!parsedSpec.success) {
    throw new PresentationError(
      "INVALID_SPEC",
      "spec does not satisfy the family schema",
      { cause: parsedSpec.error },
    );
  }
  const spec = parsedSpec.data;
  const parsedChoices = ChoiceSetSchema.safeParse(input.choices);
  if (!parsedChoices.success) {
    throw new PresentationError(
      "INVALID_OPTION_SET",
      "choices do not satisfy the shared choice-set contract",
      { cause: parsedChoices.error },
    );
  }

  const solve = SolveResultSchema.safeParse(input.solveResult);
  if (!solve.success) {
    throw new PresentationError(
      "INVALID_SOLVE_RESULT",
      "solve result does not satisfy the shared contract",
      { cause: solve.error },
    );
  }
  const result = solve.data;
  if (
    result.solutionCount !== 1 ||
    result.answerCount !== 1 ||
    result.correctAnswer === null ||
    result.correctAnswer === undefined ||
    result.proof === null
  ) {
    throw new PresentationError(
      "INVALID_SOLVE_RESULT",
      "presentation assembly requires a unique solved answer with a proof",
    );
  }

  assertChoices(input.engine, spec, result as SolveResult<A>, input.choices);
  assertAssets(input.engine.modality, assets.data);

  const rules = input.engine.visibleRules(spec);
  const localFacts = input.engine.facts(spec);
  let inventory: ReturnType<typeof mergeFactInventory>;
  try {
    inventory = mergeFactInventory(ruleFacts(rules), localFacts, result.proof.facts);
  } catch (error) {
    factError(error);
  }
  if (input.engine.modality === "text") {
    try {
      assertLocalClueFactCoverage(
        wording.data.response.clueTexts.map((clue) => clue.factId),
        localFacts,
      );
    } catch (error) {
      factError(error);
    }
  } else if (wording.data.response.clueTexts.length > 0) {
    throw new PresentationError(
      "UNEXPECTED_CLUE_TEXTS",
      "SVG wording must leave clueTexts empty; observations live in the diagram",
    );
  }
  try {
    assertFactReferences(
      wording.data.response.explanationSteps.flatMap((step) => step.factIds),
      inventory,
    );
  } catch (error) {
    factError(error);
  }

  const options = input.choices.choices.map((choice) => ({
    label: choice.label,
    text: formatOptionText(input.engine.family, choice.label, choice.value),
  }));
  if (new Set(options.map((option) => option.text)).size !== 4) {
    throw new PresentationError(
      "DUPLICATE_OPTION_TEXT",
      "code-owned option texts must be distinct",
    );
  }

  const visible: VisiblePresentation = {
    version: 1,
    slotId: input.slotId,
    family: input.engine.family,
    modality: input.engine.modality,
    question: wording.data.response.question,
    rules,
    clues: wording.data.response.clueTexts,
    options,
    assets: assets.data,
  };
  const assembled: AssembledPresentation = {
    version: 1,
    visible,
    reveal: {
      correctLabel: input.choices.correctLabel,
      correctValue: result.correctAnswer,
      hint: wording.data.response.hint,
      explanationSteps: wording.data.response.explanationSteps,
      proof: result.proof,
    },
    wordingSource: wording.data.source,
    checks: {
      wordingSchema: "pass",
      clueFactCoverage: "pass",
      explanationReferences: "pass",
      optionOrder: "pass",
      optionTextDistinctness: "pass",
      assets: input.engine.modality === "svg" ? "pass" : "not_applicable",
      semanticAlignment: "semantic_alignment_pending",
    },
  };
  return assertAssembledPresentation(assembled);
}

export function fingerprintContentFor(
  assembled: AssembledPresentation,
): FingerprintContent {
  return FingerprintContentSchema.parse({
    version: 1,
    question: assembled.visible.question,
    rules: assembled.visible.rules,
    clues: assembled.visible.clues,
    options: assembled.visible.options,
    hint: assembled.reveal.hint,
    explanation: assembled.reveal.explanationSteps,
  });
}
