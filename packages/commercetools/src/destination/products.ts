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
  readonly scope?: ProductPublishScope | undefined;
  readonly selector: CommercetoolsProductSelector;
  readonly version: number;
}

export type UpdateProductCommand = ProductUpdateCommandShape;

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

type UnknownRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null;

const isStringRecord = (
  value: unknown
): value is Readonly<Record<string, string>> =>
  isRecord(value) &&
  Object.values(value).every((item) => typeof item === "string");

const hasOwnField = (value: UnknownRecord, field: string): boolean =>
  Object.hasOwn(value, field);

const hasStringField = (value: UnknownRecord, field: string): boolean =>
  typeof value[field] === "string" && value[field] !== "";

const hasIntegerField = (value: UnknownRecord, field: string): boolean =>
  typeof value[field] === "number" && Number.isInteger(value[field]);

const hasRecordField = (value: UnknownRecord, field: string): boolean =>
  isRecord(value[field]);

const hasArrayField = (value: UnknownRecord, field: string): boolean =>
  Array.isArray(value[field]);

const hasVariantSelector = (value: UnknownRecord): boolean =>
  hasIntegerField(value, "variantId") || hasStringField(value, "sku");

const hasAssetSelector = (value: UnknownRecord): boolean =>
  hasStringField(value, "assetId") || hasStringField(value, "assetKey");

const isProductTypeResourceIdentifier = (value: unknown): boolean => {
  if (!isRecord(value) || value.typeId !== "product-type") {
    return false;
  }

  const hasId = hasOwnField(value, "id");
  const hasKey = hasOwnField(value, "key");

  if (hasId === hasKey) {
    return false;
  }

  return hasId ? hasStringField(value, "id") : hasStringField(value, "key");
};

const isProductDraft = (value: unknown): value is ProductDraft =>
  isRecord(value) &&
  isProductTypeResourceIdentifier(value.productType) &&
  isStringRecord(value.name) &&
  isStringRecord(value.slug);

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isProductPublishScope = (value: unknown): value is ProductPublishScope =>
  typeof value === "string";

type ProductUpdateActionGuard = (value: UnknownRecord) => boolean;

const productUpdateActionGuardsByName = {
  addAsset: (value) =>
    hasVariantSelector(value) && hasRecordField(value, "asset"),
  addExternalImage: (value) =>
    hasVariantSelector(value) && hasRecordField(value, "image"),
  addPrice: (value) =>
    hasVariantSelector(value) && hasRecordField(value, "price"),
  addToCategory: (value) => hasRecordField(value, "category"),
  addVariant: () => true,
  changeAssetName: (value) =>
    hasVariantSelector(value) &&
    hasAssetSelector(value) &&
    hasRecordField(value, "name"),
  changeAssetOrder: (value) =>
    hasVariantSelector(value) && hasArrayField(value, "assetOrder"),
  changeMasterVariant: hasVariantSelector,
  changeName: (value) => hasRecordField(value, "name"),
  changePrice: (value) =>
    hasStringField(value, "priceId") && hasRecordField(value, "price"),
  changeSlug: (value) => hasRecordField(value, "slug"),
  moveImageToPosition: (value) =>
    hasVariantSelector(value) &&
    hasStringField(value, "imageUrl") &&
    hasIntegerField(value, "position"),
  publish: () => true,
  removeAsset: (value) => hasVariantSelector(value) && hasAssetSelector(value),
  removeFromCategory: (value) => hasRecordField(value, "category"),
  removeImage: (value) =>
    hasVariantSelector(value) && hasStringField(value, "imageUrl"),
  removePrice: (value) => hasStringField(value, "priceId"),
  removeVariant: (value) =>
    hasIntegerField(value, "id") || hasStringField(value, "sku"),
  revertStagedChanges: () => true,
  revertStagedVariantChanges: (value) => hasIntegerField(value, "variantId"),
  setAssetCustomField: (value) =>
    hasVariantSelector(value) &&
    hasAssetSelector(value) &&
    hasStringField(value, "name"),
  setAssetCustomType: (value) =>
    hasVariantSelector(value) && hasAssetSelector(value),
  setAssetDescription: (value) =>
    hasVariantSelector(value) && hasAssetSelector(value),
  setAssetKey: (value) =>
    hasVariantSelector(value) && hasStringField(value, "assetId"),
  setAssetSources: (value) =>
    hasVariantSelector(value) &&
    hasAssetSelector(value) &&
    hasArrayField(value, "sources"),
  setAssetTags: (value) => hasVariantSelector(value) && hasAssetSelector(value),
  setAttribute: (value) =>
    hasVariantSelector(value) && hasStringField(value, "name"),
  setAttributeInAllVariants: (value) => hasStringField(value, "name"),
  setCategoryOrderHint: (value) => hasStringField(value, "categoryId"),
  setDescription: () => true,
  setDiscountedPrice: (value) => hasStringField(value, "priceId"),
  setImageLabel: (value) =>
    hasVariantSelector(value) && hasStringField(value, "imageUrl"),
  setKey: () => true,
  setMetaDescription: () => true,
  setMetaKeywords: () => true,
  setMetaTitle: () => true,
  setPriceKey: (value) => hasStringField(value, "priceId"),
  setPriceMode: () => true,
  setPrices: (value) =>
    hasVariantSelector(value) && hasArrayField(value, "prices"),
  setProductAttribute: (value) => hasStringField(value, "name"),
  setProductPriceCustomField: (value) =>
    hasStringField(value, "priceId") && hasStringField(value, "name"),
  setProductPriceCustomType: (value) => hasStringField(value, "priceId"),
  setProductVariantKey: hasVariantSelector,
  setSearchKeywords: (value) => hasRecordField(value, "searchKeywords"),
  setSku: (value) => hasIntegerField(value, "variantId"),
  setTaxCategory: () => true,
  transitionState: () => true,
  unpublish: () => true,
} satisfies Record<ProductUpdateAction["action"], ProductUpdateActionGuard>;

