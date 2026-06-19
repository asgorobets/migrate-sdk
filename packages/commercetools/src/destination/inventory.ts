import type { InventoryEntryDraft } from "@commercetools/platform-sdk";
import { Schema } from "effect";
import {
  hasStringField,
  isRecord,
  makeUpdateActionsSchema,
  ResourceVersionSchema,
} from "./internal/command-schemas.ts";
import type { InventoryEntryUpdateAction } from "./inventory-actions.ts";
import {
  type CommercetoolsInventoryEntrySelector,
  CommercetoolsInventoryEntrySelectorSchema,
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

export type NonEmptyInventoryEntryUpdateActions<
  Action extends InventoryEntryUpdateAction = InventoryEntryUpdateAction,
> = NonEmptyUpdateActions<Action>;

export type InventoryEntryUpdateInput =
  UpdateInput<CommercetoolsInventoryEntrySelector>;

export type InventoryEntryUpdateWithActionsInput<
  Action extends InventoryEntryUpdateAction = InventoryEntryUpdateAction,
> = UpdateWithActionsInput<CommercetoolsInventoryEntrySelector, Action>;

export type EmptyInventoryEntryUpdateActionBuilder = EmptyUpdateActionBuilder<
  CommercetoolsInventoryEntrySelector,
  InventoryEntryUpdateAction
>;

export type InventoryEntryUpdateActionBuilder<
  Action extends InventoryEntryUpdateAction = InventoryEntryUpdateAction,
> = UpdateActionBuilder<
  CommercetoolsInventoryEntrySelector,
  InventoryEntryUpdateAction,
  Action
>;

export type InventoryEntryUpdateFactory = UpdateActionFactory<
  CommercetoolsInventoryEntrySelector,
  InventoryEntryUpdateAction
>;

const isInventoryEntryDraft = (value: unknown): value is InventoryEntryDraft =>
  isRecord(value) &&
  hasStringField(value, "sku") &&
  typeof value.quantityOnStock === "number";

export const InventoryEntryDraftSchema = Schema.declare<InventoryEntryDraft>(
  isInventoryEntryDraft,
  {
    identifier: "InventoryEntryDraft",
  }
);

export const InventoryEntryUpdateActionsSchema =
  makeUpdateActionsSchema<InventoryEntryUpdateAction>(
    "InventoryEntryUpdateActions"
  );

export const InventoryEntryUpdateWithActionsInputSchema = Schema.Struct({
  actions: InventoryEntryUpdateActionsSchema,
  selector: CommercetoolsInventoryEntrySelectorSchema,
  version: ResourceVersionSchema,
});

export const makeInventoryEntryUpdate = makeUpdateActionFactory<
  CommercetoolsInventoryEntrySelector,
  InventoryEntryUpdateAction
>({
  label: "Inventory entry update",
});
