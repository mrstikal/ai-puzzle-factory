import { z } from "zod";

export const TRUTH_PEOPLE_COUNTS = [3, 4] as const;
export type TruthPeople = (typeof TRUTH_PEOPLE_COUNTS)[number];

export const TRUTH_OPERATORS = ["not", "and", "or", "xor"] as const;
export type TruthOperator = (typeof TRUTH_OPERATORS)[number];

export type TruthAst =
  | { readonly kind: "truthful"; readonly person: number }
  | { readonly kind: "not"; readonly operand: TruthAst }
  | {
      readonly kind: "and" | "or" | "xor";
      readonly left: TruthAst;
      readonly right: TruthAst;
    };

export const TruthAstSchema: z.ZodType<TruthAst> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("truthful"),
      person: z.number().int().min(0).max(3),
    }),
    z.strictObject({
      kind: z.literal("not"),
      operand: TruthAstSchema,
    }),
    z.strictObject({
      kind: z.literal("and"),
      left: TruthAstSchema,
      right: TruthAstSchema,
    }),
    z.strictObject({
      kind: z.literal("or"),
      left: TruthAstSchema,
      right: TruthAstSchema,
    }),
    z.strictObject({
      kind: z.literal("xor"),
      left: TruthAstSchema,
      right: TruthAstSchema,
    }),
  ]),
);

export interface TruthAstStats {
  readonly nodes: number;
  readonly leaves: number;
  readonly depth: number;
}

export function astStats(ast: TruthAst): TruthAstStats {
  if (ast.kind === "truthful") {
    return { nodes: 1, leaves: 1, depth: 0 };
  }
  if (ast.kind === "not") {
    const child = astStats(ast.operand);
    return { nodes: 1 + child.nodes, leaves: child.leaves, depth: 1 + child.depth };
  }
  const left = astStats(ast.left);
  const right = astStats(ast.right);
  return {
    nodes: 1 + left.nodes + right.nodes,
    leaves: left.leaves + right.leaves,
    depth: 1 + Math.max(left.depth, right.depth),
  };
}

export function collectLeafPeople(ast: TruthAst): readonly number[] {
  if (ast.kind === "truthful") {
    return [ast.person];
  }
  if (ast.kind === "not") {
    return collectLeafPeople(ast.operand);
  }
  return [...collectLeafPeople(ast.left), ...collectLeafPeople(ast.right)];
}

export function astKey(ast: TruthAst): string {
  if (ast.kind === "truthful") {
    return `truthful:${ast.person}`;
  }
  if (ast.kind === "not") {
    return `not(${astKey(ast.operand)})`;
  }
  const left = astKey(ast.left);
  const right = astKey(ast.right);
  const [first, second] = left <= right ? [left, right] : [right, left];
  return `${ast.kind}(${first},${second})`;
}

export function astText(ast: TruthAst): string {
  if (ast.kind === "truthful") {
    return `truthful(P${ast.person + 1})`;
  }
  if (ast.kind === "not") {
    return `not(${astText(ast.operand)})`;
  }
  return `${ast.kind}(${astText(ast.left)}, ${astText(ast.right)})`;
}

export function canonicalizeAst(
  ast: TruthAst,
  mapping: ReadonlyMap<number, number>,
): TruthAst {
  if (ast.kind === "truthful") {
    const person = mapping.get(ast.person);
    if (person === undefined) {
      throw new RangeError(`truth relabeling has no target for person ${ast.person}`);
    }
    return { kind: "truthful", person };
  }
  if (ast.kind === "not") {
    return { kind: "not", operand: canonicalizeAst(ast.operand, mapping) };
  }
  const left = canonicalizeAst(ast.left, mapping);
  const right = canonicalizeAst(ast.right, mapping);
  return astKey(left) <= astKey(right)
    ? { kind: ast.kind, left, right }
    : { kind: ast.kind, left: right, right: left };
}

