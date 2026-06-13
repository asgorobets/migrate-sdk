// biome-ignore-all assist/source/organizeImports: Product destination exports are grouped by API audience.

import type {
  Product,
  ProductDraft,
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
  hasOptionalResourceIdentifier,
  hasOptionalResourceIdentifierArray,
  hasRequiredResourceIdentifier,
  isNonEmptySdkUpdateActions,
  isRecord,
  isResourceIdentifier,
  isStringRecord,
  ResourceVersionSchema,
} from "./internal/command-schemas.ts";
import { toDestinationPluginError } from "./internal/plugin-errors.ts";
import {
  hasOptionalProductVariantDraftArrayPriceResourceIdentifiers,
  hasOptionalProductVariantDraftPriceResourceIdentifiers,
  hasValidProductUpdateActionPriceDraftResourceIdentifiers,
  type ProductPriceDraftInput as InternalProductPriceDraftInput,
  type ProductVariantDraftInput as InternalProductVariantDraftInput,
} from "./internal/product-price-drafts.ts";
import type {
  RefineResourceIdentifierArrayFields,
  RefineResourceIdentifierFields,
} from "./internal/sdk-resource-identifiers.ts";
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
  readonly draft: ProductDraftInput;
  readonly kind: "CreateProductDraft";
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
  readonly createDraft: (draft: ProductDraftInput) => CreateProductDraftCommand;
  readonly update: ProductUpdateFactory;
}

export type CommercetoolsProductAttributeSchemaRecord = object;

export type ProductDraftInput = RefineResourceIdentifierArrayFields<
  RefineResourceIdentifierFields<
    Omit<ProductDraft, "masterVariant" | "variants"> & {
      readonly masterVariant?: InternalProductVariantDraftInput;
      readonly variants?: InternalProductVariantDraftInput[];
    },
    ["productType", "taxCategory", "state"]
  >,
  ["categories"]
>;

export type ProductPriceDraftInput = InternalProductPriceDraftInput;

export type ProductVariantDraftInput = InternalProductVariantDraftInput;

export interface CommercetoolsProductHelpers<
  ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord,
> extends ProductHelpers<ProductAttributeSchemaRecord> {}

export type { CommercetoolsProductAttributeSchemasInput } from "./product-attributes.ts";
export type { CommercetoolsProductSelector } from "./selectors.ts";

const isProductTypeResourceIdentifier = isResourceIdentifier("product-type");
const isCategoryResourceIdentifier = isResourceIdentifier("category");
const isStateResourceIdentifier = isResourceIdentifier("state");
const isTaxCategoryResourceIdentifier = isResourceIdentifier("tax-category");
const isTypeResourceIdentifier = isResourceIdentifier("type");

const isProductDraft = (value: unknown): value is ProductDraftInput =>
  isRecord(value) &&
  isProductTypeResourceIdentifier(value.productType) &&
  hasOptionalResourceIdentifierArray(
    value,
    "categories",
    isCategoryResourceIdentifier
  ) &&
  hasOptionalResourceIdentifier(value, "state", isStateResourceIdentifier) &&
  hasOptionalResourceIdentifier(
    value,
    "taxCategory",
    isTaxCategoryResourceIdentifier
  ) &&
  hasOptionalProductVariantDraftPriceResourceIdentifiers(
    value,
    "masterVariant"
  ) &&
  hasOptionalProductVariantDraftArrayPriceResourceIdentifiers(
    value,
    "variants"
  ) &&
  isStringRecord(value.name) &&
  isStringRecord(value.slug);

const ProductDraftSchema = Schema.declare<ProductDraftInput>(isProductDraft, {
  identifier: "ProductDraft",
});

const hasValidProductUpdateActionResourceIdentifiers = (
  action: Readonly<Record<string, unknown>>
): boolean => {
  switch (action.action) {
    case "addToCategory":
    case "removeFromCategory":
      return hasRequiredResourceIdentifier(
        action,
        "category",
        isCategoryResourceIdentifier
      );
    case "setAssetCustomType":
    case "setProductPriceCustomType":
      return hasOptionalResourceIdentifier(
        action,
        "type",
        isTypeResourceIdentifier
      );
    case "setTaxCategory":
      return hasOptionalResourceIdentifier(
        action,
        "taxCategory",
        isTaxCategoryResourceIdentifier
      );
    case "transitionState":
      return hasOptionalResourceIdentifier(
        action,
        "state",
        isStateResourceIdentifier
      );
    default:
      return true;
  }
};

const isProductUpdateActions = (
  value: unknown
): value is NonEmptyProductUpdateActions =>
  isNonEmptySdkUpdateActions<ProductUpdateAction>(value) &&
  value.every(
    (action) =>
      hasValidProductUpdateActionResourceIdentifiers(action) &&
      hasValidProductUpdateActionPriceDraftResourceIdentifiers(action)
  );

const ProductUpdateActionsSchema = Schema.declare<NonEmptyProductUpdateActions>(
  isProductUpdateActions,
  {
    identifier: "ProductUpdateActions",
  }
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

export const makeCreateProductDraftCommand = (
  draft: ProductDraftInput
): CreateProductDraftCommand => ({
  draft,
  kind: "CreateProductDraft",
});

export const createProductDraftCommand = defineDestinationCommand(
  "CreateProductDraft",
  {
    identity: true,
    make: {
      createDraft: makeCreateProductDraftCommand,
    },
    schema: CreateProductDraftCommand,
  }
);

export const updateProductCommand = defineDestinationCommand("UpdateProduct", {
  identity: false,
  schema: UpdateProductCommand,
});

export const productCommandGroup = defineDestinationCommandGroup(
  "products"
).add(createProductDraftCommand, updateProductCommand);

export const makeCommercetoolsProductCommands =
  (): CommercetoolsProductCommands => ({
    createDraft: makeCreateProductDraftCommand,
    update: makeProductUpdate,
  });

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
      destinationIdentity: product.id,
      destinationVersion: String(product.version),
      metadata: {
        ...productMetadata(product),
        published: product.masterData.published,
      },
    };
  });
