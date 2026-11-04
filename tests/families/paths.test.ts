import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { deepEqual } from "../../src/domain/answers.js";
import type { Difficulty } from "../../src/domain/experiment.js";
import { SolverLimitError } from "../../src/families/canonicalize.js";
import {
  CanonicalStructureSchema,
  D4_OPERATIONS,
  SolveResultSchema,
  VisibleRulesSchema,
  ruleFacts,
  type D4Operation,
} from "../../src/families/contracts.js";
import { canonicalizePathsSpec } from "../../src/families/paths/canonical.js";
import {
  PathsConstructionError,
  constructPathsSpec,
  pathsEngine,
} from "../../src/families/paths/engine.js";
import {
  MAX_ROUTE_STATES,
  PathRouteSchema,
  PathsSpecSchema,
  enumerateFullGridSimpleRoutes,
  findTreeRoute,
  pathRouteKey,
  routeUsesClosedCorridor,
  samePathRoute,
  sortPathCells,
  sortPathEdge,
  sortPathEdges,
  type PathCell,
  type PathEdge,
  type PathRoute,
  type PathsSpec,
} from "../../src/families/paths/schema.js";
import { productionRegistry } from "../../src/families/registry.js";
import { deriveStreamSeed } from "../../src/util/random.js";

const SEED_A = "0".repeat(64);
const SEED_B = "1".repeat(64);

const BASE_ACTIVE: readonly PathCell[] = [
  { row: 0, column: 0 },
  { row: 0, column: 1 },
  { row: 0, column: 2 },
  { row: 1, column: 0 },
  { row: 1, column: 1 },
  { row: 1, column: 2 },
];

const BASE_EDGES: readonly PathEdge[] = [
  { from: { row: 0, column: 0 }, to: { row: 0, column: 1 } },
  { from: { row: 0, column: 0 }, to: { row: 1, column: 0 } },
  { from: { row: 0, column: 1 }, to: { row: 0, column: 2 } },
  { from: { row: 1, column: 0 }, to: { row: 1, column: 1 } },
  { from: { row: 1, column: 1 }, to: { row: 1, column: 2 } },
];

function makeSpec(
  active: readonly PathCell[],
  edges: readonly PathEdge[],
  start: PathCell,
  goal: PathCell,
): PathsSpec {
  return PathsSpecSchema.parse({
    active: sortPathCells(active),
    edges: sortPathEdges(edges),
    start,
    goal,
  });
}

const baseSpec = makeSpec(
  BASE_ACTIVE,
  BASE_EDGES,
  { row: 0, column: 0 },
  { row: 1, column: 2 },
);

function answerOf(spec: PathsSpec): PathRoute {
  const result = pathsEngine.enumerateSolutions(spec);
  const answer = result.correctAnswer;
  if (answer === null) {
    throw new Error("expected a unique path answer");
  }
  return answer;
}

function transformPathCell(operation: D4Operation, cell: PathCell): PathCell {
  const last = 3;
  switch (operation) {
    case "identity":
      return cell;
    case "rotate90":
      return { row: cell.column, column: last - cell.row };
    case "rotate180":
      return { row: last - cell.row, column: last - cell.column };
    case "rotate270":
      return { row: last - cell.column, column: cell.row };
    case "reflectLeftRight":
      return { row: cell.row, column: last - cell.column };
    case "reflectTopBottom":
      return { row: last - cell.row, column: cell.column };
    case "reflectMainDiagonal":
      return { row: cell.column, column: cell.row };
    case "reflectAntiDiagonal":
      return { row: last - cell.column, column: last - cell.row };
    default:
      throw new Error(`unknown D4 operation ${String(operation)}`);
  }
}