export function containsBinary(ast: TruthAst): boolean {
  if (ast.kind === "truthful") {
    return false;
  }
  if (ast.kind === "not") {
    return containsBinary(ast.operand);
  }
  return true;
}

export function containsXor(ast: TruthAst): boolean {
  if (ast.kind === "truthful") {
    return false;
  }
  if (ast.kind === "not") {
    return containsXor(ast.operand);
  }
  return ast.kind === "xor" || containsXor(ast.left) || containsXor(ast.right);
}

export function evaluateAst(ast: TruthAst, truth: readonly boolean[]): boolean {
  if (ast.kind === "truthful") {
    return truth[ast.person] === true;
  }
  if (ast.kind === "not") {
    return !evaluateAst(ast.operand, truth);
  }
  const left = evaluateAst(ast.left, truth);
  const right = evaluateAst(ast.right, truth);
  if (ast.kind === "and") {
    return left && right;
  }
  if (ast.kind === "or") {
    return left || right;
  }
  return left !== right;
}

export const TruthVectorSchema = z.array(z.boolean()).min(3).max(4);
export type TruthVector = z.infer<typeof TruthVectorSchema>;
export type TruthAnswer = TruthVector;

export function truthVectorText(truth: readonly boolean[]): string {
  return truth.map((value, index) => `P${index + 1}=${value ? "T" : "F"}`).join(", ");
}

export function truthVectorKey(truth: readonly boolean[]): string {
  return truth.map((value) => (value ? "T" : "F")).join("");
}

export const TruthSpecSchema = z
  .strictObject({
    people: z.union([z.literal(3), z.literal(4)]),
    exactTruthful: z.number().int().min(1).max(3),
    statements: z.array(TruthAstSchema).min(3).max(4),
  })
  .superRefine((spec, ctx) => {
    if (spec.exactTruthful >= spec.people) {
      ctx.addIssue({
        code: "custom",
        path: ["exactTruthful"],
        message: `exactTruthful must be between 1 and ${spec.people - 1}`,
      });
    }
    if (spec.statements.length !== spec.people) {
      ctx.addIssue({
        code: "custom",
        path: ["statements"],
        message: `truth requires exactly ${spec.people} statements`,
      });
    }
    for (const [index, statement] of spec.statements.entries()) {
      const stats = astStats(statement);
      if (stats.depth > 2) {
        ctx.addIssue({
          code: "custom",
          path: ["statements", index],
          message: "truth statement depth exceeds 2",
        });
      }
      if (stats.leaves > 3) {
        ctx.addIssue({
          code: "custom",
          path: ["statements", index],
          message: "truth statement has more than 3 leaves",
        });
      }
      if (stats.nodes > 7) {
        ctx.addIssue({
          code: "custom",
          path: ["statements", index],
          message: "truth statement has more than 7 nodes",
        });
      }
      for (const person of collectLeafPeople(statement)) {
        if (person >= spec.people) {
          ctx.addIssue({
            code: "custom",
            path: ["statements", index],
            message: `truth statement references person ${person} outside 0..${spec.people - 1}`,
          });
        }
      }
    }
  });
export type TruthSpec = z.infer<typeof TruthSpecSchema>;

export interface TruthPredicate {
  readonly speaker: number;
  readonly ast: TruthAst;
}

export function predicateKey(predicate: TruthPredicate): string {
  return `speaker:${predicate.speaker}:${astKey(predicate.ast)}`;
}

export interface TruthSolutions {
  readonly solutions: readonly (readonly boolean[])[];
  readonly enumeratedStates: number;
}

function truthAssignments(people: TruthPeople): readonly (readonly boolean[])[] {
  const assignments: boolean[][] = [];
  for (let mask = 0; mask < 1 << people; mask += 1) {
    const truth: boolean[] = [];
    for (let person = 0; person < people; person += 1) {
      truth.push((mask & (1 << person)) !== 0);
    }
    assignments.push(truth);
  }
  return assignments;
}

