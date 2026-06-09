// biome-ignore-all assist/source/organizeImports: Product destination exports are grouped by API audience.
// biome-ignore-all lint/performance/noBarrelFile: Product destination module intentionally re-exports product-specific APIs from the plugin implementation.

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
  CreateProductDraftCommand as CreateProductDraftCommandType,
  PublishProductCommand as PublishProductCommandType,
  UpdateProductCommand as UpdateProductCommandType,
} from "./plugin.ts";
export {
  CommercetoolsProductSelectorSchema,
  CreateProductDraftCommand,
  PublishProductCommand,
  UpdateProductCommand,
} from "./plugin.ts";
