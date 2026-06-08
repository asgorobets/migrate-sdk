import type {
  Attribute,
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

export type CommercetoolsProductAttributeSchema = Schema.Codec<
  object,
  object,
  never,
  never
>;

type CommercetoolsProductAttributeSchemaRecord = object;

type SameShapeProductAttributeSchema<ProductAttributeSchema> =
  ProductAttributeSchema extends Schema.Codec<
    infer AttributeBag extends object,
    infer EncodedAttributeBag extends object,
    never,
    never
  >
    ? [AttributeBag] extends [EncodedAttributeBag]
      ? [EncodedAttributeBag] extends [AttributeBag]
        ? ProductAttributeSchema
        : never
      : never
    : never;

export type CommercetoolsProductAttributeSchemas<
  ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord = Readonly<
    Record<string, CommercetoolsProductAttributeSchema>
  >,
> = {
  readonly [ProductTypeKey in keyof ProductAttributeSchemaRecord]: SameShapeProductAttributeSchema<
    ProductAttributeSchemaRecord[ProductTypeKey]
  >;
};

export type CommercetoolsProductAttributeBag<
  ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord,
  ProductTypeKey extends keyof ProductAttributeSchemaRecord,
> = Schema.Schema.Type<ProductAttributeSchemaRecord[ProductTypeKey]>;

type CommercetoolsProductAttributeSchemasInput<
  ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord,
> = ProductAttributeSchemaRecord &
  CommercetoolsProductAttributeSchemas<NoInfer<ProductAttributeSchemaRecord>>;

export interface CommercetoolsDestinationBaseOptions {
  readonly projectKey: string;
  readonly sdkLayer: CommercetoolsSdkLayer;
}

export interface CommercetoolsDestinationWithProductTypesOptions<
  ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord,
> extends CommercetoolsDestinationBaseOptions {
  readonly productTypes: CommercetoolsProductAttributeSchemasInput<ProductAttributeSchemaRecord>;
}

export type CommercetoolsDestinationOptions<
  ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord = Record<never, never>,
> = keyof ProductAttributeSchemaRecord extends never
  ? CommercetoolsDestinationBaseOptions
  : CommercetoolsDestinationWithProductTypesOptions<ProductAttributeSchemaRecord>;

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

export interface CommercetoolsProductHelpers<
  ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord,
> {
  readonly attributes: <
    const ProductTypeKey extends keyof ProductAttributeSchemaRecord & string,
  >(
    productTypeKey: ProductTypeKey,
    input: CommercetoolsProductAttributeBag<
      ProductAttributeSchemaRecord,
      ProductTypeKey
    >
  ) => Effect.Effect<Attribute[], Schema.SchemaError>;
}

export interface CommercetoolsDestinationHelpers<
  ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord,
> {
  readonly products: CommercetoolsProductHelpers<ProductAttributeSchemaRecord>;
}

export interface CommercetoolsDestination<
  ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord = Record<never, never>,
> extends ConfiguredDestinationPlugin<CommercetoolsDestinationCommand> {
  readonly commands: CommercetoolsDestinationCommands;
  readonly helpers: CommercetoolsDestinationHelpers<ProductAttributeSchemaRecord>;
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

const toProductAttributes = (attributeBag: object): Attribute[] =>
  Object.entries(attributeBag).flatMap(([name, value]) =>
    value === undefined ? [] : [{ name, value }]
  );

const makeProductHelpers = <
  const ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord,
>(
  productTypes:
    | CommercetoolsProductAttributeSchemasInput<ProductAttributeSchemaRecord>
    | undefined
): CommercetoolsProductHelpers<ProductAttributeSchemaRecord> => {
  const schemas = (productTypes ?? {}) as Readonly<
    Record<string, CommercetoolsProductAttributeSchema>
  >;

  return {
    attributes: (productTypeKey, input) => {
      const schema = schemas[productTypeKey];

      if (schema === undefined) {
        return Effect.die(
          new Error(
            `Commercetools product type '${productTypeKey}' does not have a configured attribute schema`
          )
        );
      }

      return Schema.decodeUnknownEffect(schema, { errors: "all" })(input).pipe(
        Effect.map(toProductAttributes)
      );
    },
  };
};

function make<
  const ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord,
>(
  options: CommercetoolsDestinationWithProductTypesOptions<ProductAttributeSchemaRecord>
): CommercetoolsDestination<ProductAttributeSchemaRecord>;
function make(
  options: CommercetoolsDestinationBaseOptions
): CommercetoolsDestination;
function make<
  const ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord,
>(
  options:
    | CommercetoolsDestinationBaseOptions
    | CommercetoolsDestinationWithProductTypesOptions<ProductAttributeSchemaRecord>
): CommercetoolsDestination<ProductAttributeSchemaRecord> {
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
    helpers: {
      products: makeProductHelpers<ProductAttributeSchemaRecord>(
        "productTypes" in options ? options.productTypes : undefined
      ),
    },
  } as CommercetoolsDestination<ProductAttributeSchemaRecord>;
}

export const CommercetoolsDestinationPlugin: {
  readonly make: typeof make;
} = {
  make,
} as const;
