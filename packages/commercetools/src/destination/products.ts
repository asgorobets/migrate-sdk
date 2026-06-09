// biome-ignore-all assist/source/organizeImports: Product destination exports are grouped by API audience.

import type {
  Product,
  ProductDraft,
  ProductPublishAction,
  ProductPublishScope,
  ProductUpdate,
} from "@commercetools/platform-sdk";
import { Effect, Schema } from "effect";
import {
  type DestinationCommandHandler,
  defineDestinationCommand,
  defineDestinationCommandGroup,
} from "migrate-sdk";
import { CommercetoolsSdk } from "../sdk.ts";
import type { ProductUpdateAction } from "./product-actions.ts";
import type { CommercetoolsProductHelpers as ProductHelpers } from "./product-attributes.ts";
import {
  isRecord,
  isResourceIdentifier,
  isStringRecord,
  makeUpdateActionsSchema,
  ResourceVersionSchema,
} from "./internal/command-schemas.ts";
import { toDestinationPluginError } from "./internal/plugin-errors.ts";
import { CommercetoolsProductSelectorSchema } from "./selectors.ts";
import type { CommercetoolsProductSelector } from "./selectors.ts";
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

export type {
  CommercetoolsProductAttributeBag,
  CommercetoolsProductAttributeSchema,
  CommercetoolsProductAttributeSchemas,
  CommercetoolsProductTypeAttributeConfig,
  CommercetoolsVariantAttributeBag,
  ProductAttributeActionOptions,
  ProductAttributeActions,
  ProductAttributeBuilder,
  ProductAttributesHelper,
  SameShapeProductAttributeSchema,
  VariantAttributeActionTarget,
  VariantAttributeActions,
  VariantAttributeAllVariantsActions,
  VariantAttributeAllVariantsTarget,
  VariantAttributeBuilder,
  VariantAttributesHelper,
  VariantAttributeSingleVariantActions,
  VariantAttributeSingleVariantTarget,
} from "./product-attributes.ts";

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

export type NonEmptyProductUpdateActions<
  Action extends ProductUpdateAction = ProductUpdateAction,
> = NonEmptyUpdateActions<Action>;

export type ProductUpdateCommandShape<
  Action extends ProductUpdateAction = ProductUpdateAction,
> = UpdateCommandShape<"UpdateProduct", CommercetoolsProductSelector, Action>;

export type ProductUpdateInput = UpdateInput<CommercetoolsProductSelector>;

export type ProductUpdateWithActionsInput<
  Action extends ProductUpdateAction = ProductUpdateAction,
> = UpdateWithActionsInput<CommercetoolsProductSelector, Action>;

export type EmptyProductUpdateActionBuilder = EmptyUpdateActionBuilder<
  "UpdateProduct",
  CommercetoolsProductSelector,
  ProductUpdateAction
>;

export type ProductUpdateActionBuilder<
  Action extends ProductUpdateAction = ProductUpdateAction,
> = UpdateActionBuilder<
  "UpdateProduct",
  CommercetoolsProductSelector,
  ProductUpdateAction,
  Action
>;

export type ProductUpdateFactory = UpdateCommandFactory<
  "UpdateProduct",
  CommercetoolsProductSelector,
  ProductUpdateAction
>;

export type UpdateProductCommand = ProductUpdateCommandShape;

export interface CommercetoolsProductCommands {
  readonly createDraft: (draft: ProductDraft) => CreateProductDraftCommand;
  readonly publish: (
    input: Omit<PublishProductCommand, "kind">
  ) => PublishProductCommand;
  readonly update: ProductUpdateFactory;
}

export type CommercetoolsProductAttributeSchemaRecord = object;

export interface CommercetoolsProductHelpers<
  ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord,
> extends ProductHelpers<ProductAttributeSchemaRecord> {}

export type { CommercetoolsProductAttributeSchemasInput } from "./product-attributes.ts";
export type { CommercetoolsProductSelector } from "./selectors.ts";

const isProductTypeResourceIdentifier = isResourceIdentifier("product-type");

