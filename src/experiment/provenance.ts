import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import { specProposalMetadataForFamily } from "../ai/propose-spec.js";
import { alignmentPromptMetadata } from "../ai/review-alignment.js";
import { blindTextPromptMetadata } from "../ai/review-text.js";
import { blindVisionPromptMetadata } from "../ai/review-vision.js";
import {
  ALIGNMENT_REVIEW_JSON_SCHEMA,
  BLIND_REVIEW_JSON_SCHEMA,
  FAMILY_SPEC_JSON_SCHEMAS,
  WORDING_JSON_SCHEMA,
  familySpecEnvelopeJsonSchema,
  strictSchemaHash,
  type StrictJsonSchema,
} from "../ai/schemas.js";
import { wordingPromptMetadata } from "../ai/write-wording.js";
import { FAMILIES, Sha256Schema } from "../domain/experiment.js";
import { canonicalJson, hashCanonicalJson } from "../util/hash.js";
import type { ProvenanceEvidence } from "./freeze.js";

export const PROVENANCE_VERSION = 1 as const;

export const PROVENANCE_CONFIG_FILES = [
  ".nvmrc",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "eslint.config.mjs",
  "vitest.config.ts",
  "playwright.config.ts",
] as const;

export const PROVENANCE_FONT_PATH = "assets/fonts/DejaVuSans.ttf";
export const PROVENANCE_LICENSE_PATH = "assets/fonts/LICENSE.txt";

export const REQUIRED_PROMPT_FILES = [
  "src/ai/prompts/v2/alignment-text.txt",
  "src/ai/prompts/v3/alignment-vision.txt",
  "src/ai/prompts/v1/blind-text.txt",
  "src/ai/prompts/v3/blind-vision.txt",
  "src/ai/prompts/v1/family-guidance.json",
  "src/ai/prompts/v1/spec.txt",
  "src/ai/prompts/v1/wording.txt",
] as const;

