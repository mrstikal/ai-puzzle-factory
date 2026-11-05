import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { Decimal } from "decimal.js";
import { z } from "zod";
import { UsdSchema } from "../domain/experiment.js";
import { canonicalJson } from "../util/hash.js";
import { ARTIFACT_LIMITS } from "../storage/artifacts.js";
import { withTransaction } from "../storage/database.js";
import {
  BUDGET_POOLS,
  BudgetPoolSchema,
  LedgerRoleSchema,
  LedgerRunKindSchema,
  getAttempt,
  getLogicalCall,
  type BudgetPool,
  type LedgerRunKind,
  type RequestAttempt,
} from "./ledger.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type BudgetErrorCode =
  | "INVALID_INPUT"
  | "INVALID_STORED_DATA"
  | "NOT_FOUND"
  | "DUPLICATE_ACCOUNT"
  | "DUPLICATE_RESERVATION"
  | "INVALID_STATE"
  | "BUDGET_BUSY"
  | "CAP_CHANGE_UNAUTHORIZED"
  | "CONSTRAINT_VIOLATION";

export class BudgetError extends Error {
  readonly code: BudgetErrorCode;

  constructor(code: BudgetErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BudgetError";
    this.code = code;
  }
}

const ZERO = "0";

export function normalizeUsd(value: string, field: string): string {
  if (!UsdSchema.safeParse(value).success) {
    throw new BudgetError("INVALID_INPUT", `${field} must be a nonnegative decimal string`);
  }
  const decimal = new Decimal(value);
  if (!decimal.isFinite() || decimal.isNegative()) {
    throw new BudgetError("INVALID_INPUT", `${field} must be a nonnegative decimal`);
  }
  return decimal.toFixed();
}

export function addUsd(...values: readonly string[]): string {
  return values.reduce((total, value) => total.plus(value), new Decimal(ZERO)).toFixed();
}

export function subtractUsd(left: string, right: string): string {
  return new Decimal(left).minus(right).toFixed();
}

export function compareUsd(left: string, right: string): number {
  return new Decimal(left).comparedTo(right);
}

export function multiplyUsd(value: string, factor: string): string {
  return new Decimal(value).times(factor).toFixed();
}

function poolForRunKind(runKind: LedgerRunKind): BudgetPool {
  switch (runKind) {
    case "full":
      return "primary";
    case "smoke":
      return "smoke";
    case "calibration":
      return "calibration";
    case "preflight":
      return "preflight";
  }
}

export const BudgetAccountInputSchema = z
  .strictObject({
    accountId: z.string().min(1).max(200).optional(),
    runId: z.uuid().nullable().optional(),
    runKind: LedgerRunKindSchema,
    maxCostUsd: UsdSchema,
    createdAt: z.iso.datetime().optional(),
  })
  .superRefine((input, ctx) => {
    const runId = input.runId ?? null;
    if (
      (input.runKind === "full" || input.runKind === "smoke") &&
      runId === null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["runId"],
        message: "full/smoke budget accounts require a runId",
      });
    }
    if (
      (input.runKind === "calibration" || input.runKind === "preflight") &&
      runId !== null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["runId"],
        message: "calibration/preflight budget accounts are global",
      });
    }
  });

export type BudgetAccountInput = z.infer<typeof BudgetAccountInputSchema>;

