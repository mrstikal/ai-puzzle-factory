import { z } from "zod";
import { HashCounterPrng } from "../util/random.js";

export const CHOICE_LABELS = ["A", "B", "C", "D"] as const;
export type ChoiceLabel = (typeof CHOICE_LABELS)[number];
export const ChoiceLabelSchema = z.enum(CHOICE_LABELS);

export interface Choice<T> {
  readonly label: ChoiceLabel;
  readonly value: T;
}

export type FourChoices<T> = readonly [
  Choice<T>,
  Choice<T>,
  Choice<T>,
  Choice<T>,
];

export interface ChoiceSet<T> {
  readonly choices: FourChoices<T>;
  readonly correctLabel: ChoiceLabel;
}

export type AnswerContractErrorCode =
  | "DUPLICATE_OPTION"
  | "INVALID_CHOICE_COUNT"
  | "INVALID_CHOICE_LABELS"
  | "CORRECT_OPTION_MISSING"
  | "INVALID_CORRECT_LABEL"
  | "INVALID_CHOICE_SET";

export class AnswerContractError extends Error {
  readonly code: AnswerContractErrorCode;

  constructor(code: AnswerContractErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AnswerContractError";
    this.code = code;
  }
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (
    typeof left !== "object" ||
    typeof right !== "object" ||
    left === null ||
    right === null
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => deepEqual(item, right[index]));
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (let index = 0; index < leftKeys.length; index += 1) {
    if (leftKeys[index] !== rightKeys[index]) {
      return false;
    }
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  return leftKeys.every((key) => deepEqual(leftRecord[key], rightRecord[key]));
}

function assertDistinctChoiceValues(values: readonly unknown[]): void {
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      if (deepEqual(values[left], values[right])) {
        throw new AnswerContractError(
          "DUPLICATE_OPTION",
          `choice values at indices ${left} and ${right} are deeply equal`,
        );
      }
    }
  }
}

export interface MakeChoiceSetInput<T> {
  readonly correct: T;
  readonly distractors: readonly [T, T, T];
  readonly seed: string;
}

export function makeChoiceSet<T>(input: MakeChoiceSetInput<T>): ChoiceSet<T> {
  const { correct, distractors, seed } = input;
  if (distractors.length !== 3) {
    throw new AnswerContractError(
      "INVALID_CHOICE_COUNT",
      `exactly three distractors are required, received ${distractors.length}`,
    );
  }

  const values: readonly [T, T, T, T] = [correct, distractors[0], distractors[1], distractors[2]];
  assertDistinctChoiceValues(values);

  const shuffled = new HashCounterPrng(seed).shuffle(values);
  const first = shuffled[0];
  const second = shuffled[1];
  const third = shuffled[2];
  const fourth = shuffled[3];
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
    throw new AnswerContractError("INVALID_CHOICE_COUNT", "shuffled choice list is incomplete");
  }

  const choices: FourChoices<T> = [
    { label: "A", value: first },
    { label: "B", value: second },
    { label: "C", value: third },
    { label: "D", value: fourth },
  ];

  const correctIndex = choices.findIndex((choice) => deepEqual(choice.value, correct));
  if (correctIndex < 0) {
    throw new AnswerContractError(
      "CORRECT_OPTION_MISSING",
      "the correct value is absent from the shuffled choices",
    );
  }
  const correctLabel = CHOICE_LABELS[correctIndex];
  if (correctLabel === undefined) {
    throw new AnswerContractError("INVALID_CORRECT_LABEL", "the correct label index is out of range");
  }

  return { choices, correctLabel };
}

export const ChoiceSchema = z.strictObject({
  label: ChoiceLabelSchema,
  value: z.unknown(),
});

export const ChoiceSetSchema = z
  .strictObject({
    choices: z.tuple([ChoiceSchema, ChoiceSchema, ChoiceSchema, ChoiceSchema]),
    correctLabel: ChoiceLabelSchema,
  })
  .superRefine((set, ctx) => {
    const labels = set.choices.map((choice) => choice.label);
    for (let index = 0; index < CHOICE_LABELS.length; index += 1) {
      if (labels[index] !== CHOICE_LABELS[index]) {
        ctx.addIssue({
          code: "custom",
          path: ["choices", index, "label"],
          message: `expected label ${CHOICE_LABELS[index]}`,
        });
      }
    }
    for (let left = 0; left < set.choices.length; left += 1) {
      for (let right = left + 1; right < set.choices.length; right += 1) {
        if (deepEqual(set.choices[left]?.value, set.choices[right]?.value)) {
          ctx.addIssue({
            code: "custom",
            path: ["choices", right, "value"],
            message: `choice value duplicates choice ${left}`,
          });
        }
      }
    }
    const matchingLabels = set.choices.filter((choice) => choice.label === set.correctLabel);
    if (matchingLabels.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["correctLabel"],
        message: "the correct label must identify exactly one choice",
      });
    }
  });

export type ParsedChoiceSet = z.infer<typeof ChoiceSetSchema>;

export function assertChoiceSet<T>(set: ChoiceSet<T>): void {
  ChoiceSetSchema.parse(set);
}

export function choiceValue<T>(set: ChoiceSet<T>, label: ChoiceLabel): T {
  const choice = set.choices.find((candidate) => candidate.label === label);
  if (choice === undefined) {
    throw new AnswerContractError("INVALID_CHOICE_LABELS", `choice label ${label} is absent`);
  }
  return choice.value;
}

export function verifyChoiceSet<T>(set: ChoiceSet<T>): void {
  assertChoiceSet(set);
  const selected = choiceValue(set, set.correctLabel);
  const matching = set.choices.filter((choice) => deepEqual(choice.value, selected));
  if (matching.length !== 1) {
    throw new AnswerContractError(
      "INVALID_CORRECT_LABEL",
      "the correct label does not identify a unique choice value",
    );
  }
}
