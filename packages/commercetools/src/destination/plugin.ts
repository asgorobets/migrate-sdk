import type { ConfiguredDestinationPlugin } from "migrate-sdk";
import { defineDestinationPlugin } from "migrate-sdk";
import type { CommercetoolsSdkLayer } from "../sdk.ts";
import {
  businessUnitCommandGroup,
  type CommercetoolsBusinessUnitCommands,
  type CommercetoolsBusinessUnitHelpers,
  type CreateBusinessUnitDraftCommand,
  handleCreateBusinessUnitDraft,
  handleUpdateBusinessUnit,
  makeCommercetoolsBusinessUnitCommands,
  type UpdateBusinessUnitCommand,
} from "./business-units.ts";
import {
  type CommercetoolsCustomFieldSchema,
  type CommercetoolsCustomTypeConfig,
  makeBusinessUnitCustomFieldsHelper,
} from "./custom-fields.ts";
import {
  type CommercetoolsCustomerCommands,
  type CreateCustomerDraftCommand,
  customerCommandGroup,
  handleCreateCustomerDraft,
  handleUpdateCustomer,
  makeCommercetoolsCustomerCommands,
  type UpdateCustomerCommand,
} from "./customers.ts";
import {
  type CommercetoolsInventoryEntryCommands,
  type CreateInventoryEntryDraftCommand,
  handleCreateInventoryEntryDraft,
  handleUpdateInventoryEntry,
  inventoryCommandGroup,
  makeCommercetoolsInventoryEntryCommands,
  type UpdateInventoryEntryCommand,
} from "./inventory.ts";
import { makeProductHelpers } from "./product-attributes.ts";
import {
  type CommercetoolsProductSelectionCommands,
  type CreateProductSelectionDraftCommand,
  handleCreateProductSelectionDraft,
  handleUpdateProductSelection,
  makeCommercetoolsProductSelectionCommands,
  productSelectionCommandGroup,
  type UpdateProductSelectionCommand,
} from "./product-selections.ts";
import {
  type CommercetoolsProductAttributeSchemaRecord,
  type CommercetoolsProductAttributeSchemasInput,
  type CommercetoolsProductCommands,
  type CommercetoolsProductHelpers,
  type CreateProductDraftCommand,
  handleCreateProductDraft,
  handleUpdateProduct,
  makeCommercetoolsProductCommands,
  productCommandGroup,
  type UpdateProductCommand,
} from "./products.ts";
import {
  type CommercetoolsStoreCommands,
  type CreateStoreDraftCommand,
  handleCreateStoreDraft,
  handleUpdateStore,
  makeCommercetoolsStoreCommands,
  storeCommandGroup,
  type UpdateStoreCommand,
} from "./stores.ts";

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

export type CommercetoolsDestinationCommand =
  | CreateBusinessUnitDraftCommand
  | UpdateBusinessUnitCommand
  | CreateCustomerDraftCommand
  | UpdateCustomerCommand
  | CreateInventoryEntryDraftCommand
  | UpdateInventoryEntryCommand
  | CreateProductDraftCommand
  | UpdateProductCommand
  | CreateProductSelectionDraftCommand
  | UpdateProductSelectionCommand
  | CreateStoreDraftCommand
  | UpdateStoreCommand;

export interface CommercetoolsDestinationCommands {
  readonly businessUnits: CommercetoolsBusinessUnitCommands;
  readonly customers: CommercetoolsCustomerCommands;
  readonly inventory: CommercetoolsInventoryEntryCommands;
  readonly productSelections: CommercetoolsProductSelectionCommands;
  readonly products: CommercetoolsProductCommands;
  readonly stores: CommercetoolsStoreCommands;
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

const pluginDefinition = defineDestinationPlugin("commercetools").addGroup(
  businessUnitCommandGroup,
  customerCommandGroup,
  inventoryCommandGroup,
  productCommandGroup,
  productSelectionCommandGroup,
  storeCommandGroup
);

const implementedCommercetoolsDestination = pluginDefinition.implement(
  (handlers) =>
    handlers
      .group("businessUnits", (businessUnitHandlers) =>
        businessUnitHandlers
          .handle("CreateBusinessUnitDraft", handleCreateBusinessUnitDraft)
          .handle("UpdateBusinessUnit", handleUpdateBusinessUnit)
      )
      .group("customers", (customerHandlers) =>
        customerHandlers
          .handle("CreateCustomerDraft", handleCreateCustomerDraft)
          .handle("UpdateCustomer", handleUpdateCustomer)
      )
      .group("inventory", (inventoryHandlers) =>
        inventoryHandlers
          .handle("CreateInventoryEntryDraft", handleCreateInventoryEntryDraft)
          .handle("UpdateInventoryEntry", handleUpdateInventoryEntry)
      )
      .group("products", (productHandlers) =>
        productHandlers
          .handle("CreateProductDraft", handleCreateProductDraft)
          .handle("UpdateProduct", handleUpdateProduct)
      )
      .group("productSelections", (productSelectionHandlers) =>
        productSelectionHandlers
          .handle(
            "CreateProductSelectionDraft",
            handleCreateProductSelectionDraft
          )
          .handle("UpdateProductSelection", handleUpdateProductSelection)
      )
      .group("stores", (storeHandlers) =>
        storeHandlers
          .handle("CreateStoreDraft", handleCreateStoreDraft)
          .handle("UpdateStore", handleUpdateStore)
      )
);

const makeCommercetoolsDestinationCommands =
  (): CommercetoolsDestinationCommands => ({
    businessUnits: makeCommercetoolsBusinessUnitCommands(),
    customers: makeCommercetoolsCustomerCommands(),
    inventory: makeCommercetoolsInventoryEntryCommands(),
    products: makeCommercetoolsProductCommands(),
    productSelections: makeCommercetoolsProductSelectionCommands(),
    stores: makeCommercetoolsStoreCommands(),
  });

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
  const implementedPlugin = implementedCommercetoolsDestination.provide(
    options.sdkLayer
  );

  return {
    ...implementedPlugin,
    commands: makeCommercetoolsDestinationCommands(),
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
