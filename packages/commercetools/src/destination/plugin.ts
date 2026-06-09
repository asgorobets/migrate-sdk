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
  makeBusinessUnitUpdate,
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
  makeCustomerUpdate,
  type UpdateCustomerCommand,
} from "./customers.ts";
import { makeProductHelpers } from "./product-attributes.ts";
import {
  type CommercetoolsProductAttributeSchemaRecord,
  type CommercetoolsProductAttributeSchemasInput,
  type CommercetoolsProductCommands,
  type CommercetoolsProductHelpers,
  type CreateProductDraftCommand,
  handleCreateProductDraft,
  handlePublishProduct,
  handleUpdateProduct,
  makeProductUpdate,
  type PublishProductCommand,
  productCommandGroup,
  type UpdateProductCommand,
} from "./products.ts";

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
  | CreateProductDraftCommand
  | PublishProductCommand
  | UpdateProductCommand;

export interface CommercetoolsDestinationCommands {
  readonly businessUnits: CommercetoolsBusinessUnitCommands;
  readonly customers: CommercetoolsCustomerCommands;
  readonly products: CommercetoolsProductCommands;
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
  productCommandGroup
);

const implementCommercetoolsDestination = () =>
  pluginDefinition.implement((handlers) =>
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
      .group("products", (productHandlers) =>
        productHandlers
          .handle("CreateProductDraft", handleCreateProductDraft)
          .handle("PublishProduct", handlePublishProduct)
          .handle("UpdateProduct", handleUpdateProduct)
      )
  );

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
  const implementedPlugin = implementCommercetoolsDestination().provide(
    options.sdkLayer
  );

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