export const BudgetAccountSchema = z
  .strictObject({
    accountId: z.string().min(1).max(200),
    runId: z.uuid().nullable(),
    runKind: LedgerRunKindSchema,
    pool: BudgetPoolSchema,
    maxCostUsd: UsdSchema,
    knownActualUsd: UsdSchema,
    reservedUsd: UsdSchema,
    unknownExposureUsd: UsdSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((account, ctx) => {
    if (account.pool !== poolForRunKind(account.runKind)) {
      ctx.addIssue({
        code: "custom",
        path: ["pool"],
        message: "budget account pool does not match its run kind",
      });
    }
  });

export type BudgetAccount = z.infer<typeof BudgetAccountSchema>;

export const RESERVATION_KINDS = ["attempt", "unknown", "nonbilling"] as const;
export type ReservationKind = (typeof RESERVATION_KINDS)[number];
export const ReservationKindSchema = z.enum(RESERVATION_KINDS);

export const RESERVATION_STATES = ["reserved", "unknown", "settled", "released"] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];
export const ReservationStateSchema = z.enum(RESERVATION_STATES);

export const BudgetReservationSchema = z
  .strictObject({
    reservationId: z.uuid(),
    accountId: z.string().min(1).max(200),
    logicalCallId: z.uuid().nullable(),
    attemptId: z.uuid().nullable(),
    kind: ReservationKindSchema,
    state: ReservationStateSchema,
    amountUsd: UsdSchema,
    actualCostUsd: UsdSchema.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((reservation, ctx) => {
    if ((reservation.state === "settled") !== (reservation.actualCostUsd !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["actualCostUsd"],
        message: "only settled reservations carry an actual cost",
      });
    }
  });

export type BudgetReservation = z.infer<typeof BudgetReservationSchema>;

export const AdmissionInputSchema = z
  .strictObject({
    accountId: z.string().min(1).max(200),
    logicalCallId: z.uuid(),
    attemptId: z.uuid(),
    kind: ReservationKindSchema,
    amountUsd: UsdSchema,
    nonBilling: z.boolean().optional(),
    createdAt: z.iso.datetime().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.kind === "nonbilling") {
      if (input.nonBilling !== true) {
        ctx.addIssue({
          code: "custom",
          path: ["nonBilling"],
          message: "nonbilling reservations require nonBilling true",
        });
      }
      if (!new Decimal(input.amountUsd).isZero()) {
        ctx.addIssue({
          code: "custom",
          path: ["amountUsd"],
          message: "nonbilling reservations must reserve zero",
        });
      }
    } else if (input.nonBilling === true) {
      ctx.addIssue({
        code: "custom",
        path: ["nonBilling"],
        message: "only nonbilling reservations may set nonBilling",
      });
    }
  });

export type AdmissionInput = z.infer<typeof AdmissionInputSchema>;

export interface AdmissionAdmitted {
  readonly admitted: true;
  readonly reservation: BudgetReservation;
  readonly account: BudgetAccount;
}

export interface AdmissionPaused {
  readonly admitted: false;
  readonly reason: "INSUFFICIENT_BUDGET" | "RUN_PAUSED" | "ADMISSION_BLOCKED";
  readonly account: BudgetAccount;
}

export type AdmissionResult = AdmissionAdmitted | AdmissionPaused;

export const SettlementInputSchema = z.strictObject({
  reservationId: z.uuid(),
  actualCostUsd: UsdSchema.nullable(),
  createdAt: z.iso.datetime().optional(),
});

export type SettlementInput = z.infer<typeof SettlementInputSchema>;

export const ReleaseInputSchema = z.strictObject({
  reservationId: z.uuid(),
  createdAt: z.iso.datetime().optional(),
});

export type ReleaseInput = z.infer<typeof ReleaseInputSchema>;

export const CapChangeInputSchema = z.strictObject({
  accountId: z.string().min(1).max(200),
  newMaxCostUsd: UsdSchema,
  operator: z.string().min(1).max(200),
  acknowledged: z.boolean(),
  createdAt: z.iso.datetime().optional(),
});

export type CapChangeInput = z.infer<typeof CapChangeInputSchema>;

export const BudgetSummarySchema = z.strictObject({
  accounts: z.array(BudgetAccountSchema),
  byRole: z.array(
    z.strictObject({
      role: z.union([LedgerRoleSchema, z.literal("unattributed")]),
      knownActualUsd: UsdSchema,
      reservedUsd: UsdSchema,
      unknownExposureUsd: UsdSchema,
    }),
  ),
  byRunKind: z.array(
    z.strictObject({
      runKind: z.union([LedgerRunKindSchema, z.literal("unattributed")]),
      knownActualUsd: UsdSchema,
      reservedUsd: UsdSchema,
      unknownExposureUsd: UsdSchema,
    }),
  ),
});

export type BudgetSummary = z.infer<typeof BudgetSummarySchema>;

interface BudgetAccountRow {
  account_id: string;
  run_id: string | null;
  run_kind: string;
  pool: string;
  max_cost_usd: string;
  known_actual_usd: string;
  reserved_usd: string;
  unknown_exposure_usd: string;
  created_at: string;
  updated_at: string;
}

interface BudgetReservationRow {
  reservation_id: string;
  account_id: string;
  logical_call_id: string | null;
  attempt_id: string | null;
  kind: string;
  state: string;
  amount_usd: string;
  actual_cost_usd: string | null;
  created_at: string;
  updated_at: string;
}

interface BudgetEventRow {
  event_id: number;
  account_id: string;
  logical_call_id: string | null;
  attempt_id: string | null;
  event_type: string;
  amount_usd: string | null;
  payload_json: string;
  created_at: string;
}

function parseStored<T>(schema: z.ZodType<T>, value: unknown, context: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BudgetError("INVALID_STORED_DATA", `${context} is invalid`, {
      cause: result.error,
    });
  }
  return result.data;
}

