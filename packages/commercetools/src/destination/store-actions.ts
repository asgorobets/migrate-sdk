import type { StoreUpdateAction as SdkStoreUpdateAction } from "@commercetools/platform-sdk";
import type {
  RefineProductSelectionResourceIdentifierActions,
  UpdateActionByName,
  UpdateActionInput,
  UpdateActionName,
} from "./internal/sdk-update-actions.ts";

export type StoreUpdateAction =
  RefineProductSelectionResourceIdentifierActions<SdkStoreUpdateAction>;

export type StoreUpdateActionName = UpdateActionName<StoreUpdateAction>;

export type StoreUpdateActionInput<Name extends StoreUpdateActionName> =
  UpdateActionInput<StoreUpdateAction, Name>;

export type StoreUpdateActionByName<Name extends StoreUpdateActionName> =
  UpdateActionByName<StoreUpdateAction, Name>;
