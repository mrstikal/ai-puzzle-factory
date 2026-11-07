import { z } from "zod";
import { ChoiceSetSchema, type ChoiceSet } from "../domain/answers.js";
import {
  CALIBRATION_ROOT_SEED,
  FAMILIES,
  MODALITY_BY_FAMILY,
  PROTOCOL_VERSION,
  SLOT_ID_PATTERN,
  DifficultySchema,
  FamilySchema,
  ModalitySchema,
  type Difficulty,
  type Family,
  type Modality,
  type SvgFamily,
} from "../domain/experiment.js";
import {
  RevealDataSchema,
  VisiblePresentationSchema,
  type RevealData,
  type VisiblePresentation,
} from "../domain/presentation.js";
import {
  SolveResultSchema,
  type SolveResult,
} from "../families/contracts.js";
import { TransformsSpecSchema } from "../families/transforms/schema.js";
import { productionRegistry } from "../families/registry.js";
import { assemblePresentation } from "../presentation/assemble.js";
import { makeFixtureWording } from "../presentation/wording.js";
import { assertPngNoTextMetadata, hashPng, renderScenePng } from "../render/png.js";
import { SCENE_SIZE, type Scene } from "../render/scene.js";
import { serializeScene } from "../render/svg.js";
import { hashCanonicalJson, sha256Hex } from "../util/hash.js";
import { deriveStreamSeed } from "../util/random.js";
import { buildDuplicateDefect, buildFamilyDefect } from "./mutations.js";

export const CALIBRATION_PACK_VERSION = 1 as const;
export const CALIBRATION_PACK_VERSION_V2 = 2 as const;
export type CalibrationPackVersion =
  | typeof CALIBRATION_PACK_VERSION
  | typeof CALIBRATION_PACK_VERSION_V2;
export const CALIBRATION_VARIANTS = ["sound", "defective"] as const;
export type CalibrationVariant = (typeof CALIBRATION_VARIANTS)[number];

export const CALIBRATION_DEFECT_CODES = [
  "DUPLICATE_CORRECT_OPTION",
  "NO_VALID_OFFERED_SOLUTION",
  "MULTIPLE_OFFERED_SOLUTIONS",
  "CONTRADICTORY_XOR_EXAMPLE",
  "CONTRADICTORY_TRANSFORM_INSTRUCTIONS",
  "CLOSED_ROUTE_EDGE",
  "CONTRADICTORY_SYMMETRY_AXIS",
  "CONFLICTING_COUNTING_CONVENTIONS",
] as const;
export type CalibrationDefectCode = (typeof CALIBRATION_DEFECT_CODES)[number];

export const CALIBRATION_MUTATION_KINDS = [
  "duplicate_correct_option",
  "visible_primitive_mutation",
  "contradictory_matrix_example",
  "contradictory_transform_instructions",
  "closed_route_edge",
  "contradictory_symmetry_axis",
  "conflicting_counting_conventions",
] as const;
export type CalibrationMutationKind = (typeof CALIBRATION_MUTATION_KINDS)[number];

export const CALIBRATION_FIELDS = [
  "question",
  "rules",
  "clues",
  "options",
  "assets",
] as const;
export type CalibrationField = (typeof CALIBRATION_FIELDS)[number];

export interface CalibrationOriginal {
  readonly spec: unknown;
  readonly solveResult: SolveResult<unknown>;
  readonly choices: ChoiceSet<unknown>;
  readonly visible: VisiblePresentation;
  readonly reveal: RevealData;
  readonly contentHash: string;
  readonly pngHash: string | null;
  readonly svgHash: string | null;
}

export interface CalibrationMutation {
  readonly kind: CalibrationMutationKind;
  readonly description: string;
  readonly changedFields: readonly CalibrationField[];
  readonly affectedFactIds: readonly string[];
  readonly details: Readonly<Record<string, unknown>>;
}

export interface CalibrationExpected {
  readonly blind: {
    readonly result: "correct" | "defect" | "no_unique";
    readonly correctLabel: "A" | "B" | "C" | "D" | null;
    readonly acceptedDefectCodes: readonly CalibrationDefectCode[];
  };
  readonly alignment: {
    readonly result: "pass" | "fail";
    readonly acceptedFailingFields: readonly CalibrationField[];
    readonly acceptedFactIds: readonly string[];
  };
}