function rowToAccount(row: BudgetAccountRow): BudgetAccount {
  return parseStored(
    BudgetAccountSchema,
    {
      accountId: row.account_id,
      runId: row.run_id,
      runKind: row.run_kind,
      pool: row.pool,
      maxCostUsd: row.max_cost_usd,
      knownActualUsd: row.known_actual_usd,
      reservedUsd: row.reserved_usd,
      unknownExposureUsd: row.unknown_exposure_usd,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    `budget account ${row.account_id}`,
  );
}

function rowToReservation(row: BudgetReservationRow): BudgetReservation {
  return parseStored(
    BudgetReservationSchema,
    {
      reservationId: row.reservation_id,
      accountId: row.account_id,
      logicalCallId: row.logical_call_id,
      attemptId: row.attempt_id,
      kind: row.kind,
      state: row.state,
      amountUsd: row.amount_usd,
      actualCostUsd: row.actual_cost_usd,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    `budget reservation ${row.reservation_id}`,
  );
}

function constraintCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function insertBudgetEvent(
  db: Database.Database,
  input: {
    accountId: string;
    logicalCallId: string | null;
    attemptId: string | null;
    eventType: string;
    amountUsd: string | null;
    payload: unknown;
    createdAt: string;
  },
): void {
  const payloadJson = canonicalJson(input.payload);
  if (Buffer.byteLength(payloadJson, "utf8") > ARTIFACT_LIMITS.json) {
    throw new BudgetError("INVALID_INPUT", "budget event payload exceeds 2 MiB");
  }
  db.prepare(
    "INSERT INTO budget_events (account_id, logical_call_id, attempt_id, event_type, amount_usd, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    input.accountId,
    input.logicalCallId,
    input.attemptId,
    input.eventType,
    input.amountUsd,
    payloadJson,
    input.createdAt,
  );
}

function withImmediateTransaction<T>(
  db: Database.Database,
  operation: () => T,
): T {
  return db.transaction(operation).immediate();
}

function getAccountRow(
  db: Database.Database,
  accountId: string,
): BudgetAccountRow | undefined {
  return db
    .prepare(
      "SELECT account_id, run_id, run_kind, pool, max_cost_usd, known_actual_usd, reserved_usd, unknown_exposure_usd, created_at, updated_at FROM budget_accounts WHERE account_id = ?",
    )
    .get(accountId) as BudgetAccountRow | undefined;
}

function getReservationRow(
  db: Database.Database,
  reservationId: string,
): BudgetReservationRow | undefined {
  return db
    .prepare(
      "SELECT reservation_id, account_id, logical_call_id, attempt_id, kind, state, amount_usd, actual_cost_usd, created_at, updated_at FROM budget_reservations WHERE reservation_id = ?",
    )
    .get(reservationId) as BudgetReservationRow | undefined;
}

function blockAdmissions(
  db: Database.Database,
  account: BudgetAccount,
  reason: string,
  at: string,
): void {
  let previousState: string | null = null;
  if (account.runId !== null) {
    const row = db
      .prepare("SELECT control_state FROM runs WHERE run_id = ?")
      .get(account.runId) as { control_state: string } | undefined;
    previousState = row?.control_state ?? null;
    if (row?.control_state === "running") {
      db.prepare("UPDATE runs SET control_state = 'paused_budget' WHERE run_id = ?").run(
        account.runId,
      );
    }
  }
  insertBudgetEvent(db, {
    accountId: account.accountId,
    logicalCallId: null,
    attemptId: null,
    eventType: "pause",
    amountUsd: null,
    payload: { reason, previousState },
    createdAt: at,
  });
}

export function getBudgetAccount(
  db: Database.Database,
  accountId: string,
): BudgetAccount {
  const row = getAccountRow(db, accountId);
  if (row === undefined) {
    throw new BudgetError("NOT_FOUND", `budget account not found: ${accountId}`);
  }
  return rowToAccount(row);
}

export function createBudgetAccount(
  db: Database.Database,
  input: unknown,
): BudgetAccount {
  const parsed = BudgetAccountInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new BudgetError("INVALID_INPUT", "invalid budget account input", {
      cause: parsed.error,
    });
  }
  const data = parsed.data;
  const runId = data.runId ?? null;
  const pool = poolForRunKind(data.runKind);
  const accountId = data.accountId ?? randomUUID();
  const createdAt = data.createdAt ?? new Date().toISOString();
  const maxCostUsd = normalizeUsd(data.maxCostUsd, "maxCostUsd");

  if (runId !== null) {
    const run = db
      .prepare("SELECT run_kind FROM runs WHERE run_id = ?")
      .get(runId) as { run_kind: string } | undefined;
    if (run === undefined) {
      throw new BudgetError("NOT_FOUND", `run not found: ${runId}`);
    }
    if (run.run_kind !== data.runKind) {
      throw new BudgetError(
        "INVALID_INPUT",
        `run kind ${run.run_kind} does not match budget account kind ${data.runKind}`,
      );
    }
  }

  try {
    withTransaction(db, () => {
      db.prepare(
        "INSERT INTO budget_accounts (account_id, run_id, run_kind, pool, max_cost_usd, known_actual_usd, reserved_usd, unknown_exposure_usd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '0', '0', '0', ?, ?)",
      ).run(accountId, runId, data.runKind, pool, maxCostUsd, createdAt, createdAt);
      insertBudgetEvent(db, {
        accountId,
        logicalCallId: null,
        attemptId: null,
        eventType: "account_created",
        amountUsd: null,
        payload: { runId, runKind: data.runKind, pool, maxCostUsd },
        createdAt,
      });
    });
  } catch (error) {
    const code = constraintCode(error);
    if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      throw new BudgetError(
        "DUPLICATE_ACCOUNT",
        "a budget account already exists for this run/pool",
        { cause: error },
      );
    }
    if (code?.startsWith("SQLITE_CONSTRAINT")) {
      throw new BudgetError("CONSTRAINT_VIOLATION", "budget account constraint failed", {
        cause: error,
      });
    }
    throw error;
  }
  return getBudgetAccount(db, accountId);
}

