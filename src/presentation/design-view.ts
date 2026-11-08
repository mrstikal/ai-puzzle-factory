import { z } from "zod";
import {
  ChoiceSetSchema,
  type ChoiceSet,
} from "../domain/answers.js";
import {
  PresentationAssetsSchema,
  PresentationClueSchema,
  PresentationOptionSchema,
  WordingExplanationStepSchema,
} from "../domain/presentation.js";
import {
  FamilySchema,
  ModalitySchema,
  Sha256Schema,
  type Family,
} from "../domain/experiment.js";
import {
  DESIGNER_CANDIDATE_SLOT_ID_PATTERN,
  DesignerSkinError,
  PresentationSkinSchema,
  validatePresentationSkin,
  type PresentationSkin,
} from "../domain/design.js";
import type { FamilySpec } from "../domain/spec.js";
import {
  VisibleRulesSchema,
  type FamilyEngine,
  type SolveResult,
} from "../families/contracts.js";
import { productionRegistry } from "../families/registry.js";
import { renderScenePng } from "../render/png.js";
import { serializeScene } from "../render/svg.js";
import { hashArtifactBytes } from "../storage/artifacts.js";
import { canonicalJson, sha256Hex } from "../util/hash.js";
import { assemblePresentation, formatOptionText } from "./assemble.js";
import {
  DESIGN_TEMPLATE_VERSION,
  FAMILY_TITLES,
  NeutralLabelSetSchema,
  buildDesignWording,
  computeDesignTemplateHash,
  neutralLabelsForSpec,
} from "./templates.js";
import {
  ProofTraceSchema,
  assertHintNonSpoiling,
  assertProofTrace,
  buildProofTrace,
  explanationStepsForTrace,
  type ProofTrace,
} from "./explain.js";

export const DESIGN_VIEW_VERSION = 1 as const;

export type DesignViewErrorCode =
  | "INVALID_VIEW"
  | "INVALID_SPEC"
  | "INVALID_CHOICES"
  | "INVALID_SOLVE"
  | "INVALID_ASSETS"
  | "INVALID_SKIN"
  | "INVALID_CERTIFICATE"
  | "SPOILING_HINT"
  | "PROOF_TRACE"
  | "PUBLIC_REVEAL_LEAK";

export class DesignViewError extends Error {
  readonly code: DesignViewErrorCode;

  constructor(
    code: DesignViewErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DesignViewError";
    this.code = code;
  }
}

export const DesignVisibleSchema = z.strictObject({
  version: z.literal(1),
  viewId: z.string().regex(DESIGNER_CANDIDATE_SLOT_ID_PATTERN),
  family: FamilySchema,
  modality: ModalitySchema,
  title: z.string().min(1).max(120),
  question: z.string().min(1).max(400),
  rules: VisibleRulesSchema,
  clues: z.array(PresentationClueSchema).max(12),
  options: z.array(PresentationOptionSchema).length(4),
  assets: PresentationAssetsSchema,
});
export type DesignVisible = z.infer<typeof DesignVisibleSchema>;

export const DesignRevealSchema = z.strictObject({
  correctLabel: z.enum(["A", "B", "C", "D"]),
  correctValue: z
    .unknown()
    .refine((value) => value !== undefined, "correctValue is required"),
  hint: z.string().min(1).max(300),
  explanationSteps: z.array(WordingExplanationStepSchema).max(8),
  proofTrace: ProofTraceSchema,
});
export type DesignReveal = z.infer<typeof DesignRevealSchema>;

export const DesignViewChecksSchema = z.strictObject({
  templates: z.literal("pass"),
  proofTrace: z.literal("pass"),
  certificate: z.literal("pass"),
  skin: z.enum(["pass", "not_applicable"]),
  semanticAlignment: z.literal("semantic_alignment_pending"),
});
export type DesignViewChecks = z.infer<typeof DesignViewChecksSchema>;