const isProductDraft = (value: unknown): value is ProductDraft =>
  isRecord(value) &&
  isProductTypeResourceIdentifier(value.productType) &&
  isStringRecord(value.name) &&
  isStringRecord(value.slug);

const isProductPublishScope = (value: unknown): value is ProductPublishScope =>
  typeof value === "string";

const ProductDraftSchema = Schema.declare<ProductDraft>(isProductDraft, {
  identifier: "ProductDraft",
});

const ProductPublishScopeSchema = Schema.optional(
  Schema.declare<ProductPublishScope>(isProductPublishScope, {
    identifier: "ProductPublishScope",
  })
);

const ProductUpdateActionsSchema = makeUpdateActionsSchema<ProductUpdateAction>(
  "ProductUpdateActions"
);

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
  version: ResourceVersionSchema,
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
  version: ResourceVersionSchema,
});

export const makeProductUpdate = makeUpdateCommandFactory<
  "UpdateProduct",
  CommercetoolsProductSelector,
  ProductUpdateAction
>({
  kind: "UpdateProduct",
  label: "Product update",
});

export const createProductDraftCommand = defineDestinationCommand(
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

export const publishProductCommand = defineDestinationCommand(
  "PublishProduct",
  {
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
  }
);

export const updateProductCommand = defineDestinationCommand("UpdateProduct", {
  identity: false,
  schema: UpdateProductCommand,
});

export const productCommandGroup = defineDestinationCommandGroup(
  "products"
).add(createProductDraftCommand, publishProductCommand, updateProductCommand);

const productMetadata = (
  product: Product
): Record<string, number | string> => ({
  ...(product.key === undefined ? {} : { productKey: product.key }),
  productVersion: product.version,
});

export const handleCreateProductDraft: DestinationCommandHandler<
  typeof createProductDraftCommand,
  CommercetoolsSdk
> = ({ command }) =>
  Effect.gen(function* () {
    const sdk = yield* CommercetoolsSdk;
    const product = yield* sdk
      .request("products.createDraft", (project) =>
        project.products().post({
          body: {
            ...command.draft,
            publish: false,
          },
        })
      )
      .pipe(Effect.mapError(toDestinationPluginError));

    return {
      destinationIdentity: product.id,
      destinationVersion: String(product.version),
      metadata: productMetadata(product),
    };
  });

export const handlePublishProduct: DestinationCommandHandler<
  typeof publishProductCommand,
  CommercetoolsSdk
> = ({ command }) =>
  Effect.gen(function* () {
    const sdk = yield* CommercetoolsSdk;
    const action: ProductPublishAction = {
      action: "publish",
      ...(command.scope === undefined ? {} : { scope: command.scope }),
    };
    const body: ProductUpdate = {
      actions: [action],
      version: command.version,
    };
    const product = yield* sdk
      .request("products.publish", (project) => {
        const products = project.products();
        const selectedProduct =
          command.selector.kind === "id"
            ? products.withId({ ID: command.selector.id })
            : products.withKey({ key: command.selector.key });

        return selectedProduct.post({
          body,
        });
      })
      .pipe(Effect.mapError(toDestinationPluginError));

    return {
      destinationVersion: String(product.version),
      metadata: {
        ...productMetadata(product),
        published: product.masterData.published,
      },
    };
  });

export const handleUpdateProduct: DestinationCommandHandler<
  typeof updateProductCommand,
  CommercetoolsSdk
> = ({ command }) =>
  Effect.gen(function* () {
    const sdk = yield* CommercetoolsSdk;
    const body: ProductUpdate = {
      actions: [...command.actions],
      version: command.version,
    };
    const product = yield* sdk
      .request("products.update", (project) => {
        const products = project.products();
        const selectedProduct =
          command.selector.kind === "id"
            ? products.withId({ ID: command.selector.id })
            : products.withKey({ key: command.selector.key });

        return selectedProduct.post({
          body,
        });
      })
      .pipe(Effect.mapError(toDestinationPluginError));

    return {
      destinationVersion: String(product.version),
      metadata: {
        ...productMetadata(product),
        published: product.masterData.published,
      },
    };
  });
