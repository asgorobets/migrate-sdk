import type { InventoryEntryUpdateAction as SdkInventoryEntryUpdateAction } from "@commercetools/platform-sdk";
import type {
  UpdateActionByName,
  UpdateActionInput,
  UpdateActionName,
} from "./internal/sdk-update-actions.ts";

export type InventoryEntryUpdateAction = SdkInventoryEntryUpdateAction;

export type InventoryEntryUpdateActionName =
  UpdateActionName<InventoryEntryUpdateAction>;

export type InventoryEntryUpdateActionInput<
  Name extends InventoryEntryUpdateActionName,
> = UpdateActionInput<InventoryEntryUpdateAction, Name>;

export type InventoryEntryUpdateActionByName<
  Name extends InventoryEntryUpdateActionName,
> = UpdateActionByName<InventoryEntryUpdateAction, Name>;
