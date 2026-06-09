import type {
  Attribute,
  BusinessUnit,
  BusinessUnitDraft,
  BusinessUnitUpdate,
  BusinessUnitUpdateAction,
  Customer,
  CustomerDraft,
  CustomerUpdate,
  Product,
  ProductDraft,
  ProductPublishAction,
  ProductPublishScope,
  ProductUpdate,
  ProductUpdateAction,
} from "@commercetools/platform-sdk";
import { Effect, Schema } from "effect";
import {
  type ConfiguredDestinationPlugin,
  DestinationPluginError,
  defineDestinationCommand,
  defineDestinationCommandGroup,
  defineDestinationPlugin,
} from "migrate-sdk";
import {
  CommercetoolsSdk,
  type CommercetoolsSdkError,
  type CommercetoolsSdkLayer,
} from "../sdk.ts";
import {
  type BusinessUnitUpdateCommandShape,
  type BusinessUnitUpdateFactory,
  makeBusinessUnitUpdate,
  type NonEmptyBusinessUnitUpdateActions,
} from "./business-unit-update-builder.ts";
import {
  type BusinessUnitCustomFieldsHelper,
  type CommercetoolsCustomFieldSchema,
  type CommercetoolsCustomTypeConfig,
  makeBusinessUnitCustomFieldsHelper,
} from "./custom-fields.ts";
import type { CustomerUpdateAction } from "./customer-actions.ts";
import {
  makeProductUpdate,
  type NonEmptyProductUpdateActions,
  type ProductUpdateCommandShape,
  type ProductUpdateFactory,
} from "./product-update-builder.ts";
import type {
  CommercetoolsCustomerSelector,
  CommercetoolsProductSelector,
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

export type {
  CommercetoolsBusinessUnitSelector,
  CommercetoolsCustomerSelector,
  CommercetoolsProductSelector,
} from "./selectors.ts";

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
  readonly sdkLayer: CommercetoolsSdkLayer;
}

export interface CommercetoolsDestinationWithProductTypesOptions<
  ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord,
> extends CommercetoolsDestinationBaseOptions {
  readonly productTypes: CommercetoolsProductAttributeSchemasInput<ProductAttributeSchemaRecord>;
}

export interface CommercetoolsDestinationWithBusinessUnitCustomTypesOptions<
  BusinessUnitCustomFieldSchema extends CommercetoolsCustomFieldSchema,
> extends CommercetoolsDestinationBaseOptions {
  readonly customTypes: {
    readonly businessUnits: CommercetoolsCustomTypeConfig<BusinessUnitCustomFieldSchema>;
  };
}

export interface CommercetoolsDestinationWithProductTypesAndBusinessUnitCustomTypesOptions<
  ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord,
  BusinessUnitCustomFieldSchema extends CommercetoolsCustomFieldSchema,
> extends CommercetoolsDestinationBaseOptions {
  readonly customTypes: {
    readonly businessUnits: CommercetoolsCustomTypeConfig<BusinessUnitCustomFieldSchema>;
  };
  readonly productTypes: CommercetoolsProductAttributeSchemasInput<ProductAttributeSchemaRecord>;
}

export type CommercetoolsDestinationOptions<
  ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord = Record<never, never>,
  BusinessUnitCustomFieldSchema extends
    | CommercetoolsCustomFieldSchema
    | never = never,
> = keyof ProductAttributeSchemaRecord extends never
  ? [BusinessUnitCustomFieldSchema] extends [never]
    ? CommercetoolsDestinationBaseOptions
    : CommercetoolsDestinationWithBusinessUnitCustomTypesOptions<BusinessUnitCustomFieldSchema>
  : [BusinessUnitCustomFieldSchema] extends [never]
    ? CommercetoolsDestinationWithProductTypesOptions<ProductAttributeSchemaRecord>
    : CommercetoolsDestinationWithProductTypesAndBusinessUnitCustomTypesOptions<
        ProductAttributeSchemaRecord,
        BusinessUnitCustomFieldSchema
      >;

export interface CreateBusinessUnitDraftCommand {
  readonly draft: BusinessUnitDraft;
  readonly kind: "CreateBusinessUnitDraft";
}

export type UpdateBusinessUnitCommand = BusinessUnitUpdateCommandShape;

export interface CreateCustomerDraftCommand {
  readonly draft: CustomerDraft;
  readonly kind: "CreateCustomerDraft";
}

