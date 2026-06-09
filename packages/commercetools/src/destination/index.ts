// biome-ignore-all assist/source/organizeImports: Public feature entrypoint is grouped by API audience.
// biome-ignore-all lint/performance/noBarrelFile: Public subpath entrypoint intentionally re-exports the Commercetools destination API.

export type {
  BusinessUnitCustomFieldBuilder,
  BusinessUnitCustomFieldsHelper,
  CommercetoolsCustomFieldSchema,
  CommercetoolsCustomTypeConfig,
  SameShapeCustomFieldSchema,
} from "./custom-fields.ts";
export type {
  BusinessUnitUpdateAction,
  BusinessUnitUpdateActionByName,
  BusinessUnitUpdateActionInput,
  BusinessUnitUpdateActionName,
} from "./business-unit-actions.ts";
export type {
  BusinessUnitUpdateActionBuilder,
  BusinessUnitUpdateCommandShape,
  EmptyBusinessUnitUpdateActionBuilder,
  BusinessUnitUpdateFactory,
  BusinessUnitUpdateInput,
  BusinessUnitUpdateWithActionsInput,
  NonEmptyBusinessUnitUpdateActions,
} from "./plugin.ts";
export type {
  CustomerUpdateAction,
  CustomerUpdateActionByName,
  CustomerUpdateActionInput,
  CustomerUpdateActionName,
} from "./customer-actions.ts";
export type {
  ProductUpdateAction,
  ProductUpdateActionByName,
  ProductUpdateActionInput,
  ProductUpdateActionName,
} from "./product-actions.ts";
export type {
  CustomerUpdateActionBuilder,
  CustomerUpdateCommandShape,
  EmptyCustomerUpdateActionBuilder,
  CustomerUpdateFactory,
  CustomerUpdateInput,
  CustomerUpdateWithActionsInput,
  NonEmptyCustomerUpdateActions,
} from "./plugin.ts";
export type {
  CommercetoolsBusinessUnitSelector,
  CommercetoolsBusinessUnitHelpers,
  CommercetoolsBusinessUnitCommands,
  CommercetoolsCustomerCommands,
  CommercetoolsCustomerSelector,
  CommercetoolsDestination,
  CommercetoolsDestinationBaseOptions,
  CommercetoolsDestinationCommand,
  CommercetoolsDestinationCommands,
  CommercetoolsDestinationHelpers,
  CommercetoolsDestinationOptions,
  CommercetoolsDestinationWithBusinessUnitCustomTypesOptions,
  CommercetoolsDestinationWithProductTypesAndBusinessUnitCustomTypesOptions,
  CommercetoolsDestinationWithProductTypesOptions,
  CreateBusinessUnitDraftCommand as CreateBusinessUnitDraftCommandType,
  CreateCustomerDraftCommand as CreateCustomerDraftCommandType,
  UpdateBusinessUnitCommand as UpdateBusinessUnitCommandType,
  UpdateCustomerCommand as UpdateCustomerCommandType,
} from "./plugin.ts";
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
export type {
  CommercetoolsProductCommands,
  CommercetoolsProductHelpers,
  CommercetoolsProductSelector,
  CreateProductDraftCommandType,
  PublishProductCommandType,
  UpdateProductCommandType,
} from "./products.ts";
export type {
  NonEmptyProductUpdateActions,
  ProductUpdateActionBuilder,
  ProductUpdateCommandShape,
  ProductUpdateFactory,
  ProductUpdateInput,
  ProductUpdateWithActionsInput,
} from "./plugin.ts";
export {
  CommercetoolsBusinessUnitSelectorSchema,
  CommercetoolsCustomerSelectorSchema,
  CommercetoolsDestinationPlugin,
  CreateBusinessUnitDraftCommand,
  CreateCustomerDraftCommand,
  UpdateBusinessUnitCommand,
  UpdateCustomerCommand,
} from "./plugin.ts";
export {
  CommercetoolsProductSelectorSchema,
  CreateProductDraftCommand,
  PublishProductCommand,
  UpdateProductCommand,
} from "./products.ts";
