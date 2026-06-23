import { Schema } from "effect";
import type { BusinessUnitUpdateAction } from "./business-unit-actions.ts";
import type {
  BusinessUnitCustomFieldsHelper,
  CommercetoolsCustomFieldSchema,
} from "./custom-fields.ts";
import {
  makeUpdateActionsSchema,
  ResourceVersionSchema,
} from "./internal/command-schemas.ts";
import {
  type CommercetoolsBusinessUnitSelector,
  CommercetoolsBusinessUnitSelectorSchema,
} from "./selectors.ts";
import type {
  NonEmptyUpdateActions,
  UpdateInput,
  UpdateWithActionsInput,
} from "./update-action-builder.ts";

export type NonEmptyBusinessUnitUpdateActions<
  Action extends BusinessUnitUpdateAction = BusinessUnitUpdateAction,
> = NonEmptyUpdateActions<Action>;

export type BusinessUnitUpdateInput =
  UpdateInput<CommercetoolsBusinessUnitSelector>;

export type BusinessUnitUpdateWithActionsInput<
  Action extends BusinessUnitUpdateAction = BusinessUnitUpdateAction,
> = UpdateWithActionsInput<CommercetoolsBusinessUnitSelector, Action>;

export interface CommercetoolsBusinessUnitHelpers<
  BusinessUnitCustomFieldSchema extends CommercetoolsCustomFieldSchema | never,
> {
  readonly customFields: BusinessUnitCustomFieldsHelper<BusinessUnitCustomFieldSchema>;
}

export const BusinessUnitUpdateActionsSchema =
  makeUpdateActionsSchema<BusinessUnitUpdateAction>(
    "BusinessUnitUpdateActions"
  );

export const BusinessUnitUpdateWithActionsInputSchema = Schema.Struct({
  actions: BusinessUnitUpdateActionsSchema,
  selector: CommercetoolsBusinessUnitSelectorSchema,
  version: ResourceVersionSchema,
});