const SOURCE_ROOTS = ["src", "scripts"] as const;
const PROMPT_ROOT = "src/ai/prompts";
const FORBIDDEN_PATH_SEGMENTS = new Set([
  ".git",
  "coverage",
  "data",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

export const PROVENANCE_FILE_CATEGORIES = [
  "source",
  "prompt",
  "config",
  "font",
  "license",
] as const;
export type ProvenanceFileCategory =
  (typeof PROVENANCE_FILE_CATEGORIES)[number];

export const ProvenanceFileSchema = z.strictObject({
  path: z.string().min(1).max(512),
  category: z.enum(PROVENANCE_FILE_CATEGORIES),
  sha256: Sha256Schema,
  byteLength: z.number().int().nonnegative(),
});
export type ProvenanceFile = z.infer<typeof ProvenanceFileSchema>;

export const ProvenanceRuntimeSchema = z.strictObject({
  node: z.string().min(1).max(64),
  platform: z.string().min(1).max(64),
  arch: z.string().min(1).max(64),
  npm: z.string().min(1).max(64).nullable(),
  lockfileVersion: z.number().int().nonnegative().nullable(),
});
export type ProvenanceRuntime = z.infer<typeof ProvenanceRuntimeSchema>;

export const ProvenanceGitSchema = z.strictObject({
  commit: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/)
    .nullable(),
  dirty: z.boolean().nullable(),
});
export type ProvenanceGit = z.infer<typeof ProvenanceGitSchema>;

export const ProvenanceSchemaEntrySchema = z.strictObject({
  name: z.string().min(1).max(128),
  strict: z.literal(true),
  hash: Sha256Schema,
  schema: z.unknown(),
});
export type ProvenanceSchemaEntry = z.infer<
  typeof ProvenanceSchemaEntrySchema
>;

export const ProvenanceSnapshotSchema = z.strictObject({
  version: z.literal(PROVENANCE_VERSION),
  createdAt: z.iso.datetime(),
  sourceHash: Sha256Schema,
  promptHashes: z.record(z.string().min(1), Sha256Schema),
  schemaHashes: z.record(z.string().min(1), Sha256Schema),
  configHash: Sha256Schema,
  promptBundleHash: Sha256Schema,
  schemaBundleHash: Sha256Schema,
  fontHash: Sha256Schema,
  licenseHash: Sha256Schema,
  lockfileHash: Sha256Schema,
  archiveHash: Sha256Schema,
  files: z.array(ProvenanceFileSchema).min(1),
  schemas: z.array(ProvenanceSchemaEntrySchema).min(1),
  runtime: ProvenanceRuntimeSchema,
  git: ProvenanceGitSchema.nullable(),
});
export type ProvenanceSnapshot = z.infer<typeof ProvenanceSnapshotSchema>;

export const PROVENANCE_FAILURE_CODES = [
  "ARCHIVE_HASH_MISMATCH",
  "ARCHIVE_INTEGRITY",
  "CONFIG_MISMATCH",
  "EXTRA_FILE",
  "FONT_MISMATCH",
  "INVALID_MANIFEST",
  "INVALID_ROOT",
  "INVALID_SNAPSHOT",
  "LICENSE_MISMATCH",
  "LOCKFILE_MISMATCH",
  "MISSING_FILE",
  "MODIFIED_FILE",
  "PROMPT_MISMATCH",
  "SCHEMA_MISMATCH",
  "SECRET_DETECTED",
  "SOURCE_MISMATCH",
  "SYMLINK_NOT_ALLOWED",
  "UNSAFE_PATH",
] as const;
export type ProvenanceFailureCode = (typeof PROVENANCE_FAILURE_CODES)[number];

export interface ProvenanceFailure {
  readonly code: ProvenanceFailureCode;
  readonly detail: string;
  readonly path?: string;
}

export interface ProvenanceVerification {
  readonly ok: boolean;
  readonly failures: readonly ProvenanceFailure[];
}

export interface ProvenanceBuildOptions {
  readonly rootDirectory: string;
  readonly clock?: { now(): Date };
  readonly runtime?: ProvenanceRuntime;
  readonly git?: ProvenanceGit | null;
  readonly forbiddenSecrets?: readonly string[];
}

export interface ProvenanceVerifyOptions {
  readonly rootDirectory: string;
  readonly forbiddenSecrets?: readonly string[];
}

export interface LoadProvenanceProviderOptions extends ProvenanceVerifyOptions {
  readonly archiveDirectory: string;
}

export interface LoadedProvenance {
  readonly snapshot: ProvenanceSnapshot;
  readonly provider: () => ProvenanceEvidence;
  readonly verification: ProvenanceVerification;
}

export interface WriteProvenanceArchiveOptions {
  readonly rootDirectory: string;
  readonly archiveDirectory: string;
}

export interface WrittenProvenanceArchive {
  readonly directory: string;
  readonly manifestPath: string;
  readonly schemasPath: string;
  readonly files: readonly string[];
}

export type ProvenanceErrorCode =
  | "ARCHIVE_CONFLICT"
  | "ARCHIVE_INTEGRITY"
  | "INVALID_MANIFEST"
  | "INVALID_ROOT"
  | "INVALID_SNAPSHOT"
  | "MISSING_FILE"
  | "SECRET_DETECTED"
  | "SYMLINK_NOT_ALLOWED"
  | "UNSAFE_PATH";

export class ProvenanceError extends Error {
  readonly code: ProvenanceErrorCode;

  constructor(
    code: ProvenanceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProvenanceError";
    this.code = code;
  }
}

interface CollectedFile {
  readonly path: string;
  readonly category: ProvenanceFileCategory;
  readonly sha256: string;
  readonly byteLength: number;
  readonly bytes: Buffer;
}

interface CollectedProvenance {
  readonly files: readonly CollectedFile[];
  readonly schemas: readonly ProvenanceSchemaEntry[];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSafeRelativePath(path: string): void {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw new ProvenanceError("UNSAFE_PATH", `unsafe provenance path: ${path}`);
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new ProvenanceError("UNSAFE_PATH", `unsafe provenance path: ${path}`);
  }
}

function assertNoForbiddenSegment(path: string): void {
  for (const segment of path.split("/")) {
    const lower = segment.toLowerCase();
    if (
      FORBIDDEN_PATH_SEGMENTS.has(lower) ||
      lower === ".env" ||
      lower.startsWith(".env.")
    ) {
      throw new ProvenanceError(
        "SECRET_DETECTED",
        `refusing to archive excluded environment or generated path: ${path}`,
      );
    }
  }
}

function assertNoSymlinkComponents(root: string, relativePath: string): void {
  const segments = relativePath.split("/");
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if (isEnoent(error)) {
        return;
      }
      throw new ProvenanceError(
        "INVALID_ROOT",
        `cannot inspect provenance path: ${relativePath}`,
        { cause: error },
      );
    }
    if (stats.isSymbolicLink()) {
      throw new ProvenanceError(
        "SYMLINK_NOT_ALLOWED",
        `provenance path uses a symbolic link: ${relativePath}`,
      );
    }
  }
}

function assertRootDirectory(root: string): void {
  let stats;
  try {
    stats = lstatSync(root);
  } catch (error) {
    throw new ProvenanceError(
      "INVALID_ROOT",
      `provenance root does not exist: ${root}`,
      { cause: error },
    );
  }
  if (!stats.isDirectory()) {
    throw new ProvenanceError(
      "INVALID_ROOT",
      `provenance root is not a directory: ${root}`,
    );
  }
}

