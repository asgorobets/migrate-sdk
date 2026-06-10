import { Schema } from "effect";
import type {
  NonEmptyUpdateActions,
  UpdateActionBase,
} from "../update-command-builder.ts";

export type UnknownRecord = Readonly<Record<string, unknown>>;

export const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null;

export const isStringRecord = (
  value: unknown
): value is Readonly<Record<string, string>> =>
  isRecord(value) &&
  Object.values(value).every((item) => typeof item === "string");

export const hasOwnField = (value: UnknownRecord, field: string): boolean =>
  Object.hasOwn(value, field);

export const hasStringField = (value: UnknownRecord, field: string): boolean =>
  typeof value[field] === "string" && value[field] !== "";

export const isResourceIdentifier =
  (typeId: string) =>
  (value: unknown): boolean => {
    if (!isRecord(value) || value.typeId !== typeId) {
      return false;
    }

    const hasId = hasOwnField(value, "id");
    const hasKey = hasOwnField(value, "key");

    if (hasId === hasKey) {
      return false;
    }

    return hasId ? hasStringField(value, "id") : hasStringField(value, "key");
  };

export const hasRequiredResourceIdentifier = (
  value: UnknownRecord,
  field: string,
  isExpectedResourceIdentifier: (value: unknown) => boolean
): boolean => isExpectedResourceIdentifier(value[field]);

export const hasOptionalResourceIdentifier = (
  value: UnknownRecord,
  field: string,
  isExpectedResourceIdentifier: (value: unknown) => boolean
): boolean =>
  !Object.hasOwn(value, field) || isExpectedResourceIdentifier(value[field]);

export const hasOptionalResourceIdentifierArray = (
  value: UnknownRecord,
  field: string,
  isExpectedResourceIdentifier: (value: unknown) => boolean
): boolean =>
  !Object.hasOwn(value, field) ||
  (Array.isArray(value[field]) &&
    value[field].every(isExpectedResourceIdentifier));

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isSdkUpdateAction = <Action extends UpdateActionBase>(
  value: unknown
): value is Action => isRecord(value) && hasStringField(value, "action");

export const isNonEmptySdkUpdateActions = <Action extends UpdateActionBase>(
  value: unknown
): value is NonEmptyUpdateActions<Action> =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(isSdkUpdateAction<Action>);

export const NonEmptyStringSchema = Schema.declare<string>(
  (value): value is string => typeof value === "string" && value !== "",
  {
    identifier: "NonEmptyString",
  }
);

export const ResourceVersionSchema = Schema.declare<number>(isPositiveInteger, {
  identifier: "ResourceVersion",
});

export const makeUpdateActionsSchema = <Action extends UpdateActionBase>(
  identifier: string
): Schema.Codec<
  NonEmptyUpdateActions<Action>,
  NonEmptyUpdateActions<Action>,
  never,
  never
> =>
  Schema.declare<NonEmptyUpdateActions<Action>>(
    isNonEmptySdkUpdateActions<Action>,
    {
      identifier,
    }
  );
