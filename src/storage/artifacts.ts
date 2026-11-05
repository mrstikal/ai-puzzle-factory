import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import { Sha256Schema } from "../domain/experiment.js";
import { StorageError } from "./database.js";

export const ARTIFACT_KINDS = [
  "json",
  "svg",
  "png",
  "raw_response",
  "request_body",
  "presentation",
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);

export const ARTIFACT_LIMITS: Readonly<Record<ArtifactKind, number>> = {
  json: 2 * 1024 * 1024,
  svg: 256 * 1024,
  png: 1024 * 1024,
  raw_response: 2 * 1024 * 1024,
  request_body: 2 * 1024 * 1024,
  presentation: 2 * 1024 * 1024,
};

export const ArtifactRecordSchema = z.strictObject({
  artifactId: z.number().int().positive(),
  contentHash: Sha256Schema,
  kind: ArtifactKindSchema,
  mediaType: z.string().min(1).max(128),
  byteLength: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});

export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;

export interface ArtifactInput {
  readonly kind: ArtifactKind;
  readonly mediaType: string;
  readonly bytes: Buffer;
  readonly role: string;
}

export interface ArtifactRow {
  artifact_id: number;
  content_hash: string;
  kind: string;
  media_type: string;
  byte_length: number;
  bytes: Buffer;
  created_at: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function hashArtifactBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateArtifactInput(input: ArtifactInput): void {
  const kind = ArtifactKindSchema.safeParse(input.kind);
  if (!kind.success) {
    throw new StorageError("INVALID_INPUT", `invalid artifact kind: ${String(input.kind)}`);
  }
  if (input.mediaType.trim() === "" || input.mediaType.length > 128) {
    throw new StorageError("INVALID_INPUT", "artifact media type must be 1-128 characters");
  }
  if (input.role.trim() === "" || input.role.length > 64) {
    throw new StorageError("INVALID_INPUT", "artifact role must be 1-64 characters");
  }
  if (!Buffer.isBuffer(input.bytes)) {
    throw new StorageError("INVALID_INPUT", "artifact bytes must be a Buffer");
  }
  const limit = ARTIFACT_LIMITS[input.kind];
  if (input.bytes.length > limit) {
    throw new StorageError(
      "ARTIFACT_TOO_LARGE",
      `${input.kind} artifact is ${input.bytes.length} bytes; limit is ${limit}`,
    );
  }
}

export function artifactRowToRecord(row: ArtifactRow): ArtifactRecord {
  const parsed = ArtifactRecordSchema.safeParse({
    artifactId: row.artifact_id,
    contentHash: row.content_hash,
    kind: row.kind,
    mediaType: row.media_type,
    byteLength: row.byte_length,
    createdAt: row.created_at,
  });
  if (!parsed.success) {
    throw new StorageError("INVALID_STORED_DATA", "stored artifact row is invalid", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export function storeArtifact(
  db: Database.Database,
  input: ArtifactInput,
  createdAt: string = new Date().toISOString(),
): ArtifactRecord {
  validateArtifactInput(input);
  const contentHash = hashArtifactBytes(input.bytes);
  const existing = db
    .prepare(
      "SELECT artifact_id, content_hash, kind, media_type, byte_length, bytes, created_at FROM artifacts WHERE content_hash = ? AND kind = ?",
    )
    .get(contentHash, input.kind) as ArtifactRow | undefined;

  if (existing !== undefined) {
    if (
      existing.media_type !== input.mediaType ||
      existing.byte_length !== input.bytes.length ||
      !existing.bytes.equals(input.bytes)
    ) {
      throw new StorageError(
        "ARTIFACT_CONFLICT",
        `artifact ${contentHash}/${input.kind} already exists with different content metadata`,
      );
    }
    return artifactRowToRecord(existing);
  }

  const result = db
    .prepare(
      "INSERT INTO artifacts (content_hash, kind, media_type, byte_length, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(contentHash, input.kind, input.mediaType, input.bytes.length, input.bytes, createdAt);
  const row = db
    .prepare(
      "SELECT artifact_id, content_hash, kind, media_type, byte_length, bytes, created_at FROM artifacts WHERE artifact_id = ?",
    )
    .get(Number(result.lastInsertRowid)) as ArtifactRow | undefined;
  if (row === undefined) {
    throw new StorageError("INVALID_STORED_DATA", "artifact insert did not return a row");
  }
  return artifactRowToRecord(row);
}

export function getArtifact(
  db: Database.Database,
  contentHash: string,
  kind: ArtifactKind,
): { artifact: ArtifactRecord; bytes: Buffer } {
  if (!Sha256Schema.safeParse(contentHash).success) {
    throw new StorageError("INVALID_INPUT", "artifact content hash must be 64 lowercase hex characters");
  }
  const row = db
    .prepare(
      "SELECT artifact_id, content_hash, kind, media_type, byte_length, bytes, created_at FROM artifacts WHERE content_hash = ? AND kind = ?",
    )
    .get(contentHash, kind) as ArtifactRow | undefined;
  if (row === undefined) {
    throw new StorageError("NOT_FOUND", `artifact not found: ${contentHash}/${kind}`);
  }
  if (
    row.byte_length !== row.bytes.length ||
    hashArtifactBytes(row.bytes) !== row.content_hash
  ) {
    throw new StorageError("INVALID_STORED_DATA", `artifact ${contentHash}/${kind} failed integrity check`);
  }
  return { artifact: artifactRowToRecord(row), bytes: row.bytes };
}

export function getArtifactById(
  db: Database.Database,
  artifactId: number,
): { artifact: ArtifactRecord; bytes: Buffer } {
  if (!Number.isInteger(artifactId) || artifactId <= 0) {
    throw new StorageError("INVALID_INPUT", "artifact id must be a positive integer");
  }
  const row = db
    .prepare(
      "SELECT artifact_id, content_hash, kind, media_type, byte_length, bytes, created_at FROM artifacts WHERE artifact_id = ?",
    )
    .get(artifactId) as ArtifactRow | undefined;
  if (row === undefined) {
    throw new StorageError("NOT_FOUND", `artifact not found: ${artifactId}`);
  }
  if (
    row.byte_length !== row.bytes.length ||
    hashArtifactBytes(row.bytes) !== row.content_hash
  ) {
    throw new StorageError(
      "INVALID_STORED_DATA",
      `artifact ${artifactId} failed integrity check`,
    );
  }
  return { artifact: artifactRowToRecord(row), bytes: row.bytes };
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function assertNoSymlinkComponent(path: string, relativePath: string): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (isEnoent(error)) {
      return;
    }
    throw new StorageError(
      "UNSAFE_PATH",
      `cannot inspect export path component: ${relativePath}`,
      { cause: error },
    );
  }
  if (stats.isSymbolicLink()) {
    throw new StorageError("UNSAFE_PATH", `export path uses a symbolic link: ${relativePath}`);
  }
}

export function resolveExportPath(
  rootDirectory: string,
  runId: string,
  relativePath: string,
): string {
  if (!UUID_PATTERN.test(runId)) {
    throw new StorageError("UNSAFE_PATH", `run ID is not a safe UUID: ${runId}`);
  }
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    isAbsolute(relativePath) ||
    /^[A-Za-z]:/.test(relativePath)
  ) {
    throw new StorageError("UNSAFE_PATH", `unsafe export path: ${relativePath}`);
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new StorageError("UNSAFE_PATH", `unsafe export path: ${relativePath}`);
  }
  const base = resolve(rootDirectory, "runs", runId);
  const resolved = resolve(base, relativePath);
  if (!resolved.startsWith(`${base}${sep}`)) {
    throw new StorageError("UNSAFE_PATH", `export path escapes the run directory: ${relativePath}`);
  }
  assertNoSymlinkComponent(join(rootDirectory, "runs"), relativePath);
  assertNoSymlinkComponent(base, relativePath);
  let current = base;
  for (const segment of segments) {
    current = join(current, segment);
    assertNoSymlinkComponent(current, relativePath);
  }
  return resolved;
}