function readRegularFile(
  root: string,
  relativePath: string,
  forbiddenSecrets: readonly string[],
): Buffer {
  assertSafeRelativePath(relativePath);
  assertNoForbiddenSegment(relativePath);
  assertNoSymlinkComponents(root, relativePath);
  const absolute = join(root, relativePath);
  let preOpenStats;
  try {
    preOpenStats = lstatSync(absolute);
  } catch (error) {
    if (isEnoent(error)) {
      throw new ProvenanceError(
        "MISSING_FILE",
        `required provenance file is missing: ${relativePath}`,
        { cause: error },
      );
    }
    throw new ProvenanceError(
      "INVALID_ROOT",
      `cannot inspect provenance file: ${relativePath}`,
      { cause: error },
    );
  }
  if (preOpenStats.isSymbolicLink()) {
    throw new ProvenanceError(
      "SYMLINK_NOT_ALLOWED",
      `provenance path uses a symbolic link: ${relativePath}`,
    );
  }
  if (!preOpenStats.isFile()) {
    throw new ProvenanceError(
      "INVALID_ROOT",
      `provenance path is not a regular file: ${relativePath}`,
    );
  }
  const realRoot = realpathSync(root);
  let descriptor: number;
  try {
    descriptor = openSync(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isEnoent(error)) {
      throw new ProvenanceError(
        "MISSING_FILE",
        `required provenance file is missing: ${relativePath}`,
        { cause: error },
      );
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ELOOP"
    ) {
      throw new ProvenanceError(
        "SYMLINK_NOT_ALLOWED",
        `provenance path uses a symbolic link: ${relativePath}`,
        { cause: error },
      );
    }
    throw new ProvenanceError(
      "INVALID_ROOT",
      `cannot inspect provenance file: ${relativePath}`,
      { cause: error },
    );
  }
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new ProvenanceError(
        "INVALID_ROOT",
        `provenance path is not a regular file: ${relativePath}`,
      );
    }
    let openedPath: string;
    try {
      openedPath = readlinkSync(`/proc/self/fd/${descriptor}`);
    } catch {
      openedPath = realpathSync(absolute);
    }
    if (
      openedPath.endsWith(" (deleted)") ||
      (openedPath !== realRoot && !openedPath.startsWith(`${realRoot}${sep}`))
    ) {
      throw new ProvenanceError(
        "SYMLINK_NOT_ALLOWED",
        `provenance path changed while being opened: ${relativePath}`,
      );
    }
    const bytes = readFileSync(descriptor);
    for (const secret of forbiddenSecrets) {
      if (secret.length > 0 && bytes.includes(Buffer.from(secret, "utf8"))) {
        throw new ProvenanceError(
          "SECRET_DETECTED",
          `forbidden secret material is present in ${relativePath}`,
        );
      }
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function walkDirectory(
  root: string,
  directory: string,
): readonly string[] {
  assertSafeRelativePath(directory);
  assertNoForbiddenSegment(directory);
  assertNoSymlinkComponents(root, directory);
  const absolute = join(root, directory);
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch (error) {
    if (isEnoent(error)) {
      throw new ProvenanceError(
        "MISSING_FILE",
        `required provenance directory is missing: ${directory}`,
        { cause: error },
      );
    }
    throw new ProvenanceError(
      "INVALID_ROOT",
      `cannot inspect provenance directory: ${directory}`,
      { cause: error },
    );
  }
  if (stats.isSymbolicLink()) {
    throw new ProvenanceError(
      "SYMLINK_NOT_ALLOWED",
      `provenance directory is a symbolic link: ${directory}`,
    );
  }
  if (!stats.isDirectory()) {
    throw new ProvenanceError(
      "INVALID_ROOT",
      `provenance path is not a directory: ${directory}`,
    );
  }
  const entries = readdirSync(absolute, { withFileTypes: true }).sort(
    (left, right) => compareStrings(left.name, right.name),
  );
  const paths: string[] = [];
  for (const entry of entries) {
    const child = `${directory}/${entry.name}`;
    assertSafeRelativePath(child);
    assertNoForbiddenSegment(child);
    if (entry.isSymbolicLink()) {
      throw new ProvenanceError(
        "SYMLINK_NOT_ALLOWED",
        `provenance path uses a symbolic link: ${child}`,
      );
    }
    if (entry.isDirectory()) {
      paths.push(...walkDirectory(root, child));
    } else if (entry.isFile()) {
      paths.push(child);
    } else {
      throw new ProvenanceError(
        "INVALID_ROOT",
        `unsupported provenance file type: ${child}`,
      );
    }
  }
  return paths;
}

function toPublicFile(file: CollectedFile): ProvenanceFile {
  return {
    path: file.path,
    category: file.category,
    sha256: file.sha256,
    byteLength: file.byteLength,
  };
}

function hashFileEntries(files: readonly ProvenanceFile[]): string {
  return hashCanonicalJson(
    [...files]
      .map(({ path, category, sha256, byteLength }) => ({
        path,
        category,
        sha256,
        byteLength,
      }))
      .sort((left, right) => compareStrings(left.path, right.path)),
  );
}

function collectProvenanceFiles(
  options: ProvenanceVerifyOptions,
): CollectedProvenance {
  const root = resolve(options.rootDirectory);
  assertRootDirectory(root);
  const forbiddenSecrets = options.forbiddenSecrets ?? [];
  const paths: Array<{ path: string; category: ProvenanceFileCategory }> = [];
  const seen = new Set<string>();

  const add = (path: string, category: ProvenanceFileCategory): void => {
    if (seen.has(path)) {
      throw new ProvenanceError(
        "INVALID_SNAPSHOT",
        `duplicate provenance path: ${path}`,
      );
    }
    seen.add(path);
    paths.push({ path, category });
  };

  for (const sourceRoot of SOURCE_ROOTS) {
    for (const path of walkDirectory(root, sourceRoot)) {
      if (path === PROMPT_ROOT || path.startsWith(`${PROMPT_ROOT}/`)) {
        continue;
      }
      add(path, "source");
    }
  }
  for (const path of walkDirectory(root, PROMPT_ROOT)) {
    add(path, "prompt");
  }
  for (const path of PROVENANCE_CONFIG_FILES) {
    add(path, "config");
  }
  add(PROVENANCE_FONT_PATH, "font");
  add(PROVENANCE_LICENSE_PATH, "license");

  for (const required of REQUIRED_PROMPT_FILES) {
    if (!seen.has(required)) {
      throw new ProvenanceError(
        "MISSING_FILE",
        `required prompt asset is missing: ${required}`,
      );
    }
  }

  paths.sort((left, right) => compareStrings(left.path, right.path));
  const files = paths.map((entry) => {
    const bytes = readRegularFile(root, entry.path, forbiddenSecrets);
    return {
      path: entry.path,
      category: entry.category,
      sha256: hashBytes(bytes),
      byteLength: bytes.length,
      bytes,
    };
  });
  const schemas = buildProvenanceSchemas();
  return { files, schemas };
}

function schemaEntry(format: StrictJsonSchema): ProvenanceSchemaEntry {
  return {
    name: format.name,
    strict: format.strict,
    hash: strictSchemaHash(format),
    schema: format.schema,
  };
}

export function buildProvenancePromptHashes(): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const family of FAMILIES) {
    hashes[`spec:${family}`] = specProposalMetadataForFamily(family).promptHash;
  }
  hashes.wording = wordingPromptMetadata().promptHash;
  hashes.blind_text = blindTextPromptMetadata().promptHash;
  hashes.blind_vision = blindVisionPromptMetadata().promptHash;
  hashes.alignment_text = alignmentPromptMetadata("text").promptHash;
  hashes.alignment_vision = alignmentPromptMetadata("svg").promptHash;
  return hashes;
}

