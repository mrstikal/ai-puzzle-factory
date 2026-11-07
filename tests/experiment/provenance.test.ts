import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REQUIRED_PROMPT_FILES,
  PROVENANCE_CONFIG_FILES,
  PROVENANCE_FONT_PATH,
  PROVENANCE_LICENSE_PATH,
  ProvenanceError,
  buildProvenanceSnapshot,
  createProvenanceProviderFromArchive,
  provenanceEvidenceFromSnapshot,
  readProvenanceArchive,
  resolveProvenanceArchivePath,
  summarizeProvenanceSnapshot,
  verifyProvenanceSnapshot,
  writeProvenanceArchive,
  type ProvenanceBuildOptions,
  type ProvenanceRuntime,
} from "../../src/experiment/provenance.js";
import {
  canFreezeProtocol,
  type FreezeProtocolEvidence,
} from "../../src/experiment/freeze.js";
import { buildPlanManifest } from "../../src/experiment/planner.js";
import { FAMILIES, THRESHOLDS } from "../../src/domain/experiment.js";
import { specProposalMetadataForFamily } from "../../src/ai/propose-spec.js";
import { wordingPromptMetadata } from "../../src/ai/write-wording.js";
import { blindTextPromptMetadata } from "../../src/ai/review-text.js";
import { blindVisionPromptMetadata } from "../../src/ai/review-vision.js";
import { alignmentPromptMetadata } from "../../src/ai/review-alignment.js";
import { main as freezeMain } from "../../src/cli/freeze.js";

const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const CLOCK = { now: () => new Date("2026-11-06T12:00:00.000Z") };
const RUNTIME: ProvenanceRuntime = {
  node: "v24.22.2",
  platform: "linux",
  arch: "x64",
  npm: "11.19.1",
  lockfileVersion: 3,
};
const GIT = { commit: "a".repeat(40), dirty: false };

let tempDirectory: string;