function assertCallBelongsToAccount(
  db: Database.Database,
  account: BudgetAccount,
  logicalCallId: string,
  attempt: RequestAttempt,
): void {
  const call = getLogicalCall(db, logicalCallId);
  if (attempt.logicalCallId !== call.logicalCallId) {
    throw new BudgetError(
      "INVALID_INPUT",
      "attempt does not belong to the supplied logical call",
    );
  }
  if (account.runId !== null) {
    if (call.runId !== account.runId) {
      throw new BudgetError(
        "INVALID_INPUT",
        "logical call run does not match the budget account run",
      );
    }
    if (call.runKind !== account.runKind || call.pool !== account.pool) {
      throw new BudgetError(
        "INVALID_INPUT",
        "logical call run kind/pool does not match the budget account",
      );
    }
  } else if (call.pool !== account.pool || call.runKind !== account.runKind) {
    throw new BudgetError(
      "INVALID_INPUT",
      "logical call run kind/pool does not match the global budget account",
    );
  }
}

export function admitRequest(
  db: Database.Database,
  input: unknown,
): AdmissionResult {
  const parsed = AdmissionInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new BudgetError("INVALID_INPUT", "invalid budget admission input", {
      cause: parsed.error,
    });
  }
  const data = parsed.data;
  const amountUsd = normalizeUsd(data.amountUsd, "amountUsd");
  const createdAt = data.createdAt ?? new Date().toISOString();
  const nonBilling = data.nonBilling === true;

  try {
    return withImmediateTransaction(db, () => {
      const account = getBudgetAccount(db, data.accountId);
      const attempt = getAttempt(db, data.attemptId);
      assertCallBelongsToAccount(db, account, data.logicalCallId, attempt);

      if (account.runId !== null) {
        const run = db
          .prepare("SELECT control_state FROM runs WHERE run_id = ?")
          .get(account.runId) as { control_state: string } | undefined;
        if (run === undefined) {
          throw new BudgetError("NOT_FOUND", `run not found: ${account.runId}`);
        }
        if (run.control_state !== "running") {
          return { admitted: false, reason: "RUN_PAUSED", account };
        }
      }
      if (!nonBilling) {
        const paused = db
          .prepare(
            "SELECT 1 AS blocked FROM budget_events WHERE account_id = ? AND event_type = 'pause' LIMIT 1",
          )
          .get(account.accountId);
        if (paused !== undefined) {
          return { admitted: false, reason: "ADMISSION_BLOCKED", account };
        }
      }

      if (!nonBilling && account.maxCostUsd === ZERO) {
        blockAdmissions(
          db,
          account,
          "zero budget without a nonbilling transport",
          createdAt,
        );
        return {
          admitted: false,
          reason: "INSUFFICIENT_BUDGET",
          account: getBudgetAccount(db, account.accountId),
        };
      }
      if (!nonBilling) {
        const committed = addUsd(account.knownActualUsd, account.reservedUsd);
        if (compareUsd(addUsd(committed, amountUsd), account.maxCostUsd) > 0) {
          blockAdmissions(db, account, "next reservation would exceed max cost", createdAt);
          return {
            admitted: false,
            reason: "INSUFFICIENT_BUDGET",
            account: getBudgetAccount(db, account.accountId),
          };
        }
      }

      if (nonBilling && amountUsd !== ZERO) {
        throw new BudgetError(
          "INVALID_INPUT",
          "nonbilling reservations must reserve zero",
        );
      }
      const reservationId = randomUUID();
      db.prepare(
        "INSERT INTO budget_reservations (reservation_id, account_id, logical_call_id, attempt_id, kind, state, amount_usd, actual_cost_usd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'reserved', ?, NULL, ?, ?)",
      ).run(
        reservationId,
        account.accountId,
        data.logicalCallId,
        data.attemptId,
        data.kind,
        amountUsd,
        createdAt,
        createdAt,
      );
      if (!nonBilling) {
        const reserved = addUsd(account.reservedUsd, amountUsd);
        const unknown = data.kind === "unknown"
          ? addUsd(account.unknownExposureUsd, amountUsd)
          : account.unknownExposureUsd;
        db.prepare(
          "UPDATE budget_accounts SET reserved_usd = ?, unknown_exposure_usd = ?, updated_at = ? WHERE account_id = ?",
        ).run(reserved, unknown, createdAt, account.accountId);
      }
      insertBudgetEvent(db, {
        accountId: account.accountId,
        logicalCallId: data.logicalCallId,
        attemptId: data.attemptId,
        eventType: nonBilling ? "nonbilling_admission" : "admission",
        amountUsd,
        payload: { kind: data.kind, attemptNumber: attempt.attemptNumber },
        createdAt,
      });
      insertBudgetEvent(db, {
        accountId: account.accountId,
        logicalCallId: data.logicalCallId,
        attemptId: data.attemptId,
        eventType: "reservation_created",
        amountUsd,
        payload: { reservationId, kind: data.kind },
        createdAt,
      });
      const reservationRow = getReservationRow(db, reservationId);
      if (reservationRow === undefined) {
        throw new BudgetError("INVALID_STORED_DATA", "created reservation is missing");
      }
      return {
        admitted: true,
        reservation: rowToReservation(reservationRow),
        account: getBudgetAccount(db, account.accountId),
      };
    });
  } catch (error) {
    if (error instanceof BudgetError) {
      throw error;
    }
    const code = constraintCode(error);
    if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      throw new BudgetError(
        "DUPLICATE_RESERVATION",
        "this attempt already has a budget reservation",
        { cause: error },
      );
    }
    if (code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT") {
      throw new BudgetError(
        "BUDGET_BUSY",
        "budget admission could not acquire the writer lock",
        { cause: error },
      );
    }
    if (code?.startsWith("SQLITE_CONSTRAINT")) {
      throw new BudgetError("CONSTRAINT_VIOLATION", "budget reservation constraint failed", {
        cause: error,
      });
    }
    throw error;
  }
}

