import { z } from "zod";
import { FAMILIES, type Family } from "./experiment.js";
import {
  ArithmeticSpecSchema,
  type ArithmeticSpec,
} from "../families/arithmetic/schema.js";
import {
  CountingSpecSchema,
  type CountingSpec,
} from "../families/counting/schema.js";
import {
  MatchingSpecSchema,
  type MatchingSpec,
} from "../families/matching/schema.js";
import {
  MatrixSpecSchema,
  type MatrixSpec,
} from "../families/matrix/schema.js";
import {
  PathsSpecSchema,
  type PathsSpec,
} from "../families/paths/schema.js";
import {
  RankingSpecSchema,
  type RankingSpec,
} from "../families/ranking/schema.js";
import {
  SchedulingSpecSchema,
  type SchedulingSpec,
} from "../families/scheduling/schema.js";
import {
  SymmetrySpecSchema,
  type SymmetrySpec,
} from "../families/symmetry/schema.js";
import {
  TransformsSpecSchema,
  type TransformsSpec,
} from "../families/transforms/schema.js";
import {
  TruthSpecSchema,
  type TruthSpec,
} from "../families/truth/schema.js";

export interface FamilySpecByFamily {
  readonly ranking: RankingSpec;
  readonly matching: MatchingSpec;
  readonly scheduling: SchedulingSpec;
  readonly truth: TruthSpec;
  readonly arithmetic: ArithmeticSpec;
  readonly matrix: MatrixSpec;
  readonly transforms: TransformsSpec;
  readonly paths: PathsSpec;
  readonly symmetry: SymmetrySpec;
  readonly counting: CountingSpec;
}

export type FamilySpec = FamilySpecByFamily[Family];

export const FAMILY_SPEC_SCHEMAS = {
  ranking: RankingSpecSchema,
  matching: MatchingSpecSchema,
  scheduling: SchedulingSpecSchema,
  truth: TruthSpecSchema,
  arithmetic: ArithmeticSpecSchema,
  matrix: MatrixSpecSchema,
  transforms: TransformsSpecSchema,
  paths: PathsSpecSchema,
  symmetry: SymmetrySpecSchema,
  counting: CountingSpecSchema,
} as const satisfies {
  readonly [F in Family]: z.ZodType<FamilySpecByFamily[F]>;
};

export type FamilySpecEnvelope = {
  readonly [F in Family]: {
    readonly family: F;
    readonly spec: FamilySpecByFamily[F];
  };
}[Family];

export const FamilySpecEnvelopeSchema = z.discriminatedUnion("family", [
  z.strictObject({ family: z.literal("ranking"), spec: RankingSpecSchema }),
  z.strictObject({ family: z.literal("matching"), spec: MatchingSpecSchema }),
  z.strictObject({ family: z.literal("scheduling"), spec: SchedulingSpecSchema }),
  z.strictObject({ family: z.literal("truth"), spec: TruthSpecSchema }),
  z.strictObject({ family: z.literal("arithmetic"), spec: ArithmeticSpecSchema }),
  z.strictObject({ family: z.literal("matrix"), spec: MatrixSpecSchema }),
  z.strictObject({ family: z.literal("transforms"), spec: TransformsSpecSchema }),
  z.strictObject({ family: z.literal("paths"), spec: PathsSpecSchema }),
  z.strictObject({ family: z.literal("symmetry"), spec: SymmetrySpecSchema }),
  z.strictObject({ family: z.literal("counting"), spec: CountingSpecSchema }),
]);

export function familySpecSchemaFor<F extends Family>(
  family: F,
): (typeof FAMILY_SPEC_SCHEMAS)[F] {
  if (!FAMILIES.includes(family)) {
    throw new RangeError(`unknown family ${String(family)}`);
  }
  return FAMILY_SPEC_SCHEMAS[family];
}

export function parseFamilySpec<F extends Family>(
  family: F,
  input: unknown,
): FamilySpecByFamily[F] {
  return familySpecSchemaFor(family).parse(input) as FamilySpecByFamily[F];
}

export function safeParseFamilySpec<F extends Family>(
  family: F,
  input: unknown,
): z.ZodSafeParseResult<FamilySpecByFamily[F]> {
  return familySpecSchemaFor(family).safeParse(input) as z.ZodSafeParseResult<
    FamilySpecByFamily[F]
  >;
}

export function parseFamilySpecEnvelope(input: unknown): FamilySpecEnvelope {
  return FamilySpecEnvelopeSchema.parse(input);
}

export function safeParseFamilySpecEnvelope(
  input: unknown,
): z.ZodSafeParseResult<FamilySpecEnvelope> {
  return FamilySpecEnvelopeSchema.safeParse(input);
}
