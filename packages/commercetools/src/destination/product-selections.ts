import type {
  ProductSelection,
  ProductSelectionDraft,
  ProductSelectionUpdate,
} from "@commercetools/platform-sdk";
import { Effect, Schema } from "effect";
import {
  type DestinationCommandHandler,
  defineDestinationCommand,
  defineDestinationCommandGroup,
} from "migrate-sdk";
import { CommercetoolsSdk } from "../sdk.ts";
import {
  isRecord,
  isStringRecord,
  makeUpdateActionsSchema,
  ResourceVersionSchema,
} from "./internal/command-schemas.ts";
import { toDestinationPluginError } from "./internal/plugin-errors.ts";
import type { ProductSelectionUpdateAction } from "./product-selection-actions.ts";
import {
  type CommercetoolsProductSelectionSelector,
  CommercetoolsProductSelectionSelectorSchema,
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

export interface CreateProductSelectionDraftCommand {
  readonly draft: ProductSelectionDraft;
  readonly kind: "CreateProductSelectionDraft";
}

export type NonEmptyProductSelectionUpdateActions<
  Action extends ProductSelectionUpdateAction = ProductSelectionUpdateAction,
> = NonEmptyUpdateActions<Action>;

export type ProductSelectionUpdateCommandShape<
  Action extends ProductSelectionUpdateAction = ProductSelectionUpdateAction,
> = UpdateCommandShape<
  "UpdateProductSelection",
  CommercetoolsProductSelectionSelector,
  Action
>;

export type ProductSelectionUpdateInput =
  UpdateInput<CommercetoolsProductSelectionSelector>;

export type ProductSelectionUpdateWithActionsInput<
  Action extends ProductSelectionUpdateAction = ProductSelectionUpdateAction,
> = UpdateWithActionsInput<CommercetoolsProductSelectionSelector, Action>;

export type EmptyProductSelectionUpdateActionBuilder = EmptyUpdateActionBuilder<
  "UpdateProductSelection",
  CommercetoolsProductSelectionSelector,
  ProductSelectionUpdateAction
>;

export type ProductSelectionUpdateActionBuilder<
  Action extends ProductSelectionUpdateAction = ProductSelectionUpdateAction,
> = UpdateActionBuilder<
  "UpdateProductSelection",
  CommercetoolsProductSelectionSelector,
  ProductSelectionUpdateAction,
  Action
>;

export type ProductSelectionUpdateFactory = UpdateCommandFactory<
  "UpdateProductSelection",
  CommercetoolsProductSelectionSelector,
  ProductSelectionUpdateAction
>;

export type UpdateProductSelectionCommand = ProductSelectionUpdateCommandShape;

export interface CommercetoolsProductSelectionCommands {
  readonly createDraft: (
    draft: ProductSelectionDraft
  ) => CreateProductSelectionDraftCommand;
  readonly update: ProductSelectionUpdateFactory;
}

const isProductSelectionDraft = (
  value: unknown
): value is ProductSelectionDraft =>
  isRecord(value) && isStringRecord(value.name);

const ProductSelectionDraftSchema = Schema.declare<ProductSelectionDraft>(
  isProductSelectionDraft,
  {
    identifier: "ProductSelectionDraft",
  }
);

const ProductSelectionUpdateActionsSchema =
  makeUpdateActionsSchema<ProductSelectionUpdateAction>(
    "ProductSelectionUpdateActions"
  );

export const CreateProductSelectionDraftCommand: Schema.Codec<
  CreateProductSelectionDraftCommand,
  CreateProductSelectionDraftCommand,
  never,
  never
> = Schema.Struct({
  draft: ProductSelectionDraftSchema,
  kind: Schema.Literal("CreateProductSelectionDraft"),
});

export const UpdateProductSelectionCommand: Schema.Codec<
  UpdateProductSelectionCommand,
  UpdateProductSelectionCommand,
  never,
  never
> = Schema.Struct({
  actions: ProductSelectionUpdateActionsSchema,
  kind: Schema.Literal("UpdateProductSelection"),
  selector: CommercetoolsProductSelectionSelectorSchema,
  version: ResourceVersionSchema,
});

export const makeProductSelectionUpdate = makeUpdateCommandFactory<
  "UpdateProductSelection",
  CommercetoolsProductSelectionSelector,
  ProductSelectionUpdateAction
>({
  kind: "UpdateProductSelection",
  label: "Product selection update",
});

export const createProductSelectionDraftCommand = defineDestinationCommand(
  "CreateProductSelectionDraft",
  {
    identity: true,
    make: {
      createDraft: (
        draft: ProductSelectionDraft
      ): CreateProductSelectionDraftCommand => ({
        draft,
        kind: "CreateProductSelectionDraft",
      }),
    },
    schema: CreateProductSelectionDraftCommand,
  }
);

export const updateProductSelectionCommand = defineDestinationCommand(
  "UpdateProductSelection",
  {
    identity: false,
    schema: UpdateProductSelectionCommand,
  }
);

export const productSelectionCommandGroup = defineDestinationCommandGroup(
  "productSelections"
).add(createProductSelectionDraftCommand, updateProductSelectionCommand);

const productSelectionMetadata = (
  productSelection: ProductSelection
): Record<string, number | string> => ({
  ...(productSelection.key === undefined
    ? {}
    : { productSelectionKey: productSelection.key }),
  productSelectionProductCount: productSelection.productCount,
  productSelectionVersion: productSelection.version,
});

export const handleCreateProductSelectionDraft: DestinationCommandHandler<
  typeof createProductSelectionDraftCommand,
  CommercetoolsSdk
> = ({ command }) =>
  Effect.gen(function* () {
    const sdk = yield* CommercetoolsSdk;
    const productSelection = yield* sdk
      .request("productSelections.createDraft", (project) =>
        project.productSelections().post({
          body: command.draft,
        })
      )
      .pipe(Effect.mapError(toDestinationPluginError));

    return {
      destinationIdentity: productSelection.id,
      destinationVersion: String(productSelection.version),
      metadata: productSelectionMetadata(productSelection),
    };
  });

export const handleUpdateProductSelection: DestinationCommandHandler<
  typeof updateProductSelectionCommand,
  CommercetoolsSdk
> = ({ command }) =>
  Effect.gen(function* () {
    const sdk = yield* CommercetoolsSdk;
    const body: ProductSelectionUpdate = {
      actions: [...command.actions],
      version: command.version,
    };
    const productSelection = yield* sdk
      .request("productSelections.update", (project) => {
        const productSelections = project.productSelections();
        const selectedProductSelection =
          command.selector.kind === "id"
            ? productSelections.withId({ ID: command.selector.id })
            : productSelections.withKey({ key: command.selector.key });

        return selectedProductSelection.post({
          body,
        });
      })
      .pipe(Effect.mapError(toDestinationPluginError));

    return {
      destinationIdentity: productSelection.id,
      destinationVersion: String(productSelection.version),
      metadata: productSelectionMetadata(productSelection),
    };
  });