export function buildProvenanceSchemaHashes(): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const family of FAMILIES) {
    hashes[`spec:${family}`] = specProposalMetadataForFamily(family).schemaHash;
  }
  hashes.wording = wordingPromptMetadata().schemaHash;
  hashes.blind_text = blindTextPromptMetadata().schemaHash;
  hashes.blind_vision = blindVisionPromptMetadata().schemaHash;
  hashes.alignment_text = alignmentPromptMetadata("text").schemaHash;
  hashes.alignment_vision = alignmentPromptMetadata("svg").schemaHash;
  return hashes;
}

export function buildProvenanceSchemas(): readonly ProvenanceSchemaEntry[] {
  const entries: ProvenanceSchemaEntry[] = [];
  for (const family of FAMILIES) {
    entries.push(schemaEntry(FAMILY_SPEC_JSON_SCHEMAS[family]));
    entries.push(schemaEntry(familySpecEnvelopeJsonSchema(family)));
  }
  entries.push(schemaEntry(WORDING_JSON_SCHEMA));
  entries.push(schemaEntry(BLIND_REVIEW_JSON_SCHEMA));
  entries.push(schemaEntry(ALIGNMENT_REVIEW_JSON_SCHEMA));
  const names = new Set<string>();
  for (const entry of entries) {
    if (names.has(entry.name)) {
      throw new ProvenanceError(
        "INVALID_SNAPSHOT",
        `duplicate strict schema name: ${entry.name}`,
      );
    }
    names.add(entry.name);
  }
  return entries.sort((left, right) =>
    compareStrings(left.name, right.name),
  );
}

function parseNpmVersion(userAgent: string | undefined): string | null {
  if (userAgent === undefined) {
    return null;
  }
  const match = /(?:^|\s)npm\/([^\s]+)/.exec(userAgent);
  return match?.[1] ?? null;
}

