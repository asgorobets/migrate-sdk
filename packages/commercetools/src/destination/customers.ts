import type {
  Customer,
  CustomerDraft,
  CustomerUpdate,
} from "@commercetools/platform-sdk";
import { Effect, Schema } from "effect";
import {
  type DestinationCommandHandler,
  defineDestinationCommand,
  defineDestinationCommandGroup,
} from "migrate-sdk";
import { CommercetoolsSdk } from "../sdk.ts";
import type { CustomerUpdateAction } from "./customer-actions.ts";
import {
  hasStringField,
  isRecord,
  makeUpdateActionsSchema,
  ResourceVersionSchema,
} from "./internal/command-schemas.ts";
import { toDestinationPluginError } from "./internal/plugin-errors.ts";
import {
  type CommercetoolsCustomerSelector,
  CommercetoolsCustomerSelectorSchema,
} from "./selectors.ts";
import {
  type EmptyUpdateActionBuilder,
  makeUpdateCommandFactory,
  type NonEmptyUpdateActions,
  type UpdateActionBuilder,
  type UpdateCommandFactory,
  type UpdateCommandShape,
  type UpdateInput,
  type UpdateWithActionsInput,
} from "./update-command-builder.ts";

export interface CreateCustomerDraftCommand {
  readonly draft: CustomerDraft;
  readonly kind: "CreateCustomerDraft";
}

export type NonEmptyCustomerUpdateActions<
  Action extends CustomerUpdateAction = CustomerUpdateAction,
> = NonEmptyUpdateActions<Action>;

export type CustomerUpdateCommandShape<
  Action extends CustomerUpdateAction = CustomerUpdateAction,
> = UpdateCommandShape<"UpdateCustomer", CommercetoolsCustomerSelector, Action>;

export type CustomerUpdateInput = UpdateInput<CommercetoolsCustomerSelector>;

export type CustomerUpdateWithActionsInput<
  Action extends CustomerUpdateAction = CustomerUpdateAction,
> = UpdateWithActionsInput<CommercetoolsCustomerSelector, Action>;

export type EmptyCustomerUpdateActionBuilder = EmptyUpdateActionBuilder<
  "UpdateCustomer",
  CommercetoolsCustomerSelector,
  CustomerUpdateAction
>;

export type CustomerUpdateActionBuilder<
  Action extends CustomerUpdateAction = CustomerUpdateAction,
> = UpdateActionBuilder<
  "UpdateCustomer",
  CommercetoolsCustomerSelector,
  CustomerUpdateAction,
  Action
>;

export type CustomerUpdateFactory = UpdateCommandFactory<
  "UpdateCustomer",
  CommercetoolsCustomerSelector,
  CustomerUpdateAction
>;

export type UpdateCustomerCommand = CustomerUpdateCommandShape;

export interface CommercetoolsCustomerCommands {
  readonly createDraft: (draft: CustomerDraft) => CreateCustomerDraftCommand;
  readonly update: CustomerUpdateFactory;
}

const isCustomerDraft = (value: unknown): value is CustomerDraft =>
  isRecord(value) && hasStringField(value, "email");

const CustomerDraftSchema = Schema.declare<CustomerDraft>(isCustomerDraft, {
  identifier: "CustomerDraft",
});

const CustomerUpdateActionsSchema =
  makeUpdateActionsSchema<CustomerUpdateAction>("CustomerUpdateActions");

export const CreateCustomerDraftCommand: Schema.Codec<
  CreateCustomerDraftCommand,
  CreateCustomerDraftCommand,
  never,
  never
> = Schema.Struct({
  draft: CustomerDraftSchema,
  kind: Schema.Literal("CreateCustomerDraft"),
});

export const UpdateCustomerCommand: Schema.Codec<
  UpdateCustomerCommand,
  UpdateCustomerCommand,
  never,
  never
> = Schema.Struct({
  actions: CustomerUpdateActionsSchema,
  kind: Schema.Literal("UpdateCustomer"),
  selector: CommercetoolsCustomerSelectorSchema,
  version: ResourceVersionSchema,
});

export const makeCustomerUpdate = makeUpdateCommandFactory<
  "UpdateCustomer",
  CommercetoolsCustomerSelector,
  CustomerUpdateAction
>({
  kind: "UpdateCustomer",
  label: "Customer update",
});

export const makeCreateCustomerDraftCommand = (
  draft: CustomerDraft
): CreateCustomerDraftCommand => ({
  draft,
  kind: "CreateCustomerDraft",
});

export const createCustomerDraftCommand = defineDestinationCommand(
  "CreateCustomerDraft",
  {
    identity: true,
    make: {
      createDraft: makeCreateCustomerDraftCommand,
    },
    schema: CreateCustomerDraftCommand,
  }
);

export const updateCustomerCommand = defineDestinationCommand(
  "UpdateCustomer",
  {
    identity: false,
    schema: UpdateCustomerCommand,
  }
);

export const customerCommandGroup = defineDestinationCommandGroup(
  "customers"
).add(createCustomerDraftCommand, updateCustomerCommand);

export const makeCommercetoolsCustomerCommands =
  (): CommercetoolsCustomerCommands => ({
    createDraft: makeCreateCustomerDraftCommand,
    update: makeCustomerUpdate,
  });

const customerMetadata = (
  customer: Customer
): Record<string, number | string> => ({
  ...(customer.key === undefined ? {} : { customerKey: customer.key }),
  customerEmail: customer.email,
  customerVersion: customer.version,
});

export const handleCreateCustomerDraft: DestinationCommandHandler<
  typeof createCustomerDraftCommand,
  CommercetoolsSdk
> = ({ command }) =>
  Effect.gen(function* () {
    const sdk = yield* CommercetoolsSdk;
    const result = yield* sdk
      .request("customers.createDraft", (project) =>
        project.customers().post({
          body: command.draft,
        })
      )
      .pipe(Effect.mapError(toDestinationPluginError));
    const customer = result.customer;

    return {
      destinationIdentity: customer.id,
      destinationVersion: String(customer.version),
      metadata: customerMetadata(customer),
    };
  });

export const handleUpdateCustomer: DestinationCommandHandler<
  typeof updateCustomerCommand,
  CommercetoolsSdk
> = ({ command }) =>
  Effect.gen(function* () {
    const sdk = yield* CommercetoolsSdk;
    const body: CustomerUpdate = {
      actions: [...command.actions],
      version: command.version,
    };
    const customer = yield* sdk
      .request("customers.update", (project) => {
        const customers = project.customers();
        const selectedCustomer =
          command.selector.kind === "id"
            ? customers.withId({ ID: command.selector.id })
            : customers.withKey({
                key: command.selector.key,
              });

        return selectedCustomer.post({
          body,
        });
      })
      .pipe(Effect.mapError(toDestinationPluginError));

    return {
      destinationIdentity: customer.id,
      destinationVersion: String(customer.version),
      metadata: customerMetadata(customer),
    };
  });
