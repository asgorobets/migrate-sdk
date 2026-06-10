import type { ProductUpdateAction as SdkProductUpdateAction } from "@commercetools/platform-sdk";
import type { RefineProductPriceDraftActionFields } from "./internal/product-price-drafts.ts";
import type {
  RefineResourceIdentifierFieldActions,
  UpdateActionByName,
  UpdateActionInput,
  UpdateActionName,
} from "./internal/sdk-update-actions.ts";

export type ProductUpdateAction = RefineProductPriceDraftActionFields<
  RefineResourceIdentifierFieldActions<
    SdkProductUpdateAction,
    ["category", "taxCategory", "state", "type"]
  >
>;

export type ProductUpdateActionName = UpdateActionName<ProductUpdateAction>;

export type ProductUpdateActionInput<Name extends ProductUpdateActionName> =
  UpdateActionInput<ProductUpdateAction, Name>;

export type ProductUpdateActionByName<Name extends ProductUpdateActionName> =
  UpdateActionByName<ProductUpdateAction, Name>;
