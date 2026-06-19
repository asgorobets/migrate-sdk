// biome-ignore-all assist/source/organizeImports: Product destination exports are grouped by API audience.

import type { ProductDraft } from "@commercetools/platform-sdk";
import { Schema } from "effect";
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
import {
  type CommercetoolsProductSelector,
  CommercetoolsProductSelectorSchema,
} from "./selectors.ts";
import {
  type EmptyUpdateActionBuilder,
  makeUpdateActionFactory,
  type NonEmptyUpdateActions,
  type UpdateActionBuilder,
  type UpdateActionFactory,
  type UpdateInput,
  type UpdateWithActionsInput,
} from "./update-action-builder.ts";

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

export type NonEmptyProductUpdateActions<
  Action extends ProductUpdateAction = ProductUpdateAction,
> = NonEmptyUpdateActions<Action>;

export type ProductUpdateInput = UpdateInput<CommercetoolsProductSelector>;

export type ProductUpdateWithActionsInput<
  Action extends ProductUpdateAction = ProductUpdateAction,
> = UpdateWithActionsInput<CommercetoolsProductSelector, Action>;

export type EmptyProductUpdateActionBuilder = EmptyUpdateActionBuilder<
  CommercetoolsProductSelector,
  ProductUpdateAction
>;

export type ProductUpdateActionBuilder<
  Action extends ProductUpdateAction = ProductUpdateAction,
> = UpdateActionBuilder<
  CommercetoolsProductSelector,
  ProductUpdateAction,
  Action
>;

export type ProductUpdateFactory = UpdateActionFactory<
  CommercetoolsProductSelector,
  ProductUpdateAction
>;

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

export const ProductDraftSchema: Schema.Codec<
  ProductDraftInput,
  ProductDraftInput,
  never,
  never
> = Schema.declare<ProductDraftInput>(isProductDraft, {
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

export const ProductUpdateActionsSchema =
  Schema.declare<NonEmptyProductUpdateActions>(isProductUpdateActions, {
    identifier: "ProductUpdateActions",
  });

export const ProductUpdateWithActionsInputSchema = Schema.Struct({
  actions: ProductUpdateActionsSchema,
  selector: CommercetoolsProductSelectorSchema,
  version: ResourceVersionSchema,
});

export const makeProductUpdate = makeUpdateActionFactory<
  CommercetoolsProductSelector,
  ProductUpdateAction
>({
  label: "Product update",
});
