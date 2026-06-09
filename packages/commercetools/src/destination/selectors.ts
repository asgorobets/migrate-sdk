import { Schema } from "effect";
import { NonEmptyStringSchema } from "./internal/command-schemas.ts";

export type CommercetoolsResourceSelector =
  | {
      readonly id: string;
      readonly kind: "id";
    }
  | {
      readonly key: string;
      readonly kind: "key";
    };

export type CommercetoolsBusinessUnitSelector = CommercetoolsResourceSelector;

export type CommercetoolsCustomerSelector = CommercetoolsResourceSelector;

export type CommercetoolsProductSelector = CommercetoolsResourceSelector;

export const CommercetoolsResourceSelectorSchema = Schema.Union([
  Schema.Struct({
    id: NonEmptyStringSchema,
    kind: Schema.Literal("id"),
  }),
  Schema.Struct({
    key: NonEmptyStringSchema,
    kind: Schema.Literal("key"),
  }),
]);

export const CommercetoolsBusinessUnitSelectorSchema =
  CommercetoolsResourceSelectorSchema;

export const CommercetoolsCustomerSelectorSchema =
  CommercetoolsResourceSelectorSchema;

export const CommercetoolsProductSelectorSchema =
  CommercetoolsResourceSelectorSchema;
