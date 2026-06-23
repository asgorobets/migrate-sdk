import { Schema } from "effect";
import type {
  CommercetoolsCustomFieldSchema,
  InventoryEntryCustomFieldsHelper,
} from "./custom-fields.ts";
import {
  makeUpdateActionsSchema,
  ResourceVersionSchema,
} from "./internal/command-schemas.ts";
import type { InventoryEntryUpdateAction } from "./inventory-actions.ts";
import {
  type CommercetoolsInventoryEntrySelector,
  CommercetoolsInventoryEntrySelectorSchema,
} from "./selectors.ts";
import type {
  NonEmptyUpdateActions,
  UpdateInput,
  UpdateWithActionsInput,
} from "./update-action-builder.ts";

export type NonEmptyInventoryEntryUpdateActions<
  Action extends InventoryEntryUpdateAction = InventoryEntryUpdateAction,
> = NonEmptyUpdateActions<Action>;

export type InventoryEntryUpdateInput =
  UpdateInput<CommercetoolsInventoryEntrySelector>;

export type InventoryEntryUpdateWithActionsInput<
  Action extends InventoryEntryUpdateAction = InventoryEntryUpdateAction,
> = UpdateWithActionsInput<CommercetoolsInventoryEntrySelector, Action>;

export interface CommercetoolsInventoryEntryHelpers<
  InventoryEntryCustomFieldSchema extends
    | CommercetoolsCustomFieldSchema
    | never,
> {
  readonly customFields: InventoryEntryCustomFieldsHelper<InventoryEntryCustomFieldSchema>;
}

export const InventoryEntryUpdateActionsSchema =
  makeUpdateActionsSchema<InventoryEntryUpdateAction>(
    "InventoryEntryUpdateActions"
  );

export const InventoryEntryUpdateWithActionsInputSchema = Schema.Struct({
  actions: InventoryEntryUpdateActionsSchema,
  selector: CommercetoolsInventoryEntrySelectorSchema,
  version: ResourceVersionSchema,
});