export type NonEmptyCustomerUpdateActions<
  Action extends CustomerUpdateAction = CustomerUpdateAction,
> = NonEmptyUpdateActions<Action>;

export type CustomerUpdateCommandShape<
  Action extends CustomerUpdateAction = CustomerUpdateAction,
> = UpdateCommandShape<"UpdateCustomer", CommercetoolsCustomerSelector, Action>;

export type CustomerUpdateInput = UpdateInput<CommercetoolsCustomerSelector>;

export type CustomerUpdateWithActionsInput<
  Action extends CustomerUpdateAction = CustomerUpdateAction,
> = UpdateWithActionsInput<CommercetoolsCustomerSelector, Action>;

export type EmptyCustomerUpdateActionBuilder = EmptyUpdateActionBuilder<
  "UpdateCustomer",
  CommercetoolsCustomerSelector,
  CustomerUpdateAction
>;

export type CustomerUpdateActionBuilder<
  Action extends CustomerUpdateAction = CustomerUpdateAction,
> = UpdateActionBuilder<
  "UpdateCustomer",
  CommercetoolsCustomerSelector,
  CustomerUpdateAction,
  Action
>;

export type CustomerUpdateFactory = UpdateCommandFactory<
  "UpdateCustomer",
  CommercetoolsCustomerSelector,
  CustomerUpdateAction
>;

export type UpdateCustomerCommand = CustomerUpdateCommandShape;

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
  | CreateBusinessUnitDraftCommand
  | UpdateBusinessUnitCommand
  | CreateCustomerDraftCommand
  | UpdateCustomerCommand
  | CreateProductDraftCommand
  | PublishProductCommand
  | UpdateProductCommand;

export interface CommercetoolsBusinessUnitCommands {
  readonly createDraft: (
    draft: BusinessUnitDraft
  ) => CreateBusinessUnitDraftCommand;
  readonly update: BusinessUnitUpdateFactory;
}

export interface CommercetoolsCustomerCommands {
  readonly createDraft: (draft: CustomerDraft) => CreateCustomerDraftCommand;
  readonly update: CustomerUpdateFactory;
}

export interface CommercetoolsProductCommands {
  readonly createDraft: (draft: ProductDraft) => CreateProductDraftCommand;
  readonly publish: (
    input: Omit<PublishProductCommand, "kind">
  ) => PublishProductCommand;
  readonly update: ProductUpdateFactory;
}

export interface CommercetoolsDestinationCommands {
  readonly businessUnits: CommercetoolsBusinessUnitCommands;
  readonly customers: CommercetoolsCustomerCommands;
  readonly products: CommercetoolsProductCommands;
}

export interface CommercetoolsBusinessUnitHelpers<
  BusinessUnitCustomFieldSchema extends CommercetoolsCustomFieldSchema | never,