function transformSpec(
  spec: PathsSpec,
  operation: D4Operation,
  rowOffset = 0,
  columnOffset = 0,
): PathsSpec {
  const transform = (cell: PathCell): PathCell => {
    const transformed = transformPathCell(operation, cell);
    return {
      row: transformed.row + rowOffset,
      column: transformed.column + columnOffset,
    };
  };
  return PathsSpecSchema.parse({
    active: sortPathCells(spec.active.map(transform)),
    edges: sortPathEdges(
      spec.edges.map((edge) =>
        sortPathEdge({ from: transform(edge.from), to: transform(edge.to) }),
      ),
    ),
    start: transform(spec.start),
    goal: transform(spec.goal),
  });
}

function thrown(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}

describe("path DSL", () => {
  it("accepts a connected 6-cell tree with a 3-edge route", () => {
    expect(() => PathsSpecSchema.parse(baseSpec)).not.toThrow();
    expect(baseSpec.active).toHaveLength(6);
    expect(baseSpec.edges).toHaveLength(5);
    expect(answerOf(baseSpec)).toEqual([
      { row: 0, column: 0 },
      { row: 1, column: 0 },
      { row: 1, column: 1 },
      { row: 1, column: 2 },
    ]);
  });

  it("rejects disconnected, cyclic, diagonal, duplicate, and unordered graphs", () => {
    const disconnected = {
      active: sortPathCells([
        { row: 0, column: 0 },
        { row: 0, column: 1 },
        { row: 1, column: 0 },
        { row: 1, column: 1 },
        { row: 3, column: 2 },
        { row: 3, column: 3 },
      ]),
      edges: sortPathEdges([
        { from: { row: 0, column: 0 }, to: { row: 0, column: 1 } },
        { from: { row: 0, column: 0 }, to: { row: 1, column: 0 } },
        { from: { row: 0, column: 1 }, to: { row: 1, column: 1 } },
        { from: { row: 1, column: 0 }, to: { row: 1, column: 1 } },
        { from: { row: 3, column: 2 }, to: { row: 3, column: 3 } },
      ]),
      start: { row: 0, column: 0 },
      goal: { row: 1, column: 1 },
    };
    expect(() => PathsSpecSchema.parse(disconnected)).toThrow();

    const extraEdge = {
      active: baseSpec.active,
      edges: sortPathEdges([
        ...baseSpec.edges,
        { from: { row: 0, column: 1 }, to: { row: 1, column: 1 } },
      ]),
      start: baseSpec.start,
      goal: baseSpec.goal,
    };
    const extraError = thrown(() => PathsSpecSchema.parse(extraEdge));
    expect(extraError).toBeInstanceOf(ZodError);
    expect(
      (extraError as ZodError).issues.some((issue) =>
        issue.message.includes("tree"),
      ),
    ).toBe(true);

    const diagonal = {
      ...baseSpec,
      edges: sortPathEdges([
        ...baseSpec.edges.slice(0, 4),
        { from: { row: 0, column: 1 }, to: { row: 1, column: 2 } },
      ]),
    };
    expect(() => PathsSpecSchema.parse(diagonal)).toThrow();

    const duplicate = {
      ...baseSpec,
      edges: [...baseSpec.edges, baseSpec.edges[0]],
    };
    expect(() => PathsSpecSchema.parse(duplicate)).toThrow();

    const firstEdge = baseSpec.edges[0];
    if (firstEdge === undefined) {
      throw new Error("expected a first edge");
    }
    const reversedEdge = {
      ...baseSpec,
      edges: [{ from: firstEdge.to, to: firstEdge.from }, ...baseSpec.edges.slice(1)],
    };
    expect(() => PathsSpecSchema.parse(reversedEdge)).toThrow();

    const unorderedActive = {
      ...baseSpec,
      active: [...baseSpec.active].reverse(),
    };
    expect(() => PathsSpecSchema.parse(unorderedActive)).toThrow();

    const unorderedEdges = {
      ...baseSpec,
      edges: [...baseSpec.edges].reverse(),
    };
    expect(() => PathsSpecSchema.parse(unorderedEdges)).toThrow();
  });

  it("rejects start=goal, out-of-range routes, and malformed route steps", () => {
    expect(() =>
      PathsSpecSchema.parse({ ...baseSpec, goal: baseSpec.start }),
    ).toThrow();
    expect(() =>
      PathsSpecSchema.parse({
        ...baseSpec,
        goal: { row: 0, column: 2 },
      }),
    ).toThrow();
    expect(() =>
      PathsSpecSchema.parse({
        ...baseSpec,
        active: baseSpec.active.slice(0, 5),
        edges: baseSpec.edges.slice(0, 4),
      }),
    ).toThrow();
    expect(() =>
      PathRouteSchema.parse([
        { row: 0, column: 0 },
        { row: 1, column: 0 },
        { row: 0, column: 0 },
      ]),
    ).toThrow();
    expect(() =>
      PathRouteSchema.parse([
        { row: 0, column: 0 },
        { row: 0, column: 2 },
      ]),
    ).toThrow();
  });

  it("rejects a route that jumps over a cell or revisits one", () => {
    expect(() =>
      PathRouteSchema.parse([
        { row: 0, column: 0 },
        { row: 0, column: 1 },
        { row: 0, column: 2 },
        { row: 1, column: 2 },
      ]),
    ).not.toThrow();
    expect(() =>
      PathRouteSchema.parse([
        { row: 0, column: 0 },
        { row: 0, column: 2 },
        { row: 1, column: 2 },
      ]),
    ).toThrow();
    expect(() =>
      PathRouteSchema.parse([
        { row: 0, column: 0 },
        { row: 1, column: 0 },
        { row: 0, column: 0 },
        { row: 0, column: 1 },
      ]),
    ).toThrow();
  });
});

