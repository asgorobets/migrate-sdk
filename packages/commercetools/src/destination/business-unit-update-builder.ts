import type { BusinessUnitUpdateAction } from "@commercetools/platform-sdk";
import type { CommercetoolsBusinessUnitSelector } from "../internal/business-units.ts";

export type BusinessUnitUpdateActionName = BusinessUnitUpdateAction["action"];

export type BusinessUnitUpdateActionByName<
  Name extends BusinessUnitUpdateActionName,
> = Extract<BusinessUnitUpdateAction, { readonly action: Name }>;

export type BusinessUnitUpdateActionInput<
  Name extends BusinessUnitUpdateActionName,
> = Omit<BusinessUnitUpdateActionByName<Name>, "action">;

export type NonEmptyBusinessUnitUpdateActions<
  Action extends BusinessUnitUpdateAction = BusinessUnitUpdateAction,
> = readonly [Action, ...Action[]];

export interface BusinessUnitUpdateCommandShape<
  Action extends BusinessUnitUpdateAction = BusinessUnitUpdateAction,
> {
  readonly actions: NonEmptyBusinessUnitUpdateActions<Action>;
  readonly kind: "UpdateBusinessUnit";
  readonly selector: CommercetoolsBusinessUnitSelector;
  readonly version: number;
}

export interface BusinessUnitUpdateInput {
  readonly selector: CommercetoolsBusinessUnitSelector;
  readonly version: number;
}

export interface BusinessUnitUpdateWithActionsInput<
  Action extends BusinessUnitUpdateAction = BusinessUnitUpdateAction,
> extends BusinessUnitUpdateInput {
  readonly actions: NonEmptyBusinessUnitUpdateActions<Action>;
}

interface BusinessUnitUpdateActionMethods<
  CurrentAction extends BusinessUnitUpdateAction = never,
> {
  readonly changeName: (
    input: BusinessUnitUpdateActionInput<"changeName">
  ) => BusinessUnitUpdateActionBuilder<
    CurrentAction | BusinessUnitUpdateActionByName<"changeName">
  >;
  readonly raw: <const Action extends BusinessUnitUpdateAction>(
    action: Action
  ) => BusinessUnitUpdateActionBuilder<CurrentAction | Action>;
  readonly setContactEmail: (
    input?: BusinessUnitUpdateActionInput<"setContactEmail">
  ) => BusinessUnitUpdateActionBuilder<
    CurrentAction | BusinessUnitUpdateActionByName<"setContactEmail">
  >;
  readonly setCustomField: (
    input: BusinessUnitUpdateActionInput<"setCustomField">
  ) => BusinessUnitUpdateActionBuilder<
    CurrentAction | BusinessUnitUpdateActionByName<"setCustomField">
  >;
}

export interface EmptyBusinessUnitUpdateActionBuilder
  extends BusinessUnitUpdateActionMethods {
  readonly actions: readonly [];
}

export interface BusinessUnitUpdateActionBuilder<
  Action extends BusinessUnitUpdateAction = BusinessUnitUpdateAction,
> extends BusinessUnitUpdateActionMethods<Action> {
  readonly actions: NonEmptyBusinessUnitUpdateActions<Action>;
  readonly command: () => BusinessUnitUpdateCommandShape<Action>;
}

export interface BusinessUnitUpdateFactory {
  readonly withActions: <const Action extends BusinessUnitUpdateAction>(
    input: BusinessUnitUpdateWithActionsInput<Action>
  ) => BusinessUnitUpdateActionBuilder<Action>;
  (input: BusinessUnitUpdateInput): EmptyBusinessUnitUpdateActionBuilder;
}

export const nonEmptyBusinessUnitUpdateActions = <
  Action extends BusinessUnitUpdateAction,
>(
  actions: readonly Action[]
): NonEmptyBusinessUnitUpdateActions<Action> => {
  const [firstAction, ...remainingActions] = actions;

  if (firstAction === undefined) {
    throw new Error("Business unit update requires at least one action");
  }

  return [firstAction, ...remainingActions];
};

const makeBusinessUnitUpdateActionBuilder = <
  CurrentAction extends BusinessUnitUpdateAction = never,
>(
  input: BusinessUnitUpdateInput & {
    readonly actions: readonly CurrentAction[];
  }
): BusinessUnitUpdateActionMethods<CurrentAction> => {
  const append = <const Action extends BusinessUnitUpdateAction>(
    action: Action
  ): BusinessUnitUpdateActionBuilder<CurrentAction | Action> =>
    makeBusinessUnitUpdateActionBuilderWithActions({
      ...input,
      actions: nonEmptyBusinessUnitUpdateActions([...input.actions, action]),
    });

  return {
    changeName: (actionInput) =>
      append({ ...actionInput, action: "changeName" }),
    raw: append,
    setCustomField: (actionInput) =>
      append({ ...actionInput, action: "setCustomField" }),
    setContactEmail: (actionInput = {}) =>
      append({ ...actionInput, action: "setContactEmail" }),
  };
};

const makeBusinessUnitUpdateActionBuilderWithActions = <
  Action extends BusinessUnitUpdateAction,
>(
  input: BusinessUnitUpdateInput & {
    readonly actions: NonEmptyBusinessUnitUpdateActions<Action>;
  }
): BusinessUnitUpdateActionBuilder<Action> => ({
  ...makeBusinessUnitUpdateActionBuilder(input),
  actions: input.actions,
  command: () => ({
    actions: input.actions,
    kind: "UpdateBusinessUnit",
    selector: input.selector,
    version: input.version,
  }),
});

export const makeBusinessUnitUpdate = Object.assign(
  (input: BusinessUnitUpdateInput): EmptyBusinessUnitUpdateActionBuilder => ({
    ...makeBusinessUnitUpdateActionBuilder({
      ...input,
      actions: [],
    }),
    actions: [],
  }),
  {
    withActions: <const Action extends BusinessUnitUpdateAction>(
      input: BusinessUnitUpdateWithActionsInput<Action>
    ): BusinessUnitUpdateActionBuilder<Action> => {
      if (input.actions.length === 0) {
        throw new Error("Business unit update requires at least one action");
      }

      return makeBusinessUnitUpdateActionBuilderWithActions({
        ...input,
        actions: input.actions,
      });
    },
  }
) satisfies BusinessUnitUpdateFactory;
