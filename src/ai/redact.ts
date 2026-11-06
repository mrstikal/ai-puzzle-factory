export const REDACTED = "[REDACTED]";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "api_key",
  "apikey",
  "openrouter_api_key",
  "x-api-key",
]);

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

export function redactText(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join(REDACTED);
    }
  }
  return redacted;
}

export function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return redactText(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secrets));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        isSensitiveKey(key) ? REDACTED : redactValue(item, secrets),
      ]),
    );
  }
  return value;
}

export function redactHeaders(
  headers: Readonly<Record<string, string>>,
  secrets: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      isSensitiveKey(key) ? REDACTED : redactText(value, secrets),
    ]),
  );
}

export function containsSecret(value: unknown, secrets: readonly string[]): boolean {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return false;
  }
  return secrets.some((secret) => secret.length > 0 && serialized.includes(secret));
}

export function assertNoSecrets(value: unknown, secrets: readonly string[]): void {
  if (containsSecret(value, secrets)) {
    throw new Error("credential material is present in persisted or logged data");
  }
}
