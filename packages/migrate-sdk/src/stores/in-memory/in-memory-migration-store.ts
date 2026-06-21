import { Effect, Layer } from "effect";
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
  MigrationExecutionHandle,
  MigrationRunState,
} from "../../domain/run.ts";
import type { MigrationItemState } from "../../domain/state.ts";
import { summarizeMigrationItemStates } from "../../domain/status.ts";
import { MigrationStore } from "../../services/migration-store.ts";

export interface InMemoryMigrationStoreState {
  readonly definitionLocks: Map<MigrationDefinitionId, MigrationDefinitionLock>;
  readonly itemStates: Map<string, MigrationItemState>;
  readonly latestRunStates: Map<MigrationDefinitionId, MigrationRunState>;
  readonly migrationContracts: Map<MigrationDefinitionId, MigrationContract>;
  nextLockNumber: number;
  nextRunNumber: number;
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

const readRunState = (
  state: InMemoryMigrationStoreState,
  runId: MigrationRunId,
  definitionIds: readonly MigrationDefinitionId[]
): Effect.Effect<MigrationRunState, MigrationStoreError> =>
  Effect.gen(function* () {
    const runStates = definitionIds.map((definitionId) =>
      state.latestRunStates.get(definitionId)
    );
    const current = runStates[0];

    if (
      current === undefined ||
      runStates.some((runState) => runState?.runId !== runId)
    ) {
      return yield* storeError("Migration run was not found", runId);
    }

    return current;
  });

const makeLayer = (state = makeState()): Layer.Layer<MigrationStore> =>
  Layer.sync(MigrationStore, () => {
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
      Effect.sync(() => state.latestRunStates.get(definitionId) ?? null)
    );

    const writeRunState = (
      runId: MigrationRunId,
      definitionIds: readonly MigrationDefinitionId[],
      status: MigrationRunState["status"]
    ) =>
      Effect.sync(() => {
        const current = definitionIds
          .map((definitionId) => state.latestRunStates.get(definitionId))
          .find((runState) => runState?.runId === runId);
        const runState: MigrationRunState = {
          ...(current ?? {}),
          runId,
          definitionIds,
          status,
          startedAt: current?.startedAt ?? new Date(),
        };

        for (const definitionId of definitionIds) {
          state.latestRunStates.set(definitionId, runState);
        }

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
      const current = yield* readRunState(state, runId, definitionIds);
      const updated: MigrationRunState = {
        ...current,
        ...(execution === undefined ? {} : { execution }),
      };

      for (const definitionId of definitionIds) {
        state.latestRunStates.set(definitionId, updated);
      }

      return updated;
    });

    const markRunStartFailed = Effect.fn(
      "InMemoryMigrationStore.markRunStartFailed"
    )(function* (
      runId: MigrationRunId,
      definitionIds: readonly MigrationDefinitionId[]
    ) {
      const current = yield* readRunState(state, runId, definitionIds);
      const failed: MigrationRunState = {
        ...current,
        status: "start-failed",
        finishedAt: new Date(),
      };

      for (const definitionId of definitionIds) {
        state.latestRunStates.set(definitionId, failed);
      }

      return failed;
    });

    const completeRun = Effect.fn("InMemoryMigrationStore.completeRun")(
      function* (
        runId: MigrationRunId,
        definitionIds: readonly MigrationDefinitionId[]
      ) {
        const current = yield* readRunState(state, runId, definitionIds);
        const completed: MigrationRunState = {
          ...current,
          status: "succeeded",
          finishedAt: new Date(),
        };

        for (const definitionId of definitionIds) {
          state.latestRunStates.set(definitionId, completed);
        }

        return completed;
      }
    );

    const failRun = Effect.fn("InMemoryMigrationStore.failRun")(function* (
      runId: MigrationRunId,
      definitionIds: readonly MigrationDefinitionId[]
    ) {
      const current = yield* readRunState(state, runId, definitionIds);
      const failed: MigrationRunState = {
        ...current,
        status: "failed",
        finishedAt: new Date(),
      };

      for (const definitionId of definitionIds) {
        state.latestRunStates.set(definitionId, failed);
      }

      return failed;
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

      const lock: MigrationDefinitionLock = {
        createdAt: new Date(),
        definitionId,
        ownerRunId,
        token: toMigrationDefinitionLockToken(`lock-${state.nextLockNumber}`),
      };

      state.nextLockNumber += 1;
      state.definitionLocks.set(definitionId, lock);

      return lock;
    });

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

    return {
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
      getLatestRunState,
      beginRun,
      queueRun,
      attachRunExecution,
      markRunStartFailed,
      completeRun,
      failRun,
      acquireDefinitionLock,
      assertDefinitionLocks,
      releaseDefinitionLock,
    };
  });

export const InMemoryMigrationStore = {
  itemStateKey,
  layer: makeLayer,
  makeState,
} as const;