function readLockfileVersion(root: string): number | null {
  try {
    const parsed = JSON.parse(
      readRegularFile(root, "package-lock.json", []).toString("utf8"),
    ) as { lockfileVersion?: unknown };
    const value = parsed.lockfileVersion;
    return typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 0
      ? value
      : null;
  } catch {
    return null;
  }
}

function deriveRuntime(root: string): ProvenanceRuntime {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    npm: parseNpmVersion(process.env.npm_config_user_agent),
    lockfileVersion: readLockfileVersion(root),
  };
}

export function readGitInfo(rootDirectory: string): ProvenanceGit | null {
  try {
    const commit = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: rootDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    const status = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=normal"],
      {
        cwd: rootDirectory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      },
    ).trim();
    return {
      commit: /^[0-9a-f]{40,64}$/.test(commit) ? commit : null,
      dirty: status.length > 0,
    };
  } catch {
    return null;
  }
}

export function buildProvenanceSnapshot(
  options: ProvenanceBuildOptions,
): ProvenanceSnapshot {
  const root = resolve(options.rootDirectory);
  const collected = collectProvenanceFiles({
    rootDirectory: root,
    ...(options.forbiddenSecrets === undefined
      ? {}
      : { forbiddenSecrets: options.forbiddenSecrets }),
  });
  const files = collected.files.map(toPublicFile);
  const promptHashes = buildProvenancePromptHashes();
  const schemaHashes = buildProvenanceSchemaHashes();
  const sourceHash = hashFileEntries(
    files.filter((file) => file.category === "source"),
  );
  const configHash = hashFileEntries(
    files.filter((file) => file.category === "config"),
  );
  const font = files.find((file) => file.path === PROVENANCE_FONT_PATH);
  const license = files.find((file) => file.path === PROVENANCE_LICENSE_PATH);
  const lockfile = files.find((file) => file.path === "package-lock.json");
  if (font === undefined || license === undefined || lockfile === undefined) {
    throw new ProvenanceError(
      "MISSING_FILE",
      "font, license, or dependency lockfile is missing from the provenance allowlist",
    );
  }
  const runtime = options.runtime ?? deriveRuntime(root);
  const git = options.git === undefined ? readGitInfo(root) : options.git;
  const promptBundleHash = hashCanonicalJson(promptHashes);
  const schemaBundleHash = hashCanonicalJson(collected.schemas);
  const hashInput = {
    version: PROVENANCE_VERSION,
    sourceHash,
    promptHashes,
    schemaHashes,
    configHash,
    promptBundleHash,
    schemaBundleHash,
    fontHash: font.sha256,
    licenseHash: license.sha256,
    lockfileHash: lockfile.sha256,
    files,
    schemas: [...collected.schemas],
  };
  return {
    ...hashInput,
    createdAt: (options.clock ?? { now: () => new Date() }).now().toISOString(),
    runtime,
    git,
    archiveHash: hashCanonicalJson(hashInput),
  };
}

function sameRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort(compareStrings);
  const rightKeys = Object.keys(right).sort(compareStrings);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && left[key] === right[key],
    )
  );
}

function verifySnapshotHash(snapshot: ProvenanceSnapshot): boolean {
  const hashInput = Object.fromEntries(
    Object.entries(snapshot).filter(
      ([key]) =>
        key !== "archiveHash" &&
        key !== "createdAt" &&
        key !== "runtime" &&
        key !== "git",
    ),
  );
  return hashCanonicalJson(hashInput) === snapshot.archiveHash;
}

function fileByPath(
  files: readonly ProvenanceFile[],
  path: string,
): ProvenanceFile | null {
  return files.find((file) => file.path === path) ?? null;
}