export const PresentationCertificateSchema = z
  .strictObject({
    version: z.literal(1),
    viewId: z.string().regex(DESIGNER_CANDIDATE_SLOT_ID_PATTERN),
    family: FamilySchema,
    modality: ModalitySchema,
    specHash: Sha256Schema,
    templateVersion: z.literal(DESIGN_TEMPLATE_VERSION),
    templateHash: Sha256Schema,
    proofTraceHash: Sha256Schema,
    choicesHash: Sha256Schema,
    correctLabel: z.enum(["A", "B", "C", "D"]),
    svgHash: Sha256Schema.nullable(),
    pngHash: Sha256Schema.nullable(),
    previewPngHash: Sha256Schema.nullable(),
    certificateHash: Sha256Schema,
  })
  .superRefine((certificate, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message });
    };
    if (certificate.modality === "text") {
      if (
        certificate.svgHash !== null ||
        certificate.pngHash !== null ||
        certificate.previewPngHash !== null
      ) {
        issue(["svgHash"], "text certificates cannot carry image hashes");
      }
    } else if (
      certificate.svgHash === null ||
      certificate.pngHash === null ||
      certificate.previewPngHash === null
    ) {
      issue(["svgHash"], "SVG certificates require full and preview hashes");
    }
    if (certificate.certificateHash !== computeCertificateHash(certificate)) {
      issue(["certificateHash"], "certificate hash does not match the certificate");
    }
  });
export type PresentationCertificate = z.infer<
  typeof PresentationCertificateSchema
>;

export const DesignViewSchema = z
  .strictObject({
    version: z.literal(DESIGN_VIEW_VERSION),
    visible: DesignVisibleSchema,
    reveal: DesignRevealSchema,
    wordingSource: z.literal("fixture"),
    templateVersion: z.literal(DESIGN_TEMPLATE_VERSION),
    templateHash: Sha256Schema,
    neutralLabels: NeutralLabelSetSchema,
    skin: PresentationSkinSchema.nullable(),
    certificate: PresentationCertificateSchema,
    checks: DesignViewChecksSchema,
  })
  .superRefine((view, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message });
    };
    if (
      view.certificate.viewId !== view.visible.viewId ||
      view.certificate.family !== view.visible.family ||
      view.certificate.modality !== view.visible.modality
    ) {
      issue(["certificate"], "certificate identity must match the visible view");
    }
    if (view.certificate.templateVersion !== view.templateVersion) {
      issue(["certificate", "templateVersion"], "certificate template version mismatch");
    }
    if (view.certificate.templateHash !== view.templateHash) {
      issue(["certificate", "templateHash"], "certificate template hash mismatch");
    }
    if (
      view.certificate.proofTraceHash !==
      sha256Hex(canonicalJson(view.reveal.proofTrace))
    ) {
      issue(["certificate", "proofTraceHash"], "certificate proof trace hash mismatch");
    }
    if (view.certificate.correctLabel !== view.reveal.correctLabel) {
      issue(["certificate", "correctLabel"], "certificate correct label mismatch");
    }
    if (
      view.certificate.svgHash !== view.visible.assets.svgHash ||
      view.certificate.pngHash !== view.visible.assets.pngHash
    ) {
      issue(["certificate", "svgHash"], "certificate asset hashes mismatch");
    }
    if (view.reveal.proofTrace.family !== view.visible.family) {
      issue(["reveal", "proofTrace", "family"], "proof trace family mismatch");
    }
    if (view.reveal.proofTrace.modality !== view.visible.modality) {
      issue(["reveal", "proofTrace", "modality"], "proof trace modality mismatch");
    }
    if (view.reveal.hint !== view.reveal.proofTrace.hint) {
      issue(["reveal", "hint"], "reveal hint must equal the certified trace hint");
    }
    const expectedSteps = explanationStepsForTrace(view.reveal.proofTrace);
    if (canonicalJson(view.reveal.explanationSteps) !== canonicalJson(expectedSteps)) {
      issue(
        ["reveal", "explanationSteps"],
        "reveal explanation steps must equal the certified trace steps",
      );
    }
    if (
      sha256Hex(canonicalJson(view.reveal.correctValue)) !==
      view.reveal.proofTrace.finalAnswerHash
    ) {
      issue(
        ["reveal", "correctValue"],
        "reveal answer must match the certified final answer hash",
      );
    }
    if (
      computeDesignTemplateHash({
        family: view.visible.family,
        modality: view.visible.modality,
        title: view.visible.title,
        question: view.visible.question,
        rules: view.visible.rules,
        clues: view.visible.clues,
        options: view.visible.options,
        neutralLabels: view.neutralLabels,
        hint: view.reveal.hint,
      }) !== view.templateHash
    ) {
      issue(
        ["templateHash"],
        "template hash does not match the visible payload",
      );
    }
  });
export type DesignView = z.infer<typeof DesignViewSchema>;

