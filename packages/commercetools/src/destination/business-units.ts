import type {
  BusinessUnit,
  BusinessUnitDraft,
  BusinessUnitUpdate,
} from "@commercetools/platform-sdk";
import { Effect, Schema } from "effect";
import {
  type DestinationCommandHandler,
  defineDestinationCommand,
  defineDestinationCommandGroup,
} from "migrate-sdk";
import { CommercetoolsSdk } from "../sdk.ts";
import type { BusinessUnitUpdateAction } from "./business-unit-actions.ts";
import type {
  BusinessUnitCustomFieldsHelper,
  CommercetoolsCustomFieldSchema,
} from "./custom-fields.ts";
import {
  hasStringField,
  isRecord,
  isResourceIdentifier,
  makeUpdateActionsSchema,
  ResourceVersionSchema,
} from "./internal/command-schemas.ts";
import { toDestinationPluginError } from "./internal/plugin-errors.ts";
import {
  type CommercetoolsBusinessUnitSelector,
  CommercetoolsBusinessUnitSelectorSchema,
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

export interface CreateBusinessUnitDraftCommand {
  readonly draft: BusinessUnitDraft;
  readonly kind: "CreateBusinessUnitDraft";
}

export type NonEmptyBusinessUnitUpdateActions<
  Action extends BusinessUnitUpdateAction = BusinessUnitUpdateAction,
> = NonEmptyUpdateActions<Action>;

export type BusinessUnitUpdateCommandShape<
  Action extends BusinessUnitUpdateAction = BusinessUnitUpdateAction,
> = UpdateCommandShape<
  "UpdateBusinessUnit",
  CommercetoolsBusinessUnitSelector,
  Action
>;

export type BusinessUnitUpdateInput =
  UpdateInput<CommercetoolsBusinessUnitSelector>;

export type BusinessUnitUpdateWithActionsInput<
  Action extends BusinessUnitUpdateAction = BusinessUnitUpdateAction,
> = UpdateWithActionsInput<CommercetoolsBusinessUnitSelector, Action>;

export type EmptyBusinessUnitUpdateActionBuilder = EmptyUpdateActionBuilder<
  "UpdateBusinessUnit",
  CommercetoolsBusinessUnitSelector,
  BusinessUnitUpdateAction
>;

export type BusinessUnitUpdateActionBuilder<
  Action extends BusinessUnitUpdateAction = BusinessUnitUpdateAction,
> = UpdateActionBuilder<
  "UpdateBusinessUnit",
  CommercetoolsBusinessUnitSelector,
  BusinessUnitUpdateAction,
  Action
>;

export type BusinessUnitUpdateFactory = UpdateCommandFactory<
  "UpdateBusinessUnit",
  CommercetoolsBusinessUnitSelector,
  BusinessUnitUpdateAction
>;

export type UpdateBusinessUnitCommand = BusinessUnitUpdateCommandShape;

export interface CommercetoolsBusinessUnitCommands {
  readonly createDraft: (
    draft: BusinessUnitDraft
  ) => CreateBusinessUnitDraftCommand;
  readonly update: BusinessUnitUpdateFactory;
}

export interface CommercetoolsBusinessUnitHelpers<
  BusinessUnitCustomFieldSchema extends CommercetoolsCustomFieldSchema | never,
> {
  readonly customFields: BusinessUnitCustomFieldsHelper<BusinessUnitCustomFieldSchema>;
}

const isBusinessUnitResourceIdentifier = isResourceIdentifier("business-unit");

const isBusinessUnitDraft = (value: unknown): value is BusinessUnitDraft => {
  if (
    !(
      isRecord(value) &&
      hasStringField(value, "key") &&
      hasStringField(value, "name")
    )
  ) {
    return false;
  }

  if (value.unitType === "Company") {
    return true;
  }

  return (
    value.unitType === "Division" &&
    isBusinessUnitResourceIdentifier(value.parentUnit)
  );
};

const BusinessUnitDraftSchema = Schema.declare<BusinessUnitDraft>(
  isBusinessUnitDraft,
  {
    identifier: "BusinessUnitDraft",
  }
);

const BusinessUnitUpdateActionsSchema =
  makeUpdateActionsSchema<BusinessUnitUpdateAction>(
    "BusinessUnitUpdateActions"
  );

export const CreateBusinessUnitDraftCommand: Schema.Codec<
  CreateBusinessUnitDraftCommand,
  CreateBusinessUnitDraftCommand,
  never,
  never
> = Schema.Struct({
  draft: BusinessUnitDraftSchema,
  kind: Schema.Literal("CreateBusinessUnitDraft"),
});

export const UpdateBusinessUnitCommand: Schema.Codec<
  UpdateBusinessUnitCommand,
  UpdateBusinessUnitCommand,
  never,
  never
> = Schema.Struct({
  actions: BusinessUnitUpdateActionsSchema,
  kind: Schema.Literal("UpdateBusinessUnit"),
  selector: CommercetoolsBusinessUnitSelectorSchema,
  version: ResourceVersionSchema,
});

export const makeBusinessUnitUpdate = makeUpdateCommandFactory<
  "UpdateBusinessUnit",
  CommercetoolsBusinessUnitSelector,
  BusinessUnitUpdateAction
>({
  kind: "UpdateBusinessUnit",
  label: "Business unit update",
});

export const createBusinessUnitDraftCommand = defineDestinationCommand(
  "CreateBusinessUnitDraft",
  {
    identity: true,
    make: {
      createDraft: (
        draft: BusinessUnitDraft
      ): CreateBusinessUnitDraftCommand => ({
        draft,
        kind: "CreateBusinessUnitDraft",
      }),
    },
    schema: CreateBusinessUnitDraftCommand,
  }
);

export const updateBusinessUnitCommand = defineDestinationCommand(
  "UpdateBusinessUnit",
  {
    identity: false,
    schema: UpdateBusinessUnitCommand,
  }
);

export const businessUnitCommandGroup = defineDestinationCommandGroup(
  "businessUnits"
).add(createBusinessUnitDraftCommand, updateBusinessUnitCommand);

const businessUnitMetadata = (
  businessUnit: BusinessUnit
): Record<string, number | string> => ({
  businessUnitKey: businessUnit.key,
  businessUnitVersion: businessUnit.version,
});

export const handleCreateBusinessUnitDraft: DestinationCommandHandler<
  typeof createBusinessUnitDraftCommand,
  CommercetoolsSdk
> = ({ command }) =>
  Effect.gen(function* () {
    const sdk = yield* CommercetoolsSdk;
    const businessUnit = yield* sdk
      .request("businessUnits.createDraft", (project) =>
        project.businessUnits().post({
          body: command.draft,
        })
      )
      .pipe(Effect.mapError(toDestinationPluginError));

    return {
      destinationIdentity: businessUnit.id,
      destinationVersion: String(businessUnit.version),
      metadata: businessUnitMetadata(businessUnit),
    };
  });

export const handleUpdateBusinessUnit: DestinationCommandHandler<
  typeof updateBusinessUnitCommand,
  CommercetoolsSdk
> = ({ command }) =>
  Effect.gen(function* () {
    const sdk = yield* CommercetoolsSdk;
    const body: BusinessUnitUpdate = {
      actions: [...command.actions],
      version: command.version,
    };
    const businessUnit = yield* sdk
      .request("businessUnits.update", (project) => {
        const businessUnits = project.businessUnits();
        const selectedBusinessUnit =
          command.selector.kind === "id"
            ? businessUnits.withId({ ID: command.selector.id })
            : businessUnits.withKey({
                key: command.selector.key,
              });

        return selectedBusinessUnit.post({
          body,
        });
      })
      .pipe(Effect.mapError(toDestinationPluginError));

    return {
      destinationVersion: String(businessUnit.version),
      metadata: businessUnitMetadata(businessUnit),
    };
  });