export function verifyProvenanceSnapshot(
  snapshot: ProvenanceSnapshot,
  options: ProvenanceVerifyOptions,
): ProvenanceVerification {
  const failures: ProvenanceFailure[] = [];
  const parsed = ProvenanceSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    return {
      ok: false,
      failures: [
        {
          code: "INVALID_SNAPSHOT",
          detail: parsed.error.message,
        },
      ],
    };
  }
  const expected = parsed.data;
  if (!verifySnapshotHash(expected)) {
    failures.push({
      code: "ARCHIVE_HASH_MISMATCH",
      detail: "provenance snapshot archive hash is invalid",
    });
  }

  let current: CollectedProvenance;
  try {
    current = collectProvenanceFiles(options);
  } catch (error) {
    if (error instanceof ProvenanceError) {
      return {
        ok: false,
        failures: [
          {
            code:
              error.code === "MISSING_FILE" ||
              error.code === "SYMLINK_NOT_ALLOWED" ||
              error.code === "SECRET_DETECTED" ||
              error.code === "INVALID_ROOT" ||
              error.code === "UNSAFE_PATH"
                ? error.code
                : "INVALID_ROOT",
            detail: error.message,
          },
        ],
      };
    }
    return {
      ok: false,
      failures: [
        {
          code: "INVALID_ROOT",
          detail:
            error instanceof Error
              ? error.message
              : "cannot inspect the current source tree",
        },
      ],
    };
  }

  const expectedFiles = new Map(
    expected.files.map((file) => [file.path, file] as const),
  );
  const currentFiles = new Map(
    current.files.map((file) => [file.path, file] as const),
  );
  for (const [path, file] of expectedFiles) {
    const actual = currentFiles.get(path);
    if (actual === undefined) {
      failures.push({
        code: "MISSING_FILE",
        path,
        detail: `provenance file is missing: ${path}`,
      });
      continue;
    }
    if (
      actual.sha256 !== file.sha256 ||
      actual.byteLength !== file.byteLength ||
      actual.category !== file.category
    ) {
      failures.push({
        code: "MODIFIED_FILE",
        path,
        detail: `provenance file changed: ${path}`,
      });
    }
  }
  for (const path of currentFiles.keys()) {
    if (!expectedFiles.has(path)) {
      failures.push({
        code: "EXTRA_FILE",
        path,
        detail: `unexpected provenance file: ${path}`,
      });
    }
  }

  const currentPublicFiles = current.files.map(toPublicFile);
  const currentPromptHashes = buildProvenancePromptHashes();
  const currentSchemaHashes = buildProvenanceSchemaHashes();
  const currentSourceHash = hashFileEntries(
    currentPublicFiles.filter((file) => file.category === "source"),
  );
  const currentConfigHash = hashFileEntries(
    currentPublicFiles.filter((file) => file.category === "config"),
  );
  if (!sameRecord(expected.promptHashes, currentPromptHashes)) {
    failures.push({
      code: "PROMPT_MISMATCH",
      detail: "prompt hash inventory changed",
    });
  }
  if (!sameRecord(expected.schemaHashes, currentSchemaHashes)) {
    failures.push({
      code: "SCHEMA_MISMATCH",
      detail: "strict schema hash inventory changed",
    });
  }
  if (currentSourceHash !== expected.sourceHash) {
    failures.push({
      code: "SOURCE_MISMATCH",
      detail: "source hash changed",
    });
  }
  if (currentConfigHash !== expected.configHash) {
    failures.push({
      code: "CONFIG_MISMATCH",
      detail: "configuration/lockfile hash changed",
    });
  }
  const font = fileByPath(currentPublicFiles, PROVENANCE_FONT_PATH);
  const license = fileByPath(currentPublicFiles, PROVENANCE_LICENSE_PATH);
  const lockfile = fileByPath(currentPublicFiles, "package-lock.json");
  if (font?.sha256 !== expected.fontHash) {
    failures.push({
      code: "FONT_MISMATCH",
      detail: "pinned font hash changed",
    });
  }
  if (license?.sha256 !== expected.licenseHash) {
    failures.push({
      code: "LICENSE_MISMATCH",
      detail: "font license hash changed",
    });
  }
  if (lockfile?.sha256 !== expected.lockfileHash) {
    failures.push({
      code: "LOCKFILE_MISMATCH",
      detail: "dependency lockfile hash changed",
    });
  }
  if (hashCanonicalJson(current.schemas) !== expected.schemaBundleHash) {
    failures.push({
      code: "SCHEMA_MISMATCH",
      detail: "strict schema bundle hash changed",
    });
  }
  return { ok: failures.length === 0, failures };
}

export function resolveProvenanceArchivePath(
  archiveDirectory: string,
  relativePath: string,
): string {
  assertSafeRelativePath(relativePath);
  const root = resolve(archiveDirectory);
  let rootStats;
  try {
    rootStats = lstatSync(root);
  } catch (error) {
    if (!isEnoent(error)) {
      throw new ProvenanceError(
        "UNSAFE_PATH",
        `cannot inspect provenance archive root: ${root}`,
        { cause: error },
      );
    }
    rootStats = null;
  }
  if (rootStats !== null && rootStats.isSymbolicLink()) {
    throw new ProvenanceError(
      "UNSAFE_PATH",
      `provenance archive root is a symbolic link: ${root}`,
    );
  }
  const resolved = resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new ProvenanceError(
      "UNSAFE_PATH",
      `provenance archive path escapes the archive root: ${relativePath}`,
    );
  }
  assertNoSymlinkComponents(root, relativePath);
  return resolved;
}

function archivePaths(
  directory: string,
  files: readonly ProvenanceFile[],
): WrittenProvenanceArchive {
  return {
    directory,
    manifestPath: join(directory, "manifest.json"),
    schemasPath: join(directory, "schemas.json"),
    files: files.map((file) => join(directory, "files", ...file.path.split("/"))),
  };
}

