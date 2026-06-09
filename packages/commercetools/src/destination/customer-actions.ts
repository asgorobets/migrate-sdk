import type { CustomerUpdateAction as SdkCustomerUpdateAction } from "@commercetools/platform-sdk";
import type {
  RefineOptionalAddressIdOrKeyActions,
  UpdateActionByName,
  UpdateActionInput,
  UpdateActionName,
} from "./internal/sdk-update-actions.ts";

export type CustomerUpdateAction =
  RefineOptionalAddressIdOrKeyActions<SdkCustomerUpdateAction>;

export type CustomerUpdateActionName = UpdateActionName<CustomerUpdateAction>;

export type CustomerUpdateActionInput<Name extends CustomerUpdateActionName> =
  UpdateActionInput<CustomerUpdateAction, Name>;

export type CustomerUpdateActionByName<Name extends CustomerUpdateActionName> =
  UpdateActionByName<CustomerUpdateAction, Name>;