export function settleReservation(
  db: Database.Database,
  input: unknown,
): BudgetReservation {
  const parsed = SettlementInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new BudgetError("INVALID_INPUT", "invalid settlement input", {
      cause: parsed.error,
    });
  }
  const data = parsed.data;
  const createdAt = data.createdAt ?? new Date().toISOString();
  const actualCostUsd =
    data.actualCostUsd === null ? null : normalizeUsd(data.actualCostUsd, "actualCostUsd");
  const reservationRow = getReservationRow(db, data.reservationId);
  if (reservationRow === undefined) {
    throw new BudgetError(
      "NOT_FOUND",
      `budget reservation not found: ${data.reservationId}`,
    );
  }
  const reservation = rowToReservation(reservationRow);
  if (reservation.state !== "reserved" && reservation.state !== "unknown") {
    throw new BudgetError(
      "INVALID_STATE",
      `reservation ${reservation.reservationId} is already ${reservation.state}`,
    );
  }
  const account = getBudgetAccount(db, reservation.accountId);

  if (actualCostUsd === null) {
    if (reservation.state === "unknown") {
      return reservation;
    }
    withTransaction(db, () => {
      const alreadyUnknown =
        reservation.kind === "unknown" || reservation.state === "unknown";
      const unknown = alreadyUnknown
        ? account.unknownExposureUsd
        : addUsd(account.unknownExposureUsd, reservation.amountUsd);
      db.prepare(
        "UPDATE budget_accounts SET unknown_exposure_usd = ?, updated_at = ? WHERE account_id = ?",
      ).run(unknown, createdAt, account.accountId);
      db.prepare(
        "UPDATE budget_reservations SET state = 'unknown', updated_at = ? WHERE reservation_id = ?",
      ).run(createdAt, reservation.reservationId);
      insertBudgetEvent(db, {
        accountId: account.accountId,
        logicalCallId: reservation.logicalCallId,
        attemptId: reservation.attemptId,
        eventType: "unknown_exposure",
        amountUsd: reservation.amountUsd,
        payload: { reservationId: reservation.reservationId },
        createdAt,
      });
    });
    return rowToReservation(
      getReservationRow(db, reservation.reservationId) as BudgetReservationRow,
    );
  }

  const overshoot = compareUsd(actualCostUsd, reservation.amountUsd) > 0
    ? subtractUsd(actualCostUsd, reservation.amountUsd)
    : ZERO;
  withTransaction(db, () => {
    const reserved = subtractUsd(account.reservedUsd, reservation.amountUsd);
    const known = addUsd(account.knownActualUsd, actualCostUsd);
    const unknown =
      reservation.state === "unknown" || reservation.kind === "unknown"
        ? subtractUsd(account.unknownExposureUsd, reservation.amountUsd)
        : account.unknownExposureUsd;
    db.prepare(
      "UPDATE budget_accounts SET known_actual_usd = ?, reserved_usd = ?, unknown_exposure_usd = ?, updated_at = ? WHERE account_id = ?",
    ).run(known, reserved, unknown, createdAt, account.accountId);
    db.prepare(
      "UPDATE budget_reservations SET state = 'settled', actual_cost_usd = ?, updated_at = ? WHERE reservation_id = ?",
    ).run(actualCostUsd, createdAt, reservation.reservationId);
    insertBudgetEvent(db, {
      accountId: account.accountId,
      logicalCallId: reservation.logicalCallId,
      attemptId: reservation.attemptId,
      eventType: "reservation_settled",
      amountUsd: actualCostUsd,
      payload: {
        reservationId: reservation.reservationId,
        reservedUsd: reservation.amountUsd,
        actualCostUsd,
        overshootUsd: overshoot,
      },
      createdAt,
    });
    if (overshoot !== ZERO) {
      insertBudgetEvent(db, {
        accountId: account.accountId,
        logicalCallId: reservation.logicalCallId,
        attemptId: reservation.attemptId,
        eventType: "overshoot",
        amountUsd: overshoot,
        payload: { reservationId: reservation.reservationId, actualCostUsd },
        createdAt,
      });
    }
    if (
      overshoot !== ZERO ||
      compareUsd(addUsd(known, reserved), account.maxCostUsd) > 0
    ) {
      blockAdmissions(db, account, "actual cost overshoot or cap breach", createdAt);
    }
  });
  return rowToReservation(
    getReservationRow(db, reservation.reservationId) as BudgetReservationRow,
  );
}

