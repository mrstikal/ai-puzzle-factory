import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import { SVG_FAMILIES, type Family, type SvgFamily } from "../domain/experiment.js";
import { productionRegistry } from "../families/registry.js";
import { assertScene, previewRegistry, type Scene } from "../render/scene.js";
import { writeScenePreviewExports } from "../render/png.js";

export const PROGRAM_NAME = "preview";

interface PreviewOptions {
  readonly family: string;
  readonly seed: string;
  readonly out?: string;
}

interface ResolvedPreviewRenderer {
  readonly family: string;
  buildScene(seed: string): Scene;
}

function resolvePreviewRenderer(family: string): ResolvedPreviewRenderer | undefined {
  const direct = previewRegistry.get(family);
  if (direct !== undefined) {
    return direct;
  }
  if (
    (SVG_FAMILIES as readonly string[]).includes(family) &&
    productionRegistry.hasRenderer(family as SvgFamily)
  ) {
    const engine = productionRegistry.getEngine(family as Family);
    const renderer = productionRegistry.getRenderer(family as SvgFamily);
    return {
      family,
      buildScene(seed) {
        const spec = engine.generateSpec(seed, 1);
        const scene = renderer.buildScene(spec);
        assertScene(scene as Scene);
        return scene as Scene;
      },
    };
  }
  return undefined;
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name(PROGRAM_NAME)
    .description("Render a safe local scene preview without provider or gallery dependencies.")
    .showHelpAfterError()
    .requiredOption("--family <family>", "preview renderer family")
    .option("--seed <seed>", "deterministic preview seed", "preview-v1")
    .option("--out <dir>", "preview output directory (default: data/previews)")
    .action((options: PreviewOptions) => {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(options.seed)) {
        program.error("seed must be 1-64 letters, digits, dots, underscores, or hyphens", {
          exitCode: 1,
        });
      }
      const renderer = resolvePreviewRenderer(options.family);
      if (renderer === undefined) {
        const available = [
          ...previewRegistry.listFamilies(),
          ...productionRegistry.listRendererFamilies(),
        ].sort();
        program.error(
          `unknown preview family ${options.family}; available: ${available.join(", ")}`,
          { exitCode: 1 },
        );
        return;
      }
      const scene = renderer.buildScene(options.seed);
      const exported =
        options.out === undefined
          ? writeScenePreviewExports(scene, renderer.family, options.seed)
          : writeScenePreviewExports(scene, renderer.family, options.seed, options.out);
      process.stdout.write(
        [
          `family: ${renderer.family}`,
          `seed: ${options.seed}`,
          `svg: ${exported.svgPath}`,
          `full_png: ${exported.fullPngPath}`,
          `preview_png: ${exported.previewPngPath}`,
          `full_sha256: ${exported.fullHash}`,
          `preview_sha256: ${exported.previewHash}`,
        ].join("\n") + "\n",
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
