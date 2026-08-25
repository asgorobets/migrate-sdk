import { DateTime, Effect, Layer } from "effect";
import { MigrationStoreError } from "../../domain/errors.ts";
import type {
  EncodedSourceCursor,
  EncodedSourceIdentity,
  EncodedSourceIdentityInput,
  MigrationDefinitionId,
  MigrationDefinitionIdInput,
  MigrationRunId,
} from "../../domain/ids.ts";
import {
  MigrationRunId as MigrationRunIdSchema,
  toEncodedSourceIdentity,
  toMigrationDefinitionId,
  toMigrationDefinitionLockToken,
} from "../../domain/ids.ts";
import type { MigrationDefinitionLock } from "../../domain/lock.ts";
import type { MigrationContract } from "../../domain/migration-contract.ts";
import type {
  MigrationDefinitionRunOutcome,
  MigrationDefinitionRunStatus,
  MigrationExecutionHandle,
  MigrationRunState,
} from "../../domain/run.ts";
import { makeMigrationDefinitionRunState } from "../../domain/run.ts";
import type { MigrationItemState } from "../../domain/state.ts";
import { summarizeMigrationItemStates } from "../../domain/status.ts";
import {
  MigrationStore,
  migrationDefinitionRunStatus,
  validateMigrationDefinitionRunOutcomes,
  validateMigrationRunDefinitionIds,
} from "../../services/migration-store.ts";

export interface InMemoryMigrationStoreState {
  readonly definitionLocks: Map<MigrationDefinitionId, MigrationDefinitionLock>;
  readonly itemStates: Map<string, MigrationItemState>;
  readonly latestRunStates: Map<
    MigrationDefinitionId,
    MigrationRunState & {
      readonly definitionStatus?: MigrationDefinitionRunStatus;
    }
  >;
  readonly migrationContracts: Map<MigrationDefinitionId, MigrationContract>;
  nextLockNumber: number;
  nextRunNumber: number;
  readonly runStates: Map<MigrationRunId, MigrationRunState>;
  readonly sourceCursorCommits: {
    readonly definitionId: MigrationDefinitionId;
    readonly cursor: EncodedSourceCursor;
  }[];
  readonly sourceCursors: Map<MigrationDefinitionId, EncodedSourceCursor>;
}

const itemStateKey = (
  definitionId: MigrationDefinitionIdInput,
  identity: EncodedSourceIdentityInput
) =>
  `${toMigrationDefinitionId(definitionId)}\u0000${toEncodedSourceIdentity(identity)}`;

const makeState = (): InMemoryMigrationStoreState => ({
  itemStates: new Map(),
  latestRunStates: new Map(),
  migrationContracts: new Map(),
  runStates: new Map(),
  sourceCursors: new Map(),
  sourceCursorCommits: [],
  definitionLocks: new Map(),
  nextRunNumber: 1,
  nextLockNumber: 1,
});

const storeError = (message: string, cause?: unknown): MigrationStoreError =>
  new MigrationStoreError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const lockOwnershipError = (
  lock: MigrationDefinitionLock,
  current: MigrationDefinitionLock
): MigrationStoreError =>
  storeError("Migration definition lock is owned by another runner", {
    currentOwnerRunId: current.ownerRunId,
    currentToken: current.token,
    definitionId: lock.definitionId,
    releaseOwnerRunId: lock.ownerRunId,
    releaseToken: lock.token,
  });

const lockNotFoundError = (
  lock: MigrationDefinitionLock
): MigrationStoreError =>
  storeError("Migration definition lock was not found", {
    definitionId: lock.definitionId,
    ownerRunId: lock.ownerRunId,
    token: lock.token,
  });

const readRunStateForUpdate = (
  state: InMemoryMigrationStoreState,
  runId: MigrationRunId,
  definitionIds: readonly MigrationDefinitionId[]
): Effect.Effect<MigrationRunState, MigrationStoreError> =>
  Effect.gen(function* () {
    const current = state.runStates.get(runId);

    if (current === undefined) {
      return yield* storeError("Migration run was not found", runId);
    }

    return yield* validateMigrationRunDefinitionIds(current, definitionIds);
  });

const updateCurrentLatestRunStates = (
  state: InMemoryMigrationStoreState,
  runId: MigrationRunId,
  definitionIds: readonly MigrationDefinitionId[],
  makeState: (definitionId: MigrationDefinitionId) => MigrationRunState & {
    readonly definitionStatus?: MigrationDefinitionRunStatus;
  }
): void => {
  for (const definitionId of definitionIds) {
    if (state.latestRunStates.get(definitionId)?.runId === runId) {
      state.latestRunStates.set(definitionId, makeState(definitionId));
    }
  }
};