function writeFixtureFile(
  root: string,
  path: string,
  content: string | Buffer,
): void {
  const absolute = join(root, ...path.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function createFixtureRoot(): string {
  const root = mkdtempSync(join(tempDirectory, "source-"));
  const promptContents: Record<string, string> = {
    "src/ai/prompts/v2/alignment-text.txt":
      "PUZZLE_ALIGNMENT_TEXT_PROMPT_VERSION: v2\n",
    "src/ai/prompts/v2/alignment-vision.txt":
      "PUZZLE_ALIGNMENT_VISION_PROMPT_VERSION: v2\n",
    "src/ai/prompts/v3/alignment-vision.txt":
      "PUZZLE_ALIGNMENT_VISION_PROMPT_VERSION: v3\n",
    "src/ai/prompts/v3/blind-vision.txt":
      "PUZZLE_BLIND_VISION_PROMPT_VERSION: v3\n",
    "src/ai/prompts/v1/alignment-text.txt":
      "PUZZLE_ALIGNMENT_TEXT_PROMPT_VERSION: v1\n",
    "src/ai/prompts/v1/alignment-vision.txt":
      "PUZZLE_ALIGNMENT_VISION_PROMPT_VERSION: v1\n",
    "src/ai/prompts/v1/blind-text.txt":
      "PUZZLE_BLIND_TEXT_PROMPT_VERSION: v1\n",
    "src/ai/prompts/v1/blind-vision.txt":
      "PUZZLE_BLIND_VISION_PROMPT_VERSION: v1\n",
    "src/ai/prompts/v1/family-guidance.json": "{\"guidanceVersion\":\"v1\"}\n",
    "src/ai/prompts/v1/spec.txt": "PUZZLE_SPEC_PROMPT_VERSION: v1\n",
    "src/ai/prompts/v1/wording.txt": "PUZZLE_WORDING_PROMPT_VERSION: v1\n",
  };
  for (const path of REQUIRED_PROMPT_FILES) {
    writeFixtureFile(root, path, promptContents[path] ?? "prompt\n");
  }
  writeFixtureFile(root, "src/domain/example.ts", "export const answer = 42;\n");
  writeFixtureFile(root, "src/reporting/assets/report.css", "body{}\n");
  writeFixtureFile(root, "src/reporting/assets/report.js", "export {};\n");
  writeFixtureFile(root, "src/storage/migrations/0001_runs.sql", "SELECT 1;\n");
  writeFixtureFile(root, "scripts/copy-assets.mjs", "console.log('copy');\n");
  for (const path of PROVENANCE_CONFIG_FILES) {
    const content =
      path === "package.json"
        ? `${JSON.stringify({ name: "fixture", version: "0.0.0" })}\n`
        : path === "package-lock.json"
          ? `${JSON.stringify({ lockfileVersion: 3, packages: {} })}\n`
          : path === ".nvmrc"
            ? "24.22.2\n"
            : "export default {};\n";
    writeFixtureFile(root, path, content);
  }
  writeFixtureFile(root, PROVENANCE_FONT_PATH, Buffer.from("font-bytes"));
  writeFixtureFile(root, PROVENANCE_LICENSE_PATH, "font license\n");
  return root;
}

function buildOptions(root: string): ProvenanceBuildOptions {
  return {
    rootDirectory: root,
    clock: CLOCK,
    runtime: RUNTIME,
    git: GIT,
  };
}

function freezeEvidenceFor(
  provenance: FreezeProtocolEvidence["provenance"],
  checkedAt: string = new Date(Date.now() - 60_000).toISOString(),
): FreezeProtocolEvidence {
  const plan = buildPlanManifest({ runKind: "full" });
  const config = {
    configHash: provenance.configHash,
    promptHashes: provenance.promptHashes,
    schemaHashes: provenance.schemaHashes,
    routesHash: HASH_D,
    sourceHash: provenance.sourceHash,
    updatedAt: "2026-11-06T08:00:00.000Z",
    roles: {
      generator: "mock/generator",
      textReviewer: "mock/text-reviewer",
      visionReviewer: "mock/vision-reviewer",
    },
    routingPolicy: {
      mode: "balanced" as const,
      allowFallbacks: true as const,
      requireParameters: true as const,
    },
    routingConfirmation: {
      operator: "test-operator",
      checkedAt,
      providerSort: "default_balanced" as const,
      byokConfigured: false as const,
    },
  };
  return {
    protocolVersion: "1.0.0",
    rootSeed: "puzzle-poc-v1",
    plan,
    planHash: plan.planHash,
    configuration: config,
    preflight: {
      evidenceKind: "live",
      checkedAt: "2026-11-06T08:10:00.000Z",
      configHash: config.configHash,
      routesSupported: true,
      pricesObservedAt: "2026-11-06T08:10:00.000Z",
      priceCatalogHash: HASH_D,
      rolePrices: {
        spec: "0.01",
        wording: "0.01",
        blind_text: "0.01",
        blind_vision: "0.01",
        alignment_text: "0.01",
        alignment_vision: "0.01",
      },
      forecast: {
        maxUsd: "9.50",
        forecast680Usd: "9.00",
        projectedAt160ApprovalsUsd: "8.00",
        conservativeReserveUsd: "9.80",
      },
    },
    fixturePack: {
      packHash: HASH_B,
      labelsHash: HASH_C,
      humanVerified: true,
      verifiedFixtures: 40,
      totalFixtures: 40,
      verifiedAt: "2026-11-06T08:20:00.000Z",
    },
    calibration: {
      runId: "calibration-live-1",
      evidenceKind: "live",
      completedAt: "2026-11-06T08:30:00.000Z",
      configHash: config.configHash,
      packHash: HASH_B,
      labelsHash: HASH_C,
      reviewCalls: 80,
      generationCalls: 0,
      combinations: {
        text_blind: {
          sensitivity: 1,
          specificity: 1,
          defectiveDenominator: 10,
          soundDenominator: 10,
          pass: true,
        },
        text_alignment: {
          sensitivity: 1,
          specificity: 1,
          defectiveDenominator: 10,
          soundDenominator: 10,
          pass: true,
        },
        svg_blind: {
          sensitivity: 1,
          specificity: 1,
          defectiveDenominator: 10,
          soundDenominator: 10,
          pass: true,
        },
        svg_alignment: {
          sensitivity: 1,
          specificity: 1,
          defectiveDenominator: 10,
          soundDenominator: 10,
          pass: true,
        },
      },
    },
    smoke: {
      runId: "smoke-live-1",
      evidenceKind: "live",
      controlState: "completed",
      acceptedAt: "2026-11-06T08:40:00.000Z",
      accepted: true,
      configHash: config.configHash,
      planHash: buildPlanManifest({ runKind: "smoke" }).planHash,
      plannedSlots: 20,
      terminalSlots: 20,
      families: 10,
      roles: [
        "blind_text",
        "blind_vision",
        "alignment_text",
        "alignment_vision",
      ],
    },
    authorizedCapUsd: "10.00",
    costPerApprovedThresholdUsd: THRESHOLDS.costPerApprovedMaxUsd,
    provenance,
  };
}

function captureStdout(): { readonly output: () => string; readonly restore: () => void } {
  let output = "";
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      output += String(chunk);
      return true;
    });
  return {
    output: () => output,
    restore: () => spy.mockRestore(),
  };
}