describe("path solver", () => {
  it("recovers the unique tree route and a derived proof", () => {
    const result = pathsEngine.enumerateSolutions(baseSpec);
    expect(result.solutionCount).toBe(1);
    expect(result.answerCount).toBe(1);
    expect(result.correctAnswer).toEqual([
      { row: 0, column: 0 },
      { row: 1, column: 0 },
      { row: 1, column: 1 },
      { row: 1, column: 2 },
    ]);
    expect(result.enumeratedStates).toBe(6);
    expect(result.checkerVersion).toBe("paths-v1");
    expect(result.proof?.facts.map((fact) => fact.factId)).toEqual(["s001"]);
    expect(() => SolveResultSchema.parse(result)).not.toThrow();
    const answer = answerOf(baseSpec);
    expect(pathsEngine.verifyAnswer(baseSpec, answer)).toBe(true);
  });

  it("rejects shortcuts, reversed routes, inactive cells, and wrong endpoints", () => {
    const shortcut: readonly PathCell[] = [
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 1, column: 1 },
      { row: 1, column: 2 },
    ];
    expect(routeUsesClosedCorridor(baseSpec, shortcut)).toBe(true);
    expect(pathsEngine.verifyAnswer(baseSpec, [...shortcut])).toBe(false);
    expect(
      pathsEngine.verifyAnswer(baseSpec, [
        { row: 1, column: 2 },
        { row: 1, column: 1 },
        { row: 1, column: 0 },
        { row: 0, column: 0 },
      ]),
    ).toBe(false);
    expect(
      pathsEngine.verifyAnswer(baseSpec, [
        { row: 0, column: 0 },
        { row: 1, column: 0 },
        { row: 2, column: 0 },
        { row: 2, column: 1 },
      ]),
    ).toBe(false);
    expect(
      pathsEngine.verifyAnswer(baseSpec, [
        { row: 0, column: 0 },
        { row: 0, column: 1 },
        { row: 0, column: 2 },
        { row: 1, column: 2 },
      ]),
    ).toBe(false);
    expect(
      pathsEngine.verifyAnswer(baseSpec, [
        { row: 0, column: 0 },
        { row: 1, column: 0 },
        { row: 1, column: 1 },
      ]),
    ).toBe(false);
    expect(
      pathsEngine.verifyAnswer(
        { ...baseSpec, goal: baseSpec.start } as unknown as PathsSpec,
        answerOf(baseSpec),
      ),
    ).toBe(false);
  });

  it("enforces the full-grid route enumeration cap", () => {
    expect(() =>
      enumerateFullGridSimpleRoutes(
        { row: 0, column: 0 },
        { row: 3, column: 3 },
        5,
      ),
    ).toThrow(SolverLimitError);
    const error = thrown(() =>
      enumerateFullGridSimpleRoutes(
        { row: 0, column: 0 },
        { row: 3, column: 3 },
        5,
      ),
    );
    expect(error).toBeInstanceOf(SolverLimitError);
    expect((error as SolverLimitError).limit).toBe(5);
    expect(MAX_ROUTE_STATES).toBe(200000);
    const routes = enumerateFullGridSimpleRoutes(
      baseSpec.start,
      baseSpec.goal,
    );
    expect(routes.length).toBeGreaterThan(3);
    expect(routes.some((route) => samePathRoute(route, answerOf(baseSpec)))).toBe(
      true,
    );
  });
});

