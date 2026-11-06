import { resolve } from "node:path";
import { config } from "dotenv";

let loaded = false;

export interface LoadLocalEnvOptions {
  readonly rootDirectory?: string;
  readonly skipInTests?: boolean;
}

export function loadLocalEnv(options: LoadLocalEnvOptions = {}): void {
  if (loaded) {
    return;
  }
  if (
    options.skipInTests !== false &&
    (process.env.VITEST === "true" || process.env.NODE_ENV === "test")
  ) {
    loaded = true;
    return;
  }
  const root = options.rootDirectory ?? process.cwd();
  for (const file of [".env.local", ".env"]) {
    config({ path: resolve(root, file), override: false, quiet: true });
  }
  loaded = true;
}
