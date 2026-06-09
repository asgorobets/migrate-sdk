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
  BusinessUnitUpdateFactory,
  BusinessUnitUpdateInput,
  BusinessUnitUpdateWithActionsInput,
  CommercetoolsBusinessUnitCommands,
  CommercetoolsBusinessUnitHelpers,
  CreateBusinessUnitDraftCommand as CreateBusinessUnitDraftCommandType,
  EmptyBusinessUnitUpdateActionBuilder,
  NonEmptyBusinessUnitUpdateActions,
  UpdateBusinessUnitCommand as UpdateBusinessUnitCommandType,
} from "./business-units.ts";
export {
  CreateBusinessUnitDraftCommand,
  UpdateBusinessUnitCommand,
} from "./business-units.ts";
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
  CommercetoolsCustomerCommands,
  CreateCustomerDraftCommand as CreateCustomerDraftCommandType,
  CustomerUpdateFactory,
  CustomerUpdateInput,
  CustomerUpdateWithActionsInput,
  EmptyCustomerUpdateActionBuilder,
  NonEmptyCustomerUpdateActions,
  UpdateCustomerCommand as UpdateCustomerCommandType,
} from "./customers.ts";
export {
  CreateCustomerDraftCommand,
  UpdateCustomerCommand,
} from "./customers.ts";
export type {
  CommercetoolsDestination,
  CommercetoolsDestinationBaseOptions,
  CommercetoolsDestinationCommand,
  CommercetoolsDestinationCommands,
  CommercetoolsDestinationHelpers,
  CommercetoolsDestinationOptions,
  CommercetoolsDestinationWithBusinessUnitCustomTypesOptions,
  CommercetoolsDestinationWithProductTypesAndBusinessUnitCustomTypesOptions,
  CommercetoolsDestinationWithProductTypesOptions,
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
  CreateProductDraftCommand as CreateProductDraftCommandType,
  EmptyProductUpdateActionBuilder,
  NonEmptyProductUpdateActions,
  ProductUpdateActionBuilder,
  ProductUpdateCommandShape,
  ProductUpdateFactory,
  ProductUpdateInput,
  ProductUpdateWithActionsInput,
  PublishProductCommand as PublishProductCommandType,
  UpdateProductCommand as UpdateProductCommandType,
} from "./products.ts";
export type {
  CommercetoolsBusinessUnitSelector,
  CommercetoolsCustomerSelector,
  CommercetoolsProductSelector,
} from "./selectors.ts";
export {
  CommercetoolsBusinessUnitSelectorSchema,
  CommercetoolsCustomerSelectorSchema,
  CommercetoolsProductSelectorSchema,
} from "./selectors.ts";
export { CommercetoolsDestinationPlugin } from "./plugin.ts";
export {
  CreateProductDraftCommand,
  PublishProductCommand,
  UpdateProductCommand,
} from "./products.ts";
