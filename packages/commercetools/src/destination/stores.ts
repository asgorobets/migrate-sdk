import type { StoreDraft } from "@commercetools/platform-sdk";
import { Schema } from "effect";
import {
  hasStringField,
  isRecord,
  makeUpdateActionsSchema,
  ResourceVersionSchema,
} from "./internal/command-schemas.ts";
import {
  type CommercetoolsStoreSelector,
  CommercetoolsStoreSelectorSchema,
} from "./selectors.ts";
import type { StoreUpdateAction } from "./store-actions.ts";
import {
  type EmptyUpdateActionBuilder,
  makeUpdateActionFactory,
  type NonEmptyUpdateActions,
  type UpdateActionBuilder,
  type UpdateActionFactory,
  type UpdateInput,
  type UpdateWithActionsInput,
} from "./update-action-builder.ts";

export type NonEmptyStoreUpdateActions<
  Action extends StoreUpdateAction = StoreUpdateAction,
> = NonEmptyUpdateActions<Action>;

export type StoreUpdateInput = UpdateInput<CommercetoolsStoreSelector>;

export type StoreUpdateWithActionsInput<
  Action extends StoreUpdateAction = StoreUpdateAction,
> = UpdateWithActionsInput<CommercetoolsStoreSelector, Action>;

export type EmptyStoreUpdateActionBuilder = EmptyUpdateActionBuilder<
  CommercetoolsStoreSelector,
  StoreUpdateAction
>;

export type StoreUpdateActionBuilder<
  Action extends StoreUpdateAction = StoreUpdateAction,
> = UpdateActionBuilder<CommercetoolsStoreSelector, StoreUpdateAction, Action>;

export type StoreUpdateFactory = UpdateActionFactory<
  CommercetoolsStoreSelector,
  StoreUpdateAction
>;

const isStoreDraft = (value: unknown): value is StoreDraft =>
  isRecord(value) && hasStringField(value, "key");

export const StoreDraftSchema = Schema.declare<StoreDraft>(isStoreDraft, {
  identifier: "StoreDraft",
});

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

export const makeStoreUpdate = makeUpdateActionFactory<
  CommercetoolsStoreSelector,
  StoreUpdateAction
>({
  label: "Store update",
});
