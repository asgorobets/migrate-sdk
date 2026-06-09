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

interface ProductUpdateActionMethods<
  CurrentAction extends ProductUpdateAction = never,
> {
  readonly addVariant: (
    input: ProductUpdateActionInput<"addVariant">
  ) => ProductUpdateActionBuilder<
    CurrentAction | ProductUpdateActionByName<"addVariant">
  >;
  readonly changeName: (
    input: ProductUpdateActionInput<"changeName">
  ) => ProductUpdateActionBuilder<
    CurrentAction | ProductUpdateActionByName<"changeName">
  >;
  readonly changeSlug: (
    input: ProductUpdateActionInput<"changeSlug">
  ) => ProductUpdateActionBuilder<
    CurrentAction | ProductUpdateActionByName<"changeSlug">
  >;
  readonly publish: (
    input?: ProductUpdateActionInput<"publish">
  ) => ProductUpdateActionBuilder<
    CurrentAction | ProductUpdateActionByName<"publish">
  >;
  readonly raw: <const Action extends ProductUpdateAction>(
    action: Action
  ) => ProductUpdateActionBuilder<CurrentAction | Action>;
  readonly setAttribute: (
    input: ProductUpdateActionInput<"setAttribute">
  ) => ProductUpdateActionBuilder<
    CurrentAction | ProductUpdateActionByName<"setAttribute">
  >;
  readonly setDescription: (
    input: ProductUpdateActionInput<"setDescription">
  ) => ProductUpdateActionBuilder<
    CurrentAction | ProductUpdateActionByName<"setDescription">
  >;
  readonly unpublish: () => ProductUpdateActionBuilder<
    CurrentAction | ProductUpdateActionByName<"unpublish">
  >;
}

export interface EmptyProductUpdateActionBuilder
  extends ProductUpdateActionMethods {
  readonly actions: readonly [];
}

export interface ProductUpdateActionBuilder<
  Action extends ProductUpdateAction = ProductUpdateAction,
> extends ProductUpdateActionMethods<Action> {
  readonly actions: NonEmptyProductUpdateActions<Action>;
  readonly command: () => ProductUpdateCommandShape<Action>;
}

export interface ProductUpdateFactory {
  readonly withActions: <const Action extends ProductUpdateAction>(
    input: ProductUpdateWithActionsInput<Action>
  ) => ProductUpdateActionBuilder<Action>;
  (input: ProductUpdateInput): EmptyProductUpdateActionBuilder;
}

const nonEmptyProductUpdateActions = <Action extends ProductUpdateAction>(
  actions: readonly Action[]
): NonEmptyProductUpdateActions<Action> => {
  const [firstAction, ...remainingActions] = actions;

  if (firstAction === undefined) {
    throw new Error("Product update requires at least one action");
  }

  return [firstAction, ...remainingActions];
};

const makeProductUpdateActionBuilder = <
  CurrentAction extends ProductUpdateAction = never,
>(
  input: ProductUpdateInput & {
    readonly actions: readonly CurrentAction[];
  }
): ProductUpdateActionMethods<CurrentAction> => {
  const append = <const Action extends ProductUpdateAction>(
    action: Action
  ): ProductUpdateActionBuilder<CurrentAction | Action> =>
    makeProductUpdateActionBuilderWithActions({
      ...input,
      actions: nonEmptyProductUpdateActions([...input.actions, action]),
    });

  return {
    addVariant: (actionInput) =>
      append({ ...actionInput, action: "addVariant" }),
    changeName: (actionInput) =>
      append({ ...actionInput, action: "changeName" }),
    changeSlug: (actionInput) =>
      append({ ...actionInput, action: "changeSlug" }),
    publish: (actionInput = {}) =>
      append({ ...actionInput, action: "publish" }),
    raw: append,
    setAttribute: (actionInput) =>
      append({ ...actionInput, action: "setAttribute" }),
    setDescription: (actionInput) =>
      append({ ...actionInput, action: "setDescription" }),
    unpublish: () => append({ action: "unpublish" }),
  };
};

const makeProductUpdateActionBuilderWithActions = <
  Action extends ProductUpdateAction,
>(
  input: ProductUpdateInput & {
    readonly actions: NonEmptyProductUpdateActions<Action>;
  }
): ProductUpdateActionBuilder<Action> => ({
  ...makeProductUpdateActionBuilder(input),
  actions: input.actions,
  command: () => ({
    actions: input.actions,
    kind: "UpdateProduct",
    selector: input.selector,
    version: input.version,
  }),
});

export const makeProductUpdate = Object.assign(
  (input: ProductUpdateInput): EmptyProductUpdateActionBuilder => ({
    ...makeProductUpdateActionBuilder({
      ...input,
      actions: [],
    }),
    actions: [],
  }),
  {
    withActions: <const Action extends ProductUpdateAction>(
      input: ProductUpdateWithActionsInput<Action>
    ): ProductUpdateActionBuilder<Action> => {
      if (input.actions.length === 0) {
        throw new Error("Product update requires at least one action");
      }

      return makeProductUpdateActionBuilderWithActions({
        ...input,
        actions: input.actions,
      });
    },
  }
) satisfies ProductUpdateFactory;
