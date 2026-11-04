import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(projectRoot, "src", "storage", "migrations");
const destination = join(projectRoot, "dist", "storage", "migrations");

mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true });

const assetsSource = join(projectRoot, "assets");
const assetsDestination = join(projectRoot, "dist", "assets");
mkdirSync(assetsDestination, { recursive: true });
cpSync(assetsSource, assetsDestination, { recursive: true });
