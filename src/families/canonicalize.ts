import { z } from "zod";
import { canonicalJson, sha256Hex } from "../util/hash.js";
import {
  CanonicalStructureSchema,
  type CanonicalStructure,
} from "./contracts.js";

export const DEFAULT_SEARCH_STATE_LIMIT = 200_000;
export const DEFAULT_CORE_REDUCTION_EVALUATIONS = 64;

export function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortedCanonicalTokens(tokens: Iterable<string>): string[] {
  return [...tokens].sort(compareCanonicalStrings);
}

export function canonicalStructureSerialization(structure: CanonicalStructure): string {
  return canonicalJson(structure);
}

export function serializeCanonicalStructure(structure: CanonicalStructure): string {
  return canonicalStructureSerialization(CanonicalStructureSchema.parse(structure));
}

export function canonicalStructureHash(structure: CanonicalStructure): string {
  return sha256Hex(serializeCanonicalStructure(structure));
}

export function canonicalStructuresEqual(
  left: CanonicalStructure,
  right: CanonicalStructure,
): boolean {
  return serializeCanonicalStructure(left) === serializeCanonicalStructure(right);
}

export function selectCanonicalStructure(
  candidates: Iterable<CanonicalStructure>,
): CanonicalStructure {
  let best: CanonicalStructure | undefined;
  let bestSerialization: string | undefined;
  for (const candidate of candidates) {
    const parsed = CanonicalStructureSchema.parse(candidate);
    const serialization = canonicalStructureSerialization(parsed);
    if (bestSerialization === undefined || serialization < bestSerialization) {
      best = parsed;
      bestSerialization = serialization;
    }
  }
  if (best === undefined) {
    throw new Error("at least one canonical structure candidate is required");
  }
  return best;
}

export const FeatureCountSchema = z.strictObject({
  feature: z.string().min(1).max(400),
  count: z.number().int().positive(),
});

export type FeatureCount = z.infer<typeof FeatureCountSchema>;

export const FeatureMultisetSchema = z.array(FeatureCountSchema).superRefine((entries, ctx) => {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      previous.feature >= current.feature
    ) {
      ctx.addIssue({
        code: "custom",
        path: [index, "feature"],
        message: "feature multisets must be strictly sorted by feature",
      });
    }
  }
});

export function extractStructureFeatures(
  structure: CanonicalStructure,
): readonly FeatureCount[] {
  const parsed = CanonicalStructureSchema.parse(structure);
  const counts = new Map<string, number>();
  const add = (prefix: string, tokens: readonly string[]): void => {
    for (const token of tokens) {
      const feature = `${prefix}:${token}`;
      counts.set(feature, (counts.get(feature) ?? 0) + 1);
    }
  };
  add("q", parsed.queryTokens);
  add("r", parsed.relationTokens);
  add("g", parsed.geometryTokens);
  return [...counts.entries()]
    .map(([feature, count]) => ({ feature, count }))
    .sort((left, right) => compareCanonicalStrings(left.feature, right.feature));
}

export interface FeatureComparison {
  readonly removed: number;
  readonly added: number;
  readonly editDistance: number;
  readonly intersection: number;
  readonly union: number;
  readonly jaccard: number;
  readonly commonFeatureCount: number;
}

function featureMap(multiset: readonly FeatureCount[]): Map<string, number> {
  FeatureMultisetSchema.parse(multiset);
  return new Map(multiset.map((entry) => [entry.feature, entry.count]));
}

export function compareFeatureMultisets(
  left: readonly FeatureCount[],
  right: readonly FeatureCount[],
): FeatureComparison {
  const leftMap = featureMap(left);
  const rightMap = featureMap(right);
  const features = new Set([...leftMap.keys(), ...rightMap.keys()]);
  let removed = 0;
  let added = 0;
  let intersection = 0;
  let union = 0;
  let commonFeatureCount = 0;
  for (const feature of features) {
    const leftCount = leftMap.get(feature) ?? 0;
    const rightCount = rightMap.get(feature) ?? 0;
    removed += Math.max(leftCount - rightCount, 0);
    added += Math.max(rightCount - leftCount, 0);
    intersection += Math.min(leftCount, rightCount);
    union += Math.max(leftCount, rightCount);
    if (leftCount > 0 && rightCount > 0) {
      commonFeatureCount += 1;
    }
  }
  return {
    removed,
    added,
    editDistance: Math.max(removed, added),
    intersection,
    union,
    jaccard: union === 0 ? 1 : intersection / union,
    commonFeatureCount,
  };
}

export function multisetJaccard(
  left: readonly FeatureCount[],
  right: readonly FeatureCount[],
): number {
  return compareFeatureMultisets(left, right).jaccard;
}

