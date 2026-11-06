import {
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import { buildCalibrationPack } from "../calibration/fixtures.js";
import {
  acceptProposedLabels,
  calibrationLabelsHash,
  parseCalibrationLabelsCsv,
  renderCalibrationLabelsCsv,
  validateCalibrationLabels,
} from "../calibration/labels.js";
import { writeCalibrationPack } from "../calibration/pack.js";
import {
  CALIBRATION_MOCK_MODES,
  runCalibrationMock,
  type CalibrationMockMode,
} from "../calibration/run.js";
import { scoreCalibration } from "../calibration/score.js";

export const PROGRAM_NAME = "calibration";

interface CalibrationOptions {
  readonly prepare?: boolean;
  readonly mock?: boolean;
  readonly mockMode?: string;
  readonly labels?: string;
  readonly verifyLabels?: string;
  readonly acceptProposed?: boolean;
  readonly auditor?: string;
  readonly auditorTime?: string;
  readonly out?: string;
}

function readLabels(path: string) {
  return parseCalibrationLabelsCsv(readFileSync(path, "utf8"));
}

function printPackSummary(
  built: ReturnType<typeof buildCalibrationPack>,
  paths: ReturnType<typeof writeCalibrationPack>,
): void {
  const sound = built.pack.fixtures.filter(
    (fixture) => fixture.variant === "sound",
  ).length;
  const defective = built.pack.fixtures.length - sound;
  process.stdout.write(
    [
      `pack_hash: ${paths.packHash}`,
      `directory: ${paths.directory}`,
      `fixtures: ${built.pack.fixtures.length}`,
      `sound: ${sound}`,
      `defective: ${defective}`,
      `pack: ${paths.packPath}`,
      `labels: ${paths.labelsPath}`,
      `gallery: ${paths.galleryPath}`,
    ].join("\n") + "\n",
  );
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name(PROGRAM_NAME)
    .description(
      "Build the held-out calibration pack, verify labels, or run the mock calibration scoring.",
    )
    .showHelpAfterError()
    .option("--prepare", "build the 40-item fixture pack, gallery, and pending label template")
    .option("--mock", "run the 80-call mock blind+alignment calibration and score it")
    .option("--mock-mode <mode>", "mock reviewer mode: oracle, agree, or reject", "oracle")
    .option("--labels <path>", "calibration label CSV")
    .option("--verify-labels <path>", "validate a human-verified label CSV without running reviews")
    .option("--accept-proposed", "after human review, fill blank observed_* fields from proposed_* and mark the file human-verified")
    .option("--auditor <name>", "auditor identity required with --verify-labels or --accept-proposed")
    .option("--auditor-time <iso>", "auditor timestamp for --accept-proposed (default: now)")
    .option("--out <dir>", "output root for --prepare (default: data/calibration)")
    .action(async (options: CalibrationOptions) => {
      const modes = [
        options.prepare === true,
        options.mock === true,
        options.verifyLabels !== undefined,
        options.acceptProposed === true,
      ].filter(Boolean);
      if (modes.length !== 1) {
        program.error(
          "choose exactly one of --prepare, --mock, --verify-labels, or --accept-proposed",
          { exitCode: 1 },
        );
        return;
      }
      if (options.prepare === true) {
        if (
          options.labels !== undefined ||
          options.auditor !== undefined ||
          options.auditorTime !== undefined
        ) {
          program.error(
            "--prepare does not accept --labels, --auditor, or --auditor-time",
            { exitCode: 1 },
          );
          return;
        }
        const built = buildCalibrationPack();
        const paths = writeCalibrationPack(built, options.out ?? "data/calibration");
        printPackSummary(built, paths);
        return;
      }
      if (options.acceptProposed === true) {
        const auditor = options.auditor;
        if (auditor === undefined || auditor.trim() === "") {
          program.error("--accept-proposed requires --auditor", { exitCode: 1 });
          return;
        }
        if (options.labels === undefined) {
          program.error("--accept-proposed requires --labels <path>", {
            exitCode: 1,
          });
          return;
        }
        if (options.mock === true || options.verifyLabels !== undefined) {
          program.error(
            "--accept-proposed cannot be combined with --mock or --verify-labels",
            { exitCode: 1 },
          );
          return;
        }
        const labelsPath = resolve(options.labels);
        const labelsName = basename(labelsPath);
        if (
          labelsName === "labels.pending.csv" ||
          labelsName.includes("mock-labels")
        ) {
          program.error(
            "--accept-proposed refuses the pending template or a mock label fixture; use a human workspace copy",
            { exitCode: 1 },
          );
          return;
        }
        const built = buildCalibrationPack();
        const labels = readLabels(labelsPath);
        const nonPending = labels.rows.filter(
          (row) => row.provenance !== "" || row.humanVerified,
        );
        if (nonPending.length > 0) {
          program.error(
            `--accept-proposed requires pending rows; already attested: ${nonPending
              .map((row) => row.fixtureId)
              .join(", ")}`,
            { exitCode: 1 },
          );
          return;
        }
        const auditorTime = options.auditorTime ?? new Date().toISOString();
        const nonEmpty = (value: unknown): boolean =>
          Array.isArray(value)
            ? value.length > 0
            : value !== null && value !== "";
        const cellValues = (row: (typeof labels.rows)[number]): unknown[] => [
          row.observedBlindResult,
          row.observedCorrectLabel,
          row.observedDefectCodes,
          row.observedAlignmentResult,
          row.observedFailingFields,
          row.observedFactIds,
        ];
        let humanAttestedCells = 0;
        let machineFilledCells = 0;
        let emptyCells = 0;
        const acceptedForCounts = acceptProposedLabels(labels, {
          auditor,
          auditorTime,
        });
        for (let index = 0; index < labels.rows.length; index += 1) {
          const before = cellValues(labels.rows[index] as (typeof labels.rows)[number]);
          const after = cellValues(
            acceptedForCounts.rows[index] as (typeof acceptedForCounts.rows)[number],
          );
          for (let cell = 0; cell < before.length; cell += 1) {
            if (nonEmpty(before[cell])) {
              humanAttestedCells += 1;
            } else if (nonEmpty(after[cell])) {
              machineFilledCells += 1;
            } else {
              emptyCells += 1;
            }
          }
        }
        const accepted = acceptProposedLabels(labels, {
          auditor,
          auditorTime,
        });
        validateCalibrationLabels({
          labels: accepted,
          pack: built.pack,
          mode: "verify",
          auditor,
        });
        const temporaryPath = `${labelsPath}.tmp-${process.pid}`;
        try {
          writeFileSync(
            temporaryPath,
            renderCalibrationLabelsCsv(accepted.rows),
          );
          const reparsed = parseCalibrationLabelsCsv(
            readFileSync(temporaryPath, "utf8"),
          );
          validateCalibrationLabels({
            labels: reparsed,
            pack: built.pack,
            mode: "verify",
            auditor,
          });
          renameSync(temporaryPath, labelsPath);
          process.stdout.write(
            `${JSON.stringify(
              {
                labels_accepted: true,
                path: labelsPath,
                pack_hash: reparsed.packHash,
                labels_hash: calibrationLabelsHash(reparsed),
                fixtures: reparsed.rows.length,
                reviewed_rows: reparsed.rows.length,
                human_attested_cells: humanAttestedCells,
                machine_filled_cells: machineFilledCells,
                empty_cells: emptyCells,
                auditor,
                auditor_time: [
                  ...new Set(reparsed.rows.map((row) => row.auditorTime)),
                ],
                provenance: "human",
                human_verified: true,
              },
              null,
              2,
            )}\n`,
          );
        } finally {
          rmSync(temporaryPath, { force: true });
        }
        return;
      }
      if (options.verifyLabels !== undefined) {
        const auditor = options.auditor;
        if (auditor === undefined || auditor.trim() === "") {
          program.error("--verify-labels requires --auditor", { exitCode: 1 });
          return;
        }
        if (options.mock === true) {
          program.error("--verify-labels cannot be combined with --mock", {
            exitCode: 1,
          });
          return;
        }
        const built = buildCalibrationPack();
        const labels = readLabels(options.verifyLabels);
        validateCalibrationLabels({
          labels,
          pack: built.pack,
          mode: "verify",
          auditor,
        });
        process.stdout.write(
          `${JSON.stringify(
            {
              labels_verified: true,
              pack_hash: labels.packHash,
              labels_hash: calibrationLabelsHash(labels),
              fixtures: labels.rows.length,
              auditor,
              auditor_time: [...new Set(labels.rows.map((row) => row.auditorTime))],
              provenance: [...new Set(labels.rows.map((row) => row.provenance))],
              human_verified: labels.rows.every((row) => row.humanVerified),
            },
            null,
            2,
          )}\n`,
        );
        return;
      }
      const labelsPath = options.labels;
      if (labelsPath === undefined) {
        program.error("--mock requires --labels", { exitCode: 1 });
        return;
      }
      const mockMode = options.mockMode ?? "oracle";
      if (!CALIBRATION_MOCK_MODES.includes(mockMode as CalibrationMockMode)) {
        program.error(
          `--mock-mode must be one of ${CALIBRATION_MOCK_MODES.join(", ")}`,
          { exitCode: 1 },
        );
        return;
      }
      const built = buildCalibrationPack();
      const labels = readLabels(labelsPath);
      validateCalibrationLabels({
        labels,
        pack: built.pack,
        mode: "mock",
      });
      const run = await runCalibrationMock({
        built,
        labels,
        mode: mockMode as CalibrationMockMode,
      });
      const score = scoreCalibration({
        labels,
        observations: run.observations,
        reviewCalls: run.reviewCalls,
        generationCalls: run.generationCalls,
      });
      process.stdout.write(`${JSON.stringify(score, null, 2)}\n`);
      process.stderr.write(
        "MOCK/TEST-ONLY calibration evidence; not live calibrated evidence.\n",
      );
    });
  return program;
}

export async function main(argv: readonly string[] = process.argv): Promise<number> {
  const program = createProgram().exitOverride();
  try {
    await program.parseAsync([...argv]);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    if (error instanceof Error) {
      process.stderr.write(`error: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  process.exitCode = await main();
}
