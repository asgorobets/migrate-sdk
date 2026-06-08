import type { ProductUpdateAction } from "@commercetools/platform-sdk";
import type { CommercetoolsProductSelector } from "../internal/products.ts";

export type ProductUpdateActionName = ProductUpdateAction["action"];

export type ProductUpdateActionByName<Name extends ProductUpdateActionName> =
  Extract<ProductUpdateAction, { readonly action: Name }>;

export type ProductUpdateActionInput<Name extends ProductUpdateActionName> =
  Omit<ProductUpdateActionByName<Name>, "action">;

export type NonEmptyProductUpdateActions<
  Action extends ProductUpdateAction = ProductUpdateAction,
> = readonly [Action, ...Action[]];

export interface ProductUpdateCommandShape<
  Action extends ProductUpdateAction = ProductUpdateAction,
> {
  readonly actions: NonEmptyProductUpdateActions<Action>;
  readonly kind: "UpdateProduct";
  readonly selector: CommercetoolsProductSelector;
  readonly version: number;
}

export interface ProductUpdateInput {
  readonly selector: CommercetoolsProductSelector;
  readonly version: number;
}

export interface ProductUpdateWithActionsInput<
  Action extends ProductUpdateAction = ProductUpdateAction,
> extends ProductUpdateInput {
  readonly actions: NonEmptyProductUpdateActions<Action>;
}

type AppendAction<
  Actions extends readonly ProductUpdateAction[],
  Action extends ProductUpdateAction,
> = readonly [...Actions, Action];

type CommandFromActions<Actions extends readonly ProductUpdateAction[]> =
  Actions extends readonly [ProductUpdateAction, ...ProductUpdateAction[]]
    ? () => ProductUpdateCommandShape<Actions[number]>
    : never;

export interface ProductUpdateActionBuilder<
  Actions extends readonly ProductUpdateAction[] = readonly [],
> {
  readonly actions: Actions;
  readonly addVariant: (
    input: ProductUpdateActionInput<"addVariant">
  ) => ProductUpdateActionBuilder<
    AppendAction<Actions, ProductUpdateActionByName<"addVariant">>
  >;
  readonly changeName: (
    input: ProductUpdateActionInput<"changeName">
  ) => ProductUpdateActionBuilder<
    AppendAction<Actions, ProductUpdateActionByName<"changeName">>
  >;
  readonly changeSlug: (
    input: ProductUpdateActionInput<"changeSlug">
  ) => ProductUpdateActionBuilder<
    AppendAction<Actions, ProductUpdateActionByName<"changeSlug">>
  >;
  readonly command: CommandFromActions<Actions>;
  readonly publish: (
    input?: ProductUpdateActionInput<"publish">
  ) => ProductUpdateActionBuilder<
    AppendAction<Actions, ProductUpdateActionByName<"publish">>
  >;
  readonly raw: <const Action extends ProductUpdateAction>(
    action: Action
  ) => ProductUpdateActionBuilder<AppendAction<Actions, Action>>;
  readonly setAttribute: (
    input: ProductUpdateActionInput<"setAttribute">
  ) => ProductUpdateActionBuilder<
    AppendAction<Actions, ProductUpdateActionByName<"setAttribute">>
  >;
  readonly setDescription: (
    input: ProductUpdateActionInput<"setDescription">
  ) => ProductUpdateActionBuilder<
    AppendAction<Actions, ProductUpdateActionByName<"setDescription">>
  >;
  readonly unpublish: () => ProductUpdateActionBuilder<
    AppendAction<Actions, ProductUpdateActionByName<"unpublish">>
  >;
}

export interface ProductUpdateFactory {
  readonly withActions: <const Action extends ProductUpdateAction>(
    input: ProductUpdateWithActionsInput<Action>
  ) => ProductUpdateActionBuilder<NonEmptyProductUpdateActions<Action>>;
  (input: ProductUpdateInput): ProductUpdateActionBuilder;
}

const productAction = <Name extends ProductUpdateActionName>(
  name: Name,
  input: ProductUpdateActionInput<Name>
): ProductUpdateActionByName<Name> =>
  ({
    ...input,
    action: name,
  }) as ProductUpdateActionByName<Name>;

const makeProductUpdateActionBuilder = <
  const Actions extends readonly ProductUpdateAction[],
>(
  input: ProductUpdateInput & {
    readonly actions: Actions;
  }
): ProductUpdateActionBuilder<Actions> => {
  const append = <const Action extends ProductUpdateAction>(
    action: Action
  ): ProductUpdateActionBuilder<AppendAction<Actions, Action>> =>
    makeProductUpdateActionBuilder({
      ...input,
      actions: [...input.actions, action] as AppendAction<Actions, Action>,
    });

  return {
    actions: input.actions,
    addVariant: (actionInput) =>
      append(productAction("addVariant", actionInput)),
    changeName: (actionInput) =>
      append(productAction("changeName", actionInput)),
    changeSlug: (actionInput) =>
      append(productAction("changeSlug", actionInput)),
    command: (() => {
      if (input.actions.length === 0) {
        throw new Error("Product update requires at least one action");
      }

      return {
        actions: input.actions as unknown as NonEmptyProductUpdateActions<
          Actions[number]
        >,
        kind: "UpdateProduct",
        selector: input.selector,
        version: input.version,
      };
    }) as CommandFromActions<Actions>,
    publish: (actionInput = {}) =>
      append(productAction("publish", actionInput)),
    raw: append,
    setAttribute: (actionInput) =>
      append(productAction("setAttribute", actionInput)),
    setDescription: (actionInput) =>
      append(productAction("setDescription", actionInput)),
    unpublish: () => append(productAction("unpublish", {})),
  };
};

export const makeProductUpdate = Object.assign(
  (input: ProductUpdateInput): ProductUpdateActionBuilder =>
    makeProductUpdateActionBuilder({
      ...input,
      actions: [],
    }),
  {
    withActions: <const Action extends ProductUpdateAction>(
      input: ProductUpdateWithActionsInput<Action>
    ): ProductUpdateActionBuilder<NonEmptyProductUpdateActions<Action>> => {
      if (input.actions.length === 0) {
        throw new Error("Product update requires at least one action");
      }

      return makeProductUpdateActionBuilder({
        ...input,
        actions: input.actions as NonEmptyProductUpdateActions<Action>,
      });
    },
  }
) satisfies ProductUpdateFactory;