export function releaseReservation(
  db: Database.Database,
  input: unknown,
): BudgetReservation {
  const parsed = ReleaseInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new BudgetError("INVALID_INPUT", "invalid release input", {
      cause: parsed.error,
    });
  }
  const createdAt = parsed.data.createdAt ?? new Date().toISOString();
  const row = getReservationRow(db, parsed.data.reservationId);
  if (row === undefined) {
    throw new BudgetError("NOT_FOUND", `budget reservation not found: ${parsed.data.reservationId}`);
  }
  const reservation = rowToReservation(row);
  if (reservation.state !== "reserved" && reservation.state !== "unknown") {
    throw new BudgetError(
      "INVALID_STATE",
      `reservation ${reservation.reservationId} is already ${reservation.state}`,
    );
  }
  const account = getBudgetAccount(db, reservation.accountId);
  withTransaction(db, () => {
    const reserved = subtractUsd(account.reservedUsd, reservation.amountUsd);
    const unknown =
      reservation.state === "unknown" || reservation.kind === "unknown"
        ? subtractUsd(account.unknownExposureUsd, reservation.amountUsd)
        : account.unknownExposureUsd;
    db.prepare(
      "UPDATE budget_accounts SET reserved_usd = ?, unknown_exposure_usd = ?, updated_at = ? WHERE account_id = ?",
    ).run(reserved, unknown, createdAt, account.accountId);
    db.prepare(
      "UPDATE budget_reservations SET state = 'released', updated_at = ? WHERE reservation_id = ?",
    ).run(createdAt, reservation.reservationId);
    insertBudgetEvent(db, {
      accountId: account.accountId,
      logicalCallId: reservation.logicalCallId,
      attemptId: reservation.attemptId,
      eventType: "reservation_released",
      amountUsd: reservation.amountUsd,
      payload: { reservationId: reservation.reservationId },
      createdAt,
    });
  });
  return rowToReservation(
    getReservationRow(db, reservation.reservationId) as BudgetReservationRow,
  );
}