describe("path options", () => {
  it("builds four distinct routes with exactly one valid answer", () => {
    const correct = answerOf(baseSpec);
    const set = pathsEngine.makeOptions(baseSpec, correct, SEED_A);
    expect(set.choices).toHaveLength(4);
    expect(set.choices.map((choice) => choice.label)).toEqual(["A", "B", "C", "D"]);
    let trueChoices = 0;
    const keys = new Set<string>();
    for (const choice of set.choices) {
      expect(PathRouteSchema.parse(choice.value)).toEqual(choice.value);
      keys.add(pathRouteKey(choice.value));
      if (pathsEngine.verifyAnswer(baseSpec, choice.value)) {
        trueChoices += 1;
      } else {
        expect(routeUsesClosedCorridor(baseSpec, choice.value)).toBe(true);
      }
    }
    expect(trueChoices).toBe(1);
    expect(keys.size).toBe(4);
    expect(
      deepEqual(
        set.choices.find((choice) => choice.label === set.correctLabel)?.value,
        correct,
      ),
    ).toBe(true);
    expect(pathsEngine.makeOptions(baseSpec, correct, SEED_A)).toEqual(set);
    expect(() => pathsEngine.makeOptions(baseSpec, answerOf(baseSpec), SEED_B)).not.toThrow();
    expect(() =>
      pathsEngine.makeOptions(
        baseSpec,
        [
          { row: 0, column: 0 },
          { row: 0, column: 1 },
          { row: 0, column: 2 },
          { row: 1, column: 2 },
        ],
        SEED_A,
      ),
    ).toThrow();
  });

  it("makes the visually tempting shortcut formally invalid", () => {
    const shortcut: readonly PathCell[] = [
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 1, column: 1 },
      { row: 1, column: 2 },
    ];
    expect(pathsEngine.verifyAnswer(baseSpec, [...shortcut])).toBe(false);
    expect(
      findTreeRoute(
        baseSpec.active,
        baseSpec.edges,
        baseSpec.start,
        baseSpec.goal,
      ),
    ).not.toEqual(shortcut);
  });
});