export function multisetEditDistance(
  left: readonly FeatureCount[],
  right: readonly FeatureCount[],
): number {
  return compareFeatureMultisets(left, right).editDistance;
}

export function hasCommonFeature(
  left: readonly FeatureCount[],
  right: readonly FeatureCount[],
): boolean {
  return compareFeatureMultisets(left, right).commonFeatureCount > 0;
}

export class SolverLimitError extends Error {
  readonly code = "SOLVER_LIMIT" as const;
  readonly limit: number;
  readonly attempted: number;

  constructor(limit: number, attempted: number) {
    super(`solver state limit ${limit} exceeded at state ${attempted}`);
    this.name = "SolverLimitError";
    this.limit = limit;
    this.attempted = attempted;
  }
}

export class SearchCounter {
  readonly limit: number;
  private states = 0;

  constructor(limit: number = DEFAULT_SEARCH_STATE_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`search limit must be a positive integer, received ${limit}`);
    }
    this.limit = limit;
  }

  get visited(): number {
    return this.states;
  }

  get remaining(): number {
    return this.limit - this.states;
  }

  consume(count = 1): void {
    if (!Number.isInteger(count) || count < 1) {
      throw new RangeError(`search counter increment must be a positive integer, received ${count}`);
    }
    const attempted = this.states + count;
    if (attempted > this.limit) {
      throw new SolverLimitError(this.limit, attempted);
    }
    this.states = attempted;
  }
}

export function countPermutations(size: number): number {
  if (!Number.isInteger(size) || size < 0) {
    throw new RangeError(`permutation size must be a nonnegative integer, received ${size}`);
  }
  let total = 1;
  for (let factor = 2; factor <= size; factor += 1) {
    total *= factor;
    if (!Number.isSafeInteger(total)) {
      throw new RangeError(`permutation count for size ${size} is not a safe integer`);
    }
  }
  return total;
}

export function countCartesianProduct(groups: readonly (readonly unknown[])[]): number {
  let total = 1;
  for (const group of groups) {
    total *= group.length;
    if (!Number.isSafeInteger(total)) {
      throw new RangeError("cartesian product size is not a safe integer");
    }
  }
  return total;
}

export interface EnumerationOptions {
  readonly maxResults?: number;
  readonly counter?: SearchCounter;
}

function resolvedMaxResults(options: EnumerationOptions): number {
  const maxResults = options.maxResults ?? DEFAULT_SEARCH_STATE_LIMIT;
  if (!Number.isInteger(maxResults) || maxResults < 0) {
    throw new RangeError(`maxResults must be a nonnegative integer, received ${maxResults}`);
  }
  return maxResults;
}

function* permutationsOf<T>(items: readonly T[]): Generator<readonly T[]> {
  if (items.length === 0) {
    yield [];
    return;
  }
  const first = items[0];
  if (items.length === 1 && first !== undefined) {
    yield [first];
    return;
  }
  for (let index = 0; index < items.length; index += 1) {
    const current = items[index];
    if (current === undefined) {
      continue;
    }
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const permutation of permutationsOf(rest)) {
      yield [current, ...permutation];
    }
  }
}

export interface EnumerationResult<T> {
  readonly items: readonly T[];
  readonly visited: number;
  readonly complete: boolean;
}

export function collectPermutations<T>(
  items: readonly T[],
  options: EnumerationOptions = {},
): EnumerationResult<readonly T[]> {
  const maxResults = resolvedMaxResults(options);
  const results: Array<readonly T[]> = [];
  let visited = 0;
  let complete = true;
  for (const permutation of permutationsOf(items)) {
    if (visited >= maxResults) {
      complete = false;
      break;
    }
    options.counter?.consume();
    results.push(permutation);
    visited += 1;
  }
  return { items: results, visited, complete };
}

export interface MinimizeResult<T, R> {
  readonly best: R | null;
  readonly bestPermutation: readonly T[] | null;
  readonly visited: number;
  readonly complete: boolean;
}

export function minimizeOverPermutations<T, R>(
  items: readonly T[],
  evaluate: (permutation: readonly T[]) => R,
  compare: (left: R, right: R) => number,
  options: EnumerationOptions = {},
): MinimizeResult<T, R> {
  const maxResults = resolvedMaxResults(options);
  let best: R | null = null;
  let bestPermutation: readonly T[] | null = null;
  let visited = 0;
  let complete = true;
  for (const permutation of permutationsOf(items)) {
    if (visited >= maxResults) {
      complete = false;
      break;
    }
    options.counter?.consume();
    const candidate = evaluate(permutation);
    if (best === null || compare(candidate, best) < 0) {
      best = candidate;
      bestPermutation = permutation;
    }
    visited += 1;
  }
  return { best, bestPermutation, visited, complete };
}

