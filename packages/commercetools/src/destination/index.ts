// biome-ignore-all lint/performance/noBarrelFile: Public subpath entrypoint intentionally re-exports the Commercetools destination API.

export {
  CommercetoolsDestination,
  type CommercetoolsProductSelectionCreatedChange,
  type CommercetoolsProductSelectionHelpers,
  type ProvidedCommercetoolsDestination,
  type UnprovidedCommercetoolsDestination,
} from "./capabilities.ts";
