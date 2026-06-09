import type { BusinessUnitUpdateAction as SdkBusinessUnitUpdateAction } from "@commercetools/platform-sdk";
import type {
  RefineOptionalAddressIdOrKeyActions,
  UpdateActionByName,
  UpdateActionInput,
  UpdateActionName,
} from "./internal/sdk-update-actions.ts";

export type BusinessUnitUpdateAction =
  RefineOptionalAddressIdOrKeyActions<SdkBusinessUnitUpdateAction>;

export type BusinessUnitUpdateActionName =
  UpdateActionName<BusinessUnitUpdateAction>;

export type BusinessUnitUpdateActionInput<
  Name extends BusinessUnitUpdateActionName,
> = UpdateActionInput<BusinessUnitUpdateAction, Name>;

export type BusinessUnitUpdateActionByName<
  Name extends BusinessUnitUpdateActionName,
> = UpdateActionByName<BusinessUnitUpdateAction, Name>;
