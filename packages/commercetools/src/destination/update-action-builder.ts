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
