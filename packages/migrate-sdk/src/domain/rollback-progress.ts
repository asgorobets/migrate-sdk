import type { MigrationDefinitionId, MigrationRunId } from "./ids.ts";
import type { RollbackDefinitionRunSummary } from "./rollback.ts";

export type RollbackProgressCounts = RollbackDefinitionRunSummary["counts"];

export type RollbackProgressOutcome = "rolled-back" | "failed" | "skipped";

export type RollbackProgressEvent =
  | {
      readonly definitionIds: readonly MigrationDefinitionId[];
      readonly kind: "rollback-started";
      readonly runId: MigrationRunId;
    }
  | {
      readonly definitionId: MigrationDefinitionId;
      readonly kind: "definition-started";
      readonly runId: MigrationRunId;
    }
  | {
      readonly counts: RollbackProgressCounts;
      readonly definitionId: MigrationDefinitionId;
      readonly kind: "source-item-completed";
      readonly outcome: RollbackProgressOutcome;
      readonly runId: MigrationRunId;
    }
  | {
      readonly counts: RollbackProgressCounts;
      readonly definitionId: MigrationDefinitionId;
      readonly kind: "definition-completed";
      readonly runId: MigrationRunId;
      readonly status: "succeeded" | "failed";
    }
  | {
      readonly definitionIds: readonly MigrationDefinitionId[];
      readonly kind: "rollback-completed";
      readonly runId: MigrationRunId;
      readonly status: "succeeded" | "failed";
    }
  | {
      readonly definitionIds: readonly MigrationDefinitionId[];
      readonly error: unknown;
      readonly kind: "rollback-failed";
      readonly runId: MigrationRunId;
    };

export type RollbackProgressRunStatus =
  | "idle"
  | "running"
  | "succeeded"
  | "failed";

export type RollbackProgressDefinitionStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed";

export interface RollbackDefinitionProgressState {
  readonly counts: RollbackProgressCounts;
  readonly definitionId: MigrationDefinitionId;
  readonly itemsProcessed: number;
  readonly status: RollbackProgressDefinitionStatus;
}

export interface RollbackProgressState {
  readonly activeDefinitionId?: MigrationDefinitionId;
  readonly definitionIds: readonly MigrationDefinitionId[];
  readonly definitions: readonly RollbackDefinitionProgressState[];
  readonly runId?: MigrationRunId;
  readonly status: RollbackProgressRunStatus;
}

export const emptyRollbackProgressCounts: RollbackProgressCounts = {
  failed: 0,
  rolledBack: 0,
  skipped: 0,
};

export const initialRollbackProgressState: RollbackProgressState = {
  definitionIds: [],
  definitions: [],
  status: "idle",
};

const countProcessedItems = (counts: RollbackProgressCounts): number =>
  counts.rolledBack + counts.skipped + counts.failed;

const initialDefinitionState = (
  definitionId: MigrationDefinitionId
): RollbackDefinitionProgressState => ({
  counts: emptyRollbackProgressCounts,
  definitionId,
  itemsProcessed: 0,
  status: "pending",
});

const upsertDefinition = (
  state: RollbackProgressState,
  definitionId: MigrationDefinitionId,
  update: (
    definition: RollbackDefinitionProgressState
  ) => RollbackDefinitionProgressState
): readonly RollbackDefinitionProgressState[] => {
  const existing = state.definitions.find(
    (definition) => definition.definitionId === definitionId
  );
  const next = update(existing ?? initialDefinitionState(definitionId));

  if (existing === undefined) {
    return [...state.definitions, next];
  }

  return state.definitions.map((definition) =>
    definition.definitionId === definitionId ? next : definition
  );
};

const clearActiveDefinition = (
  state: RollbackProgressState
): RollbackProgressState => {
  const next: RollbackProgressState = {
    definitionIds: state.definitionIds,
    definitions: state.definitions,
    status: state.status,
    ...(state.runId === undefined ? {} : { runId: state.runId }),
  };

  return next;
};

export const reduceRollbackProgressState = (
  state: RollbackProgressState,
  event: RollbackProgressEvent
): RollbackProgressState => {
  switch (event.kind) {
    case "rollback-started":
      return {
        definitionIds: event.definitionIds,
        definitions: event.definitionIds.map(initialDefinitionState),
        runId: event.runId,
        status: "running",
      };
    case "definition-started":
      return {
        ...state,
        activeDefinitionId: event.definitionId,
        definitions: upsertDefinition(
          state,
          event.definitionId,
          (definition) => ({
            ...definition,
            status: "running",
          })
        ),
        runId: state.runId ?? event.runId,
        status: "running",
      };
    case "source-item-completed":
      return {
        ...state,
        definitions: upsertDefinition(
          state,
          event.definitionId,
          (definition) => ({
            ...definition,
            counts: event.counts,
            itemsProcessed: countProcessedItems(event.counts),
          })
        ),
        runId: state.runId ?? event.runId,
      };
    case "definition-completed":
      return clearActiveDefinition({
        ...state,
        definitions: upsertDefinition(
          state,
          event.definitionId,
          (definition) => ({
            ...definition,
            counts: event.counts,
            itemsProcessed: countProcessedItems(event.counts),
            status: event.status,
          })
        ),
        runId: state.runId ?? event.runId,
      });
    case "rollback-completed":
      return clearActiveDefinition({
        ...state,
        definitionIds: event.definitionIds,
        runId: event.runId,
        status: event.status,
      });
    case "rollback-failed":
      return clearActiveDefinition({
        ...state,
        definitionIds: event.definitionIds,
        runId: event.runId,
        status: "failed",
      });
    default:
      return state;
  }
};
