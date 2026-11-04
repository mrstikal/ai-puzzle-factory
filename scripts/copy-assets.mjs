import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(projectRoot, "src", "storage", "migrations");
const destination = join(projectRoot, "dist", "storage", "migrations");

mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true });
