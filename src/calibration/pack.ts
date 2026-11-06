import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VisibleRules } from "../families/contracts.js";
import { hashPng } from "../render/png.js";
import { sha256Hex } from "../util/hash.js";
import type {
  BuiltCalibrationPack,
  CalibrationFixture,
  CalibrationPack,
} from "./fixtures.js";

const GALLERY_STYLE = `:root { color-scheme: light; --bg: #f4f5f7; --surface: #fff; --text: #1c2430; --muted: #55616f; --border: #cfd6df; --accent: #174f8a; --warn: #7a4b00; --warn-bg: #fdf0d5; }
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--text); font-family: "DejaVu Sans", "Segoe UI", Arial, sans-serif; line-height: 1.5; margin: 0; padding: 1.5rem; }
h1 { font-size: clamp(1.4rem, 4vw, 2rem); margin: 0 0 0.4rem; }
h2 { font-size: 1.05rem; margin: 0; overflow-wrap: anywhere; }
h3 { color: var(--muted); font-size: 0.82rem; letter-spacing: 0.03em; margin: 0.9rem 0 0.25rem; text-transform: uppercase; }
p, li, code, dt, dd { overflow-wrap: anywhere; }
code { background: #eef1f5; border-radius: 0.2rem; font-family: "DejaVu Sans Mono", monospace; font-size: 0.82em; padding: 0.05rem 0.25rem; }
header { margin: 0 auto 1rem; max-width: 1500px; }
.warning { background: var(--warn-bg); border: 1px solid #d9b25e; border-radius: 0.4rem; color: var(--warn); font-weight: 700; margin: 0.75rem 0; padding: 0.65rem 0.85rem; }
.meta { color: var(--muted); display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; font-size: 0.9rem; margin: 0.4rem 0 0; }
.cards { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(min(100%, 26rem), 1fr)); margin: 0 auto; max-width: 1500px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 0.55rem; min-width: 0; padding: 1rem; }
.slot { color: var(--muted); font-size: 0.82rem; font-weight: 400; margin-left: 0.4rem; }
.rules { display: grid; gap: 0.2rem 0.7rem; grid-template-columns: max-content 1fr; margin: 0; }
.rules dt { color: var(--muted); font-weight: 700; }
.rules dd { margin: 0; }
.list { margin: 0; padding-left: 1.2rem; }
.options { display: grid; gap: 0.3rem; list-style: none; margin: 0; padding: 0; }
.option { background: #eef1f5; border-radius: 0.3rem; padding: 0.35rem 0.5rem; }
.option-label { color: var(--accent); font-weight: 700; margin-right: 0.4rem; }
figure { margin: 0.75rem 0 0; }
img { background: #eef1f5; border: 1px solid var(--border); border-radius: 0.3rem; display: block; height: auto; max-width: 100%; }
.hash { color: var(--muted); font-size: 0.75rem; margin: 0.75rem 0 0; }
@media (max-width: 640px) { body { padding: 0.75rem; } .cards { grid-template-columns: minmax(0, 1fr); } .card { padding: 0.8rem; } .rules { grid-template-columns: 1fr; } .rules dd { margin-bottom: 0.3rem; } }`;

const FAVICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export interface CalibrationPackPaths {
  readonly directory: string;
  readonly packPath: string;
  readonly labelsPath: string;
  readonly galleryPath: string;
  readonly imagesDirectory: string;
  readonly packHash: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cspHash(content: string): string {
  return `sha256-${createHash("sha256").update(content, "utf8").digest("base64")}`;
}

function csvCell(value: string): string {
  let text = value;
  if (/^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function renderRules(rules: VisibleRules): string {
  const operationItems = rules.operations
    .map((operation) => `<li>${escapeHtml(operation)}</li>`)
    .join("");
  const conventionItems = rules.conventions
    .map((convention) => `<li>${escapeHtml(convention)}</li>`)
    .join("");
  return `<dl class="rules"><dt>Domain</dt><dd>${escapeHtml(
    rules.domain,
  )}</dd><dt>Closed world</dt><dd>${escapeHtml(
    rules.closedWorld,
  )}</dd><dt>Target</dt><dd>${escapeHtml(
    rules.target,
  )}</dd><dt>Operations</dt><dd><ul class="list">${operationItems}</ul></dd><dt>Conventions</dt><dd>${
    conventionItems === ""
      ? "No additional convention."
      : `<ul class="list">${conventionItems}</ul>`
  }</dd></dl>`;
}

function renderClues(fixture: CalibrationFixture): string {
  if (fixture.visible.clues.length === 0) {
    return `<p>No textual clues; observations are in the diagram.</p>`;
  }
  return `<ul class="list">${fixture.visible.clues
    .map((clue) => `<li>${escapeHtml(clue.text)}</li>`)
    .join("")}</ul>`;
}

function renderOptions(fixture: CalibrationFixture): string {
  return `<ol class="options">${fixture.visible.options
    .map(
      (option) =>
        `<li class="option"><span class="option-label">${escapeHtml(
          option.label,
        )}</span><span>${escapeHtml(option.text)}</span></li>`,
    )
    .join("")}</ol>`;
}

function renderImage(fixture: CalibrationFixture): string {
  if (fixture.modality !== "svg") {
    return "";
  }
  const png = `images/${fixture.fixtureId}.png`;
  const svg = `images/${fixture.fixtureId}.svg`;
  return `<figure><img src="${escapeHtml(
    png,
  )}" alt="Puzzle diagram for ${escapeHtml(
    fixture.fixtureId,
  )}" loading="lazy" decoding="async"><p class="hash"><a href="${escapeHtml(
    svg,
  )}">Source SVG</a></p></figure>`;
}

function renderCard(fixture: CalibrationFixture): string {
  return `<article class="card" data-fixture-id="${escapeHtml(
    fixture.fixtureId,
  )}" data-family="${escapeHtml(fixture.family)}" data-modality="${escapeHtml(
    fixture.modality,
  )}"><h2>${escapeHtml(fixture.fixtureId)}<span class="slot">${escapeHtml(
    fixture.slotId,
  )}</span></h2><p class="meta"><span>${escapeHtml(
    fixture.family,
  )}</span><span>${escapeHtml(
    fixture.modality,
  )}</span><span>difficulty ${fixture.difficulty}</span></p><h3>Question</h3><p>${escapeHtml(
    fixture.visible.question,
  )}</p><h3>Rules</h3>${renderRules(
    fixture.visible.rules,
  )}<h3>Clues</h3>${renderClues(fixture)}${renderImage(
    fixture,
  )}<h3>Options</h3>${renderOptions(
    fixture,
  )}<p class="hash">content <code>${escapeHtml(
    fixture.contentHash,
  )}</code></p></article>`;
}

export function renderCalibrationGallery(pack: CalibrationPack): string {
  const styleHash = cspHash(GALLERY_STYLE);
  const csp = [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "img-src 'self' data:",
    `style-src '${styleHash}'`,
    "script-src 'none'",
  ].join("; ");
  const textCount = pack.fixtures.filter(
    (fixture) => fixture.modality === "text",
  ).length;
  const svgCount = pack.fixtures.filter(
    (fixture) => fixture.modality === "svg",
  ).length;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<link rel="icon" href="${FAVICON}">
<title>Calibration Fixture Pack - ${escapeHtml(pack.packHash)}</title>
<style>${GALLERY_STYLE}</style>
</head>
<body>
<header><h1>Calibration Fixture Pack</h1><p class="warning">PENDING HUMAN VERIFICATION - this gallery shows visible presentations only. It does not show sound/defective labels, expected outcomes, mutation evidence, or the answer key.</p><p class="meta"><span>pack <code>${escapeHtml(
    pack.packHash,
  )}</code></span><span>${pack.fixtures.length} held-out presentations</span><span>${textCount} text</span><span>${svgCount} SVG</span></p></header>
<main class="cards">
${pack.fixtures.map(renderCard).join("\n")}
</main>
</body>
</html>
`;
}

function labelRows(fixtures: readonly CalibrationFixture[]): string[][] {
  return fixtures.map((fixture) => [
    fixture.fixtureId,
    fixture.slotId,
    fixture.sourceFixtureId ?? "",
    fixture.family,
    fixture.modality,
    String(fixture.difficulty),
    fixture.variant,
    fixture.seed,
    fixture.contentHash,
    fixture.pngHash ?? "",
    fixture.svgHash ?? "",
    fixture.fixtureHash,
    fixture.expected.blind.result,
    fixture.expected.blind.correctLabel ?? "",
    fixture.expected.blind.acceptedDefectCodes.join(";"),
    fixture.expected.alignment.result,
    fixture.expected.alignment.acceptedFailingFields.join(";"),
    fixture.expected.alignment.acceptedFactIds.join(";"),
    fixture.mutation?.description ?? "",
    "false",
    "",
    "",
    "",
  ]);
}

const LABEL_HEADER = [
  "fixture_id",
  "slot_id",
  "source_fixture_id",
  "family",
  "modality",
  "difficulty",
  "sound_or_defective",
  "seed",
  "content_hash",
  "png_hash",
  "svg_hash",
  "fixture_hash",
  "proposed_blind_result",
  "proposed_correct_label",
  "accepted_defect_codes",
  "proposed_alignment_result",
  "accepted_failing_fields",
  "accepted_fact_ids",
  "corruption_explanation",
  "human_verified",
  "auditor",
  "auditor_time",
  "notes",
] as const;

function renderLabels(fixtures: readonly CalibrationFixture[]): string {
  const rows = [LABEL_HEADER as unknown as string[], ...labelRows(fixtures)];
  return `${rows
    .map((row) => row.map((cell) => csvCell(cell)).join(","))
    .join("\n")}\n`;
}

function writeArtifact(path: string, bytes: Buffer): void {
  writeFileSync(path, bytes);
}

export function writeCalibrationPack(
  built: BuiltCalibrationPack,
  outputRoot = join("data", "calibration"),
): CalibrationPackPaths {
  const { pack, fixtures } = built;
  const directory = join(outputRoot, pack.packHash);
  const imagesDirectory = join(directory, "images");
  mkdirSync(imagesDirectory, { recursive: true });
  const packPath = join(directory, "pack.json");
  const labelsPath = join(directory, "labels.pending.csv");
  const galleryPath = join(directory, "gallery.html");
  for (const entry of fixtures) {
    const { fixture, artifacts } = entry;
    if (fixture.modality !== "svg") {
      continue;
    }
    if (artifacts.visible.png !== null) {
      if (hashPng(artifacts.visible.png) !== fixture.pngHash) {
        throw new Error(`${fixture.fixtureId} visible PNG hash mismatch`);
      }
      writeArtifact(join(imagesDirectory, `${fixture.fixtureId}.png`), artifacts.visible.png);
    }
    if (artifacts.visible.svg !== null) {
      if (sha256Hex(artifacts.visible.svg) !== fixture.svgHash) {
        throw new Error(`${fixture.fixtureId} visible SVG hash mismatch`);
      }
      writeArtifact(
        join(imagesDirectory, `${fixture.fixtureId}.svg`),
        Buffer.from(artifacts.visible.svg, "utf8"),
      );
    }
    if (fixture.variant === "defective") {
      if (artifacts.original.png !== null) {
        if (hashPng(artifacts.original.png) !== fixture.originalPngHash) {
          throw new Error(`${fixture.fixtureId} original PNG hash mismatch`);
        }
        writeArtifact(
          join(imagesDirectory, `${fixture.fixtureId}-original.png`),
          artifacts.original.png,
        );
      }
      if (artifacts.original.svg !== null) {
        if (sha256Hex(artifacts.original.svg) !== fixture.originalSvgHash) {
          throw new Error(`${fixture.fixtureId} original SVG hash mismatch`);
        }
        writeArtifact(
          join(imagesDirectory, `${fixture.fixtureId}-original.svg`),
          Buffer.from(artifacts.original.svg, "utf8"),
        );
      }
    }
  }
  writeFileSync(packPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  writeFileSync(labelsPath, renderLabels(pack.fixtures), "utf8");
  writeFileSync(galleryPath, renderCalibrationGallery(pack), "utf8");
  return {
    directory,
    packPath,
    labelsPath,
    galleryPath,
    imagesDirectory,
    packHash: pack.packHash,
  };
}
