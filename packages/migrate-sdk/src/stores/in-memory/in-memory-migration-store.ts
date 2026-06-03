import { Effect, Layer } from "effect";
import { MigrationStoreError } from "../../domain/errors.ts";
import type {
  MigrationDefinitionId,
  MigrationDefinitionIdInput,
  MigrationRunId,
  SourceCursor,
  SourceIdentity,
  SourceIdentityInput,
} from "../../domain/ids.ts";
import {
  MigrationRunId as MigrationRunIdSchema,
  toMigrationDefinitionId,
  toSourceIdentity,
} from "../../domain/ids.ts";
import type { MigrationDefinitionLock } from "../../domain/lock.ts";
import type { MigrationRunState } from "../../domain/run.ts";
import type { MigrationItemState } from "../../domain/state.ts";
import { MigrationStore } from "../../services/migration-store.ts";

export interface InMemoryMigrationStoreState {
  readonly itemStates: Map<string, MigrationItemState>;
  readonly runStates: Map<MigrationRunId, MigrationRunState>;
  readonly sourceCursors: Map<MigrationDefinitionId, SourceCursor>;
  readonly definitionLocks: Map<MigrationDefinitionId, MigrationDefinitionLock>;
  nextRunNumber: number;
  nextLockNumber: number;
}

const itemStateKey = (
  definitionId: MigrationDefinitionIdInput,
  identity: SourceIdentityInput
) =>
  `${toMigrationDefinitionId(definitionId)}\u0000${toSourceIdentity(identity)}`;

const makeState = (): InMemoryMigrationStoreState => ({
  itemStates: new Map(),
  runStates: new Map(),
  sourceCursors: new Map(),
  definitionLocks: new Map(),
  nextRunNumber: 1,
  nextLockNumber: 1,
});

const storeError = (
  message: string,
  cause?: unknown
): MigrationStoreError =>
  new MigrationStoreError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const makeLayer = (
  state = makeState()
): Layer.Layer<MigrationStore> =>
  Layer.sync(MigrationStore, () => {
    const getSourceCursor = Effect.fn("InMemoryMigrationStore.getSourceCursor")(
      (definitionId: MigrationDefinitionId) =>
        Effect.sync(() => state.sourceCursors.get(definitionId) ?? null)
    );

    const setSourceCursor = Effect.fn("InMemoryMigrationStore.setSourceCursor")(
      (definitionId: MigrationDefinitionId, cursor: SourceCursor) =>
        Effect.sync(() => void state.sourceCursors.set(definitionId, cursor))
    );

    const getItemState = Effect.fn("InMemoryMigrationStore.getItemState")(
      (definitionId: MigrationDefinitionId, identity: SourceIdentity) =>
        Effect.sync(
          () =>
            state.itemStates.get(
              itemStateKey(definitionId, identity)
            ) ?? null
        )
    );

    const upsertItemState = Effect.fn("InMemoryMigrationStore.upsertItemState")(
      (itemState: MigrationItemState) =>
        Effect.sync(() => {
          state.itemStates.set(
            itemStateKey(
              itemState.definitionId,
              itemState.sourceIdentity
            ),
            itemState
          );
        })
    );

    const beginRun = Effect.fn("InMemoryMigrationStore.beginRun")(
      (definitionIds: ReadonlyArray<MigrationDefinitionId>) =>
        Effect.sync(() => {
          const runState: MigrationRunState = {
            runId: MigrationRunIdSchema.make(`run-${state.nextRunNumber}`),
            definitionIds,
            status: "running",
            startedAt: new Date(),
          };

          state.nextRunNumber += 1;
          state.runStates.set(runState.runId, runState);

          return runState;
        })
    );

    const completeRun = Effect.fn("InMemoryMigrationStore.completeRun")(
      function* (runId: MigrationRunId) {
        const current = state.runStates.get(runId);

        if (current === undefined) {
          return yield* storeError("Migration run was not found", runId);
        }

        const completed: MigrationRunState = {
          ...current,
          status: "succeeded",
          finishedAt: new Date(),
        };

        state.runStates.set(runId, completed);

        return completed;
      }
    );

    const failRun = Effect.fn("InMemoryMigrationStore.failRun")(function* (
      runId: MigrationRunId
    ) {
        const current = state.runStates.get(runId);

        if (current === undefined) {
          return yield* storeError("Migration run was not found", runId);
        }

        const failed: MigrationRunState = {
          ...current,
          status: "failed",
          finishedAt: new Date(),
        };

        state.runStates.set(runId, failed);

        return failed;
      }
    );

    const acquireDefinitionLock = Effect.fn(
      "InMemoryMigrationStore.acquireDefinitionLock"
    )(function* (
      definitionId: MigrationDefinitionId,
      ownerRunId: MigrationRunId,
      ttlMs: number
    ) {
        const now = Date.now();
        const current = state.definitionLocks.get(definitionId);

        if (current !== undefined && current.expiresAt.getTime() > now) {
          return yield* storeError(
            "Migration definition is already locked",
            definitionId
          );
        }

        const lock: MigrationDefinitionLock = {
          definitionId,
          ownerRunId,
          token: `lock-${state.nextLockNumber}`,
          expiresAt: new Date(now + ttlMs),
        };

        state.nextLockNumber += 1;
        state.definitionLocks.set(definitionId, lock);

        return lock;
      }
    );

    const releaseDefinitionLock = Effect.fn(
      "InMemoryMigrationStore.releaseDefinitionLock"
    )((lock: MigrationDefinitionLock) =>
        Effect.sync(() => {
          const current = state.definitionLocks.get(lock.definitionId);

          if (current?.token === lock.token) {
            state.definitionLocks.delete(lock.definitionId);
          }
        })
    );

    return {
      getSourceCursor,
      setSourceCursor,
      getItemState,
      upsertItemState,
      beginRun,
      completeRun,
      failRun,
      acquireDefinitionLock,
      releaseDefinitionLock,
    };
  });

export const InMemoryMigrationStore = {
  itemStateKey,
  layer: makeLayer,
  makeState,
} as const;
