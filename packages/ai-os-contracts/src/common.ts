import * as Schema from "effect/Schema";

export const strictParse = { onExcessProperty: "error" as const };

const boundedPattern = (max: number, pattern: RegExp) =>
  Schema.String.check(Schema.isMaxLength(max), Schema.isPattern(pattern));

export const ContractId = boundedPattern(128, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export type ContractId = typeof ContractId.Type;

export const ModelId = boundedPattern(128, /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
export type ModelId = typeof ModelId.Type;

export const Revision = boundedPattern(128, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export type Revision = typeof Revision.Type;

export const ContractText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(8_000),
  Schema.makeFilter((value) =>
    value.trim() === value && value.length > 0 ? true : "Expected non-blank text.",
  ),
);
export type ContractText = typeof ContractText.Type;

export const IsoDateTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/),
);
export type IsoDateTime = typeof IsoDateTime.Type;

export const TaskLink = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2_048),
  Schema.isPattern(/^\S+$/),
);
export type TaskLink = typeof TaskLink.Type;

export const ContractVersion = Schema.Literal("v1");
export type ContractVersion = typeof ContractVersion.Type;