export interface CalibrationFixture {
  readonly fixtureId: string;
  readonly slotId: string;
  readonly family: Family;
  readonly modality: Modality;
  readonly difficulty: Difficulty;
  readonly variant: CalibrationVariant;
  readonly seed: string;
  readonly optionsSeed: string;
  readonly sourceFixtureId: string | null;
  readonly visible: VisiblePresentation;
  readonly original: CalibrationOriginal;
  readonly mutation: CalibrationMutation | null;
  readonly expected: CalibrationExpected;
  readonly contentHash: string;
  readonly originalContentHash: string;
  readonly pngHash: string | null;
  readonly svgHash: string | null;
  readonly originalPngHash: string | null;
  readonly originalSvgHash: string | null;
  readonly fixtureHash: string;
  readonly humanVerified: false;
  readonly auditor: null;
  readonly auditorTime: null;
}

export interface CalibrationPack {
  readonly version: CalibrationPackVersion;
  readonly rootSeed: typeof CALIBRATION_ROOT_SEED;
  readonly fixtures: readonly CalibrationFixture[];
  readonly packHash: string;
}

export interface CalibrationSoundBase {
  readonly slotId: string;
  readonly family: Family;
  readonly modality: Modality;
  readonly difficulty: Difficulty;
  readonly seed: string;
  readonly optionsSeed: string;
  readonly spec: unknown;
  readonly solveResult: SolveResult<unknown>;
  readonly choices: ChoiceSet<unknown>;
  readonly visible: VisiblePresentation;
  readonly reveal: RevealData;
  readonly scene: Scene | null;
  readonly svg: string | null;
  readonly png: Buffer | null;
  readonly hashes: {
    readonly contentHash: string;
    readonly pngHash: string | null;
    readonly svgHash: string | null;
  };
}

export interface CalibrationArtifacts {
  readonly visible: {
    readonly svg: string | null;
    readonly png: Buffer | null;
  };
  readonly original: {
    readonly svg: string | null;
    readonly png: Buffer | null;
  };
}

export interface CalibrationMutationResult {
  readonly visible: VisiblePresentation;
  readonly mutation: CalibrationMutation;
  readonly expected: CalibrationExpected;
  readonly artifacts: CalibrationArtifacts;
  readonly original: CalibrationOriginal;
}

export interface BuiltCalibrationFixture {
  readonly fixture: CalibrationFixture;
  readonly artifacts: CalibrationArtifacts;
}

export interface BuiltCalibrationPack {
  readonly pack: CalibrationPack;
  readonly fixtures: readonly BuiltCalibrationFixture[];
}

export class CalibrationFixtureError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "CalibrationFixtureError";
  }
}

const CalibrationFieldSchema = z.enum(CALIBRATION_FIELDS);
const CalibrationDefectCodeSchema = z.enum(CALIBRATION_DEFECT_CODES);
const CalibrationMutationKindSchema = z.enum(CALIBRATION_MUTATION_KINDS);

export const CalibrationMutationSchema = z.strictObject({
  kind: CalibrationMutationKindSchema,
  description: z.string().min(1).max(1000),
  changedFields: z.array(CalibrationFieldSchema).min(1),
  affectedFactIds: z.array(z.string().min(1).max(120)).max(20),
  details: z.record(z.string(), z.unknown()),
});

export const CalibrationExpectedSchema = z.strictObject({
  blind: z.strictObject({
    result: z.enum(["correct", "defect", "no_unique"]),
    correctLabel: z.enum(["A", "B", "C", "D"]).nullable(),
    acceptedDefectCodes: z.array(CalibrationDefectCodeSchema),
  }),
  alignment: z.strictObject({
    result: z.enum(["pass", "fail"]),
    acceptedFailingFields: z.array(CalibrationFieldSchema),
    acceptedFactIds: z.array(z.string().min(1).max(120)),
  }),
});

export const CalibrationOriginalSchema = z.strictObject({
  spec: z.unknown(),
  solveResult: SolveResultSchema,
  choices: ChoiceSetSchema,
  visible: VisiblePresentationSchema,
  reveal: RevealDataSchema,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  pngHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  svgHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
});

export const CalibrationFixtureSchema = z.strictObject({
  fixtureId: z.string().regex(/^cal-[a-z]+-\d{2}$/),
  slotId: z.string().regex(SLOT_ID_PATTERN),
  family: FamilySchema,
  modality: ModalitySchema,
  difficulty: DifficultySchema,
  variant: z.enum(CALIBRATION_VARIANTS),
  seed: z.string().regex(/^[0-9a-f]{64}$/),
  optionsSeed: z.string().regex(/^[0-9a-f]{64}$/),
  sourceFixtureId: z.string().regex(/^cal-[a-z]+-\d{2}$/).nullable(),
  visible: VisiblePresentationSchema,
  original: CalibrationOriginalSchema,
  mutation: CalibrationMutationSchema.nullable(),
  expected: CalibrationExpectedSchema,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  originalContentHash: z.string().regex(/^[0-9a-f]{64}$/),
  pngHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  svgHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  originalPngHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  originalSvgHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  fixtureHash: z.string().regex(/^[0-9a-f]{64}$/),
  humanVerified: z.literal(false),
  auditor: z.null(),
  auditorTime: z.null(),
});

