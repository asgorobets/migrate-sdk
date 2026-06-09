import type {
  InventoryEntry,
  InventoryEntryDraft,
  InventoryEntryUpdate,
} from "@commercetools/platform-sdk";
import { Effect, Schema } from "effect";
import {
  type DestinationCommandHandler,
  defineDestinationCommand,
  defineDestinationCommandGroup,
} from "migrate-sdk";
import { CommercetoolsSdk } from "../sdk.ts";
import {
  hasStringField,
  isRecord,
  makeUpdateActionsSchema,
  ResourceVersionSchema,
} from "./internal/command-schemas.ts";
import { toDestinationPluginError } from "./internal/plugin-errors.ts";
import type { InventoryEntryUpdateAction } from "./inventory-actions.ts";
import {
  type CommercetoolsInventoryEntrySelector,
  CommercetoolsInventoryEntrySelectorSchema,
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

export interface CreateInventoryEntryDraftCommand {
  readonly draft: InventoryEntryDraft;
  readonly kind: "CreateInventoryEntryDraft";
}

export type NonEmptyInventoryEntryUpdateActions<
  Action extends InventoryEntryUpdateAction = InventoryEntryUpdateAction,
> = NonEmptyUpdateActions<Action>;

export type InventoryEntryUpdateCommandShape<
  Action extends InventoryEntryUpdateAction = InventoryEntryUpdateAction,
> = UpdateCommandShape<
  "UpdateInventoryEntry",
  CommercetoolsInventoryEntrySelector,
  Action
>;

export type InventoryEntryUpdateInput =
  UpdateInput<CommercetoolsInventoryEntrySelector>;

export type InventoryEntryUpdateWithActionsInput<
  Action extends InventoryEntryUpdateAction = InventoryEntryUpdateAction,
> = UpdateWithActionsInput<CommercetoolsInventoryEntrySelector, Action>;

export type EmptyInventoryEntryUpdateActionBuilder = EmptyUpdateActionBuilder<
  "UpdateInventoryEntry",
  CommercetoolsInventoryEntrySelector,
  InventoryEntryUpdateAction
>;

export type InventoryEntryUpdateActionBuilder<
  Action extends InventoryEntryUpdateAction = InventoryEntryUpdateAction,
> = UpdateActionBuilder<
  "UpdateInventoryEntry",
  CommercetoolsInventoryEntrySelector,
  InventoryEntryUpdateAction,
  Action
>;

export type InventoryEntryUpdateFactory = UpdateCommandFactory<
  "UpdateInventoryEntry",
  CommercetoolsInventoryEntrySelector,
  InventoryEntryUpdateAction
>;

export type UpdateInventoryEntryCommand = InventoryEntryUpdateCommandShape;

export interface CommercetoolsInventoryEntryCommands {
  readonly createDraft: (
    draft: InventoryEntryDraft
  ) => CreateInventoryEntryDraftCommand;
  readonly update: InventoryEntryUpdateFactory;
}

const isInventoryEntryDraft = (value: unknown): value is InventoryEntryDraft =>
  isRecord(value) &&
  hasStringField(value, "sku") &&
  typeof value.quantityOnStock === "number";

const InventoryEntryDraftSchema = Schema.declare<InventoryEntryDraft>(
  isInventoryEntryDraft,
  {
    identifier: "InventoryEntryDraft",
  }
);

const InventoryEntryUpdateActionsSchema =
  makeUpdateActionsSchema<InventoryEntryUpdateAction>(
    "InventoryEntryUpdateActions"
  );

export const CreateInventoryEntryDraftCommand: Schema.Codec<
  CreateInventoryEntryDraftCommand,
  CreateInventoryEntryDraftCommand,
  never,
  never
> = Schema.Struct({
  draft: InventoryEntryDraftSchema,
  kind: Schema.Literal("CreateInventoryEntryDraft"),
});

export const UpdateInventoryEntryCommand: Schema.Codec<
  UpdateInventoryEntryCommand,
  UpdateInventoryEntryCommand,
  never,
  never
> = Schema.Struct({
  actions: InventoryEntryUpdateActionsSchema,
  kind: Schema.Literal("UpdateInventoryEntry"),
  selector: CommercetoolsInventoryEntrySelectorSchema,
  version: ResourceVersionSchema,
});

export const makeInventoryEntryUpdate = makeUpdateCommandFactory<
  "UpdateInventoryEntry",
  CommercetoolsInventoryEntrySelector,
  InventoryEntryUpdateAction
>({
  kind: "UpdateInventoryEntry",
  label: "Inventory entry update",
});

export const createInventoryEntryDraftCommand = defineDestinationCommand(
  "CreateInventoryEntryDraft",
  {
    identity: true,
    make: {
      createDraft: (
        draft: InventoryEntryDraft
      ): CreateInventoryEntryDraftCommand => ({
        draft,
        kind: "CreateInventoryEntryDraft",
      }),
    },
    schema: CreateInventoryEntryDraftCommand,
  }
);

export const updateInventoryEntryCommand = defineDestinationCommand(
  "UpdateInventoryEntry",
  {
    identity: false,
    schema: UpdateInventoryEntryCommand,
  }
);

export const inventoryCommandGroup = defineDestinationCommandGroup(
  "inventory"
).add(createInventoryEntryDraftCommand, updateInventoryEntryCommand);

const inventoryEntryMetadata = (
  inventoryEntry: InventoryEntry
): Record<string, number | string> => ({
  ...(inventoryEntry.key === undefined
    ? {}
    : { inventoryEntryKey: inventoryEntry.key }),
  inventoryEntrySku: inventoryEntry.sku,
  inventoryEntryVersion: inventoryEntry.version,
});

export const handleCreateInventoryEntryDraft: DestinationCommandHandler<
  typeof createInventoryEntryDraftCommand,
  CommercetoolsSdk
> = ({ command }) =>
  Effect.gen(function* () {
    const sdk = yield* CommercetoolsSdk;
    const inventoryEntry = yield* sdk
      .request("inventory.createDraft", (project) =>
        project.inventory().post({
          body: command.draft,
        })
      )
      .pipe(Effect.mapError(toDestinationPluginError));

    return {
      destinationIdentity: inventoryEntry.id,
      destinationVersion: String(inventoryEntry.version),
      metadata: inventoryEntryMetadata(inventoryEntry),
    };
  });

export const handleUpdateInventoryEntry: DestinationCommandHandler<
  typeof updateInventoryEntryCommand,
  CommercetoolsSdk
> = ({ command }) =>
  Effect.gen(function* () {
    const sdk = yield* CommercetoolsSdk;
    const body: InventoryEntryUpdate = {
      actions: [...command.actions],
      version: command.version,
    };
    const inventoryEntry = yield* sdk
      .request("inventory.update", (project) => {
        const inventory = project.inventory();
        const selectedInventoryEntry =
          command.selector.kind === "id"
            ? inventory.withId({ ID: command.selector.id })
            : inventory.withKey({ key: command.selector.key });

        return selectedInventoryEntry.post({
          body,
        });
      })
      .pipe(Effect.mapError(toDestinationPluginError));

    return {
      destinationVersion: String(inventoryEntry.version),
      metadata: inventoryEntryMetadata(inventoryEntry),
    };
  });
