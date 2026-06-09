import type { ProductSelectionUpdateAction as SdkProductSelectionUpdateAction } from "@commercetools/platform-sdk";
import type {
  RefineProductResourceIdentifierActions,
  UpdateActionByName,
  UpdateActionInput,
  UpdateActionName,
} from "./internal/sdk-update-actions.ts";

export type ProductSelectionUpdateAction =
  RefineProductResourceIdentifierActions<SdkProductSelectionUpdateAction>;

export type ProductSelectionUpdateActionName =
  UpdateActionName<ProductSelectionUpdateAction>;

export type ProductSelectionUpdateActionInput<
  Name extends ProductSelectionUpdateActionName,
> = UpdateActionInput<ProductSelectionUpdateAction, Name>;

export type ProductSelectionUpdateActionByName<
  Name extends ProductSelectionUpdateActionName,
> = UpdateActionByName<ProductSelectionUpdateAction, Name>;