export const PublicDesignViewSchema = z.strictObject({
  version: z.literal(DESIGN_VIEW_VERSION),
  viewId: z.string().regex(DESIGNER_CANDIDATE_SLOT_ID_PATTERN),
  family: FamilySchema,
  modality: ModalitySchema,
  title: z.string().min(1).max(120),
  question: z.string().min(1).max(400),
  rules: VisibleRulesSchema,
  clues: z.array(PresentationClueSchema).max(12),
  options: z.array(PresentationOptionSchema).length(4),
  assets: PresentationAssetsSchema,
  templateVersion: z.literal(DESIGN_TEMPLATE_VERSION),
});
export type PublicDesignView = z.infer<typeof PublicDesignViewSchema>;

export interface BuildDesignAssetsInput<S, A> {
  readonly engine: FamilyEngine<S, A>;
  readonly spec: S;
  readonly choices: ChoiceSet<A>;
  readonly seed: string;
}

export interface BuiltDesignAssets {
  readonly assets: z.infer<typeof PresentationAssetsSchema>;
  readonly previewPngHash: string | null;
  readonly svg: string | null;
  readonly scene: unknown;
}

export function buildDesignAssets<S, A>(
  input: BuildDesignAssetsInput<S, A>,
): BuiltDesignAssets {
  if (input.engine.modality === "text") {
    return {
      assets: { svgHash: null, pngHash: null },
      previewPngHash: null,
      svg: null,
      scene: null,
    };
  }
  const renderer = productionRegistry.getRenderer(
    input.engine.family as Parameters<typeof productionRegistry.getRenderer>[0],
  );
  const scene = renderer.buildScene(input.spec, input.seed);
  renderer.assertScene(scene, input.spec, input.choices);
  const svg = serializeScene(scene as Parameters<typeof serializeScene>[0]);
  const fullPng = renderScenePng(
    scene as Parameters<typeof renderScenePng>[0],
    1024,
  );
  const previewPng = renderScenePng(
    scene as Parameters<typeof renderScenePng>[0],
    512,
  );
  return {
    assets: {
      svgHash: sha256Hex(svg),
      pngHash: hashArtifactBytes(fullPng),
    },
    previewPngHash: hashArtifactBytes(previewPng),
    svg,
    scene,
  };
}

function computeCertificateHash(
  certificate: PresentationCertificate | Omit<PresentationCertificate, "certificateHash">,
): string {
  const base = { ...certificate } as Record<string, unknown>;
  delete base.certificateHash;
  return sha256Hex(canonicalJson(base));
}

export interface BuildPresentationCertificateInput {
  readonly viewId: string;
  readonly family: Family;
  readonly modality: "text" | "svg";
  readonly spec: unknown;
  readonly templateVersion: typeof DESIGN_TEMPLATE_VERSION;
  readonly templateHash: string;
  readonly proofTrace: ProofTrace;
  readonly choices: ChoiceSet<unknown>;
  readonly assets: z.infer<typeof PresentationAssetsSchema>;
  readonly previewPngHash: string | null;
}

export function buildPresentationCertificate(
  input: BuildPresentationCertificateInput,
): PresentationCertificate {
  const base = {
    version: 1 as const,
    viewId: input.viewId,
    family: input.family,
    modality: input.modality,
    specHash: sha256Hex(canonicalJson(input.spec)),
    templateVersion: input.templateVersion,
    templateHash: input.templateHash,
    proofTraceHash: sha256Hex(canonicalJson(input.proofTrace)),
    choicesHash: sha256Hex(canonicalJson(input.choices)),
    correctLabel: input.choices.correctLabel,
    svgHash: input.assets.svgHash,
    pngHash: input.assets.pngHash,
    previewPngHash: input.previewPngHash,
  };
  return PresentationCertificateSchema.parse({
    ...base,
    certificateHash: computeCertificateHash(base),
  });
}

export interface BuildDesignViewInput<S, A> {
  readonly viewId: string;
  readonly engine: FamilyEngine<S, A>;
  readonly spec: S;
  readonly solveResult: SolveResult<A>;
  readonly choices: ChoiceSet<A>;
  readonly difficulty: 1 | 2 | 3;
  readonly skin?: PresentationSkin | null;
  readonly choicesSeed?: string;
}

export interface BuiltDesignView {
  readonly view: DesignView;
  readonly svg: string | null;
}

