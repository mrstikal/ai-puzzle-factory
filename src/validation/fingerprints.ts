import type { z } from "zod";
import { canonicalJson, sha256Hex } from "../util/hash.js";
import {
  CandidateFingerprintSchema,
  FingerprintContentSchema,
  RenderHashesSchema,
  type CandidateFingerprint,
  type FingerprintContent,
  type RenderHashes,
} from "../domain/candidate.js";
import type { Family, Modality } from "../domain/experiment.js";
import {
  FeatureMultisetSchema,
  canonicalStructureHash,
  extractStructureFeatures,
} from "../families/canonicalize.js";
import {
  CanonicalStructureSchema,
  type CanonicalStructure,
} from "../families/contracts.js";

export interface FingerprintEngine<S> {
  readonly family: Family;
  readonly modality: Modality;
  readonly schema: z.ZodType<S>;
  canonicalData(spec: S): CanonicalStructure;
}

export type FingerprintErrorCode =
  | "SPEC_PARSE_FAILED"
  | "FAMILY_MISMATCH"
  | "EMPTY_FEATURES"
  | "STRUCTURE_HASH_MISMATCH"
  | "FEATURE_MISMATCH"
  | "RENDER_HASHES_FOR_TEXT"
  | "INVALID_RENDER_HASHES"
  | "CONTENT_SCOPE_MISMATCH";

export class FingerprintError extends Error {
  readonly code: FingerprintErrorCode;

  constructor(
    code: FingerprintErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FingerprintError";
    this.code = code;
  }
}

export function computeContentHash(content: unknown): string {
  const parsed = FingerprintContentSchema.parse(content);
  return sha256Hex(canonicalJson(parsed));
}

export function parseFingerprintContent(content: unknown): FingerprintContent {
  return FingerprintContentSchema.parse(content);
}

export function computeCanonicalSpecHash<S>(
  engine: FingerprintEngine<S>,
  spec: S,
): string {
  const parsed = engine.schema.safeParse(spec);
  if (!parsed.success) {
    throw new FingerprintError(
      "SPEC_PARSE_FAILED",
      `spec does not satisfy the ${engine.family} schema`,
      { cause: parsed.error },
    );
  }
  return sha256Hex(canonicalJson(parsed.data));
}

export interface StructureFingerprint {
  readonly canonicalStructure: CanonicalStructure;
  readonly structureHash: string;
  readonly features: ReturnType<typeof FeatureMultisetSchema.parse>;
}

export function computeStructureFingerprint<S>(
  engine: FingerprintEngine<S>,
  spec: S,
): StructureFingerprint {
  const parsed = engine.schema.safeParse(spec);
  if (!parsed.success) {
    throw new FingerprintError(
      "SPEC_PARSE_FAILED",
      `spec does not satisfy the ${engine.family} schema`,
      { cause: parsed.error },
    );
  }
  const canonicalStructure = CanonicalStructureSchema.parse(
    engine.canonicalData(parsed.data),
  );
  if (canonicalStructure.family !== engine.family) {
    throw new FingerprintError(
      "FAMILY_MISMATCH",
      `canonical structure family ${canonicalStructure.family} does not match ${engine.family}`,
    );
  }
  const features = FeatureMultisetSchema.parse(
    extractStructureFeatures(canonicalStructure),
  );
  if (features.length === 0) {
    throw new FingerprintError(
      "EMPTY_FEATURES",
      `family ${engine.family} produced no structural features`,
    );
  }
  return {
    canonicalStructure,
    structureHash: canonicalStructureHash(canonicalStructure),
    features,
  };
}

export interface FingerprintCandidateInput<S> {
  readonly engine: FingerprintEngine<S>;
  readonly spec: S;
  readonly content?: unknown;
  readonly renderHashes?: unknown;
}

export function fingerprintCandidate<S>(
  input: FingerprintCandidateInput<S>,
): CandidateFingerprint {
  const specHash = computeCanonicalSpecHash(input.engine, input.spec);
  const structure = computeStructureFingerprint(input.engine, input.spec);
  let contentHash: string | null = null;
  if (input.content !== undefined) {
    const content = parseFingerprintContent(input.content);
    if (input.engine.modality === "text") {
      if (content.clues.some((clue) => !/^f\d{3,6}$/.test(clue.factId))) {
        throw new FingerprintError(
          "CONTENT_SCOPE_MISMATCH",
          "text fingerprints may only reference local fNNN clue facts",
        );
      }
    } else if (content.clues.length > 0) {
      throw new FingerprintError(
        "CONTENT_SCOPE_MISMATCH",
        "SVG fingerprints cannot carry clue facts; observations live in the diagram",
      );
    }
    contentHash = computeContentHash(content);
  }
  const renderHashes: RenderHashes = RenderHashesSchema.parse(
    input.renderHashes ?? { svg: null, png: null },
  );
  if (
    input.engine.modality === "text" &&
    (renderHashes.svg !== null || renderHashes.png !== null)
  ) {
    throw new FingerprintError(
      "RENDER_HASHES_FOR_TEXT",
      `text family ${input.engine.family} cannot carry render hashes`,
    );
  }
  return assertFingerprintConsistency({
    version: 1,
    family: input.engine.family,
    modality: input.engine.modality,
    specHash,
    structureHash: structure.structureHash,
    contentHash,
    renderHashes,
    canonicalStructure: structure.canonicalStructure,
    features: structure.features,
  });
}

export function assertFingerprintConsistency(
  fingerprint: unknown,
): CandidateFingerprint {
  const parsed = CandidateFingerprintSchema.parse(fingerprint);
  if (parsed.canonicalStructure === null) {
    if (parsed.structureHash !== null || parsed.features.length > 0) {
      throw new FingerprintError(
        "STRUCTURE_HASH_MISMATCH",
        "a fingerprint without canonicalStructure cannot carry structure data",
      );
    }
    return parsed;
  }
  const expectedHash = canonicalStructureHash(parsed.canonicalStructure);
  if (parsed.structureHash !== expectedHash) {
    throw new FingerprintError(
      "STRUCTURE_HASH_MISMATCH",
      `structure hash does not match the canonical structure for ${parsed.family}`,
    );
  }
  const expectedFeatures = FeatureMultisetSchema.parse(
    extractStructureFeatures(parsed.canonicalStructure),
  );
  if (expectedFeatures.length === 0) {
    throw new FingerprintError(
      "EMPTY_FEATURES",
      `family ${parsed.family} produced no structural features`,
    );
  }
  if (canonicalJson(parsed.features) !== canonicalJson(expectedFeatures)) {
    throw new FingerprintError(
      "FEATURE_MISMATCH",
      `features do not match the canonical structure for ${parsed.family}`,
    );
  }
  return parsed;
}