describe("path canonicalization", () => {
  it("normalizes D4 frames and translation while retaining topology", () => {
    const baseline = canonicalizePathsSpec(baseSpec);
    expect(() => CanonicalStructureSchema.parse(baseline)).not.toThrow();
    expect(baseline.domainTokens).toEqual(["grid=4x4"]);
    expect(baseline.queryKind).toBe("S_to_G_route");
    expect(baseline.queryTokens).toHaveLength(2);
    expect(baseline.queryTokens.some((token) => token.startsWith("start:"))).toBe(
      true,
    );
    expect(baseline.queryTokens.some((token) => token.startsWith("goal:"))).toBe(
      true,
    );
    expect(baseline.geometryTokens).toHaveLength(6);
    expect(baseline.relationTokens).toHaveLength(5);
    for (const operation of D4_OPERATIONS) {
      const transformed = transformSpec(baseSpec, operation);
      expect(canonicalizePathsSpec(transformed)).toEqual(baseline);
    }
    const translated = transformSpec(baseSpec, "identity", 1, 1);
    expect(canonicalizePathsSpec(translated)).toEqual(baseline);
  });

  it("separates a genuinely different topology", () => {
    const baseline = canonicalizePathsSpec(baseSpec);
    const rewired = makeSpec(
      BASE_ACTIVE,
      [
        ...BASE_EDGES.filter(
          (edge) =>
            !(
              edge.from.row === 1 &&
              edge.from.column === 1 &&
              edge.to.row === 1 &&
              edge.to.column === 2
            ),
        ),
        { from: { row: 0, column: 2 }, to: { row: 1, column: 2 } },
      ],
      { row: 0, column: 0 },
      { row: 1, column: 2 },
    );
    expect(canonicalizePathsSpec(rewired)).not.toEqual(baseline);
  });
});

describe("path construction", () => {
  it("is deterministic and respects level route ranges", () => {
    const first = constructPathsSpec(SEED_A, 3);
    expect(constructPathsSpec(SEED_A, 3)).toEqual(first);
    expect(deepEqual(constructPathsSpec(SEED_B, 3).spec, first.spec)).toBe(false);
    for (const difficulty of [1, 2, 3] as const) {
      const { spec, trace } = constructPathsSpec(SEED_A, difficulty);
      expect(trace.difficulty).toBe(difficulty);
      expect(trace.activeSize).toBeGreaterThanOrEqual(6);
      expect(trace.activeSize).toBeLessThanOrEqual(12);
      expect(spec.edges).toHaveLength(spec.active.length - 1);
      expect(trace.falseRouteCount).toBeGreaterThanOrEqual(3);
      expect(trace.drawsUsed).toBeLessThanOrEqual(64);
      if (difficulty === 1) {
        expect(trace.routeLength).toBeGreaterThanOrEqual(3);
        expect(trace.routeLength).toBeLessThanOrEqual(5);
      } else if (difficulty === 2) {
        expect(trace.routeLength).toBeGreaterThanOrEqual(5);
        expect(trace.routeLength).toBeLessThanOrEqual(7);
      } else {
        expect(trace.routeLength).toBeGreaterThanOrEqual(7);
        expect(trace.routeLength).toBeLessThanOrEqual(11);
      }
      expect(
        findTreeRoute(spec.active, spec.edges, spec.start, spec.goal),
      ).toBeDefined();
    }
  });

  it("constructs at least 95 of 100 fixed seeds with independently verified options", () => {
    const difficulties: Difficulty[] = [
      ...Array.from({ length: 34 }, () => 1 as Difficulty),
      ...Array.from({ length: 33 }, () => 2 as Difficulty),
      ...Array.from({ length: 33 }, () => 3 as Difficulty),
    ];
    const successes: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };
    const failures: Array<{
      readonly seed: string;
      readonly difficulty: Difficulty;
      readonly code: string;
    }> = [];
    const specs: PathsSpec[] = [];
    for (const [index, difficulty] of difficulties.entries()) {
      const slotId = `paths-fixture-${String(index + 1).padStart(3, "0")}`;
      const seed = deriveStreamSeed({
        protocolVersion: "1.0.0",
        rootSeed: "puzzle-poc-v1",
        slotId,
        purpose: "spec",
      });
      let construction;
      try {
        construction = constructPathsSpec(seed, difficulty);
      } catch (error) {
        if (error instanceof PathsConstructionError) {
          failures.push({ seed, difficulty, code: error.code });
          continue;
        }
        throw error;
      }
      successes[difficulty] += 1;
      const { spec, trace } = construction;
      expect(trace.falseRouteCount).toBeGreaterThanOrEqual(3);
      expect(trace.drawsUsed).toBeLessThanOrEqual(64);
      const answer = answerOf(spec);
      expect(pathsEngine.verifyAnswer(spec, answer)).toBe(true);
      const optionsSeed = deriveStreamSeed({
        protocolVersion: "1.0.0",
        rootSeed: "puzzle-poc-v1",
        slotId,
        purpose: "options",
      });
      const set = pathsEngine.makeOptions(spec, answer, optionsSeed);
      expect(set.choices).toHaveLength(4);
      expect(
        set.choices.filter((choice) =>
          pathsEngine.verifyAnswer(spec, choice.value),
        ),
      ).toHaveLength(1);
      specs.push(spec);
    }
    expect(successes[1]).toBeGreaterThanOrEqual(30);
    expect(successes[2]).toBeGreaterThanOrEqual(30);
    expect(successes[3]).toBeGreaterThanOrEqual(30);
    expect(successes[1] + successes[2] + successes[3]).toBeGreaterThanOrEqual(95);
    expect(failures.length).toBeLessThanOrEqual(5);
    expect(new Set(specs.map((spec) => JSON.stringify(spec))).size).toBeGreaterThan(1);
  });
});

