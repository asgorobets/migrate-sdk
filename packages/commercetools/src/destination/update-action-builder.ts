export interface UpdateActionBase {
  readonly action: string;
}

export type NonEmptyUpdateActions<Action extends UpdateActionBase> = readonly [
  Action,
  ...Action[],
];

export interface UpdateInput<Selector> {
  readonly selector: Selector;
  readonly version: number;
}

export interface UpdateWithActionsInput<
  Selector,
  Action extends UpdateActionBase,
> extends UpdateInput<Selector> {
  readonly actions: NonEmptyUpdateActions<Action>;
}

interface UpdateActionMethod<
  Selector,
  ActionUnion extends UpdateActionBase,
  CurrentAction extends ActionUnion = never,
> {
  readonly action: <const Action extends ActionUnion>(
    action: Action
  ) => UpdateActionBuilder<Selector, ActionUnion, CurrentAction | Action>;
}

export interface EmptyUpdateActionBuilder<
  Selector,
  ActionUnion extends UpdateActionBase,
> extends UpdateActionMethod<Selector, ActionUnion> {
  readonly actions: readonly [];
  readonly withActions: <const Action extends ActionUnion>(
    actions: NonEmptyUpdateActions<Action>
  ) => UpdateActionBuilder<Selector, ActionUnion, Action>;
}

export interface UpdateActionBuilder<
  Selector,
  ActionUnion extends UpdateActionBase,
  Action extends ActionUnion = ActionUnion,
> extends UpdateActionMethod<Selector, ActionUnion, Action> {
  readonly actions: NonEmptyUpdateActions<Action>;
  readonly input: () => UpdateWithActionsInput<Selector, Action>;
  readonly withActions: <const NextAction extends ActionUnion>(
    actions: readonly NextAction[]
  ) => UpdateActionBuilder<Selector, ActionUnion, Action | NextAction>;
}

export interface UpdateActionFactory<
  Selector,
  ActionUnion extends UpdateActionBase,
> {
  readonly withActions: <const Action extends ActionUnion>(
    input: UpdateWithActionsInput<Selector, Action>
  ) => UpdateActionBuilder<Selector, ActionUnion, Action>;
  (
    input: UpdateInput<Selector>
  ): EmptyUpdateActionBuilder<Selector, ActionUnion>;
}

interface UpdateActionFactoryOptions {
  readonly label: string;
}

export const nonEmptyUpdateActions = <Action extends UpdateActionBase>(
  actions: readonly Action[],
  label: string
): NonEmptyUpdateActions<Action> => {
  const [firstAction, ...remainingActions] = actions;

  if (firstAction === undefined) {
    throw new Error(`${label} requires at least one action`);
  }

  return [firstAction, ...remainingActions];
};

const emptyUpdateActions: readonly [] = [];

const makeUpdateActionBuilder = <
  Selector,
  ActionUnion extends UpdateActionBase,
  CurrentAction extends ActionUnion = never,
>(
  options: UpdateActionFactoryOptions,
  input: UpdateInput<Selector> & {
    readonly actions: readonly CurrentAction[];
  }
): UpdateActionMethod<Selector, ActionUnion, CurrentAction> & {
  readonly withActions: <const Action extends ActionUnion>(
    actions: readonly Action[]
  ) => UpdateActionBuilder<Selector, ActionUnion, CurrentAction | Action>;
} => {
  const append = <const Action extends ActionUnion>(
    action: Action
  ): UpdateActionBuilder<Selector, ActionUnion, CurrentAction | Action> =>
    makeUpdateActionBuilderWithActions(options, {
      ...input,
      actions: nonEmptyUpdateActions([...input.actions, action], options.label),
    });
  const appendMany = <const Action extends ActionUnion>(
    actions: readonly Action[]
  ): UpdateActionBuilder<Selector, ActionUnion, CurrentAction | Action> =>
    makeUpdateActionBuilderWithActions(options, {
      ...input,
      actions: nonEmptyUpdateActions(
        [...input.actions, ...actions],
        options.label
      ),
    });

  return {
    action: append,
    withActions: appendMany,
  };
};

const makeUpdateActionBuilderWithActions = <
  Selector,
  ActionUnion extends UpdateActionBase,
  Action extends ActionUnion,
>(
  options: UpdateActionFactoryOptions,
  input: UpdateInput<Selector> & {
    readonly actions: NonEmptyUpdateActions<Action>;
  }
): UpdateActionBuilder<Selector, ActionUnion, Action> => ({
  ...makeUpdateActionBuilder(options, input),
  actions: input.actions,
  input: () => ({
    actions: input.actions,
    selector: input.selector,
    version: input.version,
  }),
});

export const makeUpdateActionFactory = <
  Selector,
  ActionUnion extends UpdateActionBase,
>(
  options: UpdateActionFactoryOptions
): UpdateActionFactory<Selector, ActionUnion> =>
  Object.assign(
    (
      input: UpdateInput<Selector>
    ): EmptyUpdateActionBuilder<Selector, ActionUnion> => ({
      ...makeUpdateActionBuilder(options, {
        ...input,
        actions: emptyUpdateActions,
      }),
      actions: emptyUpdateActions,
    }),
    {
      withActions: <const Action extends ActionUnion>(
        input: UpdateWithActionsInput<Selector, Action>
      ): UpdateActionBuilder<Selector, ActionUnion, Action> =>
        makeUpdateActionBuilderWithActions(options, {
          ...input,
          actions: nonEmptyUpdateActions(input.actions, options.label),
        }),
    }
  ) satisfies UpdateActionFactory<Selector, ActionUnion>;