const makeLayer = (state = makeState()): Layer.Layer<MigrationStore> =>
  Layer.sync(MigrationStore, () => {
    const listOrphanItemStates: (typeof MigrationStore)["Service"]["listOrphanItemStates"] =
      (definitionId, sourceInventoryRunId, page) =>
        Effect.sync(() => {
          const candidates = Array.from(state.itemStates.values())
            .filter(
              (itemState) =>
                itemState.definitionId === definitionId &&
                itemState.lastSourceInventoryRunId !== sourceInventoryRunId &&
                (page.afterIdentity === undefined ||
                  itemState.sourceIdentity.encoded > page.afterIdentity)
            )
            .sort((left, right) => {
              if (left.sourceIdentity.encoded < right.sourceIdentity.encoded) {
                return -1;
              }
              if (left.sourceIdentity.encoded > right.sourceIdentity.encoded) {
                return 1;
              }
              return 0;
            });
          const items = candidates.slice(0, Math.max(0, page.limit));
          const lastItem = items.at(-1);

          return {
            items,
            ...(lastItem !== undefined && candidates.length > items.length
              ? { nextAfterIdentity: lastItem.sourceIdentity.encoded }
              : {}),
          };
        });

    const observeItemState: (typeof MigrationStore)["Service"]["observeItemState"] =
      (definitionId, identity, sourceInventoryRunId) =>
        Effect.sync(() => {
          const key = itemStateKey(definitionId, identity);
          const itemState = state.itemStates.get(key);

          if (itemState !== undefined) {
            state.itemStates.set(key, {
              ...itemState,
              lastSourceInventoryRunId: sourceInventoryRunId,
            });
          }
        });

    const getSourceCursor = Effect.fn("InMemoryMigrationStore.getSourceCursor")(
      (definitionId: MigrationDefinitionId) =>
        Effect.sync(() => state.sourceCursors.get(definitionId) ?? null)
    );

    const setSourceCursor = Effect.fn("InMemoryMigrationStore.setSourceCursor")(
      (definitionId: MigrationDefinitionId, cursor: EncodedSourceCursor) =>
        Effect.sync(() => {
          state.sourceCursors.set(definitionId, cursor);
          state.sourceCursorCommits.push({ definitionId, cursor });
        })
    );

    const deleteSourceCursor = Effect.fn(
      "InMemoryMigrationStore.deleteSourceCursor"
    )((definitionId: MigrationDefinitionId) =>
      Effect.sync(() => {
        state.sourceCursors.delete(definitionId);
      })
    );

    const getItemState = Effect.fn("InMemoryMigrationStore.getItemState")(
      (definitionId: MigrationDefinitionId, identity: EncodedSourceIdentity) =>
        Effect.sync(
          () =>
            state.itemStates.get(itemStateKey(definitionId, identity)) ?? null
        )
    );

    const getMigrationContract = Effect.fn(
      "InMemoryMigrationStore.getMigrationContract"
    )((definitionId: MigrationDefinitionId) =>
      Effect.sync(() => state.migrationContracts.get(definitionId) ?? null)
    );

    const upsertMigrationContract = Effect.fn(
      "InMemoryMigrationStore.upsertMigrationContract"
    )((contract: MigrationContract) =>
      Effect.sync(() => {
        state.migrationContracts.set(contract.definitionId, contract);
      })
    );

    const listItemStates = Effect.fn("InMemoryMigrationStore.listItemStates")(
      (definitionId: MigrationDefinitionId) =>
        Effect.sync(() =>
          Array.from(state.itemStates.values()).filter(
            (itemState) => itemState.definitionId === definitionId
          )
        )
    );

    const getItemStateSummary = Effect.fn(
      "InMemoryMigrationStore.getItemStateSummary"
    )(function* (definitionId: MigrationDefinitionId) {
      const itemStates = yield* listItemStates(definitionId);

      return summarizeMigrationItemStates(itemStates);
    });

    const deleteItemState = Effect.fn("InMemoryMigrationStore.deleteItemState")(
      (definitionId: MigrationDefinitionId, identity: EncodedSourceIdentity) =>
        Effect.sync(() => {
          state.itemStates.delete(itemStateKey(definitionId, identity));
        })
    );

    const upsertItemState = Effect.fn("InMemoryMigrationStore.upsertItemState")(
      (itemState: MigrationItemState) =>
        Effect.sync(() => {
          state.itemStates.set(
            itemStateKey(
              itemState.definitionId,
              itemState.sourceIdentity.encoded
            ),
            itemState
          );
        })
    );

    const createRunId = Effect.sync(() => {
      const runId = MigrationRunIdSchema.make(`run-${state.nextRunNumber}`);
      state.nextRunNumber += 1;

      return runId;
    });

    const getLatestRunState = Effect.fn(
      "InMemoryMigrationStore.getLatestRunState"
    )((definitionId: MigrationDefinitionId) =>
      Effect.sync(() => {
        const stored = state.latestRunStates.get(definitionId);

        if (stored === undefined) {
          return null;
        }

        const { definitionStatus: storedDefinitionStatus, ...runState } =
          stored;

        return makeMigrationDefinitionRunState(
          definitionId,
          runState,
          storedDefinitionStatus ?? runState.status
        );
      })
    );

    const getRunState = Effect.fn("InMemoryMigrationStore.getRunState")(
      (runId: MigrationRunId) =>
        Effect.sync(() => state.runStates.get(runId) ?? null)
    );

    const writeRunState = (
      runId: MigrationRunId,
      definitionIds: readonly MigrationDefinitionId[],
      status: MigrationRunState["status"]
    ) =>
      Effect.gen(function* () {
        const current = definitionIds
          .map((definitionId) => state.latestRunStates.get(definitionId))
          .find((runState) => runState?.runId === runId);
        const runState: MigrationRunState = {
          ...(current ?? {}),
          runId,
          definitionIds,
          status,
          startedAt: current?.startedAt ?? (yield* DateTime.nowAsDate),
        };

        for (const definitionId of definitionIds) {
          state.latestRunStates.set(definitionId, runState);
        }
        state.runStates.set(runId, runState);

        return runState;
      });

    const beginRun = Effect.fn("InMemoryMigrationStore.beginRun")(
      (
        runId: MigrationRunId,
        definitionIds: readonly MigrationDefinitionId[]
      ) => writeRunState(runId, definitionIds, "running")
    );

    const queueRun = Effect.fn("InMemoryMigrationStore.queueRun")(
      (
        runId: MigrationRunId,
        definitionIds: readonly MigrationDefinitionId[]
      ) => writeRunState(runId, definitionIds, "queued")
    );

    const attachRunExecution = Effect.fn(
      "InMemoryMigrationStore.attachRunExecution"
    )(function* (
      runId: MigrationRunId,
      definitionIds: readonly MigrationDefinitionId[],
      execution: MigrationExecutionHandle
    ) {
      const current = yield* readRunStateForUpdate(state, runId, definitionIds);
      const updated: MigrationRunState = {
        ...current,
        ...(execution === undefined ? {} : { execution }),
      };

      updateCurrentLatestRunStates(state, runId, definitionIds, () => updated);
      state.runStates.set(runId, updated);

      return updated;
    });

    const markRunStartFailed = Effect.fn(
      "InMemoryMigrationStore.markRunStartFailed"
    )(function* (
      runId: MigrationRunId,
      definitionIds: readonly MigrationDefinitionId[]
    ) {
      const current = yield* readRunStateForUpdate(state, runId, definitionIds);
      const finishedAt = yield* DateTime.nowAsDate;
      const failed: MigrationRunState = {
        ...current,
        status: "start-failed",
        finishedAt,
      };

      updateCurrentLatestRunStates(state, runId, definitionIds, () => failed);
      state.runStates.set(runId, failed);

      return failed;
    });

    const completeRun = Effect.fn("InMemoryMigrationStore.completeRun")(
      function* (
        runId: MigrationRunId,
        definitionIds: readonly MigrationDefinitionId[],
        definitionOutcomes: readonly MigrationDefinitionRunOutcome[]
      ) {
        const outcomeByDefinitionId =
          yield* validateMigrationDefinitionRunOutcomes(
            definitionIds,
            definitionOutcomes
          );
        const current = yield* readRunStateForUpdate(
          state,
          runId,
          definitionIds
        );
        const finishedAt = yield* DateTime.nowAsDate;
        const completed: MigrationRunState = {
          ...current,
          status: "succeeded",
          finishedAt,
        };

        updateCurrentLatestRunStates(
          state,
          runId,
          definitionIds,
          (definitionId) => ({
            ...completed,
            definitionStatus: migrationDefinitionRunStatus(
              definitionId,
              completed.status,
              outcomeByDefinitionId
            ),
          })
        );
        state.runStates.set(runId, completed);

        return completed;
      }
    );

    const failRun = Effect.fn("InMemoryMigrationStore.failRun")(function* (
      runId: MigrationRunId,
      definitionIds: readonly MigrationDefinitionId[],
      definitionOutcomes: readonly MigrationDefinitionRunOutcome[]
    ) {
      const outcomeByDefinitionId =
        yield* validateMigrationDefinitionRunOutcomes(
          definitionIds,
          definitionOutcomes
        );
      const current = yield* readRunStateForUpdate(state, runId, definitionIds);
      const finishedAt = yield* DateTime.nowAsDate;
      const failed: MigrationRunState = {
        ...current,
        status: "failed",
        finishedAt,
      };

      updateCurrentLatestRunStates(
        state,
        runId,
        definitionIds,
        (definitionId) => ({
          ...failed,
          definitionStatus: migrationDefinitionRunStatus(
            definitionId,
            failed.status,
            outcomeByDefinitionId
          ),
        })
      );
      state.runStates.set(runId, failed);

      return failed;
    });

    const markRunCancelled = Effect.fn(
      "InMemoryMigrationStore.markRunCancelled"
    )(function* (
      runId: MigrationRunId,
      definitionIds: readonly MigrationDefinitionId[]
    ) {
      const current = yield* readRunStateForUpdate(state, runId, definitionIds);
      const finishedAt = yield* DateTime.nowAsDate;
      const cancelled: MigrationRunState = {
        ...current,
        status: "cancelled",
        finishedAt,
      };

      updateCurrentLatestRunStates(
        state,
        runId,
        definitionIds,
        () => cancelled
      );
      state.runStates.set(runId, cancelled);

      return cancelled;
    });

    const acquireDefinitionLock = Effect.fn(
      "InMemoryMigrationStore.acquireDefinitionLock"
    )(function* (
      definitionId: MigrationDefinitionId,
      ownerRunId: MigrationRunId
    ) {
      const current = state.definitionLocks.get(definitionId);

      if (current !== undefined) {
        return yield* storeError(
          "Migration definition is already locked",
          definitionId
        );
      }

      const createdAt = yield* DateTime.nowAsDate;
      const lock: MigrationDefinitionLock = {
        createdAt,
        definitionId,
        ownerRunId,
        token: toMigrationDefinitionLockToken(`lock-${state.nextLockNumber}`),
      };

      state.nextLockNumber += 1;
      state.definitionLocks.set(definitionId, lock);

      return lock;
    });

    const getDefinitionLock = Effect.fn(
      "InMemoryMigrationStore.getDefinitionLock"
    )((definitionId: MigrationDefinitionId) =>
      Effect.sync(() => state.definitionLocks.get(definitionId) ?? null)
    );

    const assertDefinitionLocks = Effect.fn(
      "InMemoryMigrationStore.assertDefinitionLocks"
    )(function* (locks: readonly MigrationDefinitionLock[]) {
      for (const lock of locks) {
        const current = yield* Effect.sync(() =>
          state.definitionLocks.get(lock.definitionId)
        );

        if (current === undefined) {
          return yield* lockNotFoundError(lock);
        }

        if (
          current.ownerRunId !== lock.ownerRunId ||
          current.token !== lock.token
        ) {
          return yield* lockOwnershipError(lock, current);
        }
      }
    });

    const releaseDefinitionLock = Effect.fn(
      "InMemoryMigrationStore.releaseDefinitionLock"
    )(function* (lock: MigrationDefinitionLock) {
      const current = yield* Effect.sync(() =>
        state.definitionLocks.get(lock.definitionId)
      );

      if (current === undefined) {
        return;
      }

      if (current.token !== lock.token) {
        return yield* lockOwnershipError(lock, current);
      }

      yield* Effect.sync(() => {
        const current = state.definitionLocks.get(lock.definitionId);

        if (current?.token === lock.token) {
          state.definitionLocks.delete(lock.definitionId);
        }
      });
    });

    const breakDefinitionLock = Effect.fn(
      "InMemoryMigrationStore.breakDefinitionLock"
    )(function* (definitionId: MigrationDefinitionId) {
      const current = yield* Effect.sync(
        () => state.definitionLocks.get(definitionId) ?? null
      );

      yield* Effect.sync(() => {
        state.definitionLocks.delete(definitionId);
      });

      return current;
    });

    return {
      listOrphanItemStates,
      observeItemState,
      getSourceCursor,
      setSourceCursor,
      deleteSourceCursor,
      getMigrationContract,
      upsertMigrationContract,
      getItemState,
      listItemStates,
      getItemStateSummary,
      deleteItemState,
      upsertItemState,
      createRunId,
      getRunState,
      getLatestRunState,
      beginRun,
      queueRun,
      attachRunExecution,
      markRunStartFailed,
      markRunCancelled,
      completeRun,
      failRun,
      acquireDefinitionLock,
      getDefinitionLock,
      assertDefinitionLocks,
      releaseDefinitionLock,
      breakDefinitionLock,
    };
  });

export const InMemoryMigrationStore = {
  itemStateKey,
  layer: makeLayer,
  makeState,
} as const;
