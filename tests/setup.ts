import http from "node:http";
import https from "node:https";
import net from "node:net";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const allowedTargets = new Set<string>();
let installed = false;

export class NetworkAccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkAccessDeniedError";
  }
}

function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isLoopback(host: string): boolean {
  const normalized = normalizeHost(host);
  return LOOPBACK_HOSTNAMES.has(normalized) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

function targetKey(host: string, port: number | string | undefined, fallbackPort: number): string {
  const numericPort = port === undefined || port === "" ? fallbackPort : Number(port);
  return `${normalizeHost(host)}:${numericPort}`;
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function denyNonLoopback(host: string): never {
  throw new NetworkAccessDeniedError(
    `Network access denied by test guard: non-loopback host ${normalizeHost(host)}`,
  );
}

function denyUnregistered(key: string): never {
  throw new NetworkAccessDeniedError(
    `Network access denied by test guard: loopback target ${key} is not registered as a local fake`,
  );
}

function urlKey(url: URL): string {
  const fallbackPort = url.protocol === "https:" ? 443 : 80;
  return targetKey(url.hostname, url.port, fallbackPort);
}

function assertUrlAllowed(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return;
  }
  if (!isLoopback(url.hostname)) {
    denyNonLoopback(url.hostname);
  }
  const key = urlKey(url);
  if (!allowedTargets.has(key)) {
    denyUnregistered(key);
  }
}

function assertSocketAllowed(host: string, port: number): void {
  if (!isLoopback(host)) {
    denyNonLoopback(host);
  }
  const key = targetKey(host, port, port);
  if (!allowedTargets.has(key)) {
    denyUnregistered(key);
  }
}

export function allowLocalFake(target: string | URL): string {
  const url = typeof target === "string" ? safeUrl(target) : target;
  if (url === undefined) {
    throw new Error(`Cannot register local fake: invalid URL ${String(target)}`);
  }
  if (!isLoopback(url.hostname)) {
    throw new Error(`Cannot register local fake: ${url.hostname} is not a loopback host`);
  }
  const key = urlKey(url);
  allowedTargets.add(key);
  return key;
}

export function clearLocalFakes(): void {
  allowedTargets.clear();
}

function splitHostPort(value: string): { host: string; port: string | undefined } {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end > 0) {
      const rest = trimmed.slice(end + 1);
      return {
        host: trimmed.slice(1, end),
        port: rest.startsWith(":") ? rest.slice(1) : undefined,
      };
    }
  }
  const first = trimmed.indexOf(":");
  const last = trimmed.lastIndexOf(":");
  if (first !== -1 && first === last) {
    return { host: trimmed.slice(0, first), port: trimmed.slice(first + 1) };
  }
  return { host: trimmed, port: undefined };
}

function extractSocketTarget(args: readonly unknown[]): { host: string; port: number } | undefined {
  const rawFirst = args[0];
  const first: unknown = Array.isArray(rawFirst) ? (rawFirst as unknown[])[0] : rawFirst;
  if (typeof first === "number") {
    const host = typeof args[1] === "string" ? args[1] : "localhost";
    return { host, port: first };
  }
  if (typeof first === "string") {
    const port = Number(first);
    if (first.trim() === "" || !Number.isFinite(port) || port < 0) {
      return undefined;
    }
    const host = typeof args[1] === "string" ? args[1] : "localhost";
    return { host, port };
  }
  if (typeof first !== "object" || first === null) {
    return undefined;
  }
  const options = first as Record<string, unknown>;
  if (typeof options.path === "string" && options.path !== "") {
    return undefined;
  }
  const rawHost =
    typeof options.hostname === "string"
      ? options.hostname
      : typeof options.host === "string"
        ? options.host
        : "localhost";
  const split = splitHostPort(rawHost);
  const portValue = options.port ?? split.port;
  const port = typeof portValue === "number" ? portValue : Number(portValue);
  return { host: split.host, port: Number.isNaN(port) ? 0 : port };
}

function extractUrl(args: readonly unknown[]): URL | undefined {
  const first = args[0];
  if (typeof first === "string") {
    return safeUrl(first);
  }
  if (first instanceof URL) {
    return first;
  }
  if (typeof first !== "object" || first === null) {
    return undefined;
  }
  const options = first as Record<string, unknown>;
  const hostname =
    typeof options.hostname === "string"
      ? options.hostname
      : typeof options.host === "string"
        ? splitHostPort(options.host).host
        : undefined;
  if (hostname === undefined || hostname === "") {
    return undefined;
  }
  const protocol = typeof options.protocol === "string" ? options.protocol : "http:";
  const port =
    typeof options.port === "number" || typeof options.port === "string"
      ? String(options.port)
      : "";
  const hostPart = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return safeUrl(`${protocol}//${hostPart}${port === "" ? "" : `:${port}`}/`);
}

function guardCallable<T extends (...args: never[]) => unknown>(original: T): T {
  return function patched(this: unknown, ...args: unknown[]): unknown {
    const target = extractUrl(args);
    if (target !== undefined) {
      assertUrlAllowed(target);
    }
    return Reflect.apply(original, this, args);
  } as unknown as T;
}

function resolveFetchUrl(input: Parameters<typeof fetch>[0]): URL | undefined {
  if (typeof input === "string") {
    return safeUrl(input);
  }
  if (input instanceof URL) {
    return input;
  }
  if (typeof input === "object" && input !== null && "url" in input) {
    const value = (input as { url: unknown }).url;
    return typeof value === "string" ? safeUrl(value) : undefined;
  }
  return undefined;
}

export function installNetworkGuard(): void {
  if (installed) {
    return;
  }
  installed = true;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function guardedFetch(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> {
    const target = resolveFetchUrl(input);
    if (target !== undefined) {
      assertUrlAllowed(target);
    }
    return originalFetch(input, init);
  } as typeof fetch;

  const mutableHttp = http as unknown as {
    request: typeof http.request;
    get: typeof http.get;
  };
  mutableHttp.request = guardCallable(mutableHttp.request);
  mutableHttp.get = guardCallable(mutableHttp.get);

  const mutableHttps = https as unknown as {
    request: typeof https.request;
    get: typeof https.get;
  };
  mutableHttps.request = guardCallable(mutableHttps.request);
  mutableHttps.get = guardCallable(mutableHttps.get);

  const originalSocketConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patchedSocketConnect(
    this: net.Socket,
    ...args: unknown[]
  ): net.Socket {
    const target = extractSocketTarget(args);
    if (target !== undefined) {
      assertSocketAllowed(target.host, target.port);
    }
    return Reflect.apply(originalSocketConnect, this, args) as net.Socket;
  } as typeof net.Socket.prototype.connect;
}

installNetworkGuard();
