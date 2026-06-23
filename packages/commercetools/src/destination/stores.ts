import { Schema } from "effect";
import type {
  CommercetoolsCustomFieldSchema,
  StoreCustomFieldsHelper,
} from "./custom-fields.ts";
import {
  makeUpdateActionsSchema,
  ResourceVersionSchema,
} from "./internal/command-schemas.ts";
import {
  type CommercetoolsStoreSelector,
  CommercetoolsStoreSelectorSchema,
} from "./selectors.ts";
import type { StoreUpdateAction } from "./store-actions.ts";
import type {
  NonEmptyUpdateActions,
  UpdateInput,
  UpdateWithActionsInput,
} from "./update-action-builder.ts";

export type NonEmptyStoreUpdateActions<
  Action extends StoreUpdateAction = StoreUpdateAction,
> = NonEmptyUpdateActions<Action>;

export type StoreUpdateInput = UpdateInput<CommercetoolsStoreSelector>;

export type StoreUpdateWithActionsInput<
  Action extends StoreUpdateAction = StoreUpdateAction,
> = UpdateWithActionsInput<CommercetoolsStoreSelector, Action>;

export interface CommercetoolsStorePureHelpers<
  StoreCustomFieldSchema extends CommercetoolsCustomFieldSchema | never,
> {
  readonly customFields: StoreCustomFieldsHelper<StoreCustomFieldSchema>;
}

export const StoreUpdateActionsSchema =
  makeUpdateActionsSchema<StoreUpdateAction>("StoreUpdateActions");

export const StoreUpdateWithActionsInputSchema = Schema.Struct({
  actions: StoreUpdateActionsSchema,
  selector: CommercetoolsStoreSelectorSchema,
  version: ResourceVersionSchema,
});

export const StoreProductSelectionAssignmentInputSchema = Schema.Struct({
  productSelection: Schema.Union([
    Schema.Struct({
      id: Schema.NonEmptyString,
      typeId: Schema.Literal("product-selection"),
    }),
    Schema.Struct({
      key: Schema.NonEmptyString,
      typeId: Schema.Literal("product-selection"),
    }),
  ]),
  selector: CommercetoolsStoreSelectorSchema,
  version: ResourceVersionSchema,
});

export interface StoreProductSelectionAssignmentInput {
  readonly productSelection:
    | {
        readonly id: string;
        readonly typeId: "product-selection";
      }
    | {
        readonly key: string;
        readonly typeId: "product-selection";
      };
  readonly selector: CommercetoolsStoreSelector;
  readonly version: number;
}
