import type {
  Store,
  StoreDraft,
  StoreUpdate,
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
import {
  type CommercetoolsStoreSelector,
  CommercetoolsStoreSelectorSchema,
} from "./selectors.ts";
import type { StoreUpdateAction } from "./store-actions.ts";
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

export interface CreateStoreDraftCommand {
  readonly draft: StoreDraft;
  readonly kind: "CreateStoreDraft";
}

export type NonEmptyStoreUpdateActions<
  Action extends StoreUpdateAction = StoreUpdateAction,
> = NonEmptyUpdateActions<Action>;

export type StoreUpdateCommandShape<
  Action extends StoreUpdateAction = StoreUpdateAction,
> = UpdateCommandShape<"UpdateStore", CommercetoolsStoreSelector, Action>;

export type StoreUpdateInput = UpdateInput<CommercetoolsStoreSelector>;

export type StoreUpdateWithActionsInput<
  Action extends StoreUpdateAction = StoreUpdateAction,
> = UpdateWithActionsInput<CommercetoolsStoreSelector, Action>;

export type EmptyStoreUpdateActionBuilder = EmptyUpdateActionBuilder<
  "UpdateStore",
  CommercetoolsStoreSelector,
  StoreUpdateAction
>;

export type StoreUpdateActionBuilder<
  Action extends StoreUpdateAction = StoreUpdateAction,
> = UpdateActionBuilder<
  "UpdateStore",
  CommercetoolsStoreSelector,
  StoreUpdateAction,
  Action
>;

export type StoreUpdateFactory = UpdateCommandFactory<
  "UpdateStore",
  CommercetoolsStoreSelector,
  StoreUpdateAction
>;

export type UpdateStoreCommand = StoreUpdateCommandShape;

export interface CommercetoolsStoreCommands {
  readonly createDraft: (draft: StoreDraft) => CreateStoreDraftCommand;
  readonly update: StoreUpdateFactory;
}

const isStoreDraft = (value: unknown): value is StoreDraft =>
  isRecord(value) && hasStringField(value, "key");

const StoreDraftSchema = Schema.declare<StoreDraft>(isStoreDraft, {
  identifier: "StoreDraft",
});

const StoreUpdateActionsSchema =
  makeUpdateActionsSchema<StoreUpdateAction>("StoreUpdateActions");

export const CreateStoreDraftCommand: Schema.Codec<
  CreateStoreDraftCommand,
  CreateStoreDraftCommand,
  never,
  never
> = Schema.Struct({
  draft: StoreDraftSchema,
  kind: Schema.Literal("CreateStoreDraft"),
});

export const UpdateStoreCommand: Schema.Codec<
  UpdateStoreCommand,
  UpdateStoreCommand,
  never,
  never
> = Schema.Struct({
  actions: StoreUpdateActionsSchema,
  kind: Schema.Literal("UpdateStore"),
  selector: CommercetoolsStoreSelectorSchema,
  version: ResourceVersionSchema,
});

export const makeStoreUpdate = makeUpdateCommandFactory<
  "UpdateStore",
  CommercetoolsStoreSelector,
  StoreUpdateAction
>({
  kind: "UpdateStore",
  label: "Store update",
});

export const createStoreDraftCommand = defineDestinationCommand(
  "CreateStoreDraft",
  {
    identity: true,
    make: {
      createDraft: (draft: StoreDraft): CreateStoreDraftCommand => ({
        draft,
        kind: "CreateStoreDraft",
      }),
    },
    schema: CreateStoreDraftCommand,
  }
);

export const updateStoreCommand = defineDestinationCommand("UpdateStore", {
  identity: false,
  schema: UpdateStoreCommand,
});

export const storeCommandGroup = defineDestinationCommandGroup("stores").add(
  createStoreDraftCommand,
  updateStoreCommand
);

const storeMetadata = (store: Store): Record<string, number | string> => ({
  storeKey: store.key,
  storeProductSelectionCount: store.productSelections.length,
  storeVersion: store.version,
});

export const handleCreateStoreDraft: DestinationCommandHandler<
  typeof createStoreDraftCommand,
  CommercetoolsSdk
> = ({ command }) =>
  Effect.gen(function* () {
    const sdk = yield* CommercetoolsSdk;
    const store = yield* sdk
      .request("stores.createDraft", (project) =>
        project.stores().post({
          body: command.draft,
        })
      )
      .pipe(Effect.mapError(toDestinationPluginError));

    return {
      destinationIdentity: store.id,
      destinationVersion: String(store.version),
      metadata: storeMetadata(store),
    };
  });

export const handleUpdateStore: DestinationCommandHandler<
  typeof updateStoreCommand,
  CommercetoolsSdk
> = ({ command }) =>
  Effect.gen(function* () {
    const sdk = yield* CommercetoolsSdk;
    const body: StoreUpdate = {
      actions: [...command.actions],
      version: command.version,
    };
    const store = yield* sdk
      .request("stores.update", (project) => {
        const stores = project.stores();
        const selectedStore =
          command.selector.kind === "id"
            ? stores.withId({ ID: command.selector.id })
            : stores.withKey({ key: command.selector.key });

        return selectedStore.post({
          body,
        });
      })
      .pipe(Effect.mapError(toDestinationPluginError));

    return {
      destinationVersion: String(store.version),
      metadata: storeMetadata(store),
    };
  });
