// biome-ignore-all assist/source/organizeImports: Public feature entrypoint is grouped by API audience.
// biome-ignore-all lint/performance/noBarrelFile: Public subpath entrypoint intentionally re-exports the Commercetools destination API.

export type {
  CommercetoolsDestination,
  CommercetoolsDestinationBaseOptions,
  CommercetoolsDestinationCommand,
  CommercetoolsDestinationCommands,
  CommercetoolsDestinationHelpers,
  CommercetoolsDestinationOptions,
  CommercetoolsDestinationWithProductTypesOptions,
  CommercetoolsProductAttributeBag,
  CommercetoolsProductAttributeSchema,
  CommercetoolsProductAttributeSchemas,
  CommercetoolsProductCommands,
  CommercetoolsProductHelpers,
  CommercetoolsProductSelector,
  CreateProductDraftCommand as CreateProductDraftCommandType,
  PublishProductCommand as PublishProductCommandType,
  UpdateProductCommand as UpdateProductCommandType,
} from "./products.ts";
export type {
  NonEmptyProductUpdateActions,
  ProductUpdateActionBuilder,
  ProductUpdateActionByName,
  ProductUpdateActionInput,
  ProductUpdateActionName,
  ProductUpdateCommandShape,
  ProductUpdateFactory,
  ProductUpdateInput,
  ProductUpdateWithActionsInput,
} from "./product-update-builder.ts";
export {
  CommercetoolsDestinationPlugin,
  CommercetoolsProductSelectorSchema,
  CreateProductDraftCommand,
  PublishProductCommand,
  UpdateProductCommand,
} from "./products.ts";