describe("path engine contract and registry", () => {
  it("keeps the answer out of the generated spec", () => {
    const generated = pathsEngine.generateSpec(SEED_A, 3);
    expect(Object.keys(generated).sort()).toEqual(["active", "edges", "goal", "start"]);
    expect(pathsEngine.generateSpec(SEED_A, 3)).toEqual(generated);
    expect(() =>
      PathsSpecSchema.parse({ ...generated, route: answerOf(generated) }),
    ).toThrow();
  });

  it("returns deterministic valid mutations", () => {
    const mutations = pathsEngine.testMutations(baseSpec);
    expect(mutations.map((mutation) => mutation.id)).toEqual(["swapped-endpoints"]);
    expect(pathsEngine.testMutations(baseSpec)).toEqual(mutations);
    const swapped = mutations[0]?.spec;
    if (swapped === undefined) {
      throw new Error("expected a swapped-endpoint mutation");
    }
    expect(() => PathsSpecSchema.parse(swapped)).not.toThrow();
    expect(deepEqual(swapped, baseSpec)).toBe(false);
    const reversed = [...answerOf(baseSpec)].reverse();
    expect(pathsEngine.verifyAnswer(swapped, reversed)).toBe(true);
  });

  it("exposes explicit rules, observation facts, and registry registration", () => {
    const rules = pathsEngine.visibleRules(baseSpec);
    expect(() => VisibleRulesSchema.parse(rules)).not.toThrow();
    expect(rules.domain).toContain("tree");
    expect(rules.closedWorld).toContain("orthogonally");
    expect(rules.operations.join(" ")).toContain("open corridor");
    expect(rules.operations.join(" ")).toContain("tree");
    expect(rules.conventions.join(" ")).toContain("S marks the start");
    expect(ruleFacts(rules).map((fact) => fact.factId)).toEqual([
      "r-domain",
      "r-closed",
      "r-target",
      "r-operations",
      "r-conventions",
    ]);
    const facts = pathsEngine.facts(baseSpec);
    expect(facts.map((fact) => fact.factId)).toEqual([
      "p001",
      "p002",
      "p003",
      "p004",
      "p005",
      "p006",
      "p007",
      "p008",
      "p009",
      "p010",
      "p011",
      "p012",
      "p013",
    ]);
    expect(facts[0]?.text).toContain("row 1, column 1");
    expect(facts[6]?.text).toContain("Open corridor");
    expect(facts[11]?.text).toContain("Start marker");
    expect(facts[12]?.text).toContain("Goal marker");
    expect(productionRegistry.listEngineFamilies()).toContain("paths");
    expect(productionRegistry.getEngine("paths").modality).toBe("svg");
    expect(productionRegistry.hasRenderer("paths")).toBe(false);
    expect(productionRegistry.listRendererFamilies()).not.toContain("paths");
  });
});
