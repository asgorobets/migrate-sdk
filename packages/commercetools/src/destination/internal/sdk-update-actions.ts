import type {
  RefineResourceIdentifierField,
  RefineResourceIdentifierFields,
} from "./sdk-resource-identifiers.ts";

export interface SdkUpdateActionBase {
  readonly action: string;
}

export type UpdateActionName<ActionUnion extends SdkUpdateActionBase> =
  ActionUnion["action"];

export type UpdateActionByName<
  ActionUnion extends SdkUpdateActionBase,
  Name extends UpdateActionName<ActionUnion>,
> = Extract<ActionUnion, { readonly action: Name }>;

export type UpdateActionInput<
  ActionUnion extends SdkUpdateActionBase,
  Name extends UpdateActionName<ActionUnion>,
> = Omit<UpdateActionByName<ActionUnion, Name>, "action">;

type RequireAtLeastOne<T, Keys extends keyof T> = Omit<T, Keys> &
  {
    readonly [Key in Keys]-?: Required<Pick<T, Key>> &
      Partial<Pick<T, Exclude<Keys, Key>>>;
  }[Keys];

type OptionalKeys<T> = {
  readonly [Key in keyof T]-?: undefined extends T[Key] ? Key : never;
}[keyof T];

type AddressSelectorKeys = "addressId" | "addressKey";

interface AddressIdOrKeyFields<T> {
  readonly addressId?: T extends { readonly addressId?: infer AddressId }
    ? AddressId
    : never;
  readonly addressKey?: T extends { readonly addressKey?: infer AddressKey }
    ? AddressKey
    : never;
}

type RequireOptionalAddressIdOrKey<T> = [AddressSelectorKeys] extends [keyof T]
  ? [AddressSelectorKeys] extends [OptionalKeys<T>]
    ? Omit<T, "addressId" | "addressKey"> &
        RequireAtLeastOne<AddressIdOrKeyFields<T>, AddressSelectorKeys>
    : T
  : T;

type RefineOptionalAddressIdOrKeyAction<Action extends SdkUpdateActionBase> =
  RequireOptionalAddressIdOrKey<Omit<Action, "action">> &
    Pick<Action, "action">;

type RefineProductResourceIdentifier<T> = RefineResourceIdentifierField<
  T,
  "product"
>;

type RefineProductSelectionSetting<T> = RefineResourceIdentifierField<
  T,
  "productSelection"
>;

type RefineProductSelectionSettings<ProductSelections> =
  ProductSelections extends (infer Setting)[]
    ? RefineProductSelectionSetting<Setting>[]
    : ProductSelections extends readonly (infer Setting)[]
      ? readonly RefineProductSelectionSetting<Setting>[]
      : ProductSelections;

type RefineProductSelectionResourceIdentifier<T> =
  RefineResourceIdentifierField<T, "productSelection">;

type RefineProductSelectionSettingsField<T> =
  "productSelections" extends keyof T
    ? Omit<T, "productSelections"> & {
        readonly productSelections?: RefineProductSelectionSettings<
          NonNullable<T["productSelections"]>
        >;
      }
    : T;

type RefineProductSelectionResourceIdentifiers<T> =
  RefineProductSelectionSettingsField<
    RefineProductSelectionResourceIdentifier<T>
  >;

type RefineProductResourceIdentifierAction<Action extends SdkUpdateActionBase> =
  RefineProductResourceIdentifier<Omit<Action, "action">> &
    Pick<Action, "action">;

type RefineProductSelectionResourceIdentifierAction<
  Action extends SdkUpdateActionBase,
> = RefineProductSelectionResourceIdentifiers<Omit<Action, "action">> &
  Pick<Action, "action">;

type RefineResourceIdentifierFieldsAction<
  Action extends SdkUpdateActionBase,
  Fields extends readonly PropertyKey[],
> = RefineResourceIdentifierFields<Omit<Action, "action">, Fields> &
  Pick<Action, "action">;

export type RefineOptionalAddressIdOrKeyActions<
  ActionUnion extends SdkUpdateActionBase,
> = ActionUnion extends SdkUpdateActionBase
  ? RefineOptionalAddressIdOrKeyAction<ActionUnion>
  : never;

export type RefineProductResourceIdentifierActions<
  ActionUnion extends SdkUpdateActionBase,
> = ActionUnion extends SdkUpdateActionBase
  ? RefineProductResourceIdentifierAction<ActionUnion>
  : never;

export type RefineProductSelectionResourceIdentifierActions<
  ActionUnion extends SdkUpdateActionBase,
> = ActionUnion extends SdkUpdateActionBase
  ? RefineProductSelectionResourceIdentifierAction<ActionUnion>
  : never;

export type RefineResourceIdentifierFieldActions<
  ActionUnion extends SdkUpdateActionBase,
  Fields extends readonly PropertyKey[],
> = ActionUnion extends SdkUpdateActionBase
  ? RefineResourceIdentifierFieldsAction<ActionUnion, Fields>
  : never;
