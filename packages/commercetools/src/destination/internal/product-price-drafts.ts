import type {
  CustomFieldsDraft,
  PriceDraft,
  ProductVariantDraft,
} from "@commercetools/platform-sdk";
import {
  hasOptionalResourceIdentifier,
  hasOptionalResourceIdentifierArray,
  hasRequiredResourceIdentifier,
  isRecord,
  isResourceIdentifier,
  type UnknownRecord,
} from "./command-schemas.ts";
import type { RefineResourceIdentifierFields } from "./sdk-resource-identifiers.ts";

type ProductCustomFieldsDraftInput = RefineResourceIdentifierFields<
  CustomFieldsDraft,
  ["type"]
>;

export type ProductPriceDraftInput = RefineResourceIdentifierFields<
  Omit<PriceDraft, "custom"> & {
    readonly custom?: ProductCustomFieldsDraftInput;
  },
  ["customerGroup", "channel", "recurrencePolicy"]
>;

export type ProductVariantDraftInput = Omit<ProductVariantDraft, "prices"> & {
  readonly prices?: ProductPriceDraftInput[];
};

type RefineKnownProductPriceDraftField<
  T,
  Field extends keyof T,
> = undefined extends T[Field]
  ? Omit<T, Field> & {
      readonly [Key in Field]?: ProductPriceDraftInput;
    }
  : Omit<T, Field> & {
      readonly [Key in Field]: ProductPriceDraftInput;
    };

type RefineProductPriceDraftField<
  T,
  Field extends PropertyKey,
> = Field extends keyof T ? RefineKnownProductPriceDraftField<T, Field> : T;

type RefineProductPriceDraftArray<ArrayLike> = ArrayLike extends unknown[]
  ? ProductPriceDraftInput[]
  : ArrayLike extends readonly unknown[]
    ? readonly ProductPriceDraftInput[]
    : ArrayLike;

type RefineKnownProductPriceDraftArrayField<
  T,
  Field extends keyof T,
> = undefined extends T[Field]
  ? Omit<T, Field> & {
      readonly [Key in Field]?: RefineProductPriceDraftArray<
        NonNullable<T[Field]>
      >;
    }
  : Omit<T, Field> & {
      readonly [Key in Field]: RefineProductPriceDraftArray<T[Field]>;
    };

type RefineProductPriceDraftArrayField<
  T,
  Field extends PropertyKey,
> = Field extends keyof T
  ? RefineKnownProductPriceDraftArrayField<T, Field>
  : T;

export type RefineProductPriceDraftActionFields<ActionUnion> =
  ActionUnion extends object
    ? RefineProductPriceDraftArrayField<
        RefineProductPriceDraftField<ActionUnion, "price">,
        "prices"
      >
    : ActionUnion;

const isChannelResourceIdentifier = isResourceIdentifier("channel");
const isCustomerGroupResourceIdentifier =
  isResourceIdentifier("customer-group");
const isRecurrencePolicyResourceIdentifier =
  isResourceIdentifier("recurrence-policy");
const isTypeResourceIdentifier = isResourceIdentifier("type");

const hasValidCustomFieldsDraftTypeResourceIdentifier = (
  value: unknown
): boolean => isRecord(value) && isTypeResourceIdentifier(value.type);

export const hasValidProductPriceDraftResourceIdentifiers = (
  value: unknown
): boolean =>
  isRecord(value) &&
  hasOptionalResourceIdentifier(
    value,
    "channel",
    isChannelResourceIdentifier
  ) &&
  hasOptionalResourceIdentifier(
    value,
    "customerGroup",
    isCustomerGroupResourceIdentifier
  ) &&
  hasOptionalResourceIdentifier(
    value,
    "recurrencePolicy",
    isRecurrencePolicyResourceIdentifier
  ) &&
  hasOptionalResourceIdentifier(
    value,
    "custom",
    hasValidCustomFieldsDraftTypeResourceIdentifier
  );

export const hasOptionalProductPriceDraftResourceIdentifiers = (
  value: UnknownRecord,
  field: string
): boolean =>
  hasOptionalResourceIdentifier(
    value,
    field,
    hasValidProductPriceDraftResourceIdentifiers
  );

export const hasRequiredProductPriceDraftResourceIdentifiers = (
  value: UnknownRecord,
  field: string
): boolean =>
  hasRequiredResourceIdentifier(
    value,
    field,
    hasValidProductPriceDraftResourceIdentifiers
  );

export const hasOptionalProductPriceDraftArrayResourceIdentifiers = (
  value: UnknownRecord,
  field: string
): boolean =>
  hasOptionalResourceIdentifierArray(
    value,
    field,
    hasValidProductPriceDraftResourceIdentifiers
  );

export const hasRequiredProductPriceDraftArrayResourceIdentifiers = (
  value: UnknownRecord,
  field: string
): boolean =>
  Array.isArray(value[field]) &&
  value[field].every(hasValidProductPriceDraftResourceIdentifiers);

export const hasValidProductVariantDraftPriceResourceIdentifiers = (
  value: unknown
): boolean =>
  isRecord(value) &&
  hasOptionalProductPriceDraftArrayResourceIdentifiers(value, "prices");

export const hasOptionalProductVariantDraftPriceResourceIdentifiers = (
  value: UnknownRecord,
  field: string
): boolean =>
  hasOptionalResourceIdentifier(
    value,
    field,
    hasValidProductVariantDraftPriceResourceIdentifiers
  );

export const hasOptionalProductVariantDraftArrayPriceResourceIdentifiers = (
  value: UnknownRecord,
  field: string
): boolean =>
  hasOptionalResourceIdentifierArray(
    value,
    field,
    hasValidProductVariantDraftPriceResourceIdentifiers
  );

export const hasValidProductUpdateActionPriceDraftResourceIdentifiers = (
  action: UnknownRecord
): boolean => {
  switch (action.action) {
    case "addPrice":
    case "changePrice":
      return hasRequiredProductPriceDraftResourceIdentifiers(action, "price");
    case "addVariant":
      return hasOptionalProductPriceDraftArrayResourceIdentifiers(
        action,
        "prices"
      );
    case "setPrices":
      return hasRequiredProductPriceDraftArrayResourceIdentifiers(
        action,
        "prices"
      );
    default:
      return true;
  }
};