function assertChoices<S, A>(
  engine: FamilyEngine<S, A>,
  spec: S,
  solveResult: SolveResult<A>,
  choices: ChoiceSet<A>,
): void {
  const parsed = ChoiceSetSchema.safeParse(choices);
  if (!parsed.success) {
    throw new DesignViewError("INVALID_CHOICES", "choices do not satisfy the choice-set schema", {
      cause: parsed.error,
    });
  }
  if (
    solveResult.solutionCount !== 1 ||
    solveResult.answerCount !== 1 ||
    solveResult.correctAnswer === null ||
    solveResult.correctAnswer === undefined
  ) {
    throw new DesignViewError(
      "INVALID_SOLVE",
      "design view requires one complete verified answer",
    );
  }
  const correct = choices.choices.filter((choice) =>
    engine.verifyAnswer(spec, choice.value),
  );
  if (correct.length !== 1 || correct[0]?.label !== choices.correctLabel) {
    throw new DesignViewError(
      "INVALID_CHOICES",
      "choices require exactly one correct option matching correctLabel",
    );
  }
  if (canonicalJson(correct[0].value) !== canonicalJson(solveResult.correctAnswer)) {
    throw new DesignViewError(
      "INVALID_CHOICES",
      "correct option does not match the independent answer",
    );
  }
}

export function buildDesignView<S, A>(
  input: BuildDesignViewInput<S, A>,
): BuiltDesignView {
  const spec = input.engine.schema.parse(input.spec);
  assertChoices(input.engine, spec, input.solveResult, input.choices);
  const parsedSkin =
    input.skin === undefined || input.skin === null
      ? null
      : PresentationSkinSchema.safeParse(input.skin);
  if (parsedSkin !== null && !parsedSkin.success) {
    throw new DesignViewError(
      "INVALID_SKIN",
      "presentation skin does not satisfy the closed schema",
      { cause: parsedSkin.error },
    );
  }
  const skin = parsedSkin === null ? null : parsedSkin.data;
  if (skin !== null) {
    try {
      validatePresentationSkin(
        input.engine.family,
        spec as unknown as FamilySpec,
        skin,
      );
    } catch (error) {
      if (error instanceof DesignerSkinError) {
        throw new DesignViewError("INVALID_SKIN", error.message, { cause: error });
      }
      throw error;
    }
  }
  const proofTrace = buildProofTrace({
    engine: input.engine,
    spec,
    solveResult: input.solveResult,
  });
  const explanationSteps = explanationStepsForTrace(proofTrace);
  const wording = buildDesignWording({
    engine: input.engine,
    spec,
    difficulty: input.difficulty,
    explanationSteps,
  });
  if (input.engine.modality === "svg" && input.choicesSeed === undefined) {
    throw new DesignViewError(
      "INVALID_ASSETS",
      "SVG design view requires choicesSeed so scene options match the certificate choices",
    );
  }
  const builtAssets = buildDesignAssets({
    engine: input.engine,
    spec,
    choices: input.choices,
    seed: input.choicesSeed ?? sha256Hex(canonicalJson(spec)),
  });
  const assembled = assemblePresentation({
    slotId: `${input.engine.modality}-${input.engine.family}-01`,
    engine: input.engine,
    spec,
    solveResult: input.solveResult,
    choices: input.choices,
    wording: wording.wording,
    assets: builtAssets.assets,
  });
  assertHintNonSpoiling(
    proofTrace,
    assembled.visible.options.map((option) => option.text),
    assembled.reveal.correctLabel,
  );
  const templateHash = computeDesignTemplateHash({
    family: input.engine.family,
    modality: input.engine.modality,
    title: wording.title,
    question: assembled.visible.question,
    rules: assembled.visible.rules,
    clues: assembled.visible.clues,
    options: assembled.visible.options,
    neutralLabels: wording.neutralLabels,
    hint: proofTrace.hint,
  });
  const certificate = buildPresentationCertificate({
    viewId: input.viewId,
    family: input.engine.family,
    modality: input.engine.modality,
    spec,
    templateVersion: DESIGN_TEMPLATE_VERSION,
    templateHash,
    proofTrace,
    choices: input.choices as ChoiceSet<unknown>,
    assets: builtAssets.assets,
    previewPngHash: builtAssets.previewPngHash,
  });
  const visible: DesignVisible = {
    version: 1,
    viewId: input.viewId,
    family: input.engine.family,
    modality: input.engine.modality,
    title: wording.title,
    question: assembled.visible.question,
    rules: assembled.visible.rules,
    clues: assembled.visible.clues,
    options: assembled.visible.options,
    assets: assembled.visible.assets,
  };
  const reveal: DesignReveal = {
    correctLabel: assembled.reveal.correctLabel,
    correctValue: assembled.reveal.correctValue,
    hint: assembled.reveal.hint,
    explanationSteps: assembled.reveal.explanationSteps,
    proofTrace,
  };
  const view = DesignViewSchema.parse({
    version: DESIGN_VIEW_VERSION,
    visible,
    reveal,
    wordingSource: "fixture",
    templateVersion: DESIGN_TEMPLATE_VERSION,
    templateHash,
    neutralLabels: wording.neutralLabels,
    skin,
    certificate,
    checks: {
      templates: "pass",
      proofTrace: "pass",
      certificate: "pass",
      skin: skin === null ? "not_applicable" : "pass",
      semanticAlignment: "semantic_alignment_pending",
    },
  });
  assertDesignView({
    view,
    engine: input.engine,
    spec,
    solveResult: input.solveResult,
    choices: input.choices,
    difficulty: input.difficulty,
  });
  return { view, svg: builtAssets.svg };
}