export function readProvenanceArchive(
  archiveDirectory: string,
): ProvenanceSnapshot {
  const directory = resolve(archiveDirectory);
  const manifestPath = resolveProvenanceArchivePath(directory, "manifest.json");
  let manifestText: string;
  try {
    manifestText = readRegularFile(directory, "manifest.json", []).toString(
      "utf8",
    );
  } catch (error) {
    throw new ProvenanceError(
      "ARCHIVE_INTEGRITY",
      `cannot read provenance manifest: ${manifestPath}`,
      { cause: error },
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(manifestText);
  } catch (error) {
    throw new ProvenanceError(
      "INVALID_MANIFEST",
      "provenance manifest is not valid JSON",
      { cause: error },
    );
  }
  const parsed = ProvenanceSnapshotSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new ProvenanceError(
      "INVALID_MANIFEST",
      `provenance manifest is invalid: ${parsed.error.message}`,
    );
  }
  const snapshot = parsed.data;
  if (!verifySnapshotHash(snapshot)) {
    throw new ProvenanceError(
      "ARCHIVE_INTEGRITY",
      "provenance manifest archive hash does not match its contents",
    );
  }
  const schemasPath = resolveProvenanceArchivePath(directory, "schemas.json");
  let schemaBytes: Buffer;
  try {
    schemaBytes = readRegularFile(directory, "schemas.json", []);
  } catch (error) {
    throw new ProvenanceError(
      "ARCHIVE_INTEGRITY",
      `provenance archive is missing schemas.json: ${schemasPath}`,
      { cause: error },
    );
  }
  if (hashBytes(schemaBytes) !== snapshot.schemaBundleHash) {
    throw new ProvenanceError(
      "ARCHIVE_INTEGRITY",
      "provenance schemas.json does not match the schema bundle hash",
    );
  }
  let schemaJson: unknown;
  try {
    schemaJson = JSON.parse(schemaBytes.toString("utf8"));
  } catch (error) {
    throw new ProvenanceError(
      "ARCHIVE_INTEGRITY",
      "provenance schemas.json is not valid JSON",
      { cause: error },
    );
  }
  const archivedSchemas = ProvenanceSchemaEntrySchema.array().safeParse(schemaJson);
  if (!archivedSchemas.success) {
    throw new ProvenanceError(
      "ARCHIVE_INTEGRITY",
      `provenance schemas.json is invalid: ${archivedSchemas.error.message}`,
    );
  }
  if (hashCanonicalJson(archivedSchemas.data) !== snapshot.schemaBundleHash) {
    throw new ProvenanceError(
      "ARCHIVE_INTEGRITY",
      "provenance schemas.json content does not match the schema bundle hash",
    );
  }
  for (const file of snapshot.files) {
    let bytes: Buffer;
    try {
      bytes = readRegularFile(directory, `files/${file.path}`, []);
    } catch (error) {
      throw new ProvenanceError(
        "ARCHIVE_INTEGRITY",
        `provenance archive is missing or unsafe: ${file.path}`,
        { cause: error },
      );
    }
    if (
      bytes.length !== file.byteLength ||
      hashBytes(bytes) !== file.sha256
    ) {
      throw new ProvenanceError(
        "ARCHIVE_INTEGRITY",
        `provenance archive file failed integrity check: ${file.path}`,
      );
    }
  }
  let archivedFiles: readonly string[];
  try {
    archivedFiles = walkDirectory(directory, "files");
  } catch (error) {
    throw new ProvenanceError(
      "ARCHIVE_INTEGRITY",
      "provenance archive files/ tree is missing or invalid",
      { cause: error },
    );
  }
  const expectedPaths = snapshot.files
    .map((file) => `files/${file.path}`)
    .sort(compareStrings);
  const actualPaths = [...archivedFiles].sort(compareStrings);
  if (
    expectedPaths.length !== actualPaths.length ||
    expectedPaths.some((path, index) => path !== actualPaths[index])
  ) {
    throw new ProvenanceError(
      "ARCHIVE_INTEGRITY",
      "provenance archive contains extra or missing files",
    );
  }
  return snapshot;
}

