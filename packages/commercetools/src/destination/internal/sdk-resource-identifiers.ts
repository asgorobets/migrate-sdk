type ForbidKeys<Keys extends PropertyKey> = {
  readonly [Key in Keys]?: never;
};

type RequireExactlyOne<T, Keys extends keyof T> = Omit<T, Keys> &
  {
    readonly [Key in Keys]-?: Required<Pick<T, Key>> &
      ForbidKeys<Exclude<Keys, Key>>;
  }[Keys];

type OptionalKeys<T> = {
  readonly [Key in keyof T]-?: undefined extends T[Key] ? Key : never;
}[keyof T];

type ResourceSelectorKeys = "id" | "key";

interface ResourceIdOrKeyFields<T> {
  readonly id?: T extends { readonly id?: infer Id } ? Id : never;
  readonly key?: T extends { readonly key?: infer Key } ? Key : never;
}

export type RequireOptionalResourceIdOrKey<T> = [ResourceSelectorKeys] extends [
  keyof T,
]
  ? [ResourceSelectorKeys] extends [OptionalKeys<T>]
    ? Omit<T, "id" | "key"> &
        RequireExactlyOne<ResourceIdOrKeyFields<T>, ResourceSelectorKeys>
    : T
  : T;

type RefineKnownResourceIdentifierField<
  T,
  Field extends keyof T,
> = undefined extends T[Field]
  ? Omit<T, Field> & {
      readonly [Key in Field]?: RequireOptionalResourceIdOrKey<
        NonNullable<T[Field]>
      >;
    }
  : Omit<T, Field> & {
      readonly [Key in Field]: RequireOptionalResourceIdOrKey<T[Field]>;
    };

export type RefineResourceIdentifierField<
  T,
  Field extends PropertyKey,
> = Field extends keyof T ? RefineKnownResourceIdentifierField<T, Field> : T;

export type RefineResourceIdentifierFields<
  T,
  Fields extends readonly PropertyKey[],
> = Fields extends readonly [
  infer Field extends PropertyKey,
  ...infer Rest extends readonly PropertyKey[],
]
  ? RefineResourceIdentifierFields<
      RefineResourceIdentifierField<T, Field>,
      Rest
    >
  : T;

type RefineResourceIdentifierArray<ArrayLike> = ArrayLike extends (infer Item)[]
  ? RequireOptionalResourceIdOrKey<Item>[]
  : ArrayLike extends readonly (infer Item)[]
    ? readonly RequireOptionalResourceIdOrKey<Item>[]
    : ArrayLike;

type RefineKnownResourceIdentifierArrayField<
  T,
  Field extends keyof T,
> = undefined extends T[Field]
  ? Omit<T, Field> & {
      readonly [Key in Field]?: RefineResourceIdentifierArray<
        NonNullable<T[Field]>
      >;
    }
  : Omit<T, Field> & {
      readonly [Key in Field]: RefineResourceIdentifierArray<T[Field]>;
    };

export type RefineResourceIdentifierArrayField<
  T,
  Field extends PropertyKey,
> = Field extends keyof T
  ? RefineKnownResourceIdentifierArrayField<T, Field>
  : T;

export type RefineResourceIdentifierArrayFields<
  T,
  Fields extends readonly PropertyKey[],
> = Fields extends readonly [
  infer Field extends PropertyKey,
  ...infer Rest extends readonly PropertyKey[],
]
  ? RefineResourceIdentifierArrayFields<
      RefineResourceIdentifierArrayField<T, Field>,
      Rest
    >
  : T;
