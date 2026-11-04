import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { lock } from "proper-lockfile";

export type StorageErrorCode =
  | "INVALID_INPUT"
  | "INVALID_STORED_DATA"
  | "NOT_FOUND"
  | "DUPLICATE_RUN"
  | "DUPLICATE_STAGE"
  | "STAGE_ORDER"
  | "ARTIFACT_TOO_LARGE"
  | "ARTIFACT_CONFLICT"
  | "UNSAFE_PATH"
  | "WRITER_LOCKED"
  | "MIGRATION_FAILED"
  | "CONSTRAINT_VIOLATION";

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
    this.code = code;
  }
}

export interface WriterLockOptions {
  readonly onCompromised?: (error: Error) => void;
}

export interface WriterLock {
  release(): Promise<void>;
}

export function openDatabase(filePath: string): Database.Database {
  if (filePath !== ":memory:") {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  return db;
}

export function migrate(db: Database.Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const appliedRows = db.prepare("SELECT version FROM schema_migrations").all() as Array<{
    version: string;
  }>;
  const applied = new Set(appliedRows.map((row) => row.version));
  const migrationsDirectory = fileURLToPath(new URL("./migrations/", import.meta.url));
  const files = readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }
    const sql = readFileSync(join(migrationsDirectory, file), "utf8");
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        file,
        new Date().toISOString(),
      );
    });
    try {
      apply();
    } catch (error) {
      throw new StorageError("MIGRATION_FAILED", `migration ${file} failed`, { cause: error });
    }
  }
}

export function withTransaction<T>(db: Database.Database, operation: () => T): T {
  return db.transaction(operation)();
}

function isLockError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ELOCKED"
  );
}

export async function acquireWriterLock(
  databasePath: string,
  options: WriterLockOptions = {},
): Promise<WriterLock> {
  if (databasePath === ":memory:") {
    throw new StorageError("WRITER_LOCKED", "an in-memory database cannot be writer-locked");
  }
  if (!existsSync(databasePath)) {
    throw new StorageError("NOT_FOUND", `database file does not exist: ${databasePath}`);
  }
  try {
    const release = await lock(databasePath, {
      stale: 30_000,
      update: 10_000,
      retries: 0,
      realpath: false,
      ...(options.onCompromised === undefined
        ? {}
        : { onCompromised: options.onCompromised }),
    });
    return {
      release: async () => {
        await release();
      },
    };
  } catch (error) {
    if (isLockError(error)) {
      throw new StorageError(
        "WRITER_LOCKED",
        `another writer holds the database lock: ${databasePath}`,
        { cause: error },
      );
    }
    throw error;
  }
}
