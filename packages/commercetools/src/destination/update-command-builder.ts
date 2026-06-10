export interface UpdateActionBase {
  readonly action: string;
}

export type NonEmptyUpdateActions<Action extends UpdateActionBase> = readonly [
  Action,
  ...Action[],
];

export interface UpdateCommandShape<
  Kind extends string,
  Selector,
  Action extends UpdateActionBase,
> {
  readonly actions: NonEmptyUpdateActions<Action>;
  readonly kind: Kind;
  readonly selector: Selector;
  readonly version: number;
}

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
  Kind extends string,
  Selector,
  ActionUnion extends UpdateActionBase,
  CurrentAction extends ActionUnion = never,
> {
  readonly action: <const Action extends ActionUnion>(
    action: Action
  ) => UpdateActionBuilder<Kind, Selector, ActionUnion, CurrentAction | Action>;
}

export interface EmptyUpdateActionBuilder<
  Kind extends string,
  Selector,
  ActionUnion extends UpdateActionBase,
> extends UpdateActionMethod<Kind, Selector, ActionUnion> {
  readonly actions: readonly [];
  readonly withActions: <const Action extends ActionUnion>(
    actions: NonEmptyUpdateActions<Action>
  ) => UpdateActionBuilder<Kind, Selector, ActionUnion, Action>;
}

export interface UpdateActionBuilder<
  Kind extends string,
  Selector,
  ActionUnion extends UpdateActionBase,
  Action extends ActionUnion = ActionUnion,
> extends UpdateActionMethod<Kind, Selector, ActionUnion, Action> {
  readonly actions: NonEmptyUpdateActions<Action>;
  readonly command: () => UpdateCommandShape<Kind, Selector, Action>;
  readonly withActions: <const NextAction extends ActionUnion>(
    actions: readonly NextAction[]
  ) => UpdateActionBuilder<Kind, Selector, ActionUnion, Action | NextAction>;
}

export interface UpdateCommandFactory<
  Kind extends string,
  Selector,
  ActionUnion extends UpdateActionBase,
> {
  readonly withActions: <const Action extends ActionUnion>(
    input: UpdateWithActionsInput<Selector, Action>
  ) => UpdateActionBuilder<Kind, Selector, ActionUnion, Action>;
  (
    input: UpdateInput<Selector>
  ): EmptyUpdateActionBuilder<Kind, Selector, ActionUnion>;
}

interface UpdateCommandFactoryOptions<Kind extends string> {
  readonly kind: Kind;
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
  const Kind extends string,
  Selector,
  ActionUnion extends UpdateActionBase,
  CurrentAction extends ActionUnion = never,
>(
  options: UpdateCommandFactoryOptions<Kind>,
  input: UpdateInput<Selector> & {
    readonly actions: readonly CurrentAction[];
  }
): UpdateActionMethod<Kind, Selector, ActionUnion, CurrentAction> & {
  readonly withActions: <const Action extends ActionUnion>(
    actions: readonly Action[]
  ) => UpdateActionBuilder<Kind, Selector, ActionUnion, CurrentAction | Action>;
} => {
  const append = <const Action extends ActionUnion>(
    action: Action
  ): UpdateActionBuilder<Kind, Selector, ActionUnion, CurrentAction | Action> =>
    makeUpdateActionBuilderWithActions(options, {
      ...input,
      actions: nonEmptyUpdateActions([...input.actions, action], options.label),
    });
  const appendMany = <const Action extends ActionUnion>(
    actions: readonly Action[]
  ): UpdateActionBuilder<Kind, Selector, ActionUnion, CurrentAction | Action> =>
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
  const Kind extends string,
  Selector,
  ActionUnion extends UpdateActionBase,
  Action extends ActionUnion,
>(
  options: UpdateCommandFactoryOptions<Kind>,
  input: UpdateInput<Selector> & {
    readonly actions: NonEmptyUpdateActions<Action>;
  }
): UpdateActionBuilder<Kind, Selector, ActionUnion, Action> => ({
  ...makeUpdateActionBuilder(options, input),
  actions: input.actions,
  command: () => ({
    actions: input.actions,
    kind: options.kind,
    selector: input.selector,
    version: input.version,
  }),
});

export const makeUpdateCommandFactory = <
  const Kind extends string,
  Selector,
  ActionUnion extends UpdateActionBase,
>(
  options: UpdateCommandFactoryOptions<Kind>
): UpdateCommandFactory<Kind, Selector, ActionUnion> =>
  Object.assign(
    (
      input: UpdateInput<Selector>
    ): EmptyUpdateActionBuilder<Kind, Selector, ActionUnion> => ({
      ...makeUpdateActionBuilder(options, {
        ...input,
        actions: emptyUpdateActions,
      }),
      actions: emptyUpdateActions,
    }),
    {
      withActions: <const Action extends ActionUnion>(
        input: UpdateWithActionsInput<Selector, Action>
      ): UpdateActionBuilder<Kind, Selector, ActionUnion, Action> =>
        makeUpdateActionBuilderWithActions(options, {
          ...input,
          actions: nonEmptyUpdateActions(input.actions, options.label),
        }),
    }
  ) satisfies UpdateCommandFactory<Kind, Selector, ActionUnion>;
