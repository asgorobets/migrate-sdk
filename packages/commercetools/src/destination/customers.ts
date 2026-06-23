import { Schema } from "effect";
import type {
  CommercetoolsCustomFieldSchema,
  CustomerCustomFieldsHelper,
} from "./custom-fields.ts";
import type { CustomerUpdateAction } from "./customer-actions.ts";
import {
  makeUpdateActionsSchema,
  ResourceVersionSchema,
} from "./internal/command-schemas.ts";
import {
  type CommercetoolsCustomerSelector,
  CommercetoolsCustomerSelectorSchema,
} from "./selectors.ts";
import type {
  NonEmptyUpdateActions,
  UpdateInput,
  UpdateWithActionsInput,
} from "./update-action-builder.ts";

export type NonEmptyCustomerUpdateActions<
  Action extends CustomerUpdateAction = CustomerUpdateAction,
> = NonEmptyUpdateActions<Action>;

export type CustomerUpdateInput = UpdateInput<CommercetoolsCustomerSelector>;

export type CustomerUpdateWithActionsInput<
  Action extends CustomerUpdateAction = CustomerUpdateAction,
> = UpdateWithActionsInput<CommercetoolsCustomerSelector, Action>;

export interface CommercetoolsCustomerHelpers<
  CustomerCustomFieldSchema extends CommercetoolsCustomFieldSchema | never,
> {
  readonly customFields: CustomerCustomFieldsHelper<CustomerCustomFieldSchema>;
}

export const CustomerUpdateActionsSchema =
  makeUpdateActionsSchema<CustomerUpdateAction>("CustomerUpdateActions");

export const CustomerUpdateWithActionsInputSchema = Schema.Struct({
  actions: CustomerUpdateActionsSchema,
  selector: CommercetoolsCustomerSelectorSchema,
  version: ResourceVersionSchema,
});
