import type { MigrationDefinitionId, MigrationRunId } from "./ids.ts";
import type { MigrationDefinitionRunSummary } from "./run.ts";
import type { MigrationItemOutcome } from "./state.ts";

export type MigrationProgressCounts = MigrationDefinitionRunSummary["counts"];

export type MigrationProgressEvent =
  | {
      readonly definitionIds: readonly MigrationDefinitionId[];
      readonly kind: "run-started";
      readonly runId: MigrationRunId;
    }
  | {
      readonly definitionId: MigrationDefinitionId;
      readonly kind: "definition-started";
      readonly runId: MigrationRunId;
    }
  | {
      readonly counts: MigrationProgressCounts;
      readonly definitionId: MigrationDefinitionId;
      readonly kind: "source-item-completed";
      readonly outcome: MigrationItemOutcome;
      readonly runId: MigrationRunId;
    }
  | {
      readonly counts: MigrationProgressCounts;
      readonly definitionId: MigrationDefinitionId;
      readonly itemsRead: number;
      readonly kind: "source-cursor-window-completed";
      readonly runId: MigrationRunId;
    }
  | {
      readonly counts: MigrationProgressCounts;
      readonly definitionId: MigrationDefinitionId;
      readonly kind: "definition-completed";
      readonly runId: MigrationRunId;
      readonly status: "succeeded" | "failed" | "skipped";
    }
  | {
      readonly definitionIds: readonly MigrationDefinitionId[];
      readonly kind: "run-completed";
      readonly runId: MigrationRunId;
      readonly status: "succeeded" | "failed";
    }
  | {
      readonly definitionIds: readonly MigrationDefinitionId[];
      readonly error: unknown;
      readonly kind: "run-failed";
      readonly runId: MigrationRunId;
    };

export type MigrationProgressRunStatus =
  | "idle"
  | "running"
  | "succeeded"
  | "failed";

export type MigrationProgressDefinitionStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export interface MigrationDefinitionProgressState {
  readonly counts: MigrationProgressCounts;
  readonly cursorWindowsCompleted: number;
  readonly definitionId: MigrationDefinitionId;
  readonly itemsRead: number;
  readonly status: MigrationProgressDefinitionStatus;
}

export interface MigrationProgressState {
  readonly activeDefinitionId?: MigrationDefinitionId;
  readonly definitionIds: readonly MigrationDefinitionId[];
  readonly definitions: readonly MigrationDefinitionProgressState[];
  readonly runId?: MigrationRunId;
  readonly status: MigrationProgressRunStatus;
}

export const emptyMigrationProgressCounts: MigrationProgressCounts = {
  migrated: 0,
  skipped: 0,
  failed: 0,
  unchanged: 0,
  needsUpdate: 0,
};

export const initialMigrationProgressState: MigrationProgressState = {
  definitionIds: [],
  definitions: [],
  status: "idle",
};

const initialDefinitionState = (
  definitionId: MigrationDefinitionId
): MigrationDefinitionProgressState => ({
  counts: emptyMigrationProgressCounts,
  cursorWindowsCompleted: 0,
  definitionId,
  itemsRead: 0,
  status: "pending",
});

const upsertDefinition = (
  state: MigrationProgressState,
  definitionId: MigrationDefinitionId,
  update: (
    definition: MigrationDefinitionProgressState
  ) => MigrationDefinitionProgressState
): readonly MigrationDefinitionProgressState[] => {
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
  state: MigrationProgressState
): MigrationProgressState => {
  const next: MigrationProgressState = {
    definitionIds: state.definitionIds,
    definitions: state.definitions,
    status: state.status,
    ...(state.runId === undefined ? {} : { runId: state.runId }),
  };

  return next;
};

export const reduceMigrationProgressState = (
  state: MigrationProgressState,
  event: MigrationProgressEvent
): MigrationProgressState => {
  switch (event.kind) {
    case "run-started":
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
          })
        ),
        runId: state.runId ?? event.runId,
      };
    case "source-cursor-window-completed":
      return {
        ...state,
        definitions: upsertDefinition(
          state,
          event.definitionId,
          (definition) => ({
            ...definition,
            counts: event.counts,
            cursorWindowsCompleted: definition.cursorWindowsCompleted + 1,
            itemsRead: definition.itemsRead + event.itemsRead,
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
            status: event.status,
          })
        ),
        runId: state.runId ?? event.runId,
      });
    case "run-completed":
      return clearActiveDefinition({
        ...state,
        definitionIds: event.definitionIds,
        runId: event.runId,
        status: event.status,
      });
    case "run-failed":
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