export function writeProvenanceArchive(
  snapshot: ProvenanceSnapshot,
  options: WriteProvenanceArchiveOptions,
): WrittenProvenanceArchive {
  const verification = verifyProvenanceSnapshot(snapshot, {
    rootDirectory: options.rootDirectory,
  });
  if (!verification.ok) {
    throw new ProvenanceError(
      "INVALID_SNAPSHOT",
      `cannot archive a snapshot that does not match the source tree: ${verification.failures
        .map((failure) => failure.detail)
        .join("; ")}`,
    );
  }
  const directory = resolve(options.archiveDirectory);
  if (existsSync(directory)) {
    let existing: ProvenanceSnapshot;
    try {
      existing = readProvenanceArchive(directory);
    } catch (error) {
      throw new ProvenanceError(
        "ARCHIVE_CONFLICT",
        `existing provenance archive is invalid or incomplete: ${directory}`,
        { cause: error },
      );
    }
    if (existing.archiveHash !== snapshot.archiveHash) {
      throw new ProvenanceError(
        "ARCHIVE_CONFLICT",
        `existing provenance archive has a different snapshot: ${directory}`,
      );
    }
    return archivePaths(directory, snapshot.files);
  }

  const parent = dirname(directory);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, ".provenance-"));
  try {
    for (const file of snapshot.files) {
      const bytes = readRegularFile(options.rootDirectory, file.path, []);
      if (bytes.length !== file.byteLength || hashBytes(bytes) !== file.sha256) {
        throw new ProvenanceError(
          "INVALID_SNAPSHOT",
          `source file changed while archiving: ${file.path}`,
        );
      }
      const destination = resolveProvenanceArchivePath(
        staging,
        `files/${file.path}`,
      );
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
    }
    const schemasText = canonicalJson(snapshot.schemas);
    if (hashCanonicalJson(snapshot.schemas) !== snapshot.schemaBundleHash) {
      throw new ProvenanceError(
        "INVALID_SNAPSHOT",
        "snapshot schema bundle hash does not match the schema content",
      );
    }
    writeFileSync(
      resolveProvenanceArchivePath(staging, "schemas.json"),
      schemasText,
    );
    writeFileSync(
      resolveProvenanceArchivePath(staging, "manifest.json"),
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );
    renameSync(staging, directory);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return archivePaths(directory, snapshot.files);
}

export function provenanceEvidenceFromSnapshot(
  snapshot: ProvenanceSnapshot,
): ProvenanceEvidence {
  return provenanceConfigurationFromSnapshot(snapshot);
}

export function provenanceConfigurationFromSnapshot(
  snapshot: ProvenanceSnapshot,
): ProvenanceEvidence {
  return {
    sourceHash: snapshot.sourceHash,
    promptHashes: snapshot.promptHashes,
    schemaHashes: snapshot.schemaHashes,
    configHash: snapshot.configHash,
  };
}

export function createSourceProvenanceProvider(
  options: ProvenanceBuildOptions,
): LoadedProvenance {
  const snapshot = buildProvenanceSnapshot(options);
  return {
    snapshot,
    provider: () => provenanceEvidenceFromSnapshot(snapshot),
    verification: { ok: true, failures: [] },
  };
}

export function createProvenanceProviderFromArchive(
  options: LoadProvenanceProviderOptions,
): LoadedProvenance {
  const snapshot = readProvenanceArchive(options.archiveDirectory);
  const verification = verifyProvenanceSnapshot(snapshot, options);
  return {
    snapshot,
    provider: () => {
      if (!verification.ok) {
        throw new ProvenanceError(
          "ARCHIVE_INTEGRITY",
          "provenance archive does not match the current source tree",
        );
      }
      return provenanceEvidenceFromSnapshot(snapshot);
    },
    verification,
  };
}

export interface ProvenanceSummary {
  readonly archiveHash: string;
  readonly sourceHash: string;
  readonly configHash: string;
  readonly promptBundleHash: string;
  readonly schemaBundleHash: string;
  readonly fontHash: string;
  readonly licenseHash: string;
  readonly lockfileHash: string;
  readonly createdAt: string;
  readonly fileCount: number;
  readonly filesByCategory: Readonly<Record<ProvenanceFileCategory, number>>;
  readonly promptFileCount: number;
  readonly promptHashCount: number;
  readonly schemaCount: number;
  readonly schemaHashCount: number;
  readonly runtime: ProvenanceRuntime;
  readonly git: ProvenanceGit | null;
}

export function summarizeProvenanceSnapshot(
  snapshot: ProvenanceSnapshot,
): ProvenanceSummary {
  const filesByCategory: Record<ProvenanceFileCategory, number> = {
    source: 0,
    prompt: 0,
    config: 0,
    font: 0,
    license: 0,
  };
  for (const file of snapshot.files) {
    filesByCategory[file.category] += 1;
  }
  return {
    archiveHash: snapshot.archiveHash,
    sourceHash: snapshot.sourceHash,
    configHash: snapshot.configHash,
    promptBundleHash: snapshot.promptBundleHash,
    schemaBundleHash: snapshot.schemaBundleHash,
    fontHash: snapshot.fontHash,
    licenseHash: snapshot.licenseHash,
    lockfileHash: snapshot.lockfileHash,
    createdAt: snapshot.createdAt,
    fileCount: snapshot.files.length,
    filesByCategory,
    promptFileCount: filesByCategory.prompt,
    promptHashCount: Object.keys(snapshot.promptHashes).length,
    schemaCount: snapshot.schemas.length,
    schemaHashCount: Object.keys(snapshot.schemaHashes).length,
    runtime: snapshot.runtime,
    git: snapshot.git,
  };
}
