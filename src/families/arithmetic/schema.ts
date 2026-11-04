import { z } from "zod";

export const ARITHMETIC_VARIABLES = ["x", "y", "z"] as const;
export type ArithmeticVariable = (typeof ARITHMETIC_VARIABLES)[number];
export const ARITHMETIC_DOMAIN_MIN = 0;
export const ARITHMETIC_DOMAIN_MAX = 12;
export const ARITHMETIC_DOMAIN_SIZE = 13;
export const ARITHMETIC_TUPLE_COUNT = 2197;

export const ARITHMETIC_OPS = ["eq", "lt", "le"] as const;
export type ArithmeticOp = (typeof ARITHMETIC_OPS)[number];
export const ArithmeticOpSchema = z.enum(ARITHMETIC_OPS);

const coefficientSchema = z.number().int().min(-3).max(3);

export const ArithmeticConstraintSchema = z
  .strictObject({
    coeffs: z.tuple([coefficientSchema, coefficientSchema, coefficientSchema]),
    op: ArithmeticOpSchema,
    constant: z.number().int().min(-108).max(108),
  })
  .superRefine((constraint, ctx) => {
    if (constraint.coeffs.every((coefficient) => coefficient === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["coeffs"],
        message: "an arithmetic constraint cannot have all-zero coefficients",
      });
    }
  });
export type ArithmeticConstraint = z.infer<typeof ArithmeticConstraintSchema>;

export const ArithmeticSpecSchema = z.strictObject({
  allDifferent: z.boolean(),
  constraints: z.array(ArithmeticConstraintSchema).min(2).max(5),
});
export type ArithmeticSpec = z.infer<typeof ArithmeticSpecSchema>;

const tupleComponent = z.number().int().min(0).max(12);
export const ArithmeticTupleSchema = z.tuple([
  tupleComponent,
  tupleComponent,
  tupleComponent,
]);
export type ArithmeticTuple = z.infer<typeof ArithmeticTupleSchema>;
export type ArithmeticAnswer = ArithmeticTuple;

export function tupleText(tuple: readonly number[]): string {
  return `(x, y, z) = (${tuple[0] ?? "?"}, ${tuple[1] ?? "?"}, ${tuple[2] ?? "?"})`;
}

export function tupleKey(tuple: readonly number[]): string {
  return tuple.join(",");
}

export function constraintText(constraint: ArithmeticConstraint): string {
  const terms = constraint.coeffs.map(
    (coefficient, index) => `(${coefficient})*${ARITHMETIC_VARIABLES[index] ?? "?"}`,
  );
  const operator =
    constraint.op === "eq" ? "=" : constraint.op === "lt" ? "<" : "<=";
  const constant =
    constraint.constant < 0 ? `(${constraint.constant})` : String(constraint.constant);
  return `${terms.join(" + ")} ${operator} ${constant}`;
}

export function constraintSatisfied(
  constraint: ArithmeticConstraint,
  tuple: readonly number[],
): boolean {
  const lhs =
    constraint.coeffs[0] * (tuple[0] ?? 0) +
    constraint.coeffs[1] * (tuple[1] ?? 0) +
    constraint.coeffs[2] * (tuple[2] ?? 0);
  if (constraint.op === "eq") {
    return lhs === constraint.constant;
  }
  if (constraint.op === "lt") {
    return lhs < constraint.constant;
  }
  return lhs <= constraint.constant;
}

export function allDifferentSatisfied(tuple: readonly number[]): boolean {
  return tuple[0] !== tuple[1] && tuple[0] !== tuple[2] && tuple[1] !== tuple[2];
}

export function solveArithmetic(spec: ArithmeticSpec): {
  readonly solutions: readonly ArithmeticTuple[];
  readonly enumeratedStates: number;
} {
  const parsed = ArithmeticSpecSchema.parse(spec);
  const solutions: ArithmeticTuple[] = [];
  for (let x = 0; x < ARITHMETIC_DOMAIN_SIZE; x += 1) {
    for (let y = 0; y < ARITHMETIC_DOMAIN_SIZE; y += 1) {
      for (let z = 0; z < ARITHMETIC_DOMAIN_SIZE; z += 1) {
        const tuple: ArithmeticTuple = [x, y, z];
        if (parsed.allDifferent && !allDifferentSatisfied(tuple)) {
          continue;
        }
        if (parsed.constraints.every((constraint) => constraintSatisfied(constraint, tuple))) {
          solutions.push(tuple);
        }
      }
    }
  }
  return { solutions, enumeratedStates: ARITHMETIC_TUPLE_COUNT };
}

export type ArithmeticNormalizationErrorCode = "NONINTEGRAL_EQUALITY";

export class ArithmeticNormalizationError extends Error {
  readonly code: ArithmeticNormalizationErrorCode;

  constructor(code: ArithmeticNormalizationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArithmeticNormalizationError";
    this.code = code;
  }
}

function gcd(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function coefficientsGcd(coeffs: readonly number[]): number {
  let result = 0;
  for (const coefficient of coeffs) {
    result = gcd(result, coefficient);
  }
  return result === 0 ? 1 : result;
}

export function normalizeConstraint(
  constraint: ArithmeticConstraint,
): ArithmeticConstraint {
  const op = constraint.op === "lt" ? "le" : constraint.op;
  const constant =
    constraint.op === "lt" ? constraint.constant - 1 : constraint.constant;
  const divisor = coefficientsGcd(constraint.coeffs);
  const normalizedCoeffs = constraint.coeffs.map((coefficient) =>
    coefficient / divisor,
  ) as [number, number, number];
  if (op === "eq") {
    if (constant % divisor !== 0) {
      throw new ArithmeticNormalizationError(
        "NONINTEGRAL_EQUALITY",
        `equality ${constraintText(constraint)} has no integer solution`,
      );
    }
    const normalizedConstant = constant / divisor;
    const firstNonzero = normalizedCoeffs.findIndex((coefficient) => coefficient !== 0);
    if (firstNonzero < 0) {
      throw new ArithmeticNormalizationError(
        "NONINTEGRAL_EQUALITY",
        "equality has no nonzero coefficient",
      );
    }
    const first = normalizedCoeffs[firstNonzero];
    if (first !== undefined && first < 0) {
      return {
        coeffs: normalizedCoeffs.map((coefficient) => -coefficient) as [
          number,
          number,
          number,
        ],
        op,
        constant: -normalizedConstant,
      };
    }
    return { coeffs: normalizedCoeffs, op, constant: normalizedConstant };
  }
  return {
    coeffs: normalizedCoeffs,
    op,
    constant: Math.floor(constant / divisor),
  };
}

export function normalizedConstraintKey(constraint: ArithmeticConstraint): string {
  const normalized = normalizeConstraint(constraint);
  return `${normalized.op}:${normalized.coeffs.join(",")}:${normalized.constant}`;
}

export function relabelConstraint(
  constraint: ArithmeticConstraint,
  permutation: readonly number[],
): ArithmeticConstraint {
  const mapped: [number, number, number] = [0, 0, 0];
  for (let oldVariable = 0; oldVariable < 3; oldVariable += 1) {
    const newVariable = permutation[oldVariable];
    const coefficient = constraint.coeffs[oldVariable];
    if (newVariable === undefined || coefficient === undefined) {
      throw new RangeError("arithmetic variable relabeling is incomplete");
    }
    mapped[newVariable] = coefficient;
  }
  return normalizeConstraint({
    coeffs: mapped,
    op: constraint.op,
    constant: constraint.constant,
  });
}
