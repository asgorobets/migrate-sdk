import type {
  Product,
  ProductDraft,
  ProductPublishScope,
  ProductUpdateAction,
} from "@commercetools/platform-sdk";
import { Effect, Layer, Schema } from "effect";
import {
  type ConfiguredDestinationPlugin,
  DestinationPluginError,
  defineDestinationCommand,
  defineDestinationCommandGroup,
  defineDestinationPlugin,
} from "migrate-sdk";
import {
  type CommercetoolsProductSelector,
  CommercetoolsProducts,
} from "../internal/products.ts";
import type { CommercetoolsSdkError, CommercetoolsSdkLayer } from "../sdk.ts";
import {
  makeProductUpdate,
  type NonEmptyProductUpdateActions,
  type ProductUpdateCommandShape,
  type ProductUpdateFactory,
} from "./product-update-builder.ts";

export type { CommercetoolsProductSelector } from "../internal/products.ts";

export interface CommercetoolsDestinationOptions {
  readonly projectKey: string;
  readonly sdkLayer: CommercetoolsSdkLayer;
}

export interface CreateProductDraftCommand {
  readonly draft: ProductDraft;
  readonly kind: "CreateProductDraft";
}

export interface PublishProductCommand {
  readonly kind: "PublishProduct";
  readonly scope?: ProductPublishScope;
  readonly selector: CommercetoolsProductSelector;
  readonly version: number;
}

export type UpdateProductCommand = ProductUpdateCommandShape;

const ProductDraftSchema = Schema.Any as Schema.Codec<
  ProductDraft,
  ProductDraft,
  never,
  never
>;

const ProductSelectorValueSchema = Schema.NonEmptyString as Schema.Codec<
  string,
  string,
  never,
  never
>;

export const CommercetoolsProductSelectorSchema = Schema.Union([
  Schema.Struct({
    id: ProductSelectorValueSchema,
    kind: Schema.Literal("id"),
  }),
  Schema.Struct({
    key: ProductSelectorValueSchema,
    kind: Schema.Literal("key"),
  }),
]) as unknown as Schema.Codec<
  CommercetoolsProductSelector,
  CommercetoolsProductSelector,
  never,
  never
>;

const ProductPublishScopeSchema = Schema.optional(
  Schema.String as unknown as Schema.Codec<
    ProductPublishScope,
    ProductPublishScope,
    never,
    never
  >
);

const ProductUpdateActionSchema = Schema.Any as Schema.Codec<
  ProductUpdateAction,
  ProductUpdateAction,
  never,
  never
>;

const ProductUpdateActionsSchema = Schema.NonEmptyArray(
  ProductUpdateActionSchema
) as unknown as Schema.Codec<
  NonEmptyProductUpdateActions,
  NonEmptyProductUpdateActions,
  never,
  never
>;

const ProductVersionSchema = Schema.Int.check(
  Schema.isGreaterThan(0)
) as Schema.Codec<number, number, never, never>;

export const CreateProductDraftCommand = Schema.Struct({
  draft: ProductDraftSchema,
  kind: Schema.Literal("CreateProductDraft"),
}) as unknown as Schema.Codec<
  CreateProductDraftCommand,
  CreateProductDraftCommand,
  never,
  never
>;

export const PublishProductCommand = Schema.Struct({
  kind: Schema.Literal("PublishProduct"),
  scope: ProductPublishScopeSchema,
  selector: CommercetoolsProductSelectorSchema,
  version: ProductVersionSchema,
}) as unknown as Schema.Codec<
  PublishProductCommand,
  PublishProductCommand,
  never,
  never
>;

export const UpdateProductCommand = Schema.Struct({
  actions: ProductUpdateActionsSchema,
  kind: Schema.Literal("UpdateProduct"),
  selector: CommercetoolsProductSelectorSchema,
  version: ProductVersionSchema,
}) as unknown as Schema.Codec<
  UpdateProductCommand,
  UpdateProductCommand,
  never,
  never
>;

export type CommercetoolsDestinationCommand =
  | CreateProductDraftCommand
  | PublishProductCommand
  | UpdateProductCommand;