export function solveTruthAssignments(spec: TruthSpec): TruthSolutions {
  const parsed = TruthSpecSchema.parse(spec);
  const solutions: boolean[][] = [];
  for (const truth of truthAssignments(parsed.people)) {
    const count = truth.filter(Boolean).length;
    if (count !== parsed.exactTruthful) {
      continue;
    }
    const satisfies = parsed.statements.every(
      (statement, speaker) => truth[speaker] === evaluateAst(statement, truth),
    );
    if (satisfies) {
      solutions.push([...truth]);
    }
  }
  return { solutions, enumeratedStates: 1 << parsed.people };
}

export function solveTruthPredicates(
  people: TruthPeople,
  exactTruthful: number,
  predicates: readonly TruthPredicate[],
): TruthSolutions {
  const solutions: boolean[][] = [];
  for (const truth of truthAssignments(people)) {
    const count = truth.filter(Boolean).length;
    if (count !== exactTruthful) {
      continue;
    }
    const satisfies = predicates.every(
      (predicate) =>
        truth[predicate.speaker] === evaluateAst(predicate.ast, truth),
    );
    if (satisfies) {
      solutions.push([...truth]);
    }
  }
  return { solutions, enumeratedStates: 1 << people };
}

const AST_POOL_CACHE = new Map<string, readonly TruthAst[]>();

function isLegalAst(ast: TruthAst): boolean {
  const stats = astStats(ast);
  return stats.depth <= 2 && stats.leaves <= 3 && stats.nodes <= 7;
}

function binaryAst(
  kind: "and" | "or" | "xor",
  left: TruthAst,
  right: TruthAst,
): TruthAst {
  return astKey(left) <= astKey(right)
    ? { kind, left, right }
    : { kind, left: right, right: left };
}

export function generateTruthAstPool(
  people: TruthPeople,
  includeXor: boolean,
): readonly TruthAst[] {
  const cacheKey = `${people}:${includeXor ? "xor" : "no-xor"}`;
  const cached = AST_POOL_CACHE.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const leaves: TruthAst[] = [];
  for (let person = 0; person < people; person += 1) {
    leaves.push({ kind: "truthful", person });
  }
  const operators: ReadonlyArray<"and" | "or" | "xor"> = includeXor
    ? ["and", "or", "xor"]
    : ["and", "or"];
  const level1 = new Map<string, TruthAst>();
  const add = (ast: TruthAst): void => {
    if (isLegalAst(ast)) {
      level1.set(astKey(ast), ast);
    }
  };
  for (const leaf of leaves) {
    add(leaf);
    add({ kind: "not", operand: leaf });
  }
  for (let leftIndex = 0; leftIndex < leaves.length; leftIndex += 1) {
    for (let rightIndex = leftIndex; rightIndex < leaves.length; rightIndex += 1) {
      const left = leaves[leftIndex];
      const right = leaves[rightIndex];
      if (left === undefined || right === undefined) {
        continue;
      }
      for (const operator of operators) {
        add(binaryAst(operator, left, right));
      }
    }
  }

  const pool = new Map<string, TruthAst>(level1);
  for (const ast of level1.values()) {
    const negated: TruthAst = { kind: "not", operand: ast };
    if (isLegalAst(negated)) {
      pool.set(astKey(negated), negated);
    }
  }
  const level1Values = [...level1.values()];
  for (const left of level1Values) {
    for (const right of level1Values) {
      for (const operator of operators) {
        const ast = binaryAst(operator, left, right);
        if (isLegalAst(ast)) {
          pool.set(astKey(ast), ast);
        }
      }
    }
  }
  const result = [...pool.values()].sort((left, right) =>
    astKey(left) < astKey(right) ? -1 : astKey(left) > astKey(right) ? 1 : 0,
  );
  AST_POOL_CACHE.set(cacheKey, result);
  return result;
}
