import {
  AssembledPresentationSchema,
  VisiblePresentationSchema,
  type AssembledPresentation,
  type VisiblePresentation,
} from "../domain/presentation.js";
import { MODALITY_BY_FAMILY } from "../domain/experiment.js";

export type PresentationErrorCode =
  | "INVALID_PRESENTATION"
  | "INVALID_WORDING"
  | "INVALID_SPEC"
  | "INVALID_SLOT"
  | "INVALID_SOLVE_RESULT"
  | "FACT_COVERAGE_MISMATCH"
  | "UNKNOWN_FACT_REFERENCE"
  | "UNEXPECTED_CLUE_TEXTS"
  | "INVALID_OPTION_SET"
  | "INVALID_OPTION_VALUE"
  | "DUPLICATE_OPTION_TEXT"
  | "MISSING_IMAGE_ASSET"
  | "UNEXPECTED_IMAGE_ASSET"
  | "PUBLIC_REVEAL_LEAK"
  | "SEMANTIC_ALIGNMENT_CLAIMED";

export class PresentationError extends Error {
  readonly code: PresentationErrorCode;

  constructor(
    code: PresentationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PresentationError";
    this.code = code;
  }
}

const FORBIDDEN_PUBLIC_KEYS = [
  "correctLabel",
  "correctValue",
  "hint",
  "explanationSteps",
  "proof",
  "reveal",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertNoPublicRevealKeys(input: unknown): void {
  if (!isRecord(input)) {
    return;
  }
  for (const key of FORBIDDEN_PUBLIC_KEYS) {
    if (key in input) {
      throw new PresentationError(
        "PUBLIC_REVEAL_LEAK",
        `public presentation must not expose ${key}`,
      );
    }
  }
}

export function assertVisiblePresentation(input: unknown): VisiblePresentation {
  assertNoPublicRevealKeys(input);
  const result = VisiblePresentationSchema.safeParse(input);
  if (!result.success) {
    throw new PresentationError(
      "INVALID_PRESENTATION",
      "visible presentation does not satisfy the public schema",
      { cause: result.error },
    );
  }
  const parsed = result.data;
  const labels = parsed.options.map((option) => option.label).join("");
  if (labels !== "ABCD") {
    throw new PresentationError(
      "INVALID_OPTION_SET",
      "visible options must be labeled A-D in order",
    );
  }
  if (new Set(parsed.options.map((option) => option.text)).size !== 4) {
    throw new PresentationError(
      "DUPLICATE_OPTION_TEXT",
      "visible options must have four distinct texts",
    );
  }
  const clueIds = parsed.clues.map((clue) => clue.factId);
  if (new Set(clueIds).size !== clueIds.length) {
    throw new PresentationError(
      "FACT_COVERAGE_MISMATCH",
      "visible clues must not repeat fact IDs",
    );
  }
  const [slotModality, slotFamily] = parsed.slotId.split("-");
  if (slotModality !== parsed.modality || slotFamily !== parsed.family) {
    throw new PresentationError(
      "INVALID_SLOT",
      "presentation slot ID must match its modality and family",
    );
  }
  if (parsed.modality === "text") {
    if (parsed.assets.svgHash !== null || parsed.assets.pngHash !== null) {
      throw new PresentationError(
        "UNEXPECTED_IMAGE_ASSET",
        "text presentations cannot carry image asset hashes",
      );
    }
  } else {
    if (parsed.clues.length > 0) {
      throw new PresentationError(
        "UNEXPECTED_CLUE_TEXTS",
        "SVG presentations must keep clue text empty",
      );
    }
    if (parsed.assets.svgHash === null || parsed.assets.pngHash === null) {
      throw new PresentationError(
        "MISSING_IMAGE_ASSET",
        "SVG presentations require both stored SVG and PNG hashes",
      );
    }
  }
  if (MODALITY_BY_FAMILY[parsed.family] !== parsed.modality) {
    throw new PresentationError(
      "INVALID_PRESENTATION",
      "presentation modality must match its family",
    );
  }
  return parsed;
}

export function assertAssembledPresentation(
  input: unknown,
): AssembledPresentation {
  if (isRecord(input) && isRecord(input.visible)) {
    assertNoPublicRevealKeys(input.visible);
  }
  if (
    isRecord(input) &&
    isRecord(input.checks) &&
    input.checks.semanticAlignment !== undefined &&
    input.checks.semanticAlignment !== "semantic_alignment_pending"
  ) {
    throw new PresentationError(
      "SEMANTIC_ALIGNMENT_CLAIMED",
      "P22 cannot claim semantic alignment; the status must remain pending",
    );
  }
  const result = AssembledPresentationSchema.safeParse(input);
  if (!result.success) {
    throw new PresentationError(
      "INVALID_PRESENTATION",
      "assembled presentation does not satisfy its schema",
      { cause: result.error },
    );
  }
  const parsed = result.data;
  assertVisiblePresentation(parsed.visible);
  if (
    (parsed.visible.modality === "text" && parsed.checks.assets !== "not_applicable") ||
    (parsed.visible.modality === "svg" && parsed.checks.assets !== "pass")
  ) {
    throw new PresentationError(
      "INVALID_PRESENTATION",
      "mechanical asset status must match the presentation modality",
    );
  }
  return parsed;
}
