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

export type RefineOptionalAddressIdOrKeyActions<
  ActionUnion extends SdkUpdateActionBase,
> = ActionUnion extends SdkUpdateActionBase
  ? RefineOptionalAddressIdOrKeyAction<ActionUnion>
  : never;