export function increaseBudgetCap(
  db: Database.Database,
  input: unknown,
): BudgetAccount {
  const parsed = CapChangeInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new BudgetError("INVALID_INPUT", "invalid cap change input", {
      cause: parsed.error,
    });
  }
  const data = parsed.data;
  const account = getBudgetAccount(db, data.accountId);
  const newMax = normalizeUsd(data.newMaxCostUsd, "newMaxCostUsd");
  if (compareUsd(newMax, account.maxCostUsd) <= 0) {
    throw new BudgetError("INVALID_INPUT", "budget cap increase must exceed the current cap");
  }
  if (!data.acknowledged) {
    throw new BudgetError(
      "CAP_CHANGE_UNAUTHORIZED",
      "budget cap increase requires explicit operator acknowledgement",
    );
  }
  const createdAt = data.createdAt ?? new Date().toISOString();
  withTransaction(db, () => {
    db.prepare("UPDATE budget_accounts SET max_cost_usd = ?, updated_at = ? WHERE account_id = ?").run(
      newMax,
      createdAt,
      account.accountId,
    );
    insertBudgetEvent(db, {
      accountId: account.accountId,
      logicalCallId: null,
      attemptId: null,
      eventType: "cap_change",
      amountUsd: newMax,
      payload: {
        oldMaxCostUsd: account.maxCostUsd,
        newMaxCostUsd: newMax,
        operator: data.operator,
        acknowledged: data.acknowledged,
      },
      createdAt,
    });
  });
  return getBudgetAccount(db, account.accountId);
}

