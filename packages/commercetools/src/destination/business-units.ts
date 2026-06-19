import type { BusinessUnitDraft } from "@commercetools/platform-sdk";
import { Schema } from "effect";
import type { BusinessUnitUpdateAction } from "./business-unit-actions.ts";
import type {
  BusinessUnitCustomFieldsHelper,
  CommercetoolsCustomFieldSchema,
} from "./custom-fields.ts";
import {
  hasStringField,
  isRecord,
  isResourceIdentifier,
  makeUpdateActionsSchema,
  ResourceVersionSchema,
} from "./internal/command-schemas.ts";
import {
  type CommercetoolsBusinessUnitSelector,
  CommercetoolsBusinessUnitSelectorSchema,
} from "./selectors.ts";
import {
  type EmptyUpdateActionBuilder,
  makeUpdateActionFactory,
  type NonEmptyUpdateActions,
  type UpdateActionBuilder,
  type UpdateActionFactory,
  type UpdateInput,
  type UpdateWithActionsInput,
} from "./update-action-builder.ts";

export type NonEmptyBusinessUnitUpdateActions<
  Action extends BusinessUnitUpdateAction = BusinessUnitUpdateAction,
> = NonEmptyUpdateActions<Action>;

export type BusinessUnitUpdateInput =
  UpdateInput<CommercetoolsBusinessUnitSelector>;

export type BusinessUnitUpdateWithActionsInput<
  Action extends BusinessUnitUpdateAction = BusinessUnitUpdateAction,
> = UpdateWithActionsInput<CommercetoolsBusinessUnitSelector, Action>;

export type EmptyBusinessUnitUpdateActionBuilder = EmptyUpdateActionBuilder<
  CommercetoolsBusinessUnitSelector,
  BusinessUnitUpdateAction
>;

export type BusinessUnitUpdateActionBuilder<
  Action extends BusinessUnitUpdateAction = BusinessUnitUpdateAction,
> = UpdateActionBuilder<
  CommercetoolsBusinessUnitSelector,
  BusinessUnitUpdateAction,
  Action
>;

export type BusinessUnitUpdateFactory = UpdateActionFactory<
  CommercetoolsBusinessUnitSelector,
  BusinessUnitUpdateAction
>;

export interface CommercetoolsBusinessUnitHelpers<
  BusinessUnitCustomFieldSchema extends CommercetoolsCustomFieldSchema | never,
> {
  readonly customFields: BusinessUnitCustomFieldsHelper<BusinessUnitCustomFieldSchema>;
}

const isBusinessUnitResourceIdentifier = isResourceIdentifier("business-unit");

const isBusinessUnitDraft = (value: unknown): value is BusinessUnitDraft => {
  if (
    !(
      isRecord(value) &&
      hasStringField(value, "key") &&
      hasStringField(value, "name")
    )
  ) {
    return false;
  }

  if (value.unitType === "Company") {
    return true;
  }

  return (
    value.unitType === "Division" &&
    isBusinessUnitResourceIdentifier(value.parentUnit)
  );
};

export const BusinessUnitDraftSchema = Schema.declare<BusinessUnitDraft>(
  isBusinessUnitDraft,
  {
    identifier: "BusinessUnitDraft",
  }
);

export const BusinessUnitUpdateActionsSchema =
  makeUpdateActionsSchema<BusinessUnitUpdateAction>(
    "BusinessUnitUpdateActions"
  );

export const BusinessUnitUpdateWithActionsInputSchema = Schema.Struct({
  actions: BusinessUnitUpdateActionsSchema,
  selector: CommercetoolsBusinessUnitSelectorSchema,
  version: ResourceVersionSchema,
});

export const makeBusinessUnitUpdate = makeUpdateActionFactory<
  CommercetoolsBusinessUnitSelector,
  BusinessUnitUpdateAction
>({
  label: "Business unit update",
});