export const CalibrationPackSchema = z.strictObject({
  version: z.union([
    z.literal(CALIBRATION_PACK_VERSION),
    z.literal(CALIBRATION_PACK_VERSION_V2),
  ]),
  rootSeed: z.literal(CALIBRATION_ROOT_SEED),
  fixtures: z.array(CalibrationFixtureSchema).length(40),
  packHash: z.string().regex(/^[0-9a-f]{64}$/),
});

function fixtureCore(fixture: CalibrationFixture): unknown {
  const core: Record<string, unknown> = { ...fixture };
  delete core.fixtureHash;
  delete core.humanVerified;
  delete core.auditor;
  delete core.auditorTime;
  return core;
}

function originalFromBase(base: CalibrationSoundBase): CalibrationOriginal {
  return {
    spec: base.spec,
    solveResult: base.solveResult,
    choices: base.choices,
    visible: base.visible,
    reveal: base.reveal,
    contentHash: base.hashes.contentHash,
    pngHash: base.hashes.pngHash,
    svgHash: base.hashes.svgHash,
  };
}

function streamSeed(slotId: string, purpose: "spec" | "options", attempt: number): string {
  return deriveStreamSeed({
    protocolVersion: PROTOCOL_VERSION,
    rootSeed: CALIBRATION_ROOT_SEED,
    slotId: `${slotId}#${attempt}`,
    purpose,
  });
}

function fixtureSeed(slotId: string): string {
  return deriveStreamSeed({
    protocolVersion: PROTOCOL_VERSION,
    rootSeed: CALIBRATION_ROOT_SEED,
    slotId: `${slotId}#fixture`,
    purpose: "spec",
  });
}

