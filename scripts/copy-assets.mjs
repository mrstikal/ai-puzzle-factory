import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(projectRoot, "src", "storage", "migrations");
const destination = join(projectRoot, "dist", "storage", "migrations");

mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true });

const promptsSource = join(projectRoot, "src", "ai", "prompts");
const promptsDestination = join(projectRoot, "dist", "ai", "prompts");
mkdirSync(promptsDestination, { recursive: true });
cpSync(promptsSource, promptsDestination, { recursive: true });

const reportingSource = join(projectRoot, "src", "reporting", "assets");
const reportingDestination = join(projectRoot, "dist", "reporting", "assets");
mkdirSync(reportingDestination, { recursive: true });
cpSync(reportingSource, reportingDestination, { recursive: true });

const assetsSource = join(projectRoot, "assets");
const assetsDestination = join(projectRoot, "dist", "assets");
mkdirSync(assetsDestination, { recursive: true });
cpSync(assetsSource, assetsDestination, { recursive: true });