beforeEach(() => {
  tempDirectory = mkdtempSync(join(tmpdir(), "puzzle-p44-provenance-"));
});

afterEach(() => {
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("source provenance", () => {
  it("builds a deterministic hashed allowlist with prompts, schemas, configs, font, runtime, and Git", () => {
    const root = createFixtureRoot();
    const first = buildProvenanceSnapshot(buildOptions(root));
    const second = buildProvenanceSnapshot(buildOptions(root));

    expect(second.archiveHash).toBe(first.archiveHash);
    expect(first.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.promptBundleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.schemaBundleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.files.map((file) => file.path)).toEqual(
      [...first.files.map((file) => file.path)].sort(),
    );
    expect(first.files.some((file) => file.category === "prompt")).toBe(true);
    expect(first.files.some((file) => file.category === "source")).toBe(true);
    expect(first.files.some((file) => file.category === "config")).toBe(true);
    expect(first.files.some((file) => file.category === "font")).toBe(true);
    expect(first.files.some((file) => file.category === "license")).toBe(true);
    expect(first.files.some((file) => file.path.includes("src/ai/prompts"))).toBe(
      true,
    );
    expect(
      first.files.some(
        (file) => file.category === "source" && file.path.startsWith("src/ai/prompts"),
      ),
    ).toBe(false);
    expect(Object.keys(first.promptHashes)).toHaveLength(FAMILIES.length + 5);
    expect(Object.keys(first.promptHashes)).toEqual(
      expect.arrayContaining([
        "spec:ranking",
        "wording",
        "blind_text",
        "blind_vision",
        "alignment_text",
        "alignment_vision",
      ]),
    );
    expect(Object.keys(first.schemaHashes)).toHaveLength(FAMILIES.length + 5);
    expect(Object.keys(first.schemaHashes)).toEqual(
      expect.arrayContaining([
        "spec:ranking",
        "wording",
        "blind_text",
        "blind_vision",
        "alignment_text",
        "alignment_vision",
      ]),
    );
    const expectedPromptHashes = Object.fromEntries([
      ...FAMILIES.map((family) => [
        `spec:${family}`,
        specProposalMetadataForFamily(family).promptHash,
      ]),
      ["wording", wordingPromptMetadata().promptHash],
      ["blind_text", blindTextPromptMetadata().promptHash],
      ["blind_vision", blindVisionPromptMetadata().promptHash],
      ["alignment_text", alignmentPromptMetadata("text").promptHash],
      ["alignment_vision", alignmentPromptMetadata("svg").promptHash],
    ]);
    expect(first.promptHashes).toEqual(expectedPromptHashes);
    expect(first.schemas).toHaveLength(23);
    expect(first.runtime).toEqual(RUNTIME);
    expect(first.git).toEqual(GIT);
    expect(summarizeProvenanceSnapshot(first)).toMatchObject({
      fileCount: first.files.length,
      promptFileCount: REQUIRED_PROMPT_FILES.length,
      promptHashCount: FAMILIES.length + 5,
      schemaCount: 23,
      schemaHashCount: FAMILIES.length + 5,
      runtime: RUNTIME,
      git: GIT,
    });
  });

  it("detects modified, missing, extra, and symlink files", () => {
    const root = createFixtureRoot();
    const snapshot = buildProvenanceSnapshot(buildOptions(root));
    const sourcePath = join(root, "src", "domain", "example.ts");

    writeFileSync(sourcePath, "export const answer = 43;\n");
    const modified = verifyProvenanceSnapshot(snapshot, { rootDirectory: root });
    expect(modified.ok).toBe(false);
    expect(modified.failures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining(["MODIFIED_FILE", "SOURCE_MISMATCH"]),
    );

    writeFileSync(sourcePath, "export const answer = 42;\n");
    rmSync(sourcePath);
    const missing = verifyProvenanceSnapshot(snapshot, { rootDirectory: root });
    expect(missing.ok).toBe(false);
    expect(missing.failures.map((failure) => failure.code)).toContain(
      "MISSING_FILE",
    );

    writeFileSync(sourcePath, "export const answer = 42;\n");
    writeFileSync(join(root, "src", "domain", "extra.ts"), "export {};\n");
    const extra = verifyProvenanceSnapshot(snapshot, { rootDirectory: root });
    expect(extra.ok).toBe(false);
    expect(extra.failures.map((failure) => failure.code)).toContain(
      "EXTRA_FILE",
    );

    rmSync(join(root, "src", "domain", "extra.ts"));
    symlinkSync("example.ts", join(root, "src", "domain", "link.ts"));
    const symlinked = verifyProvenanceSnapshot(snapshot, { rootDirectory: root });
    expect(symlinked.ok).toBe(false);
    expect(symlinked.failures.map((failure) => failure.code)).toContain(
      "SYMLINK_NOT_ALLOWED",
    );
    expect(() => buildProvenanceSnapshot(buildOptions(root))).toThrow(
      ProvenanceError,
    );
  });

  it("never archives environment files or a caller-supplied secret canary", () => {
    const root = createFixtureRoot();
    const canary = `sk-or-v1-${"f".repeat(64)}`;
    writeFixtureFile(root, ".env", `OPENROUTER_API_KEY=${canary}\n`);
    writeFixtureFile(root, "notes.txt", `unlisted ${canary}\n`);

    const snapshot = buildProvenanceSnapshot(buildOptions(root));
    expect(snapshot.files.some((file) => file.path === ".env")).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain(canary);

    const archive = join(tempDirectory, "secret-archive");
    writeProvenanceArchive(snapshot, {
      rootDirectory: root,
      archiveDirectory: archive,
    });
    expect(existsSync(join(archive, "files", ".env"))).toBe(false);
    expect(existsSync(join(archive, "files", "notes.txt"))).toBe(false);

    writeFixtureFile(
      root,
      "src/domain/example.ts",
      `export const leaked = "${canary}";\n`,
    );
    expect(() =>
      buildProvenanceSnapshot({
        ...buildOptions(root),
        forbiddenSecrets: [canary],
      }),
    ).toThrow(/forbidden secret material/);
  });

  it("writes a safe replay archive, verifies it, and rejects tampering or unsafe paths", () => {
    const root = createFixtureRoot();
    const snapshot = buildProvenanceSnapshot(buildOptions(root));
    const archive = join(tempDirectory, "archive");

    const written = writeProvenanceArchive(snapshot, {
      rootDirectory: root,
      archiveDirectory: archive,
    });
    expect(written.directory).toBe(archive);
    expect(existsSync(join(archive, "manifest.json"))).toBe(true);
    expect(existsSync(join(archive, "schemas.json"))).toBe(true);
    expect(existsSync(join(archive, "files", "src", "domain", "example.ts"))).toBe(
      true,
    );
    expect(written.files).toHaveLength(snapshot.files.length);

    const read = readProvenanceArchive(archive);
    expect(read.archiveHash).toBe(snapshot.archiveHash);
    expect(verifyProvenanceSnapshot(read, { rootDirectory: root }).ok).toBe(true);

    expect(() =>
      writeProvenanceArchive(snapshot, {
        rootDirectory: root,
        archiveDirectory: archive,
      }),
    ).not.toThrow();

    writeFileSync(join(archive, "files", "extra.txt"), "extra\n");
    expect(() => readProvenanceArchive(archive)).toThrow(
      /extra or missing files/,
    );
    rmSync(join(archive, "files", "extra.txt"));

    const archivedSource = join(
      archive,
      "files",
      "src",
      "domain",
      "example.ts",
    );
    writeFileSync(archivedSource, "tampered\n");
    expect(() => readProvenanceArchive(archive)).toThrow(ProvenanceError);

    expect(() =>
      resolveProvenanceArchivePath(archive, "../escape"),
    ).toThrow(ProvenanceError);
    expect(() =>
      resolveProvenanceArchivePath(archive, "/etc/passwd"),
    ).toThrow(ProvenanceError);
    expect(() =>
      resolveProvenanceArchivePath(archive, "files\\..\\escape"),
    ).toThrow(ProvenanceError);

    const outside = join(tempDirectory, "outside");
    writeFixtureFile(tempDirectory, "outside.txt", "outside\n");
    symlinkSync(outside, join(archive, "files", "linked"));
    expect(() =>
      resolveProvenanceArchivePath(archive, "files/linked"),
    ).toThrow(/symbolic link/);
  });

  it("rejects missing required prompt, config, and font files", () => {
    const promptRoot = createFixtureRoot();
    rmSync(join(promptRoot, ...REQUIRED_PROMPT_FILES[0].split("/")));
    expect(() => buildProvenanceSnapshot(buildOptions(promptRoot))).toThrow(
      /required prompt asset is missing/,
    );

    const configRoot = createFixtureRoot();
    rmSync(join(configRoot, ".nvmrc"));
    expect(() => buildProvenanceSnapshot(buildOptions(configRoot))).toThrow(
      /required provenance file is missing/,
    );

    const fontRoot = createFixtureRoot();
    rmSync(join(fontRoot, ...PROVENANCE_FONT_PATH.split("/")));
    expect(() => buildProvenanceSnapshot(buildOptions(fontRoot))).toThrow(
      /required provenance file is missing/,
    );
  });

  it("supports a dirty Git snapshot and records unavailable Git as null", () => {
    const root = createFixtureRoot();
    const dirty = buildProvenanceSnapshot({
      ...buildOptions(root),
      git: { commit: "a".repeat(40), dirty: true },
    });
    expect(dirty.git).toEqual({ commit: "a".repeat(40), dirty: true });
    expect(verifyProvenanceSnapshot(dirty, { rootDirectory: root }).ok).toBe(true);

    const noGit = buildProvenanceSnapshot({ ...buildOptions(root), git: null });
    expect(noGit.git).toBeNull();
    expect(verifyProvenanceSnapshot(noGit, { rootDirectory: root }).ok).toBe(true);
  });

  it("connects the verified provenance archive to freeze and rejects code drift", () => {
    const root = createFixtureRoot();
    const snapshot = buildProvenanceSnapshot(buildOptions(root));
    const archive = join(tempDirectory, "freeze-archive");
    writeProvenanceArchive(snapshot, {
      rootDirectory: root,
      archiveDirectory: archive,
    });
    const loaded = createProvenanceProviderFromArchive({
      archiveDirectory: archive,
      rootDirectory: root,
    });
    expect(loaded.verification.ok).toBe(true);
    const evidence = freezeEvidenceFor(
      provenanceEvidenceFromSnapshot(loaded.snapshot),
      "2026-11-06T11:55:00.000Z",
    );
    const accepted = canFreezeProtocol(evidence, loaded.provider, {
      now: () => new Date("2026-11-06T12:00:00.000Z"),
    });
    expect(accepted.ok).toBe(true);

    const pathKeyedMismatch = canFreezeProtocol(
      {
        ...evidence,
        configuration: {
          ...evidence.configuration,
          promptHashes: { "src/ai/prompts/v1/spec.txt": "a".repeat(64) },
          schemaHashes: { puzzle_spec_ranking: "b".repeat(64) },
        },
      },
      loaded.provider,
      { now: () => new Date("2026-11-06T12:00:00.000Z") },
    );
    expect(pathKeyedMismatch.ok).toBe(false);
    expect(pathKeyedMismatch.failed.map((failure) => failure.id)).toContain(
      "PROVENANCE_MISMATCH",
    );

    writeFileSync(
      join(root, "src", "domain", "example.ts"),
      "export const answer = 43;\n",
    );
    const drifted = createProvenanceProviderFromArchive({
      archiveDirectory: archive,
      rootDirectory: root,
    });
    expect(drifted.verification.ok).toBe(false);
    expect(drifted.verification.failures.map((failure) => failure.code)).toContain(
      "MODIFIED_FILE",
    );

    const fresh = buildProvenanceSnapshot(buildOptions(root));
    const mismatch = canFreezeProtocol(
      evidence,
      () => provenanceEvidenceFromSnapshot(fresh),
      { now: () => new Date("2026-11-06T12:00:00.000Z") },
    );
    expect(mismatch.ok).toBe(false);
    expect(mismatch.failed.map((failure) => failure.id)).toContain(
      "PROVENANCE_MISMATCH",
    );

    expect(() =>
      writeProvenanceArchive(fresh, {
        rootDirectory: root,
        archiveDirectory: archive,
      }),
    ).toThrow(/different snapshot/);
  });

  it("exposes archive and verified-freeze CLI paths without network access", async () => {
    const root = createFixtureRoot();
    const archive = join(tempDirectory, "cli-archive");
    const captured = captureStdout();
    try {
      const code = await freezeMain([
        "node",
        "freeze",
        "--archive-provenance",
        archive,
        "--source-root",
        root,
      ]);
      expect(code).toBe(0);
    } finally {
      captured.restore();
    }
    expect(existsSync(join(archive, "manifest.json"))).toBe(true);
    expect(captured.output()).toContain('"ok": true');

    const verifyCapture = captureStdout();
    try {
      const code = await freezeMain([
        "node",
        "freeze",
        "--verify-provenance",
        archive,
        "--source-root",
        root,
      ]);
      expect(code).toBe(0);
    } finally {
      verifyCapture.restore();
    }
    expect(verifyCapture.output()).toContain('"ok": true');

    const snapshot = readProvenanceArchive(archive);
    const bundlePath = join(tempDirectory, "bundle.json");
    writeFileSync(
      bundlePath,
      `${JSON.stringify(
        { freeze: freezeEvidenceFor(provenanceEvidenceFromSnapshot(snapshot)) },
        null,
        2,
      )}\n`,
    );
    const freezeCapture = captureStdout();
    try {
      const code = await freezeMain([
        "node",
        "freeze",
        "--evidence",
        bundlePath,
        "--provenance",
        archive,
        "--source-root",
        root,
      ]);
      expect(code).toBe(0);
    } finally {
      freezeCapture.restore();
    }
    expect(freezeCapture.output()).toContain('"ok": true');
    expect(freezeCapture.output()).toContain('"archiveHash"');
  });
});
