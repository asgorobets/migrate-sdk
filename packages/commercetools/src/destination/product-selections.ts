import type { ProductSelectionDraft } from "@commercetools/platform-sdk";
import { Schema } from "effect";
import {
  isRecord,
  isStringRecord,
  makeUpdateActionsSchema,
  ResourceVersionSchema,
} from "./internal/command-schemas.ts";
import type { ProductSelectionUpdateAction } from "./product-selection-actions.ts";
import {
  type CommercetoolsProductSelectionSelector,
  CommercetoolsProductSelectionSelectorSchema,
} from "./selectors.ts";
import {
  type EmptyUpdateActionBuilder,
  makeUpdateActionFactory,
  type NonEmptyUpdateActions,
  type UpdateActionBuilder,
  type UpdateActionFactory,
  type UpdateInput,
  type UpdateWithActionsInput,
} from "./update-action-builder.ts";

export type NonEmptyProductSelectionUpdateActions<
  Action extends ProductSelectionUpdateAction = ProductSelectionUpdateAction,
> = NonEmptyUpdateActions<Action>;

export type ProductSelectionUpdateInput =
  UpdateInput<CommercetoolsProductSelectionSelector>;

export type ProductSelectionUpdateWithActionsInput<
  Action extends ProductSelectionUpdateAction = ProductSelectionUpdateAction,
> = UpdateWithActionsInput<CommercetoolsProductSelectionSelector, Action>;

export type EmptyProductSelectionUpdateActionBuilder = EmptyUpdateActionBuilder<
  CommercetoolsProductSelectionSelector,
  ProductSelectionUpdateAction
>;

export type ProductSelectionUpdateActionBuilder<
  Action extends ProductSelectionUpdateAction = ProductSelectionUpdateAction,
> = UpdateActionBuilder<
  CommercetoolsProductSelectionSelector,
  ProductSelectionUpdateAction,
  Action
>;

export type ProductSelectionUpdateFactory = UpdateActionFactory<
  CommercetoolsProductSelectionSelector,
  ProductSelectionUpdateAction
>;

const isProductSelectionDraft = (
  value: unknown
): value is ProductSelectionDraft =>
  isRecord(value) && isStringRecord(value.name);

export const ProductSelectionDraftSchema =
  Schema.declare<ProductSelectionDraft>(isProductSelectionDraft, {
    identifier: "ProductSelectionDraft",
  });

export const ProductSelectionUpdateActionsSchema =
  makeUpdateActionsSchema<ProductSelectionUpdateAction>(
    "ProductSelectionUpdateActions"
  );

export const ProductSelectionUpdateWithActionsInputSchema = Schema.Struct({
  actions: ProductSelectionUpdateActionsSchema,
  selector: CommercetoolsProductSelectionSelectorSchema,
  version: ResourceVersionSchema,
});

export const makeProductSelectionUpdate = makeUpdateActionFactory<
  CommercetoolsProductSelectionSelector,
  ProductSelectionUpdateAction
>({
  label: "Product selection update",
});