interface SummaryAccumulator {
  knownActualUsd: string;
  reservedUsd: string;
  unknownExposureUsd: string;
}

function addToSummary(
  map: Map<string, SummaryAccumulator>,
  key: string,
  known: string,
  reserved: string,
  unknown: string,
): void {
  const current = map.get(key) ?? {
    knownActualUsd: ZERO,
    reservedUsd: ZERO,
    unknownExposureUsd: ZERO,
  };
  map.set(key, {
    knownActualUsd: addUsd(current.knownActualUsd, known),
    reservedUsd: addUsd(current.reservedUsd, reserved),
    unknownExposureUsd: addUsd(current.unknownExposureUsd, unknown),
  });
}

export function getBudgetSummary(db: Database.Database): BudgetSummary {
  const accountRows = db
    .prepare(
      "SELECT account_id, run_id, run_kind, pool, max_cost_usd, known_actual_usd, reserved_usd, unknown_exposure_usd, created_at, updated_at FROM budget_accounts ORDER BY account_id",
    )
    .all() as BudgetAccountRow[];
  const accounts = accountRows.map(rowToAccount);
  const reservationRows = db
    .prepare(
      "SELECT br.reservation_id, br.account_id, br.logical_call_id, br.attempt_id, br.kind, br.state, br.amount_usd, br.actual_cost_usd, br.created_at, br.updated_at, lc.role, lc.run_kind FROM budget_reservations br LEFT JOIN logical_calls lc ON lc.logical_call_id = br.logical_call_id",
    )
    .all() as Array<BudgetReservationRow & { role: string | null; run_kind: string | null }>;
  const byRole = new Map<string, SummaryAccumulator>();
  const byRunKind = new Map<string, SummaryAccumulator>();
  for (const row of reservationRows) {
    const role = row.role ?? "unattributed";
    const runKind = row.run_kind ?? "unattributed";
    let known = ZERO;
    let reserved = ZERO;
    let unknown = ZERO;
    if (row.state === "settled") {
      known = row.actual_cost_usd ?? ZERO;
    } else if (row.state === "reserved") {
      reserved = row.amount_usd;
      if (row.kind === "unknown") {
        unknown = row.amount_usd;
      }
    } else if (row.state === "unknown") {
      reserved = row.amount_usd;
      unknown = row.amount_usd;
    }
    addToSummary(byRole, role, known, reserved, unknown);
    addToSummary(byRunKind, runKind, known, reserved, unknown);
  }
  return BudgetSummarySchema.parse({
    accounts,
    byRole: [...byRole.entries()].map(([role, totals]) => ({ role, ...totals })),
    byRunKind: [...byRunKind.entries()].map(([runKind, totals]) => ({ runKind, ...totals })),
  });
}

export function listBudgetEvents(
  db: Database.Database,
  accountId: string,
): Array<{
  eventId: number;
  accountId: string;
  logicalCallId: string | null;
  attemptId: string | null;
  eventType: string;
  amountUsd: string | null;
  payload: unknown;
  createdAt: string;
}> {
  const rows = db
    .prepare(
      "SELECT event_id, account_id, logical_call_id, attempt_id, event_type, amount_usd, payload_json, created_at FROM budget_events WHERE account_id = ? ORDER BY event_id",
    )
    .all(accountId) as BudgetEventRow[];
  return rows.map((row) => ({
    eventId: row.event_id,
    accountId: row.account_id,
    logicalCallId: row.logical_call_id,
    attemptId: row.attempt_id,
    eventType: row.event_type,
    amountUsd: row.amount_usd,
    payload: JSON.parse(row.payload_json) as unknown,
    createdAt: row.created_at,
  }));
}

export { BUDGET_POOLS };