export interface CommercetoolsProductCommands {
  readonly createDraft: (draft: ProductDraft) => CreateProductDraftCommand;
  readonly publish: (
    input: Omit<PublishProductCommand, "kind">
  ) => PublishProductCommand;
  readonly update: ProductUpdateFactory;
}

export interface CommercetoolsDestinationCommands {
  readonly products: CommercetoolsProductCommands;
}

export interface CommercetoolsDestination
  extends ConfiguredDestinationPlugin<CommercetoolsDestinationCommand> {
  readonly commands: CommercetoolsDestinationCommands;
}

const createProductDraftCommand = defineDestinationCommand(
  "CreateProductDraft",
  {
    identity: true,
    make: {
      createDraft: (draft: ProductDraft): CreateProductDraftCommand => ({
        draft,
        kind: "CreateProductDraft",
      }),
    },
    schema: CreateProductDraftCommand,
  }
);

const publishProductCommand = defineDestinationCommand("PublishProduct", {
  identity: false,
  make: {
    publish: (
      input: Omit<PublishProductCommand, "kind">
    ): PublishProductCommand => ({
      ...input,
      kind: "PublishProduct",
    }),
  },
  schema: PublishProductCommand,
});

const updateProductCommand = defineDestinationCommand("UpdateProduct", {
  identity: false,
  schema: UpdateProductCommand,
});

const pluginDefinition = defineDestinationPlugin("commercetools").addGroup(
  defineDestinationCommandGroup("products").add(
    createProductDraftCommand,
    publishProductCommand,
    updateProductCommand
  )
);

const toDestinationPluginError = (
  cause: CommercetoolsSdkError
): DestinationPluginError =>
  new DestinationPluginError({
    cause,
    message: cause.message,
  });

const productMetadata = (product: Product): Record<string, unknown> => ({
  ...(product.key === undefined ? {} : { productKey: product.key }),
  productVersion: product.version,
});

const make = (
  options: CommercetoolsDestinationOptions
): CommercetoolsDestination => {
  const productsLayer = CommercetoolsProducts.layer({
    projectKey: options.projectKey,
  }).pipe(Layer.provide(options.sdkLayer));
  const implementedPlugin = pluginDefinition
    .implement((handlers) =>
      handlers.group("products", (productsHandlers) =>
        productsHandlers
          .handle("CreateProductDraft", ({ command }) =>
            Effect.gen(function* () {
              const products = yield* CommercetoolsProducts;
              const product = yield* products
                .createProductDraft(command.draft)
                .pipe(Effect.mapError(toDestinationPluginError));

              return {
                destinationIdentity: product.id,
                destinationVersion: String(product.version),
                metadata: productMetadata(product),
              };
            })
          )
          .handle("PublishProduct", ({ command }) =>
            Effect.gen(function* () {
              const products = yield* CommercetoolsProducts;
              const product = yield* products
                .publishProduct({
                  selector: command.selector,
                  version: command.version,
                  ...(command.scope === undefined
                    ? {}
                    : { scope: command.scope }),
                })
                .pipe(Effect.mapError(toDestinationPluginError));

              return {
                destinationVersion: String(product.version),
                metadata: {
                  ...productMetadata(product),
                  published: product.masterData.published,
                },
              };
            })
          )
          .handle("UpdateProduct", ({ command }) =>
            Effect.gen(function* () {
              const products = yield* CommercetoolsProducts;
              const product = yield* products
                .updateProduct({
                  actions: command.actions,
                  selector: command.selector,
                  version: command.version,
                })
                .pipe(Effect.mapError(toDestinationPluginError));

              return {
                destinationVersion: String(product.version),
                metadata: {
                  ...productMetadata(product),
                  published: product.masterData.published,
                },
              };
            })
          )
      )
    )
    .provide(productsLayer);

  return {
    ...implementedPlugin,
    commands: {
      ...implementedPlugin.commands,
      products: {
        ...implementedPlugin.commands.products,
        update: makeProductUpdate,
      },
    },
  } as CommercetoolsDestination;
};

export const CommercetoolsDestinationPlugin: {
  readonly make: (
    options: CommercetoolsDestinationOptions
  ) => CommercetoolsDestination;
} = {
  make,
} as const;
