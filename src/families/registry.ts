import {
  FAMILIES,
  MODALITY_BY_FAMILY,
  SVG_FAMILIES,
  type Family,
  type SvgFamily,
} from "../domain/experiment.js";
import type { FamilyEngine } from "./contracts.js";
import { matchingEngine } from "./matching/engine.js";
import { rankingEngine } from "./ranking/engine.js";
import { schedulingEngine } from "./scheduling/engine.js";
import { truthEngine } from "./truth/engine.js";
import { arithmeticEngine } from "./arithmetic/engine.js";
import { matrixEngine } from "./matrix/engine.js";
import { matrixRenderer } from "./matrix/render.js";
import { transformsEngine } from "./transforms/engine.js";
import { transformsRenderer } from "./transforms/render.js";
import { pathsEngine } from "./paths/engine.js";
import { pathsRenderer } from "./paths/render.js";
import { symmetryEngine } from "./symmetry/engine.js";
import { symmetryRenderer } from "./symmetry/render.js";

export interface RendererContract<Spec = unknown, Scene = unknown> {
  readonly family: SvgFamily;
  readonly version: string;
  buildScene(spec: Spec): Scene;
}

export type AnyFamilyEngine = FamilyEngine<unknown, unknown>;
export type AnyRendererContract = RendererContract<unknown, unknown>;

export type RegistryErrorCode =
  | "DUPLICATE_REGISTRATION"
  | "INVALID_REGISTRATION"
  | "NOT_FOUND"
  | "INCOMPLETE_REGISTRY";

export class RegistryError extends Error {
  readonly code: RegistryErrorCode;

  constructor(code: RegistryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistryError";
    this.code = code;
  }
}

const ENGINE_METHODS = [
  "generateSpec",
  "enumerateSolutions",
  "verifyAnswer",
  "makeOptions",
  "visibleRules",
  "facts",
  "canonicalData",
  "testMutations",
] as const;

export class FamilyRegistry {
  private readonly engines = new Map<Family, AnyFamilyEngine>();
  private readonly renderers = new Map<SvgFamily, AnyRendererContract>();

  registerEngine<S, A>(engine: FamilyEngine<S, A>): void {
    if (!FAMILIES.includes(engine.family)) {
      throw new RegistryError(
        "INVALID_REGISTRATION",
        `engine family ${String(engine.family)} is not a declared family`,
      );
    }
    const expectedModality = MODALITY_BY_FAMILY[engine.family];
    if (engine.modality !== expectedModality) {
      throw new RegistryError(
        "INVALID_REGISTRATION",
        `engine ${engine.family} declares modality ${engine.modality}, expected ${expectedModality}`,
      );
    }
    if (typeof engine.schema?.parse !== "function") {
      throw new RegistryError(
        "INVALID_REGISTRATION",
        `engine ${engine.family} must expose a strict Zod schema`,
      );
    }
    for (const method of ENGINE_METHODS) {
      if (typeof engine[method] !== "function") {
        throw new RegistryError(
          "INVALID_REGISTRATION",
          `engine ${engine.family} is missing method ${method}`,
        );
      }
    }
    if (this.engines.has(engine.family)) {
      throw new RegistryError(
        "DUPLICATE_REGISTRATION",
        `an engine for family ${engine.family} is already registered`,
      );
    }
    this.engines.set(engine.family, engine as unknown as AnyFamilyEngine);
  }

  registerRenderer<S, Scene>(renderer: RendererContract<S, Scene>): void {
    if (!SVG_FAMILIES.includes(renderer.family)) {
      throw new RegistryError(
        "INVALID_REGISTRATION",
        `renderer family ${String(renderer.family)} is not a declared SVG family`,
      );
    }
    if (typeof renderer.version !== "string" || renderer.version.trim().length === 0) {
      throw new RegistryError(
        "INVALID_REGISTRATION",
        `renderer ${renderer.family} requires a nonempty version`,
      );
    }
    if (typeof renderer.buildScene !== "function") {
      throw new RegistryError(
        "INVALID_REGISTRATION",
        `renderer ${renderer.family} must expose buildScene`,
      );
    }
    if (this.renderers.has(renderer.family)) {
      throw new RegistryError(
        "DUPLICATE_REGISTRATION",
        `a renderer for family ${renderer.family} is already registered`,
      );
    }
    this.renderers.set(renderer.family, renderer as unknown as AnyRendererContract);
  }

  getEngine(family: Family): AnyFamilyEngine {
    const engine = this.engines.get(family);
    if (engine === undefined) {
      throw new RegistryError("NOT_FOUND", `no engine is registered for family ${family}`);
    }
    return engine;
  }

  getRenderer(family: SvgFamily): AnyRendererContract {
    const renderer = this.renderers.get(family);
    if (renderer === undefined) {
      throw new RegistryError("NOT_FOUND", `no renderer is registered for family ${family}`);
    }
    return renderer;
  }

  hasEngine(family: Family): boolean {
    return this.engines.has(family);
  }

  hasRenderer(family: SvgFamily): boolean {
    return this.renderers.has(family);
  }

  listEngineFamilies(): readonly Family[] {
    return FAMILIES.filter((family) => this.engines.has(family));
  }

  listRendererFamilies(): readonly SvgFamily[] {
    return SVG_FAMILIES.filter((family) => this.renderers.has(family));
  }

  assertComplete(options: { readonly requireRenderers?: boolean } = {}): void {
    const missingEngines = FAMILIES.filter((family) => !this.engines.has(family));
    if (missingEngines.length > 0) {
      throw new RegistryError(
        "INCOMPLETE_REGISTRY",
        `missing formal engines: ${missingEngines.join(", ")}`,
      );
    }
    if (options.requireRenderers === true) {
      const missingRenderers = SVG_FAMILIES.filter((family) => !this.renderers.has(family));
      if (missingRenderers.length > 0) {
        throw new RegistryError(
          "INCOMPLETE_REGISTRY",
          `missing SVG renderers: ${missingRenderers.join(", ")}`,
        );
      }
    }
  }
}

export function createFamilyRegistry(): FamilyRegistry {
  return new FamilyRegistry();
}

export const productionRegistry = new FamilyRegistry();

productionRegistry.registerEngine(rankingEngine);
productionRegistry.registerEngine(matchingEngine);
productionRegistry.registerEngine(schedulingEngine);
productionRegistry.registerEngine(truthEngine);
productionRegistry.registerEngine(arithmeticEngine);
productionRegistry.registerEngine(matrixEngine);
productionRegistry.registerEngine(transformsEngine);
productionRegistry.registerEngine(pathsEngine);
productionRegistry.registerEngine(symmetryEngine);
productionRegistry.registerRenderer(matrixRenderer);
productionRegistry.registerRenderer(transformsRenderer);
productionRegistry.registerRenderer(pathsRenderer);
productionRegistry.registerRenderer(symmetryRenderer);
