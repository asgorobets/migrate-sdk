import { Schema } from "effect";
import type {
  CommercetoolsCustomFieldSchema,
  ProductSelectionCustomFieldsHelper,
} from "./custom-fields.ts";
import {
  makeUpdateActionsSchema,
  ResourceVersionSchema,
} from "./internal/command-schemas.ts";
import type { ProductSelectionUpdateAction } from "./product-selection-actions.ts";
import {
  type CommercetoolsProductSelectionSelector,
  CommercetoolsProductSelectionSelectorSchema,
} from "./selectors.ts";
import type {
  NonEmptyUpdateActions,
  UpdateInput,
  UpdateWithActionsInput,
} from "./update-action-builder.ts";

export type NonEmptyProductSelectionUpdateActions<
  Action extends ProductSelectionUpdateAction = ProductSelectionUpdateAction,
> = NonEmptyUpdateActions<Action>;

export type ProductSelectionUpdateInput =
  UpdateInput<CommercetoolsProductSelectionSelector>;

export type ProductSelectionUpdateWithActionsInput<
  Action extends ProductSelectionUpdateAction = ProductSelectionUpdateAction,
> = UpdateWithActionsInput<CommercetoolsProductSelectionSelector, Action>;

export interface CommercetoolsProductSelectionHelpers<
  ProductSelectionCustomFieldSchema extends
    | CommercetoolsCustomFieldSchema
    | never,
> {
  readonly customFields: ProductSelectionCustomFieldsHelper<ProductSelectionCustomFieldSchema>;
}

export const ProductSelectionUpdateActionsSchema =
  makeUpdateActionsSchema<ProductSelectionUpdateAction>(
    "ProductSelectionUpdateActions"
  );

export const ProductSelectionUpdateWithActionsInputSchema = Schema.Struct({
  actions: ProductSelectionUpdateActionsSchema,
  selector: CommercetoolsProductSelectionSelectorSchema,
  version: ResourceVersionSchema,
});