function buildSoundBase(
  family: Family,
  slotId: string,
  difficulty: Difficulty,
  predicate?: (spec: unknown) => boolean,
): CalibrationSoundBase {
  const engine = productionRegistry.getEngine(family);
  const renderer =
    MODALITY_BY_FAMILY[family] === "svg"
      ? productionRegistry.getRenderer(family as SvgFamily)
      : null;
  let lastError: unknown;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const seed = streamSeed(slotId, "spec", attempt);
    const optionsSeed = streamSeed(slotId, "options", attempt);
    try {
      const spec = engine.schema.parse(engine.generateSpec(seed, difficulty));
      if (predicate !== undefined && !predicate(spec)) {
        continue;
      }
      const solveResult = engine.enumerateSolutions(spec);
      if (
        solveResult.solutionCount !== 1 ||
        solveResult.answerCount !== 1 ||
        solveResult.correctAnswer === null ||
        solveResult.proof === null
      ) {
        continue;
      }
      const choices = ChoiceSetSchema.parse(
        engine.makeOptions(spec, solveResult.correctAnswer, optionsSeed),
      ) as ChoiceSet<unknown>;
      const wording = makeFixtureWording(engine, spec);
      let scene: Scene | null = null;
      let svg: string | null = null;
      let png: Buffer | null = null;
      let svgHash: string | null = null;
      let pngHash: string | null = null;
      if (renderer !== null) {
        scene = renderer.buildScene(spec, optionsSeed) as Scene;
        renderer.assertScene(scene, spec, choices);
        svg = serializeScene(scene);
        png = renderScenePng(scene, SCENE_SIZE);
        assertPngNoTextMetadata(png);
        svgHash = sha256Hex(svg);
        pngHash = hashPng(png);
      }
      const assembled = assemblePresentation({
        slotId,
        engine,
        spec,
        solveResult,
        choices,
        wording,
        assets: { svgHash, pngHash },
      });
      return {
        slotId,
        family,
        modality: MODALITY_BY_FAMILY[family],
        difficulty,
        seed,
        optionsSeed,
        spec,
        solveResult,
        choices,
        visible: assembled.visible,
        reveal: assembled.reveal,
        scene,
        svg,
        png,
        hashes: {
          contentHash: hashCanonicalJson(assembled.visible),
          pngHash,
          svgHash,
        },
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new CalibrationFixtureError(
    "SOUND_FIXTURE_FAILED",
    `cannot build a sound calibration fixture for ${family} ${slotId}`,
    { cause: lastError },
  );
}

function soundExpected(base: CalibrationSoundBase): CalibrationExpected {
  return {
    blind: {
      result: "correct",
      correctLabel: base.choices.correctLabel,
      acceptedDefectCodes: [],
    },
    alignment: {
      result: "pass",
      acceptedFailingFields: [],
      acceptedFactIds: [],
    },
  };
}

function soundFixture(
  base: CalibrationSoundBase,
  fixtureId: string,
): BuiltCalibrationFixture {
  const original = originalFromBase(base);
  const core = {
    fixtureId,
    slotId: base.slotId,
    family: base.family,
    modality: base.modality,
    difficulty: base.difficulty,
    variant: "sound" as const,
    seed: base.seed,
    optionsSeed: base.optionsSeed,
    sourceFixtureId: null,
    visible: base.visible,
    original,
    mutation: null,
    expected: soundExpected(base),
    contentHash: base.hashes.contentHash,
    originalContentHash: base.hashes.contentHash,
    pngHash: base.hashes.pngHash,
    svgHash: base.hashes.svgHash,
    originalPngHash: base.hashes.pngHash,
    originalSvgHash: base.hashes.svgHash,
  };
  const fixture = CalibrationFixtureSchema.parse({
    ...core,
    fixtureHash: hashCanonicalJson(core),
    humanVerified: false,
    auditor: null,
    auditorTime: null,
  });
  return {
    fixture,
    artifacts: {
      visible: { svg: base.svg, png: base.png },
      original: { svg: base.svg, png: base.png },
    },
  };
}

function defectiveFixture(
  base: CalibrationSoundBase,
  result: CalibrationMutationResult,
  fixtureId: string,
  slotId: string,
  sourceFixtureId: string,
): BuiltCalibrationFixture {
  const visible = { ...result.visible, slotId };
  const core = {
    fixtureId,
    slotId,
    family: base.family,
    modality: base.modality,
    difficulty: base.difficulty,
    variant: "defective" as const,
    seed: fixtureSeed(slotId),
    optionsSeed: base.optionsSeed,
    sourceFixtureId,
    visible,
    original: result.original,
    mutation: result.mutation,
    expected: result.expected,
    contentHash: hashCanonicalJson(visible),
    originalContentHash: result.original.contentHash,
    pngHash: result.visible.assets.pngHash,
    svgHash: result.visible.assets.svgHash,
    originalPngHash: result.original.pngHash,
    originalSvgHash: result.original.svgHash,
  };
  const fixture = CalibrationFixtureSchema.parse({
    ...core,
    fixtureHash: hashCanonicalJson(core),
    humanVerified: false,
    auditor: null,
    auditorTime: null,
  });
  return { fixture, artifacts: result.artifacts };
}

function assertDefectConsequences(fixture: CalibrationFixture): void {
  const mutation = fixture.mutation;
  if (mutation === null) {
    throw new CalibrationFixtureError(
      "INVALID_DEFECT",
      `${fixture.fixtureId} is defective without a mutation record`,
    );
  }
  const expectedCodeByKind: Readonly<Record<CalibrationMutationKind, CalibrationDefectCode>> = {
    duplicate_correct_option: "DUPLICATE_CORRECT_OPTION",
    visible_primitive_mutation: "NO_VALID_OFFERED_SOLUTION",
    contradictory_matrix_example: "CONTRADICTORY_XOR_EXAMPLE",
    contradictory_transform_instructions: "CONTRADICTORY_TRANSFORM_INSTRUCTIONS",
    closed_route_edge: "CLOSED_ROUTE_EDGE",
    contradictory_symmetry_axis: "CONTRADICTORY_SYMMETRY_AXIS",
    conflicting_counting_conventions: "CONFLICTING_COUNTING_CONVENTIONS",
  };
  const expectedCodes: readonly CalibrationDefectCode[] =
    mutation.kind === "visible_primitive_mutation"
      ? ["NO_VALID_OFFERED_SOLUTION", "MULTIPLE_OFFERED_SOLUTIONS"]
      : [expectedCodeByKind[mutation.kind]];
  if (
    !expectedCodes.some((code) =>
      fixture.expected.blind.acceptedDefectCodes.includes(code),
    )
  ) {
    throw new CalibrationFixtureError(
      "INVALID_DEFECT",
      `${fixture.fixtureId} expected codes do not match mutation kind`,
    );
  }
  switch (mutation.kind) {
    case "duplicate_correct_option": {
      const duplicatedLabel = mutation.details.duplicatedLabel;
      if (typeof duplicatedLabel !== "string") {
        throw new CalibrationFixtureError(
          "INVALID_DEFECT",
          `${fixture.fixtureId} duplicate mutation lacks duplicatedLabel`,
        );
      }
      if (fixture.modality === "text" || fixture.family === "counting") {
        const counts = new Map<string, number>();
        for (const option of fixture.visible.options) {
          counts.set(option.text, (counts.get(option.text) ?? 0) + 1);
        }
        if (![...counts.values()].some((count) => count >= 2)) {
          throw new CalibrationFixtureError(
            "INVALID_DEFECT",
            `${fixture.fixtureId} duplicate mutation does not duplicate visible option text`,
          );
        }
      }
      if (fixture.modality !== "text" && fixture.pngHash === fixture.originalPngHash) {
        throw new CalibrationFixtureError(
          "INVALID_DEFECT",
          `${fixture.fixtureId} duplicate SVG mutation does not change the visible PNG`,
        );
      }
      break;
    }
    case "visible_primitive_mutation": {
      const offered = mutation.details.offeredValidLabels;
      if (!Array.isArray(offered) || (offered.length !== 0 && offered.length < 2)) {
        throw new CalibrationFixtureError(
          "INVALID_DEFECT",
          `${fixture.fixtureId} text mutation leaves one clear valid offered answer`,
        );
      }
      break;
    }
    case "contradictory_matrix_example": {
      if (
        mutation.details.solutionCount !== 0 ||
        !Array.isArray(mutation.details.offeredValidLabels) ||
        mutation.details.offeredValidLabels.length !== 0
      ) {
        throw new CalibrationFixtureError(
          "INVALID_DEFECT",
          `${fixture.fixtureId} matrix contradiction still has a valid completion`,
        );
      }
      break;
    }
    case "closed_route_edge": {
      if (
        !Array.isArray(mutation.details.offeredValidLabels) ||
        mutation.details.offeredValidLabels.length !== 0
      ) {
        throw new CalibrationFixtureError(
          "INVALID_DEFECT",
          `${fixture.fixtureId} closed route still leaves a valid offered route`,
        );
      }
      break;
    }
    case "contradictory_transform_instructions": {
      const labels = mutation.details.offeredLabels;
      const directions = mutation.details.instructedDirections;
      if (
        !Array.isArray(labels) ||
        labels.length < 2 ||
        !Array.isArray(directions) ||
        !directions.includes("clockwise") ||
        !directions.includes("counterclockwise")
      ) {
        throw new CalibrationFixtureError(
          "INVALID_DEFECT",
          `${fixture.fixtureId} transform contradiction lacks both outputs or directions`,
        );
      }
      break;
    }
    case "contradictory_symmetry_axis": {
      if (mutation.details.displayedAxis === mutation.details.instructedAxis) {
        throw new CalibrationFixtureError(
          "INVALID_DEFECT",
          `${fixture.fixtureId} symmetry axes do not contradict`,
        );
      }
      break;
    }
    case "conflicting_counting_conventions": {
      if (
        mutation.details.unionCount === mutation.details.overlapCount ||
        !Array.isArray(mutation.details.offeredCounts) ||
        mutation.details.offeredCounts.length < 2
      ) {
        throw new CalibrationFixtureError(
          "INVALID_DEFECT",
          `${fixture.fixtureId} counting conventions do not offer two distinct counts`,
        );
      }
      break;
    }
    default: {
      const exhaustive: never = mutation.kind;
      throw new CalibrationFixtureError(
        "INVALID_DEFECT",
        `unsupported mutation kind ${String(exhaustive)}`,
      );
    }
  }
}

export function assertCalibrationFixture(fixture: CalibrationFixture): void {
  const parsed = CalibrationFixtureSchema.parse(fixture);
  if (hashCanonicalJson(fixtureCore(parsed)) !== parsed.fixtureHash) {
    throw new CalibrationFixtureError(
      "INVALID_FIXTURE_HASH",
      `${parsed.fixtureId} fixture hash does not match its content`,
    );
  }
  if (hashCanonicalJson(parsed.visible) !== parsed.contentHash) {
    throw new CalibrationFixtureError(
      "INVALID_CONTENT_HASH",
      `${parsed.fixtureId} content hash does not match visible presentation`,
    );
  }
  if (hashCanonicalJson(parsed.original.visible) !== parsed.originalContentHash) {
    throw new CalibrationFixtureError(
      "INVALID_CONTENT_HASH",
      `${parsed.fixtureId} original content hash does not match original presentation`,
    );
  }
  if (
    parsed.visible.assets.pngHash !== parsed.pngHash ||
    parsed.visible.assets.svgHash !== parsed.svgHash ||
    parsed.original.visible.assets.pngHash !== parsed.originalPngHash ||
    parsed.original.visible.assets.svgHash !== parsed.originalSvgHash
  ) {
    throw new CalibrationFixtureError(
      "INVALID_ASSET_HASH",
      `${parsed.fixtureId} asset hashes do not match the presentation`,
    );
  }
  if (parsed.humanVerified !== false || parsed.auditor !== null || parsed.auditorTime !== null) {
    throw new CalibrationFixtureError(
      "HUMAN_LABEL_PRESENT",
      `${parsed.fixtureId} must remain pending human verification`,
    );
  }
  if (parsed.variant === "sound") {
    if (
      parsed.mutation !== null ||
      parsed.expected.blind.result !== "correct" ||
      parsed.expected.blind.correctLabel === null ||
      parsed.expected.blind.acceptedDefectCodes.length !== 0 ||
      parsed.expected.alignment.result !== "pass" ||
      parsed.expected.alignment.acceptedFailingFields.length !== 0
    ) {
      throw new CalibrationFixtureError(
        "INVALID_SOUND_FIXTURE",
        `${parsed.fixtureId} sound fixture has defective expectations`,
      );
    }
  } else {
    if (
      parsed.mutation === null ||
      parsed.expected.blind.result === "correct" ||
      parsed.expected.blind.correctLabel !== null ||
      parsed.expected.blind.acceptedDefectCodes.length === 0 ||
      parsed.expected.alignment.result !== "fail" ||
      parsed.expected.alignment.acceptedFailingFields.length === 0
    ) {
      throw new CalibrationFixtureError(
        "INVALID_DEFECT",
        `${parsed.fixtureId} defective fixture has sound expectations`,
      );
    }
    assertDefectConsequences(parsed);
  }
}

export function assertCalibrationPack(pack: CalibrationPack): void {
  const parsed = CalibrationPackSchema.parse(pack);
  const recomputed = hashCanonicalJson({
    version: parsed.version,
    rootSeed: parsed.rootSeed,
    fixtures: parsed.fixtures,
  });
  if (recomputed !== parsed.packHash) {
    throw new CalibrationFixtureError(
      "INVALID_PACK_HASH",
      "calibration pack hash does not match its fixtures",
    );
  }
  const ids = new Set<string>();
  const slotIds = new Set<string>();
  const seeds = new Set<string>();
  for (const fixture of parsed.fixtures) {
    assertCalibrationFixture(fixture);
    if (ids.has(fixture.fixtureId)) {
      throw new CalibrationFixtureError(
        "DUPLICATE_FIXTURE",
        `duplicate fixture ID ${fixture.fixtureId}`,
      );
    }
    ids.add(fixture.fixtureId);
    if (slotIds.has(fixture.slotId)) {
      throw new CalibrationFixtureError(
        "DUPLICATE_SLOT",
        `duplicate fixture slot ${fixture.slotId}`,
      );
    }
    slotIds.add(fixture.slotId);
    if (seeds.has(fixture.seed)) {
      throw new CalibrationFixtureError(
        "DUPLICATE_SEED",
        `duplicate fixture seed ${fixture.seed}`,
      );
    }
    seeds.add(fixture.seed);
  }
  for (const family of FAMILIES) {
    const familyFixtures = parsed.fixtures.filter(
      (fixture) => fixture.family === family,
    );
    if (familyFixtures.length !== 4) {
      throw new CalibrationFixtureError(
        "INVALID_PACK_COMPOSITION",
        `${family} must have exactly four fixtures`,
      );
    }
    const sound = familyFixtures.filter((fixture) => fixture.variant === "sound");
    const defective = familyFixtures.filter(
      (fixture) => fixture.variant === "defective",
    );
    if (sound.length !== 2 || defective.length !== 2) {
      throw new CalibrationFixtureError(
        "INVALID_PACK_COMPOSITION",
        `${family} must have two sound and two defective fixtures`,
      );
    }
  }
  const text = parsed.fixtures.filter((fixture) => fixture.modality === "text");
  const svg = parsed.fixtures.filter((fixture) => fixture.modality === "svg");
  if (text.length !== 20 || svg.length !== 20) {
    throw new CalibrationFixtureError(
      "INVALID_PACK_COMPOSITION",
      `expected 20 text and 20 SVG fixtures, received ${text.length}/${svg.length}`,
    );
  }
}

function slotIdFor(family: Family, ordinal: number): string {
  return `${MODALITY_BY_FAMILY[family]}-${family}-${String(ordinal)}`;
}

function fixtureIdFor(family: Family, index: number): string {
  return `cal-${family}-${String(index).padStart(2, "0")}`;
}

export function buildCalibrationPilotPack(): BuiltCalibrationPack {
  const built: BuiltCalibrationFixture[] = [];
  for (const family of ["ranking", "paths"] as const) {
    const base = buildSoundBase(family, slotIdFor(family, 97), 1);
    const sound = soundFixture(base, fixtureIdFor(family, 97));
    const familyDefect = defectiveFixture(
      base,
      buildFamilyDefect(base),
      fixtureIdFor(family, 98),
      slotIdFor(family, 98),
      sound.fixture.fixtureId,
    );
    const duplicate = defectiveFixture(
      base,
      buildDuplicateDefect(base),
      fixtureIdFor(family, 99),
      slotIdFor(family, 99),
      sound.fixture.fixtureId,
    );
    built.push(sound, familyDefect, duplicate);
  }
  const fixtures = built.map((entry) => entry.fixture);
  const base = {
    version: CALIBRATION_PACK_VERSION,
    rootSeed: CALIBRATION_ROOT_SEED,
    fixtures,
  } as const;
  const pack: CalibrationPack = {
    ...base,
    packHash: hashCanonicalJson(base),
  };
  return { pack, fixtures: built };
}

export function buildPathsPilotPack(): BuiltCalibrationPack {
  const base = buildSoundBase("paths", slotIdFor("paths", 105), 1);
  const sound = soundFixture(base, fixtureIdFor("paths", 9));
  const closed = defectiveFixture(
    base,
    buildFamilyDefect(base),
    fixtureIdFor("paths", 10),
    slotIdFor("paths", 106),
    sound.fixture.fixtureId,
  );
  const duplicate = defectiveFixture(
    base,
    buildDuplicateDefect(base),
    fixtureIdFor("paths", 11),
    slotIdFor("paths", 107),
    sound.fixture.fixtureId,
  );
  const built = [sound, closed, duplicate];
  const fixtures = built.map((entry) => entry.fixture);
  const basePack = {
    version: CALIBRATION_PACK_VERSION,
    rootSeed: CALIBRATION_ROOT_SEED,
    fixtures,
  } as const;
  const pack: CalibrationPack = {
    ...basePack,
    packHash: hashCanonicalJson(basePack),
  };
  return { pack, fixtures: built };
}

export function buildPathsPilotPackV2(): BuiltCalibrationPack {
  const base = buildSoundBase("paths", slotIdFor("paths", 108), 1);
  const sound = soundFixture(base, fixtureIdFor("paths", 12));
  const closed = defectiveFixture(
    base,
    buildFamilyDefect(base),
    fixtureIdFor("paths", 13),
    slotIdFor("paths", 109),
    sound.fixture.fixtureId,
  );
  const duplicate = defectiveFixture(
    base,
    buildDuplicateDefect(base),
    fixtureIdFor("paths", 14),
    slotIdFor("paths", 110),
    sound.fixture.fixtureId,
  );
  const built = [sound, closed, duplicate];
  const fixtures = built.map((entry) => entry.fixture);
  const basePack = {
    version: CALIBRATION_PACK_VERSION,
    rootSeed: CALIBRATION_ROOT_SEED,
    fixtures,
  } as const;
  const pack: CalibrationPack = {
    ...basePack,
    packHash: hashCanonicalJson(basePack),
  };
  return { pack, fixtures: built };
}

export function buildPathsDuplicatePilotPack(): BuiltCalibrationPack {
  const base = buildSoundBase("paths", slotIdFor("paths", 108), 1);
  const sound = soundFixture(base, fixtureIdFor("paths", 12));
  const duplicate = defectiveFixture(
    base,
    buildDuplicateDefect(base),
    fixtureIdFor("paths", 14),
    slotIdFor("paths", 110),
    sound.fixture.fixtureId,
  );
  const built = [sound, duplicate];
  const fixtures = built.map((entry) => entry.fixture);
  const basePack = {
    version: CALIBRATION_PACK_VERSION,
    rootSeed: CALIBRATION_ROOT_SEED,
    fixtures,
  } as const;
  const pack: CalibrationPack = {
    ...basePack,
    packHash: hashCanonicalJson(basePack),
  };
  return { pack, fixtures: built };
}

export function buildPathsDuplicateOnlyPilotPack(): BuiltCalibrationPack {
  const base = buildSoundBase("paths", slotIdFor("paths", 108), 1);
  const sound = soundFixture(base, fixtureIdFor("paths", 12));
  const duplicate = defectiveFixture(
    base,
    buildDuplicateDefect(base),
    fixtureIdFor("paths", 14),
    slotIdFor("paths", 110),
    sound.fixture.fixtureId,
  );
  const built = [duplicate];
  const fixtures = built.map((entry) => entry.fixture);
  const basePack = {
    version: CALIBRATION_PACK_VERSION,
    rootSeed: CALIBRATION_ROOT_SEED,
    fixtures,
  } as const;
  const pack: CalibrationPack = {
    ...basePack,
    packHash: hashCanonicalJson(basePack),
  };
  return { pack, fixtures: built };
}

export function buildCalibrationPack(): BuiltCalibrationPack {
  const built: BuiltCalibrationFixture[] = [];
  for (const family of FAMILIES) {
    const soundA = buildSoundBase(family, slotIdFor(family, 91), 1);
    const soundB = buildSoundBase(
      family,
      slotIdFor(family, 92),
      family === "counting" || family === "transforms" ? 1 : 2,
      family === "transforms"
        ? (spec) =>
            TransformsSpecSchema.parse(spec).operations.some(
              (operation) =>
                operation === "rotate90" || operation === "rotate270",
            )
        : undefined,
    );
    const fixtureA = soundFixture(soundA, fixtureIdFor(family, 1));
    const fixtureB = soundFixture(soundB, fixtureIdFor(family, 2));
    const textFamily = MODALITY_BY_FAMILY[family] === "text";
    const duplicateBase = textFamily ? soundB : soundA;
    const familyDefectBase = textFamily ? soundA : soundB;
    const duplicateSource = textFamily ? fixtureB : fixtureA;
    const familyDefectSource = textFamily ? fixtureA : fixtureB;
    const duplicate = defectiveFixture(
      duplicateBase,
      buildDuplicateDefect(duplicateBase),
      fixtureIdFor(family, 3),
      slotIdFor(family, 93),
      duplicateSource.fixture.fixtureId,
    );
    const familyDefect = defectiveFixture(
      familyDefectBase,
      buildFamilyDefect(familyDefectBase),
      fixtureIdFor(family, 4),
      slotIdFor(family, 94),
      familyDefectSource.fixture.fixtureId,
    );
    built.push(fixtureA, fixtureB, duplicate, familyDefect);
  }
  const fixtures = built.map((entry) => entry.fixture);
  const base: Omit<CalibrationPack, "packHash"> = {
    version: CALIBRATION_PACK_VERSION,
    rootSeed: CALIBRATION_ROOT_SEED,
    fixtures,
  };
  const pack: CalibrationPack = {
    ...base,
    packHash: hashCanonicalJson(base),
  };
  assertCalibrationPack(pack);
  return { pack, fixtures: built };
}

export function buildCalibrationPackV2(): BuiltCalibrationPack {
  const built: BuiltCalibrationFixture[] = [];
  for (const family of FAMILIES) {
    const soundA = buildSoundBase(family, slotIdFor(family, 101), 1);
    const soundB = buildSoundBase(
      family,
      slotIdFor(family, 102),
      family === "counting" || family === "transforms" ? 1 : 2,
      family === "transforms"
        ? (spec) =>
            TransformsSpecSchema.parse(spec).operations.some(
              (operation) =>
                operation === "rotate90" || operation === "rotate270",
            )
        : undefined,
    );
    const fixtureA = soundFixture(soundA, fixtureIdFor(family, 5));
    const fixtureB = soundFixture(soundB, fixtureIdFor(family, 6));
    const textFamily = MODALITY_BY_FAMILY[family] === "text";
    const duplicateBase = textFamily ? soundB : soundA;
    const familyDefectBase = textFamily ? soundA : soundB;
    const duplicateSource = textFamily ? fixtureB : fixtureA;
    const familyDefectSource = textFamily ? fixtureA : fixtureB;
    const duplicate = defectiveFixture(
      duplicateBase,
      buildDuplicateDefect(duplicateBase),
      fixtureIdFor(family, 7),
      slotIdFor(family, 103),
      duplicateSource.fixture.fixtureId,
    );
    const familyDefect = defectiveFixture(
      familyDefectBase,
      buildFamilyDefect(familyDefectBase),
      fixtureIdFor(family, 8),
      slotIdFor(family, 104),
      familyDefectSource.fixture.fixtureId,
    );
    built.push(fixtureA, fixtureB, duplicate, familyDefect);
  }
  const fixtures = built.map((entry) => entry.fixture);
  const base: Omit<CalibrationPack, "packHash"> = {
    version: CALIBRATION_PACK_VERSION_V2,
    rootSeed: CALIBRATION_ROOT_SEED,
    fixtures,
  };
  const pack: CalibrationPack = {
    ...base,
    packHash: hashCanonicalJson(base),
  };
  assertCalibrationPack(pack);
  return { pack, fixtures: built };
}