function* cartesianProductOf<T>(
  groups: readonly (readonly T[])[],
  prefix: readonly T[],
): Generator<readonly T[]> {
  if (groups.length === 0) {
    yield prefix;
    return;
  }
  const firstGroup = groups[0];
  const rest = groups.slice(1);
  if (firstGroup === undefined || firstGroup.length === 0) {
    return;
  }
  for (const item of firstGroup) {
    yield* cartesianProductOf(rest, [...prefix, item]);
  }
}

export function collectCartesianProduct<T>(
  groups: readonly (readonly T[])[],
  options: EnumerationOptions = {},
): EnumerationResult<readonly T[]> {
  const maxResults = resolvedMaxResults(options);
  const results: Array<readonly T[]> = [];
  let visited = 0;
  let complete = true;
  for (const combination of cartesianProductOf(groups, [])) {
    if (visited >= maxResults) {
      complete = false;
      break;
    }
    options.counter?.consume();
    results.push(combination);
    visited += 1;
  }
  return { items: results, visited, complete };
}

export function minimizeOverCartesianProduct<T, R>(
  groups: readonly (readonly T[])[],
  evaluate: (combination: readonly T[]) => R,
  compare: (left: R, right: R) => number,
  options: EnumerationOptions = {},
): MinimizeResult<T, R> {
  const maxResults = resolvedMaxResults(options);
  let best: R | null = null;
  let bestPermutation: readonly T[] | null = null;
  let visited = 0;
  let complete = true;
  for (const combination of cartesianProductOf(groups, [])) {
    if (visited >= maxResults) {
      complete = false;
      break;
    }
    options.counter?.consume();
    const candidate = evaluate(combination);
    if (best === null || compare(candidate, best) < 0) {
      best = candidate;
      bestPermutation = combination;
    }
    visited += 1;
  }
  return { best, bestPermutation, visited, complete };
}