export interface AssertDesignViewInput<S, A> {
  readonly view: unknown;
  readonly engine?: FamilyEngine<S, A>;
  readonly spec?: S;
  readonly solveResult?: SolveResult<A>;
  readonly choices?: ChoiceSet<A>;
  readonly difficulty?: 1 | 2 | 3;
}

export function assertDesignView<S, A>(
  input: AssertDesignViewInput<S, A>,
): DesignView {
  const parsed = DesignViewSchema.safeParse(input.view);
  if (!parsed.success) {
    throw new DesignViewError(
      "INVALID_VIEW",
      "design view does not satisfy the strict schema",
      { cause: parsed.error },
    );
  }
  const view = parsed.data;
  if (
    view.certificate.certificateHash !== computeCertificateHash(view.certificate)
  ) {
    throw new DesignViewError(
      "INVALID_CERTIFICATE",
      "design view certificate hash is invalid",
    );
  }
  if (
    view.certificate.proofTraceHash !==
    sha256Hex(canonicalJson(view.reveal.proofTrace))
  ) {
    throw new DesignViewError(
      "INVALID_CERTIFICATE",
      "design view proof trace hash is invalid",
    );
  }
  if (
    input.engine !== undefined &&
    input.spec !== undefined &&
    input.solveResult !== undefined
  ) {
    const engine = input.engine;
    const spec = input.spec;
    const solveResult = input.solveResult;
    if (view.certificate.specHash !== sha256Hex(canonicalJson(spec))) {
      throw new DesignViewError(
        "INVALID_CERTIFICATE",
        "certificate spec hash does not match the supplied spec",
      );
    }
    if (view.skin !== null) {
      try {
        validatePresentationSkin(
          engine.family,
          spec as unknown as FamilySpec,
          view.skin,
        );
      } catch (error) {
        if (error instanceof DesignerSkinError) {
          throw new DesignViewError("INVALID_SKIN", error.message, {
            cause: error,
          });
        }
        throw error;
      }
    }
    if (
      input.choices !== undefined &&
      view.certificate.choicesHash !== sha256Hex(canonicalJson(input.choices))
    ) {
      throw new DesignViewError(
        "INVALID_CERTIFICATE",
        "certificate choices hash does not match the supplied choices",
      );
    }
    const rules = engine.visibleRules(spec);
    const facts = engine.facts(spec);
    const expectedClues =
      engine.modality === "text"
        ? facts.map((fact) => ({ factId: fact.factId, text: fact.text }))
        : [];
    const expectedOptions =
      input.choices === undefined
        ? null
        : input.choices.choices.map((choice) => ({
            label: choice.label,
            text: formatOptionText(
              engine.family,
              choice.label,
              choice.value,
            ),
          }));
    const expectedLabels = neutralLabelsForSpec(
      engine.family,
      spec as unknown as FamilySpec,
    );
    if (
      view.visible.question !== rules.target ||
      canonicalJson(view.visible.rules) !== canonicalJson(rules) ||
      canonicalJson(view.visible.clues) !== canonicalJson(expectedClues) ||
      (expectedOptions !== null &&
        canonicalJson(view.visible.options) !== canonicalJson(expectedOptions)) ||
      canonicalJson(view.neutralLabels) !== canonicalJson(expectedLabels)
    ) {
      throw new DesignViewError(
        "INVALID_VIEW",
        "visible payload does not match the supplied spec and choices",
      );
    }
    if (
      input.difficulty !== undefined &&
      view.visible.title !==
        `${FAMILY_TITLES[engine.family]} - Level ${input.difficulty}`
    ) {
      throw new DesignViewError(
        "INVALID_VIEW",
        "visible title does not match the supplied difficulty",
      );
    }
    if (
      solveResult.correctAnswer !== null &&
      sha256Hex(canonicalJson(view.reveal.correctValue)) !==
        sha256Hex(canonicalJson(solveResult.correctAnswer))
    ) {
      throw new DesignViewError(
        "INVALID_VIEW",
        "reveal answer does not match the supplied solve result",
      );
    }
    if (input.choices !== undefined) {
      const correctChoice = input.choices.choices.find(
        (choice) => choice.label === input.choices?.correctLabel,
      );
      if (
        view.reveal.correctLabel !== input.choices.correctLabel ||
        correctChoice === undefined ||
        canonicalJson(correctChoice.value) !==
          canonicalJson(view.reveal.correctValue)
      ) {
        throw new DesignViewError(
          "INVALID_VIEW",
          "reveal answer does not match the supplied choices",
        );
      }
    }
    try {
      assertProofTrace({
        trace: view.reveal.proofTrace,
        engine,
        spec,
        solveResult,
      });
    } catch (error) {
      throw new DesignViewError("PROOF_TRACE", "proof trace verification failed", {
        cause: error,
      });
    }
  }
  return view;
}

