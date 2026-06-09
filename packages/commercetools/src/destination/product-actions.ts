import type { ProductUpdateAction as SdkProductUpdateAction } from "@commercetools/platform-sdk";
import type {
  UpdateActionByName,
  UpdateActionInput,
  UpdateActionName,
} from "./internal/sdk-update-actions.ts";

export type ProductUpdateAction = SdkProductUpdateAction;

export type ProductUpdateActionName = UpdateActionName<ProductUpdateAction>;

export type ProductUpdateActionInput<Name extends ProductUpdateActionName> =
  UpdateActionInput<ProductUpdateAction, Name>;

export type ProductUpdateActionByName<Name extends ProductUpdateActionName> =
  UpdateActionByName<ProductUpdateAction, Name>;