const productUpdateActionGuards = new Map<string, ProductUpdateActionGuard>(
  Object.entries(productUpdateActionGuardsByName)
);

const isProductUpdateAction = (
  value: unknown
): value is ProductUpdateAction => {
  if (!isRecord(value) || typeof value.action !== "string") {
    return false;
  }

  const guard = productUpdateActionGuards.get(value.action);

  return guard?.(value) === true;
};

const isProductUpdateActions = (
  value: unknown
): value is NonEmptyProductUpdateActions =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(isProductUpdateAction);

const NonEmptyStringSchema = Schema.declare<string>(
  (value): value is string => typeof value === "string" && value !== "",
  {
    identifier: "NonEmptyString",
  }
);

const ProductDraftSchema = Schema.declare<ProductDraft>(isProductDraft, {
  identifier: "ProductDraft",
});

export const CommercetoolsProductSelectorSchema = Schema.Union([
  Schema.Struct({
    id: NonEmptyStringSchema,
    kind: Schema.Literal("id"),
  }),
  Schema.Struct({
    key: NonEmptyStringSchema,
    kind: Schema.Literal("key"),
  }),
]);

const ProductPublishScopeSchema = Schema.optional(
  Schema.declare<ProductPublishScope>(isProductPublishScope, {
    identifier: "ProductPublishScope",
  })
);

const ProductUpdateActionsSchema = Schema.declare<NonEmptyProductUpdateActions>(
  isProductUpdateActions,
  {
    identifier: "ProductUpdateActions",
  }
);

const ProductVersionSchema = Schema.declare<number>(isPositiveInteger, {
  identifier: "ProductVersion",
});

export const CreateProductDraftCommand: Schema.Codec<
  CreateProductDraftCommand,
  CreateProductDraftCommand,
  never,
  never
> = Schema.Struct({
  draft: ProductDraftSchema,
  kind: Schema.Literal("CreateProductDraft"),
});

export const PublishProductCommand: Schema.Codec<
  PublishProductCommand,
  PublishProductCommand,
  never,
  never
> = Schema.Struct({
  kind: Schema.Literal("PublishProduct"),
  scope: ProductPublishScopeSchema,
  selector: CommercetoolsProductSelectorSchema,
  version: ProductVersionSchema,
});

export const UpdateProductCommand: Schema.Codec<
  UpdateProductCommand,
  UpdateProductCommand,
  never,
  never
> = Schema.Struct({
  actions: ProductUpdateActionsSchema,
  kind: Schema.Literal("UpdateProduct"),
  selector: CommercetoolsProductSelectorSchema,
  version: ProductVersionSchema,
});

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

const productMetadata = (
  product: Product
): Record<string, number | string> => ({
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
  return {
    attributes: (productTypeKey, input) => {
      const schema = productTypes?.[productTypeKey];

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
  };
}

export const CommercetoolsDestinationPlugin: {
  readonly make: typeof make;
} = {
  make,
};