> {
  readonly customFields: BusinessUnitCustomFieldsHelper<BusinessUnitCustomFieldSchema>;
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
  BusinessUnitCustomFieldSchema extends CommercetoolsCustomFieldSchema | never,
> {
  readonly businessUnits: CommercetoolsBusinessUnitHelpers<BusinessUnitCustomFieldSchema>;
  readonly products: CommercetoolsProductHelpers<ProductAttributeSchemaRecord>;
}

export interface CommercetoolsDestination<
  ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord = Record<never, never>,
  BusinessUnitCustomFieldSchema extends
    | CommercetoolsCustomFieldSchema
    | never = never,
> extends ConfiguredDestinationPlugin<CommercetoolsDestinationCommand> {
  readonly commands: CommercetoolsDestinationCommands;
  readonly helpers: CommercetoolsDestinationHelpers<
    ProductAttributeSchemaRecord,
    BusinessUnitCustomFieldSchema
  >;
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

const hasBooleanField = (value: UnknownRecord, field: string): boolean =>
  typeof value[field] === "boolean";

const hasRecordField = (value: UnknownRecord, field: string): boolean =>
  isRecord(value[field]);

const hasArrayField = (value: UnknownRecord, field: string): boolean =>
  Array.isArray(value[field]);

const hasStringIdOrKey = (
  value: UnknownRecord,
  idField: string,
  keyField: string
): boolean =>
  (hasOwnField(value, idField) || hasOwnField(value, keyField)) &&
  (!hasOwnField(value, idField) || hasStringField(value, idField)) &&
  (!hasOwnField(value, keyField) || hasStringField(value, keyField));

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

const isBusinessUnitResourceIdentifier = (value: unknown): boolean => {
  if (!isRecord(value) || value.typeId !== "business-unit") {
    return false;
  }

  const hasId = hasOwnField(value, "id");
  const hasKey = hasOwnField(value, "key");

  if (hasId === hasKey) {
    return false;
  }

  return hasId ? hasStringField(value, "id") : hasStringField(value, "key");
};

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

const isProductDraft = (value: unknown): value is ProductDraft =>
  isRecord(value) &&
  isProductTypeResourceIdentifier(value.productType) &&
  isStringRecord(value.name) &&
  isStringRecord(value.slug);

const isCustomerDraft = (value: unknown): value is CustomerDraft =>
  isRecord(value) && hasStringField(value, "email");

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isProductPublishScope = (value: unknown): value is ProductPublishScope =>
  typeof value === "string";

type BusinessUnitUpdateActionGuard = (value: UnknownRecord) => boolean;

const businessUnitUpdateActionGuardsByName = {
  addAddress: (value) => hasRecordField(value, "address"),
  addAssociate: (value) => hasRecordField(value, "associate"),
  addBillingAddressId: (value) =>
    hasStringIdOrKey(value, "addressId", "addressKey"),
  addCustomerGroupAssignment: (value) =>
    hasRecordField(value, "customerGroupAssignment"),
  addShippingAddressId: (value) =>
    hasStringIdOrKey(value, "addressId", "addressKey"),
  addStore: (value) => hasRecordField(value, "store"),
  changeAddress: (value) =>
    hasStringIdOrKey(value, "addressId", "addressKey") &&
    hasRecordField(value, "address"),
  changeApprovalRuleMode: (value) => hasStringField(value, "approvalRuleMode"),
  changeAssociate: (value) => hasRecordField(value, "associate"),
  changeAssociateMode: (value) =>
    hasStringField(value, "associateMode") &&
    hasBooleanField(value, "makeInheritedAssociatesExplicit"),
  changeName: (value) => hasStringField(value, "name"),
  changeParentUnit: (value) => hasRecordField(value, "parentUnit"),
  changeStatus: (value) => hasStringField(value, "status"),
  removeAddress: (value) => hasStringIdOrKey(value, "addressId", "addressKey"),
  removeAssociate: (value) => hasRecordField(value, "customer"),
  removeBillingAddressId: (value) =>
    hasStringIdOrKey(value, "addressId", "addressKey"),
  removeCustomerGroupAssignment: (value) =>
    hasRecordField(value, "customerGroup"),
  removeShippingAddressId: (value) =>
    hasStringIdOrKey(value, "addressId", "addressKey"),
  removeStore: (value) => hasRecordField(value, "store"),
  setAddressCustomField: (value) =>
    hasStringField(value, "addressId") && hasStringField(value, "name"),
  setAddressCustomType: (value) => hasStringField(value, "addressId"),
  setAssociates: (value) => hasArrayField(value, "associates"),
  setContactEmail: () => true,
  setCustomField: (value) => hasStringField(value, "name"),
  setCustomType: () => true,
  setCustomerGroupAssignments: () => true,
  setDefaultBillingAddress: (value) =>
    hasOwnField(value, "addressId") || hasOwnField(value, "addressKey")
      ? hasStringIdOrKey(value, "addressId", "addressKey")
      : true,
  setDefaultShippingAddress: (value) =>
    hasOwnField(value, "addressId") || hasOwnField(value, "addressKey")
      ? hasStringIdOrKey(value, "addressId", "addressKey")
      : true,
  setStoreMode: (value) => hasStringField(value, "storeMode"),
  setStores: (value) => hasArrayField(value, "stores"),
  setUnitType: (value) => hasStringField(value, "unitType"),
} satisfies Record<
  BusinessUnitUpdateAction["action"],
  BusinessUnitUpdateActionGuard
>;

const businessUnitUpdateActionGuards = new Map<
  string,
  BusinessUnitUpdateActionGuard
>(Object.entries(businessUnitUpdateActionGuardsByName));

const isBusinessUnitUpdateAction = (
  value: unknown
): value is BusinessUnitUpdateAction => {
  if (!isRecord(value) || typeof value.action !== "string") {
    return false;
  }

  const guard = businessUnitUpdateActionGuards.get(value.action);

  return guard?.(value) === true;
};

const isBusinessUnitUpdateActions = (
  value: unknown
): value is NonEmptyBusinessUnitUpdateActions =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(isBusinessUnitUpdateAction);

const isCustomerUpdateAction = (
  value: unknown
): value is CustomerUpdateAction =>
  isRecord(value) && hasStringField(value, "action");

const isCustomerUpdateActions = (
  value: unknown
): value is NonEmptyCustomerUpdateActions =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(isCustomerUpdateAction);

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

const BusinessUnitDraftSchema = Schema.declare<BusinessUnitDraft>(
  isBusinessUnitDraft,
  {
    identifier: "BusinessUnitDraft",
  }
);

const CustomerDraftSchema = Schema.declare<CustomerDraft>(isCustomerDraft, {
  identifier: "CustomerDraft",
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

export const CommercetoolsBusinessUnitSelectorSchema =
  CommercetoolsProductSelectorSchema;

export const CommercetoolsCustomerSelectorSchema =
  CommercetoolsProductSelectorSchema;

const ProductPublishScopeSchema = Schema.optional(
  Schema.declare<ProductPublishScope>(isProductPublishScope, {
    identifier: "ProductPublishScope",
  })
);

const BusinessUnitUpdateActionsSchema =
  Schema.declare<NonEmptyBusinessUnitUpdateActions>(
    isBusinessUnitUpdateActions,
    {
      identifier: "BusinessUnitUpdateActions",
    }
  );

const CustomerUpdateActionsSchema =
  Schema.declare<NonEmptyCustomerUpdateActions>(isCustomerUpdateActions, {
    identifier: "CustomerUpdateActions",
  });

const ProductUpdateActionsSchema = Schema.declare<NonEmptyProductUpdateActions>(
  isProductUpdateActions,
  {
    identifier: "ProductUpdateActions",
  }
);

const ProductVersionSchema = Schema.declare<number>(isPositiveInteger, {
  identifier: "ProductVersion",
});

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
  version: ProductVersionSchema,
});

export const CreateCustomerDraftCommand: Schema.Codec<
  CreateCustomerDraftCommand,
  CreateCustomerDraftCommand,
  never,
  never
> = Schema.Struct({
  draft: CustomerDraftSchema,
  kind: Schema.Literal("CreateCustomerDraft"),
});

export const UpdateCustomerCommand: Schema.Codec<
  UpdateCustomerCommand,
  UpdateCustomerCommand,
  never,
  never
> = Schema.Struct({
  actions: CustomerUpdateActionsSchema,
  kind: Schema.Literal("UpdateCustomer"),
  selector: CommercetoolsCustomerSelectorSchema,
  version: ProductVersionSchema,
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

const createBusinessUnitDraftCommand = defineDestinationCommand(
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

const updateBusinessUnitCommand = defineDestinationCommand(
  "UpdateBusinessUnit",
  {
    identity: false,
    schema: UpdateBusinessUnitCommand,
  }
);

const createCustomerDraftCommand = defineDestinationCommand(
  "CreateCustomerDraft",
  {
    identity: true,
    make: {
      createDraft: (draft: CustomerDraft): CreateCustomerDraftCommand => ({
        draft,
        kind: "CreateCustomerDraft",
      }),
    },
    schema: CreateCustomerDraftCommand,
  }
);

const updateCustomerCommand = defineDestinationCommand("UpdateCustomer", {
  identity: false,
  schema: UpdateCustomerCommand,
});

const makeCustomerUpdate = makeUpdateCommandFactory<
  "UpdateCustomer",
  CommercetoolsCustomerSelector,
  CustomerUpdateAction
>({
  kind: "UpdateCustomer",
  label: "Customer update",
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
  defineDestinationCommandGroup("businessUnits").add(
    createBusinessUnitDraftCommand,
    updateBusinessUnitCommand
  ),
  defineDestinationCommandGroup("customers").add(
    createCustomerDraftCommand,
    updateCustomerCommand
  ),
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

const businessUnitMetadata = (
  businessUnit: BusinessUnit
): Record<string, number | string> => ({
  businessUnitKey: businessUnit.key,
  businessUnitVersion: businessUnit.version,
});

const customerMetadata = (
  customer: Customer
): Record<string, number | string> => ({
  ...(customer.key === undefined ? {} : { customerKey: customer.key }),
  customerEmail: customer.email,
  customerVersion: customer.version,
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
  const BusinessUnitCustomFieldSchema extends CommercetoolsCustomFieldSchema,
>(
  options: CommercetoolsDestinationWithProductTypesAndBusinessUnitCustomTypesOptions<
    ProductAttributeSchemaRecord,
    BusinessUnitCustomFieldSchema
  >
): CommercetoolsDestination<
  ProductAttributeSchemaRecord,
  BusinessUnitCustomFieldSchema
>;
function make<
  const BusinessUnitCustomFieldSchema extends CommercetoolsCustomFieldSchema,
>(
  options: CommercetoolsDestinationWithBusinessUnitCustomTypesOptions<BusinessUnitCustomFieldSchema>
): CommercetoolsDestination<
  Record<never, never>,
  BusinessUnitCustomFieldSchema
>;
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
  const BusinessUnitCustomFieldSchema extends
    | CommercetoolsCustomFieldSchema
    | never = never,
>(
  options:
    | CommercetoolsDestinationBaseOptions
    | CommercetoolsDestinationWithProductTypesOptions<ProductAttributeSchemaRecord>
    | CommercetoolsDestinationWithBusinessUnitCustomTypesOptions<BusinessUnitCustomFieldSchema>
    | CommercetoolsDestinationWithProductTypesAndBusinessUnitCustomTypesOptions<
        ProductAttributeSchemaRecord,
        BusinessUnitCustomFieldSchema
      >
): CommercetoolsDestination<
  ProductAttributeSchemaRecord,
  BusinessUnitCustomFieldSchema
> {
  const implementedPlugin = pluginDefinition
    .implement((handlers) =>
      handlers
        .group("businessUnits", (businessUnitHandlers) =>
          businessUnitHandlers
            .handle("CreateBusinessUnitDraft", ({ command }) =>
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
              })
            )
            .handle("UpdateBusinessUnit", ({ command }) =>
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
              })
            )
        )
        .group("customers", (customerHandlers) =>
          customerHandlers
            .handle("CreateCustomerDraft", ({ command }) =>
              Effect.gen(function* () {
                const sdk = yield* CommercetoolsSdk;
                const result = yield* sdk
                  .request("customers.createDraft", (project) =>
                    project.customers().post({
                      body: command.draft,
                    })
                  )
                  .pipe(Effect.mapError(toDestinationPluginError));
                const customer = result.customer;

                return {
                  destinationIdentity: customer.id,
                  destinationVersion: String(customer.version),
                  metadata: customerMetadata(customer),
                };
              })
            )
            .handle("UpdateCustomer", ({ command }) =>
              Effect.gen(function* () {
                const sdk = yield* CommercetoolsSdk;
                const body: CustomerUpdate = {
                  actions: [...command.actions],
                  version: command.version,
                };
                const customer = yield* sdk
                  .request("customers.update", (project) => {
                    const customers = project.customers();
                    const selectedCustomer =
                      command.selector.kind === "id"
                        ? customers.withId({ ID: command.selector.id })
                        : customers.withKey({
                            key: command.selector.key,
                          });

                    return selectedCustomer.post({
                      body,
                    });
                  })
                  .pipe(Effect.mapError(toDestinationPluginError));

                return {
                  destinationVersion: String(customer.version),
                  metadata: customerMetadata(customer),
                };
              })
            )
        )
        .group("products", (productsHandlers) =>
          productsHandlers
            .handle("CreateProductDraft", ({ command }) =>
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
              })
            )
            .handle("PublishProduct", ({ command }) =>
              Effect.gen(function* () {
                const sdk = yield* CommercetoolsSdk;
                const action: ProductPublishAction = {
                  action: "publish",
                  ...(command.scope === undefined
                    ? {}
                    : { scope: command.scope }),
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
              })
            )
            .handle("UpdateProduct", ({ command }) =>
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
              })
            )
        )
    )
    .provide(options.sdkLayer);

  return {
    ...implementedPlugin,
    commands: {
      ...implementedPlugin.commands,
      businessUnits: {
        ...implementedPlugin.commands.businessUnits,
        update: makeBusinessUnitUpdate,
      },
      customers: {
        ...implementedPlugin.commands.customers,
        update: makeCustomerUpdate,
      },
      products: {
        ...implementedPlugin.commands.products,
        update: makeProductUpdate,
      },
    },
    helpers: {
      businessUnits: {
        customFields:
          makeBusinessUnitCustomFieldsHelper<BusinessUnitCustomFieldSchema>(
            "customTypes" in options
              ? options.customTypes.businessUnits
              : undefined
          ),
      },
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
