import { readFileSync } from "node:fs";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "../util/hash.js";

export const DESIGNER_ROUTING_POLICY = "balanced" as const;
export const ROUTING_CONFIRMATION_MAX_AGE_MS = 30 * 60 * 1000;

export const RoutingConfirmationSchema = z
  .strictObject({
    operator: z.string().min(1).max(200),
    checkedAt: z.iso.datetime(),
    routingPolicy: z.literal(DESIGNER_ROUTING_POLICY),
    providerSort: z.enum(["default", "balanced"]).nullable(),
    byokProviderKeysConfigured: z.literal(false),
  })
  .superRefine((confirmation, ctx) => {
    if (
      confirmation.providerSort !== null &&
      confirmation.providerSort !== "default" &&
      confirmation.providerSort !== "balanced"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["providerSort"],
        message: "provider sort must be unset/default Balanced",
      });
    }
  });
export type RoutingConfirmation = z.infer<typeof RoutingConfirmationSchema>;

export class RoutingConfirmationError extends Error {
  readonly code:
    | "INVALID_CONFIRMATION"
    | "CONFLICTING_SORT"
    | "BYOK_CONFIGURED"
    | "STALE_CONFIRMATION";

  constructor(
    code: RoutingConfirmationError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RoutingConfirmationError";
    this.code = code;
    this.message = message;
  }
}

export function parseRoutingConfirmation(value: unknown): RoutingConfirmation {
  const parsed = RoutingConfirmationSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") ?? "<confirmation>";
    if (path === "byokProviderKeysConfigured") {
      throw new RoutingConfirmationError(
        "BYOK_CONFIGURED",
        "BYOK provider keys must not be configured for designer runs",
        { cause: parsed.error },
      );
    }
    if (path === "providerSort") {
      throw new RoutingConfirmationError(
        "CONFLICTING_SORT",
        "provider sort must be unset/default Balanced",
        { cause: parsed.error },
      );
    }
    throw new RoutingConfirmationError(
      "INVALID_CONFIRMATION",
      `routing confirmation is invalid at ${path}: ${issue?.message ?? "unknown issue"}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

export function readRoutingConfirmationFile(path: string): RoutingConfirmation {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new RoutingConfirmationError(
      "INVALID_CONFIRMATION",
      `cannot read routing confirmation ${path}`,
      { cause: error },
    );
  }
  return parseRoutingConfirmation(value);
}

export function assertRoutingConfirmationFresh(
  confirmation: RoutingConfirmation,
  now: Date,
  maxAgeMs: number = ROUTING_CONFIRMATION_MAX_AGE_MS,
): void {
  const checked = Date.parse(confirmation.checkedAt);
  if (!Number.isFinite(checked)) {
    throw new RoutingConfirmationError(
      "INVALID_CONFIRMATION",
      "routing confirmation timestamp is invalid",
    );
  }
  if (checked > now.getTime() + 60_000) {
    throw new RoutingConfirmationError(
      "INVALID_CONFIRMATION",
      "routing confirmation timestamp is in the future",
    );
  }
  if (now.getTime() - checked > maxAgeMs) {
    throw new RoutingConfirmationError(
      "STALE_CONFIRMATION",
      "routing confirmation is stale; confirm the account routing settings again",
    );
  }
}

export function computeRoutingConfirmationHash(
  confirmation: RoutingConfirmation,
): string {
  return sha256Hex(canonicalJson(confirmation));
}