function popcount(value: number): number {
  let remaining = value - ((value >>> 1) & 0x55555555);
  remaining = (remaining & 0x33333333) + ((remaining >>> 2) & 0x33333333);
  return (((remaining + (remaining >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export class Bitset {
  readonly size: number;
  private readonly words: Uint32Array;

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 0) {
      throw new RangeError(`bitset size must be a nonnegative integer, received ${size}`);
    }
    this.size = size;
    this.words = new Uint32Array(Math.ceil(size / 32));
  }

  static fromIndices(size: number, indices: Iterable<number>): Bitset {
    const bitset = new Bitset(size);
    for (const index of indices) {
      bitset.set(index);
    }
    return bitset;
  }

  static full(size: number): Bitset {
    const bitset = new Bitset(size);
    for (let index = 0; index < size; index += 1) {
      bitset.set(index);
    }
    return bitset;
  }

  set(index: number): void {
    this.assertIndex(index);
    const wordIndex = Math.floor(index / 32);
    this.words[wordIndex] = (this.words[wordIndex] ?? 0) | (1 << (index % 32));
  }

  clear(index: number): void {
    this.assertIndex(index);
    const wordIndex = Math.floor(index / 32);
    this.words[wordIndex] = (this.words[wordIndex] ?? 0) & ~(1 << (index % 32));
  }

  has(index: number): boolean {
    this.assertIndex(index);
    const wordIndex = Math.floor(index / 32);
    return (((this.words[wordIndex] ?? 0) >>> (index % 32)) & 1) === 1;
  }

  count(): number {
    let total = 0;
    for (const word of this.words) {
      total += popcount(word);
    }
    return total;
  }

  isEmpty(): boolean {
    return this.words.every((word) => word === 0);
  }

  clone(): Bitset {
    const copy = new Bitset(this.size);
    copy.words.set(this.words);
    return copy;
  }

  and(other: Bitset): Bitset {
    this.assertSameSize(other);
    const result = new Bitset(this.size);
    for (let index = 0; index < this.words.length; index += 1) {
      result.words[index] = (this.words[index] ?? 0) & (other.words[index] ?? 0);
    }
    return result;
  }

  or(other: Bitset): Bitset {
    this.assertSameSize(other);
    const result = new Bitset(this.size);
    for (let index = 0; index < this.words.length; index += 1) {
      result.words[index] = (this.words[index] ?? 0) | (other.words[index] ?? 0);
    }
    return result;
  }

  equals(other: Bitset): boolean {
    if (this.size !== other.size) {
      return false;
    }
    for (let index = 0; index < this.words.length; index += 1) {
      if (this.words[index] !== other.words[index]) {
        return false;
      }
    }
    return true;
  }

  indices(): number[] {
    const result: number[] = [];
    for (let index = 0; index < this.size; index += 1) {
      if (this.has(index)) {
        result.push(index);
      }
    }
    return result;
  }

  private assertIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.size) {
      throw new RangeError(`bitset index ${index} is outside 0..${this.size - 1}`);
    }
  }

  private assertSameSize(other: Bitset): void {
    if (this.size !== other.size) {
      throw new RangeError(`bitset sizes differ: ${this.size} and ${other.size}`);
    }
  }
}

export interface CoreSolution {
  readonly solutionCount: number;
  readonly answerKey: string;
}

export type ReducedCoreErrorCode =
  | "EMPTY_CLUE_SET"
  | "BASELINE_NOT_UNIQUE"
  | "CORE_REDUCTION_LIMIT"
  | "INVALID_SOLUTION";

export class ReducedCoreError extends Error {
  readonly code: ReducedCoreErrorCode;

  constructor(code: ReducedCoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReducedCoreError";
    this.code = code;
  }
}

export interface ReduceClueCoreOptions<T> {
  readonly clues: readonly T[];
  readonly normalize: (clues: readonly T[]) => readonly T[];
  readonly clueKey: (clue: T) => string;
  readonly solve: (clues: readonly T[]) => CoreSolution;
  readonly maxEvaluations?: number;
}

export interface ReducedClueCore<T> {
  readonly retained: readonly T[];
  readonly removedIndices: readonly number[];
  readonly removedKeys: readonly string[];
  readonly evaluations: number;
  readonly baselineSolutionCount: number;
}

export function reduceClueCore<T>(options: ReduceClueCoreOptions<T>): ReducedClueCore<T> {
  const normalized = [...options.normalize(options.clues)];
  if (normalized.length === 0) {
    throw new ReducedCoreError("EMPTY_CLUE_SET", "reduced-core input must contain at least one clue");
  }
  const ordered = [...normalized].sort((left, right) =>
    compareCanonicalStrings(options.clueKey(left), options.clueKey(right)),
  );
  const maxEvaluations = options.maxEvaluations ?? DEFAULT_CORE_REDUCTION_EVALUATIONS;
  if (!Number.isInteger(maxEvaluations) || maxEvaluations < 1) {
    throw new RangeError(
      `core reduction evaluation cap must be a positive integer, received ${maxEvaluations}`,
    );
  }

  let evaluations = 0;
  const evaluate = (clues: readonly T[]): CoreSolution => {
    if (evaluations >= maxEvaluations) {
      throw new ReducedCoreError(
        "CORE_REDUCTION_LIMIT",
        `reduced-core evaluation cap ${maxEvaluations} was reached`,
      );
    }
    evaluations += 1;
    const solution = options.solve(clues);
    if (!Number.isInteger(solution.solutionCount) || solution.solutionCount < 0) {
      throw new ReducedCoreError(
        "INVALID_SOLUTION",
        "the independent solver returned an invalid solution count",
      );
    }
    if (solution.solutionCount === 1 && solution.answerKey.length === 0) {
      throw new ReducedCoreError(
        "INVALID_SOLUTION",
        "a unique solution requires a nonempty answer key",
      );
    }
    return solution;
  };

  const baseline = evaluate(ordered);
  if (baseline.solutionCount !== 1) {
    throw new ReducedCoreError(
      "BASELINE_NOT_UNIQUE",
      `reduced-core input must have exactly one solution, received ${baseline.solutionCount}`,
    );
  }

  const retained = new Set<number>(ordered.map((_clue, index) => index));
  const removed: number[] = [];
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    if (!retained.has(index)) {
      continue;
    }
    const candidate = [...retained]
      .filter((candidateIndex) => candidateIndex !== index)
      .sort((left, right) => left - right)
      .map((candidateIndex) => ordered[candidateIndex] as T);
    const solution = evaluate(candidate);
    if (solution.solutionCount === 1 && solution.answerKey === baseline.answerKey) {
      retained.delete(index);
      removed.push(index);
    }
  }
  removed.sort((left, right) => left - right);
  const retainedClues = [...retained]
    .sort((left, right) => left - right)
    .map((index) => ordered[index] as T);

  return {
    retained: options.normalize(retainedClues),
    removedIndices: removed,
    removedKeys: removed.map((index) => options.clueKey(ordered[index] as T)),
    evaluations,
    baselineSolutionCount: baseline.solutionCount,
  };
}