export function toPublicDesignView(view: DesignView): PublicDesignView {
  return PublicDesignViewSchema.parse({
    version: view.version,
    viewId: view.visible.viewId,
    family: view.visible.family,
    modality: view.visible.modality,
    title: view.visible.title,
    question: view.visible.question,
    rules: view.visible.rules,
    clues: view.visible.clues,
    options: view.visible.options,
    assets: view.visible.assets,
    templateVersion: view.templateVersion,
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderDesignViewGallery(
  entries: readonly BuiltDesignView[],
): string {
  const cards = entries
    .map(({ view, svg }) => {
      const clues = view.visible.clues
        .map((clue) => `<li>${escapeHtml(clue.text)}</li>`)
        .join("");
      const options = view.visible.options
        .map(
          (option) =>
            `<li><strong>${escapeHtml(option.label)}</strong>: ${escapeHtml(option.text)}</li>`,
        )
        .join("");
      const steps = view.reveal.explanationSteps
        .map((step) => `<li>${escapeHtml(step.text)}</li>`)
        .join("");
      const operations = view.visible.rules.operations
        .map((operation) => `<li>${escapeHtml(operation)}</li>`)
        .join("");
      const conventions = view.visible.rules.conventions
        .map((convention) => `<li>${escapeHtml(convention)}</li>`)
        .join("");
      return `<article class="card">
<h2>${escapeHtml(view.visible.title)}</h2>
<p class="muted">${escapeHtml(view.visible.family)} / ${escapeHtml(view.visible.modality)} / ${escapeHtml(view.visible.viewId)}</p>
<p>${escapeHtml(view.visible.question)}</p>
<p class="muted">${escapeHtml(view.visible.rules.domain)} ${escapeHtml(view.visible.rules.closedWorld)}</p>
<h3>Operations</h3><ul>${operations}</ul>
<h3>Conventions</h3><ul>${conventions}</ul>
${svg === null ? "" : `<div class="scene">${svg}</div>`}
${clues === "" ? "" : `<h3>Clues</h3><ul>${clues}</ul>`}
<h3>Options</h3><ul>${options}</ul>
<details><summary>Reveal (gallery only)</summary>
<p><strong>Hint:</strong> ${escapeHtml(view.reveal.hint)}</p>
<ol>${steps}</ol>
</details>
</article>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>P49 deterministic design view</title>
<style>
body{font-family:system-ui,sans-serif;margin:1.5rem;color:#17202a;background:#fbfcfd}
h1{font-size:1.5rem}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:.75rem}
.card{border:1px solid #d5dbe1;border-radius:.5rem;padding:.75rem;background:#fff}
.scene svg{max-width:100%;height:auto}.muted{color:#5b6773;font-size:.8rem}
</style>
</head>
<body>
<h1>P49 deterministic design view</h1>
<p>Question, rules, clues, options, hint, and explanation are code-owned. The reveal is gallery-only, not a public solving DTO.</p>
<div class="cards">${cards}</div>
</body>
</html>
`;
}
