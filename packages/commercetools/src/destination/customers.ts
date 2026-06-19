import type { CustomerDraft } from "@commercetools/platform-sdk";
import { Schema } from "effect";
import type { CustomerUpdateAction } from "./customer-actions.ts";
import {
  hasStringField,
  isRecord,
  makeUpdateActionsSchema,
  ResourceVersionSchema,
} from "./internal/command-schemas.ts";
import {
  type CommercetoolsCustomerSelector,
  CommercetoolsCustomerSelectorSchema,
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

export type NonEmptyCustomerUpdateActions<
  Action extends CustomerUpdateAction = CustomerUpdateAction,
> = NonEmptyUpdateActions<Action>;

export type CustomerUpdateInput = UpdateInput<CommercetoolsCustomerSelector>;

export type CustomerUpdateWithActionsInput<
  Action extends CustomerUpdateAction = CustomerUpdateAction,
> = UpdateWithActionsInput<CommercetoolsCustomerSelector, Action>;

export type EmptyCustomerUpdateActionBuilder = EmptyUpdateActionBuilder<
  CommercetoolsCustomerSelector,
  CustomerUpdateAction
>;

export type CustomerUpdateActionBuilder<
  Action extends CustomerUpdateAction = CustomerUpdateAction,
> = UpdateActionBuilder<
  CommercetoolsCustomerSelector,
  CustomerUpdateAction,
  Action
>;

export type CustomerUpdateFactory = UpdateActionFactory<
  CommercetoolsCustomerSelector,
  CustomerUpdateAction
>;

const isCustomerDraft = (value: unknown): value is CustomerDraft =>
  isRecord(value) && hasStringField(value, "email");

export const CustomerDraftSchema = Schema.declare<CustomerDraft>(
  isCustomerDraft,
  {
    identifier: "CustomerDraft",
  }
);

export const CustomerUpdateActionsSchema =
  makeUpdateActionsSchema<CustomerUpdateAction>("CustomerUpdateActions");

export const CustomerUpdateWithActionsInputSchema = Schema.Struct({
  actions: CustomerUpdateActionsSchema,
  selector: CommercetoolsCustomerSelectorSchema,
  version: ResourceVersionSchema,
});

export const makeCustomerUpdate = makeUpdateActionFactory<
  CommercetoolsCustomerSelector,
  CustomerUpdateAction
>({
  label: "Customer update",
});
