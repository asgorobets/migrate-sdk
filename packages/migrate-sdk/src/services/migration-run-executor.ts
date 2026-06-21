import { Deferred, Effect, Exit, Layer, Predicate, Schema } from "effect";
import { Service } from "effect/Context";
import type { MigrationDefinition } from "../domain/definition.ts";
import {
  MigrationReferenceLookupError,
  MigrationRuntimeError,
  MigrationStoreError,
  RollbackPreflightError,
  RollbackRequestError,
  type SkipItem,
  SourcePluginError,
} from "../domain/errors.ts";
import {
  type MigrationExecutionOptions,
  type NormalizedMigrationExecutionOptions,
  normalizeMigrationExecutionOptions,
  type PipelineExecutionConcurrency,
  type PipelineExecutionOptions,
  resolvePipelineExecutionOptions,
} from "../domain/execution.ts";
import type {
  EncodedSourceIdentity,
  MigrationDefinitionId,
  MigrationRunId,
  SourceIdentitySnapshotKey,
  SourceIdentity as SourceIdentityValue,
} from "../domain/ids.ts";
import { SourceIdentity, toEncodedSourceCursor } from "../domain/ids.ts";
import type { MigrationDefinitionLock } from "../domain/lock.ts";
import type {
  MigrationDefinitionExecutableRollbackPlan,
  MigrationDefinitionExecutableRunPlan,
} from "../domain/registry.ts";
import type {
  AnyRollbackMigrationDefinition,
  EncodedRollbackMigrationOptions,
  EncodedRollbackRequest,
  EncodedRollbackRequestInput,
  RollbackDefinitionRunSummary,
  RollbackMigrationOptions,
  RollbackMigrationOptionsInput,
  RollbackPipeline,
  RollbackRequestInput,
  RollbackRunSummary,
} from "../domain/rollback.ts";
import {
  makeEncodedRollbackRequest,
  makeRollbackMigrationOptions,
  makeRollbackRequest,
} from "../domain/rollback.ts";
import type {
  AnyMigrationDefinition,
  EncodedRunRequest,
  EncodedRunRequestInput,
  ExecutionStartResult,
  MigrationDefinitionRunSummary,
  MigrationRunState,
  MigrationRunSummary,
  RunRequestInput,
  RunRequestSourceLayerError,
  RunRequestSourceRequirements,
} from "../domain/run.ts";
import { makeEncodedRunRequest, makeRunRequest } from "../domain/run.ts";
import {
  makeRunMode,
  normalRunMode,
  type RunMode,
} from "../domain/run-mode.ts";
import { normalizeSourceItemTotal, SourceItemTotal } from "../domain/source.ts";
import type {
  FailedItemState,
  MigratedItemState,
  MigrationItemError,
  MigrationItemOutcome,
  MigrationItemState,
  NeedsUpdateItemState,
} from "../domain/state.ts";
import type {
  DestinationJournal,
  DestinationRollbackAttemptJournalSegment,
  TrackingRecord,
  TrackingRecordContract,
} from "../domain/tracking.ts";
import { MigrationProgress } from "./migration-progress.ts";
import type { MigrationReference } from "./migration-reference-lookup.ts";
import { MigrationStore } from "./migration-store.ts";
import { RollbackProgress } from "./rollback-progress.ts";
import {
  getSourcePlugin,
  type SourcePlugin,
} from "./source-plugin.ts";
import {
  makeProcessScope,
  Tracking,
  type TrackingService,
} from "./tracking.ts";
import { normalizeItemError } from "../runtime/item-error.ts";
import {
  isMigrationRuntimeError,
  validateMigrationContract,
  validateMigrationContracts,
} from "../runtime/migration-contract-validation.ts";
import {
  type CreateMigrationReferenceStub,
  makeMigrationReferenceLookupLayer,
} from "../runtime/migration-reference-lookup-layer.ts";
import {
  makeProcessJournal,
  processSourceItem,
  validateStagedTrackingRecord,
} from "../runtime/process-source-item.ts";

export type RunMigrationDefinitionError =
  | SourcePluginError
  | MigrationStoreError;

export type RunMigrationError =
  | MigrationRuntimeError
  | RunMigrationDefinitionError;

export type RollbackMigrationDefinitionError = MigrationStoreError;

export type RollbackMigrationError =
  | RollbackMigrationDefinitionError
  | RollbackPreflightError
  | RollbackRequestError;

const emptyRunError = new MigrationRuntimeError({
  message: "Run request must include at least one Migration Definition",
});

const missingDefinitionError = (definitionId: MigrationDefinitionId) =>
  new MigrationRuntimeError({
    message: "Migration Definition was not found",
    cause: { definitionId },
  });

const dependencyCycleError = (definitionId: MigrationDefinitionId) =>
  new MigrationRuntimeError({
    message: "Migration Definition dependency cycle detected",
    cause: { definitionId },
  });

const splitStoreRunError = (
  definitionId: MigrationDefinitionId,
  storeOwnerDefinitionId: MigrationDefinitionId
) =>
  new MigrationRuntimeError({
    message:
      "Migration Definitions in the same run must use the same Migration Store",
    cause: { definitionId, storeOwnerDefinitionId },
  });

const invalidRunRequestError = (cause: unknown) =>
  new MigrationRuntimeError({
    message: "Run request contains invalid input",
    cause,
  });

const invalidUpdateRunModeError = (mode: RunMode) =>
  new MigrationRuntimeError({
    message:
      mode.kind === "item"
        ? "Update run cannot target source identities"
        : `Update run cannot combine with ${mode.kind} mode`,
  });

const invalidRollbackRequestError = (cause: unknown) =>
  cause instanceof RollbackRequestError
    ? cause
    : new RollbackRequestError({
        message: "Rollback request contains invalid input",
        cause,
      });

const itemModeDefinitionCountError = new MigrationRuntimeError({
  message:
    "Run source identity key targeting requires exactly one selected Migration Definition",
});

const rollbackSourceIdentityKeyDefinitionCountError = new RollbackRequestError({
  message:
    "Rollback sourceIdentityKeys require exactly one selected Migration Definition",
});

const normalizeRunMode = (
  definitions: readonly AnyMigrationDefinition[],
  mode: RunRequestInput<readonly AnyMigrationDefinition[]>["mode"] | undefined
): Effect.Effect<RunMode, MigrationRuntimeError> => {
  if (mode === undefined || mode.kind !== "item") {
    return Effect.succeed(mode ?? normalRunMode);
  }

  if (definitions.length !== 1) {
    return Effect.fail(itemModeDefinitionCountError);
  }

  const definition = definitions[0];

  if (definition === undefined) {
    return Effect.fail(itemModeDefinitionCountError);
  }

  return Effect.try({
    try: () => makeRunMode(definition.source.identity, mode),
    catch: (cause) =>
      new MigrationRuntimeError({
        message: "Run sourceIdentityKey did not match Source Identity Schema",
        cause,
      }),
  });
};

const encodeRollbackMigrationOptions = (
  definition: AnyRollbackMigrationDefinition,
  options: RollbackMigrationOptions
): Effect.Effect<EncodedRollbackMigrationOptions, RollbackRequestError> => {
  if (options.sourceIdentityKeys === undefined) {
    return Effect.succeed({
      ...(options.execution === undefined
        ? {}
        : { execution: options.execution }),
    });
  }

  const sourceIdentityKeys = options.sourceIdentityKeys;

  return Effect.try({
    try: () => {
      const sourceIdentities: EncodedSourceIdentity[] = [];
      const seenSourceIdentities = new Set<EncodedSourceIdentity>();

      for (const sourceIdentityKey of sourceIdentityKeys) {
        const sourceIdentity = SourceIdentity.fromKey(
          definition.source.identity,
          sourceIdentityKey
        ).encoded;

        if (seenSourceIdentities.has(sourceIdentity)) {
          continue;
        }

        seenSourceIdentities.add(sourceIdentity);
        sourceIdentities.push(sourceIdentity);
      }

      const [firstIdentity, ...remainingIdentities] = sourceIdentities;

      if (firstIdentity === undefined) {
        throw new RollbackRequestError({
          message:
            "Rollback sourceIdentityKeys must include at least one identity",
        });
      }

      return {
        ...(options.execution === undefined
          ? {}
          : { execution: options.execution }),
        encodedSourceIdentities: [firstIdentity, ...remainingIdentities],
      };
    },
    catch: (cause) =>
      cause instanceof RollbackRequestError
        ? cause
        : new RollbackRequestError({
            message:
              "Rollback sourceIdentityKeys did not match Source Identity Schema",
            cause,
          }),
  });
};

const unsafeDependentRollbackError = (
  definitionId: MigrationDefinitionId,
  dependentDefinitionId: MigrationDefinitionId
) =>
  new RollbackPreflightError({
    message: "Rollback would leave dependent Migration Definition item state",
    cause: { definitionId, dependentDefinitionId },
  });

const missingRollbackPipelineError = (definitionId: MigrationDefinitionId) =>
  new RollbackPreflightError({
    message: "Migration Definition does not define a rollback process",
    cause: { definitionId },
  });

const rollbackDependencyStoreError = (
  definitionId: MigrationDefinitionId,
  dependentDefinitionId: MigrationDefinitionId
) =>
  new RollbackPreflightError({
    message: "Rollback dependency preflight requires one Migration Store",
    cause: { definitionId, dependentDefinitionId },
  });

const rollbackDependencyCycleError = (definitionId: MigrationDefinitionId) =>
  new RollbackPreflightError({
    message: "Migration Definition dependency cycle detected",
    cause: { definitionId },
  });

const failRunFinalizationError = <Error>(
  runId: MigrationRunId,
  definitionIds: readonly MigrationDefinitionId[],
  primaryError: Error,
  failRunError: MigrationStoreError
) =>
  new MigrationStoreError({
    message: "Unable to mark Migration Run failed",
    cause: { definitionIds, failRunError, primaryError, runId },
  });

interface LockReleaseFailure {
  readonly error: MigrationStoreError;
  readonly lock: MigrationDefinitionLock;
}

interface StubRunFinalizationFailure {
  readonly definitionId: MigrationDefinitionId;
  readonly error: MigrationStoreError;
  readonly runId: MigrationRunId;
}

const lockReleaseFailureError = (
  failures: readonly LockReleaseFailure[],
  primaryExit?: Exit.Exit<unknown, unknown>
) =>
  new MigrationStoreError({
    message: "Unable to release Migration Definition Lock set",
    cause: {
      releaseFailures: failures.map(({ error, lock }) => ({
        definitionId: lock.definitionId,
        error,
        ownerRunId: lock.ownerRunId,
        token: lock.token,
      })),
      ...(primaryExit !== undefined && Exit.isFailure(primaryExit)
        ? { primaryCause: primaryExit.cause }
        : {}),
    },
  });

const stubRunScopeFinalizationError = (
  failures: readonly StubRunFinalizationFailure[]
) =>
  new MigrationStoreError({
    message: "Unable to finalize Destination Stub Migration Run set",
    cause: {
      failures,
    },
  });

const emptyCounts = {
  migrated: 0,
  skipped: 0,
  failed: 0,
  unchanged: 0,
  needsUpdate: 0,
};

export const emptyMigrationRunCursorWindowState: MigrationRunCursorWindowState =
  {
    counts: emptyCounts,
    excludedSourceIdentities: [],
  };

const snapshotCounts = (
  counts: MutableDefinitionCounts
): MigrationDefinitionRunSummary["counts"] => ({ ...counts });

const snapshotRollbackCounts = (
  counts: MutableRollbackDefinitionCounts
): RollbackDefinitionRunSummary["counts"] => ({ ...counts });

const emptyRollbackCounts = {
  rolledBack: 0,
  failed: 0,
  skipped: 0,
};

interface MutableDefinitionCounts {
  failed: number;
  migrated: number;
  needsUpdate: number;
  skipped: number;
  unchanged: number;
}

const mutableCounts = (
  counts: MigrationDefinitionRunSummary["counts"]
): MutableDefinitionCounts => ({ ...counts });

const isEmptyCounts = (
  counts: MigrationDefinitionRunSummary["counts"]
): boolean =>
  counts.failed === 0 &&
  counts.migrated === 0 &&
  counts.needsUpdate === 0 &&
  counts.skipped === 0 &&
  counts.unchanged === 0;

interface MutableRollbackDefinitionCounts {
  failed: number;
  rolledBack: number;
  skipped: number;
}

type RollbackItemOutcome = "failed" | "rolled-back" | "skipped";

const runStatusForDefinitions = (
  definitions: readonly MigrationDefinitionRunSummary[]
): MigrationRunSummary["status"] =>
  definitions.some((definition) => definition.status === "failed")
    ? "failed"
    : "succeeded";

const rollbackStatusForDefinitions = (
  definitions: readonly RollbackDefinitionRunSummary[]
): RollbackRunSummary["status"] =>
  definitions.some((definition) => definition.status === "failed")
    ? "failed"
    : "succeeded";

const failRunAndRethrow = <Error>(
  store: typeof MigrationStore.Service,
  runId: MigrationRunId,
  definitionIds: readonly MigrationDefinitionId[],
  error: Error
): Effect.Effect<never, Error | MigrationStoreError> =>
  store.failRun(runId, definitionIds).pipe(
    Effect.mapError((failRunError) =>
      failRunFinalizationError(runId, definitionIds, error, failRunError)
    ),
    Effect.flatMap(() => Effect.fail(error))
  );

const lockDefinitionIds = (
  definitionIds: readonly MigrationDefinitionId[]
): readonly MigrationDefinitionId[] =>
  Array.from(new Set(definitionIds)).sort((left, right) =>
    left.localeCompare(right)
  );

const lockMismatchError = (
  lease: MigrationRunExecutionLease,
  definitionIds: readonly MigrationDefinitionId[]
) =>
  new MigrationStoreError({
    message: "Migration Run lease does not match planned definitions",
    cause: {
      lockDefinitionIds: lease.locks.map((lock) => lock.definitionId),
      plannedDefinitionIds: definitionIds,
      scopeDefinitionIds: lease.scopeDefinitionIds,
      runId: lease.runId,
    },
  });

const lockOwnerMismatchError = (lease: MigrationRunExecutionLease) =>
  new MigrationStoreError({
    message: "Migration Run lease is owned by another run",
    cause: {
      locks: lease.locks.map((lock) => ({
        definitionId: lock.definitionId,
        ownerRunId: lock.ownerRunId,
        token: lock.token,
      })),
      runId: lease.runId,
    },
  });

const assertMigrationRunExecutionLease = (
  lease: MigrationRunExecutionLease,
  definitionIds: readonly MigrationDefinitionId[]
): Effect.Effect<void, MigrationStoreError> => {
  const plannedDefinitionIds = lockDefinitionIds(definitionIds);
  const leaseDefinitionIds = lockDefinitionIds(lease.scopeDefinitionIds);
  const lockIds = lockDefinitionIds(
    lease.locks.map((lock) => lock.definitionId)
  );
  const idsMatch =
    plannedDefinitionIds.length === leaseDefinitionIds.length &&
    plannedDefinitionIds.length === lockIds.length &&
    plannedDefinitionIds.every(
      (definitionId, index) =>
        definitionId === leaseDefinitionIds[index] &&
        definitionId === lockIds[index]
    );

  if (!idsMatch) {
    return Effect.fail(lockMismatchError(lease, definitionIds));
  }

  if (lease.locks.some((lock) => lock.ownerRunId !== lease.runId)) {
    return Effect.fail(lockOwnerMismatchError(lease));
  }

  return Effect.void;
};

const assertCurrentMigrationRunExecutionLease = (
  store: typeof MigrationStore.Service,
  lease: MigrationRunExecutionLease,
  definitionIds: readonly MigrationDefinitionId[]
): Effect.Effect<void, MigrationStoreError> =>
  assertMigrationRunExecutionLease(lease, definitionIds).pipe(
    Effect.andThen(store.assertDefinitionLocks(lease.locks))
  );

const releaseDefinitionLocks = (
  store: typeof MigrationStore.Service,
  locks: readonly MigrationDefinitionLock[],
  primaryExit?: Exit.Exit<unknown, unknown>
): Effect.Effect<void, MigrationStoreError> =>
  Effect.gen(function* () {
    const failures: LockReleaseFailure[] = [];

    for (const lock of [...locks].reverse()) {
      yield* store.releaseDefinitionLock(lock).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            failures.push({ error, lock });
          })
        )
      );
    }

    if (failures.length > 0) {
      return yield* lockReleaseFailureError(failures, primaryExit);
    }
  });

const acquireDefinitionLocks = (
  store: typeof MigrationStore.Service,
  runId: MigrationRunId,
  definitionIds: readonly MigrationDefinitionId[]
): Effect.Effect<readonly MigrationDefinitionLock[], MigrationStoreError> =>
  Effect.gen(function* () {
    const locks: MigrationDefinitionLock[] = [];

    for (const definitionId of lockDefinitionIds(definitionIds)) {
      const lock = yield* store
        .acquireDefinitionLock(definitionId, runId)
        .pipe(
          Effect.catch((error) =>
            releaseDefinitionLocks(store, locks, Exit.fail(error)).pipe(
              Effect.flatMap(() => Effect.fail(error))
            )
          )
        );
      locks.push(lock);
    }

    return locks;
  });

interface MigrationRunBodyResult<A> {
  readonly status: MigrationRunSummary["status"];
  readonly value: A;
}

interface MigrationRunExecutionResult<A> extends MigrationRunBodyResult<A> {
  readonly completedRun: MigrationRunState;
  readonly runState: MigrationRunState;
}

export interface MigrationRuntimeExecutionOptions {
  readonly lease?: MigrationRunExecutionLease;
  readonly runId?: MigrationRunId;
}

export interface MigrationRunExecutionLease {
  readonly locks: readonly MigrationDefinitionLock[];
  readonly runId: MigrationRunId;
  readonly scopeDefinitionIds: readonly MigrationDefinitionId[];
}

export interface MigrationRunCursorWindowState {
  readonly counts: MigrationDefinitionRunSummary["counts"];
  readonly excludedSourceIdentities: readonly EncodedSourceIdentity[];
}

export type MigrationRunCursorWindowResult =
  | {
      readonly kind: "continue";
      readonly state: MigrationRunCursorWindowState;
    }
  | {
      readonly kind: "definition-completed";
      readonly state: MigrationRunCursorWindowState;
      readonly summary: MigrationDefinitionRunSummary;
    };

export interface MigrationRunCursorWindowInput {
  readonly definitionId: MigrationDefinitionId;
  readonly runId: MigrationRunId;
  readonly state: MigrationRunCursorWindowState;
}

export interface MigrationRunBeginInput {
  readonly definitions: readonly AnyMigrationDefinition[];
  readonly lease: MigrationRunExecutionLease;
}

export interface MigrationRunDefinitionCursorWindowInput
  extends MigrationRunCursorWindowInput {
  readonly definitionIds: readonly MigrationDefinitionId[];
  readonly lease: MigrationRunExecutionLease;
}

export interface MigrationRunCompletionInput {
  readonly definitions: readonly MigrationDefinitionRunSummary[];
  readonly lease: MigrationRunExecutionLease;
  readonly storeLayer: Layer.Layer<MigrationStore, MigrationStoreError>;
}

export interface MigrationRunFailureInput {
  readonly definitionIds?: readonly MigrationDefinitionId[];
  readonly error: unknown;
  readonly lease: MigrationRunExecutionLease;
  readonly storeLayer: Layer.Layer<MigrationStore, MigrationStoreError>;
}

const beginMigrationRunExecution = (
  input: MigrationRunBeginInput
): Effect.Effect<MigrationRunState, RunMigrationError> => {
  const firstDefinition = input.definitions[0];

  if (firstDefinition === undefined) {
    return Effect.fail(emptyRunError);
  }

  const sharedStoreError = validateSharedStore(input.definitions);

  if (sharedStoreError !== null) {
    return Effect.fail(sharedStoreError);
  }

  const definitionIds = input.definitions.map((definition) => definition.id);

  return Effect.gen(function* () {
    const store = yield* MigrationStore;

    yield* assertCurrentMigrationRunExecutionLease(
      store,
      input.lease,
      definitionIds
    );
    yield* validateMigrationContracts(store, input.definitions);
    const runState = yield* store.beginRun(input.lease.runId, definitionIds);
    yield* MigrationProgress.emit({
      definitionIds,
      kind: "run-started",
      runId: runState.runId,
    });

    return runState;
  }).pipe(Effect.provide(firstDefinition.store));
};

const completeMigrationRunExecution = (
  input: MigrationRunCompletionInput
): Effect.Effect<MigrationRunSummary, RunMigrationError> => {
  const definitionIds = input.definitions.map(
    (definition) => definition.definitionId
  );

  return Effect.gen(function* () {
    const store = yield* MigrationStore;

    yield* assertCurrentMigrationRunExecutionLease(
      store,
      input.lease,
      definitionIds
    );
    const status = runStatusForDefinitions(input.definitions);
    const completedRunExit = yield* Effect.exit(
      status === "failed"
        ? store.failRun(input.lease.runId, definitionIds)
        : store.completeRun(input.lease.runId, definitionIds)
    );

    if (Exit.isSuccess(completedRunExit)) {
      yield* MigrationProgress.emit({
        definitionIds,
        kind: "run-completed",
        runId: input.lease.runId,
        status,
      });
    }

    yield* releaseDefinitionLocks(store, input.lease.locks, completedRunExit);

    const completedRun = yield* completedRunExit;

    return {
      definitions: input.definitions,
      finishedAt: completedRun.finishedAt ?? new Date(),
      runId: completedRun.runId,
      startedAt: completedRun.startedAt,
      status,
    };
  }).pipe(Effect.provide(input.storeLayer));
};

const failMigrationRunExecution = (
  input: MigrationRunFailureInput
): Effect.Effect<void, RunMigrationError> => {
  const definitionIds = input.definitionIds ?? input.lease.scopeDefinitionIds;

  return Effect.gen(function* () {
    const store = yield* MigrationStore;

    yield* assertCurrentMigrationRunExecutionLease(
      store,
      input.lease,
      definitionIds
    );
    yield* MigrationProgress.emit({
      definitionIds,
      error: input.error,
      kind: "run-failed",
      runId: input.lease.runId,
    });
    const failedRunExit = yield* Effect.exit(
      store.failRun(input.lease.runId, definitionIds)
    );
    yield* releaseDefinitionLocks(store, input.lease.locks, failedRunExit);
    yield* failedRunExit;
  }).pipe(Effect.provide(input.storeLayer));
};

const executeMigrationRun = <A, E, R = never>(
  store: typeof MigrationStore.Service,
  definitionIds: readonly MigrationDefinitionId[],
  body: (
    runId: MigrationRunId
  ) => Effect.Effect<MigrationRunBodyResult<A>, E | MigrationStoreError, R>,
  beforeBegin?: (
    runId: MigrationRunId
  ) => Effect.Effect<void, E | MigrationStoreError>,
  options: MigrationRuntimeExecutionOptions = {}
): Effect.Effect<MigrationRunExecutionResult<A>, E | MigrationStoreError, R> =>
  Effect.gen(function* () {
    const runId =
      options.lease?.runId ?? options.runId ?? (yield* store.createRunId);
    const acquireLocks =
      options.lease === undefined
        ? acquireDefinitionLocks(store, runId, definitionIds)
        : assertCurrentMigrationRunExecutionLease(
            store,
            options.lease,
            definitionIds
          ).pipe(Effect.as(options.lease.locks));

    return yield* Effect.acquireUseRelease(
      acquireLocks,
      () =>
        Effect.gen(function* () {
          if (beforeBegin !== undefined) {
            yield* beforeBegin(runId);
          }

          const runState = yield* store.beginRun(runId, definitionIds);
          yield* MigrationProgress.emit({
            definitionIds,
            kind: "run-started",
            runId: runState.runId,
          });
          const bodyResult = yield* body(runState.runId).pipe(
            Effect.catch((error) =>
              MigrationProgress.emit({
                definitionIds,
                error,
                kind: "run-failed",
                runId: runState.runId,
              }).pipe(
                Effect.andThen(
                  failRunAndRethrow(store, runState.runId, definitionIds, error)
                )
              )
            )
          );
          const completedRun =
            bodyResult.status === "failed"
              ? yield* store.failRun(runState.runId, definitionIds)
              : yield* store.completeRun(runState.runId, definitionIds);
          yield* MigrationProgress.emit({
            definitionIds,
            kind: "run-completed",
            runId: runState.runId,
            status: bodyResult.status,
          });

          return {
            ...bodyResult,
            completedRun,
            runState,
          };
        }),
      (locks, exit) => releaseDefinitionLocks(store, locks, exit)
    );
  });

const encodeSourceCursor = <Cursor>(
  cursorSchema: Schema.Codec<Cursor, unknown, never, never>,
  cursor: Cursor
) =>
  Schema.encodeEffect(Schema.fromJsonString(cursorSchema))(cursor).pipe(
    Effect.map(toEncodedSourceCursor),
    Effect.mapError(
      (cause) =>
        new MigrationStoreError({
          message: "Unable to encode Source Cursor for durable storage",
          cause,
        })
    )
  );

const decodeSourceCursor = <Cursor>(
  cursorSchema: Schema.Codec<Cursor, unknown, never, never>,
  cursor: string
) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(cursorSchema))(cursor).pipe(
    Effect.mapError(
      (cause) =>
        new MigrationStoreError({
          message: "Unable to decode stored Source Cursor",
          cause,
        })
    )
  );

type OrderedDefinitionsResult =
  | {
      readonly definitions: readonly AnyMigrationDefinition[];
      readonly kind: "ordered";
    }
  | {
      readonly error: MigrationRuntimeError;
      readonly kind: "failed";
    };

const orderDefinitions = (
  definitions: readonly AnyMigrationDefinition[],
  selectedDefinitionIds: readonly MigrationDefinitionId[] | undefined
): OrderedDefinitionsResult => {
  const definitionsById = new Map(
    definitions.map((definition) => [definition.id, definition])
  );
  const orderedDefinitions: AnyMigrationDefinition[] = [];
  const activeDefinitionIds = new Set<MigrationDefinitionId>();
  const visitedDefinitionIds = new Set<MigrationDefinitionId>();
  const rootDefinitionIds =
    selectedDefinitionIds === undefined
      ? definitions.map((definition) => definition.id)
      : selectedDefinitionIds;

  const visit = (
    definitionId: MigrationDefinitionId
  ): MigrationRuntimeError | null => {
    if (visitedDefinitionIds.has(definitionId)) {
      return null;
    }

    if (activeDefinitionIds.has(definitionId)) {
      return dependencyCycleError(definitionId);
    }

    const definition = definitionsById.get(definitionId);

    if (definition === undefined) {
      return missingDefinitionError(definitionId);
    }

    activeDefinitionIds.add(definitionId);

    for (const dependencyId of definition.dependsOn ?? []) {
      const error = visit(dependencyId);

      if (error !== null) {
        activeDefinitionIds.delete(definitionId);
        return error;
      }
    }

    activeDefinitionIds.delete(definitionId);
    visitedDefinitionIds.add(definitionId);
    orderedDefinitions.push(definition);

    return null;
  };

  for (const definitionId of rootDefinitionIds) {
    const error = visit(definitionId);

    if (error !== null) {
      return { kind: "failed", error };
    }
  }

  return { kind: "ordered", definitions: orderedDefinitions };
};

const validateSharedStore = (
  definitions: readonly AnyMigrationDefinition[]
): MigrationRuntimeError | null => {
  const firstDefinition = definitions[0];

  if (firstDefinition === undefined) {
    return null;
  }

  for (const definition of definitions) {
    if (definition.store !== firstDefinition.store) {
      return splitStoreRunError(definition.id, firstDefinition.id);
    }
  }

  return null;
};

const validateUpdateRunRequest = (
  request: EncodedRunRequest<readonly AnyMigrationDefinition[]>
): MigrationRuntimeError | null => {
  if (request.update !== true) {
    return null;
  }

  const mode = request.mode ?? normalRunMode;

  return mode.kind === "normal" ? null : invalidUpdateRunModeError(mode);
};

const isTargetedMode = (mode: RunMode): boolean => mode.kind !== "normal";

const shouldReprocessUnchangedTerminal = (mode: RunMode): boolean =>
  mode.kind === "skipped" || mode.kind === "item";

const updateRunScheduleReason = "Scheduled by update run";

const previousTrackingRecord = (
  previousState: MigrationItemState | null
): TrackingRecord | undefined =>
  previousState !== null && "trackingRecord" in previousState
    ? previousState.trackingRecord
    : undefined;

const makeUpdateRunNeedsUpdateState = (
  itemState: MigratedItemState,
  runId: MigrationRunId
): NeedsUpdateItemState => ({
  definitionId: itemState.definitionId,
  sourceIdentity: itemState.sourceIdentity,
  ...(itemState.sourceVersionContractFingerprint === undefined
    ? {}
    : {
        sourceVersionContractFingerprint:
          itemState.sourceVersionContractFingerprint,
      }),
  sourceVersion: itemState.sourceVersion,
  ...(itemState.journal === undefined ? {} : { journal: itemState.journal }),
  lastRunId: runId,
  updatedAt: new Date(),
  reason: updateRunScheduleReason,
  status: "needs-update",
  ...(itemState.trackingRecord === undefined
    ? {}
    : { trackingRecord: itemState.trackingRecord }),
});

const prepareUpdateRunDefinition = ({
  definitionId,
  itemStates,
  runId,
  store,
}: {
  readonly definitionId: MigrationDefinitionId;
  readonly itemStates: readonly MigrationItemState[];
  readonly runId: MigrationRunId;
  readonly store: typeof MigrationStore.Service;
}): Effect.Effect<void, MigrationStoreError> =>
  Effect.gen(function* () {
    for (const itemState of itemStates) {
      if (itemState.status !== "migrated") {
        continue;
      }

      yield* store.upsertItemState(
        makeUpdateRunNeedsUpdateState(itemState, runId)
      );
    }

    yield* store.deleteSourceCursor(definitionId);
  });

const selectBacklogStates = (
  mode: RunMode,
  itemStates: readonly MigrationItemState[]
): readonly MigrationItemState[] => {
  switch (mode.kind) {
    case "normal": {
      return itemStates.filter(
        (itemState) =>
          itemState.status === "failed" || itemState.status === "needs-update"
      );
    }
    case "failed": {
      return itemStates.filter((itemState) => itemState.status === "failed");
    }
    case "skipped": {
      return itemStates.filter((itemState) => itemState.status === "skipped");
    }
    case "item": {
      return [];
    }
    default: {
      const unhandledMode: never = mode;
      throw new Error(`Unhandled Run Mode: ${unhandledMode}`);
    }
  }
};

const sourceIdentitiesForMode = (
  mode: RunMode,
  backlogStates: readonly MigrationItemState[]
): readonly EncodedSourceIdentity[] =>
  mode.kind === "item"
    ? [mode.encodedSourceIdentity]
    : backlogStates.map((itemState) => itemState.sourceIdentity.encoded);

const stubNotConfiguredError = (definitionId: MigrationDefinitionId) =>
  new MigrationReferenceLookupError({
    message:
      "Migration Definition does not define Migration Reference Stub creation",
    cause: { definitionId },
  });

const stubCreationFailedError = (
  definitionId: MigrationDefinitionId,
  sourceIdentity: EncodedSourceIdentity
) =>
  new MigrationReferenceLookupError({
    message: "Migration Reference Stub creation failed",
    cause: { definitionId, sourceIdentity },
  });

const missingTrackingRecordContractError = (
  definitionId: MigrationDefinitionId
) =>
  new MigrationReferenceLookupError({
    message:
      "Migration Reference Lookup requires referenced Migration Definition to declare a Tracking Record Contract",
    cause: { definitionId },
  });

const isSkipItem = (error: unknown): error is SkipItem =>
  Predicate.isTagged(error, "SkipItem");

const makeFailedStubReferenceState = ({
  definitionId,
  error,
  journal,
  previousState,
  runId,
  sourceIdentity,
}: {
  readonly definitionId: MigrationDefinitionId;
  readonly error: MigrationItemError;
  readonly journal?: FailedItemState["journal"];
  readonly previousState: MigrationItemState | null;
  readonly runId: MigrationRunId;
  readonly sourceIdentity: SourceIdentityValue;
}): FailedItemState => {
  const preservedJournal = previousState?.journal ?? journal;
  const trackingRecord = previousTrackingRecord(previousState);

  return {
    definitionId,
    sourceIdentity,
    ...(previousState?.sourceVersionContractFingerprint === undefined
      ? {}
      : {
          sourceVersionContractFingerprint:
            previousState.sourceVersionContractFingerprint,
        }),
    ...(previousState?.sourceVersion === undefined
      ? {}
      : { sourceVersion: previousState.sourceVersion }),
    ...(preservedJournal === undefined ? {} : { journal: preservedJournal }),
    lastRunId: runId,
    updatedAt: new Date(),
    status: "failed",
    error,
    ...(trackingRecord === undefined ? {} : { trackingRecord }),
  };
};

const makeNeedsUpdateStubReferenceState = ({
  definitionId,
  journal,
  previousState,
  runId,
  sourceIdentity,
  trackingRecord,
}: {
  readonly definitionId: MigrationDefinitionId;
  readonly journal?: NeedsUpdateItemState["journal"];
  readonly previousState: MigrationItemState | null;
  readonly runId: MigrationRunId;
  readonly sourceIdentity: SourceIdentityValue;
  readonly trackingRecord?: TrackingRecord;
}): NeedsUpdateItemState => {
  const resolvedTrackingRecord =
    trackingRecord ?? previousTrackingRecord(previousState);

  return {
    definitionId,
    sourceIdentity,
    ...(previousState?.sourceVersionContractFingerprint === undefined
      ? {}
      : {
          sourceVersionContractFingerprint:
            previousState.sourceVersionContractFingerprint,
        }),
    ...(previousState?.sourceVersion === undefined
      ? {}
      : { sourceVersion: previousState.sourceVersion }),
    ...(journal === undefined ? {} : { journal }),
    lastRunId: runId,
    updatedAt: new Date(),
    reason: "Migration Reference Stub requires update",
    status: "needs-update",
    ...(resolvedTrackingRecord === undefined
      ? {}
      : { trackingRecord: resolvedTrackingRecord }),
  };
};

type TrackingStubOutcome =
  | {
      readonly error: MigrationItemError;
      readonly journal?: FailedItemState["journal"];
      readonly kind: "failed";
    }
  | {
      readonly journal?: NeedsUpdateItemState["journal"];
      readonly kind: "succeeded";
      readonly trackingRecord: TrackingRecord;
    };

const executeTrackingStub = (
  definition: AnyMigrationDefinition,
  runId: MigrationRunId,
  sourceIdentity: EncodedSourceIdentity,
  previousState: MigrationItemState | null
): Effect.Effect<TrackingStubOutcome, MigrationReferenceLookupError> =>
  Effect.gen(function* () {
    const contract = definition.tracking as TrackingRecordContract | undefined;

    if (contract === undefined) {
      return yield* missingTrackingRecordContractError(definition.id);
    }

    const stub = definition.stub;

    if (stub === undefined) {
      return yield* stubNotConfiguredError(definition.id);
    }

    const tracking = yield* makeProcessScope({
      definitionId: definition.id,
      runId,
      sourceIdentity,
      ...(previousState === null ? {} : { previousState }),
    });

    const stubOutcome = yield* Effect.try({
      try: () =>
        stub(
          { sourceIdentity },
          {
            definitionId: definition.id,
            runId,
          }
        ),
      catch: (error) =>
        isSkipItem(error)
          ? error
          : new MigrationReferenceLookupError({
              message: "Migration Reference Stub creation threw",
              cause: error,
            }),
    }).pipe(
      Effect.flatMap((voidOrEffect) =>
        Effect.isEffect(voidOrEffect)
          ? (voidOrEffect as Effect.Effect<void, unknown, Tracking>)
          : Effect.void
      ),
      Effect.provide(Layer.succeed(Tracking, tracking)),
      Effect.as({ kind: "succeeded" as const }),
      Effect.catchIf(isSkipItem, (error) =>
        Effect.succeed({
          kind: "failed" as const,
          error: normalizeItemError(
            "process",
            new MigrationReferenceLookupError({
              message: "Migration Reference Stub creation skipped",
              cause: error,
            })
          ),
        })
      ),
      Effect.catch((error) =>
        Effect.succeed({
          kind: "failed" as const,
          error: normalizeItemError("process", error),
        })
      )
    );

    const processJournalSegment = yield* tracking.snapshot;
    const journal = makeProcessJournal(processJournalSegment);

    if (stubOutcome.kind === "failed") {
      return {
        kind: "failed" as const,
        error: stubOutcome.error,
        ...(journal === undefined ? {} : { journal }),
      };
    }

    const records = yield* tracking.records;

    return yield* validateStagedTrackingRecord(contract, records).pipe(
      Effect.map((trackingRecord) => ({
        kind: "succeeded" as const,
        ...(journal === undefined ? {} : { journal }),
        trackingRecord: trackingRecord as TrackingRecord,
      })),
      Effect.catch((error) =>
        Effect.succeed({
          kind: "failed" as const,
          error,
          ...(journal === undefined ? {} : { journal }),
        })
      )
    );
  });

const makeSourceLookupFailedItemState = (
  definitionId: MigrationDefinitionId,
  runId: MigrationRunId,
  previousState: MigrationItemState,
  error: unknown
): FailedItemState => {
  const trackingRecord = previousTrackingRecord(previousState);

  return {
    definitionId,
    sourceIdentity: previousState.sourceIdentity,
    ...(previousState.sourceVersionContractFingerprint === undefined
      ? {}
      : {
          sourceVersionContractFingerprint:
            previousState.sourceVersionContractFingerprint,
        }),
    ...(previousState.sourceVersion === undefined
      ? {}
      : { sourceVersion: previousState.sourceVersion }),
    lastRunId: runId,
    updatedAt: new Date(),
    status: "failed",
    error: normalizeItemError("source", error),
    ...(previousState.journal === undefined
      ? {}
      : { journal: previousState.journal }),
    ...(trackingRecord === undefined ? {} : { trackingRecord }),
  };
};

const addOutcomeToCounts = (
  counts: MutableDefinitionCounts,
  outcome: MigrationItemOutcome
) => {
  switch (outcome) {
    case "migrated": {
      counts.migrated += 1;
      break;
    }
    case "skipped": {
      counts.skipped += 1;
      break;
    }
    case "failed": {
      counts.failed += 1;
      break;
    }
    case "unchanged": {
      counts.unchanged += 1;
      break;
    }
    case "needs-update": {
      counts.needsUpdate += 1;
      break;
    }
    default: {
      const unhandledOutcome: never = outcome;
      throw new Error(`Unhandled Migration Item Outcome: ${unhandledOutcome}`);
    }
  }
};

const recordMigrationOutcome = ({
  counts,
  definitionId,
  outcome,
  runId,
}: {
  readonly counts: MutableDefinitionCounts;
  readonly definitionId: MigrationDefinitionId;
  readonly outcome: MigrationItemOutcome;
  readonly runId: MigrationRunId;
}) =>
  Effect.sync(() => {
    addOutcomeToCounts(counts, outcome);
    return snapshotCounts(counts);
  }).pipe(
    Effect.flatMap((countsSnapshot) =>
      MigrationProgress.emit({
        counts: countsSnapshot,
        definitionId,
        kind: "source-item-completed",
        outcome,
        runId,
      })
    )
  );

const countDefinitionSourceItemTotal = <
  Source,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  SourceInput,
>({
  definitionId,
  itemLimit,
  runId,
  source,
}: {
  readonly definitionId: MigrationDefinitionId;
  readonly itemLimit?: number;
  readonly runId: MigrationRunId;
  readonly source: SourcePlugin<Source, Cursor, SourceInput, IdentityKey>;
}) =>
  MigrationProgress.shouldCountSourceItemTotals.pipe(
    Effect.flatMap((shouldCountTotals) => {
      if (!shouldCountTotals) {
        return Effect.void;
      }

      const count =
        source.countTotal === undefined
          ? Effect.succeed(
              SourceItemTotal.unknown({
                message:
                  "Source plugin does not support Source Item total count",
                reason: "unsupported",
              })
            )
          : source.countTotal().pipe(
              Effect.flatMap(normalizeSourceItemTotal),
              Effect.catch((error) =>
                Effect.succeed(
                  SourceItemTotal.unknown({
                    cause: error,
                    message: "Source Item total count failed",
                    reason: "failed",
                  })
                )
              )
            );

      return count.pipe(
        Effect.flatMap((sourceItemTotal) =>
          MigrationProgress.emit({
            definitionId,
            ...(itemLimit === undefined ? {} : { itemLimit }),
            kind: "source-item-total-counted",
            runId,
            sourceItemTotal,
          })
        )
      );
    })
  );

const addRollbackOutcomeToCounts = (
  counts: MutableRollbackDefinitionCounts,
  outcome: RollbackItemOutcome
) => {
  if (outcome === "failed") {
    counts.failed += 1;
  } else if (outcome === "rolled-back") {
    counts.rolledBack += 1;
  } else {
    counts.skipped += 1;
  }
};

const recordRollbackOutcome = ({
  counts,
  definitionId,
  outcome,
  runId,
}: {
  readonly counts: MutableRollbackDefinitionCounts;
  readonly definitionId: MigrationDefinitionId;
  readonly outcome: RollbackItemOutcome;
  readonly runId: MigrationRunId;
}) =>
  Effect.sync(() => {
    addRollbackOutcomeToCounts(counts, outcome);
    return snapshotRollbackCounts(counts);
  }).pipe(
    Effect.flatMap((countsSnapshot) =>
      RollbackProgress.emit({
        counts: countsSnapshot,
        definitionId,
        kind: "source-item-completed",
        outcome,
        runId,
      })
    )
  );

const runRollbackPipeline = <RollbackError>(
  rollback: RollbackPipeline<RollbackError>,
  definitionId: MigrationDefinitionId,
  itemState: MigrationItemState,
  runId: MigrationRunId
): Effect.Effect<void, RollbackError, Tracking> =>
  Effect.try({
    try: () =>
      rollback(itemState, {
        definitionId,
        runId,
      }),
    catch: (error) => error as RollbackError,
  }).pipe(
    Effect.flatMap((voidOrEffect) =>
      Effect.isEffect(voidOrEffect)
        ? (voidOrEffect as Effect.Effect<void, RollbackError, Tracking>)
        : Effect.void
    )
  );

const emptyProcessJournalSegment = (
  itemState: MigrationItemState
): DestinationJournal["process"] => ({
  entries: [],
  runId: itemState.lastRunId,
});

const appendFailedRollbackAttempt = (
  itemState: MigrationItemState,
  runId: MigrationRunId,
  tracking: TrackingService,
  error: MigrationItemError
): Effect.Effect<MigrationItemState> =>
  Effect.gen(function* () {
    const rollbackJournal = yield* tracking.snapshot;
    const rollbackAttempt: DestinationRollbackAttemptJournalSegment = {
      entries: rollbackJournal?.entries ?? [],
      error,
      failedAt: new Date(),
      runId,
    };

    return {
      ...itemState,
      journal: {
        process:
          itemState.journal?.process ?? emptyProcessJournalSegment(itemState),
        rollbackAttempts: [
          ...(itemState.journal?.rollbackAttempts ?? []),
          rollbackAttempt,
        ],
      },
    };
  });

const rollbackItemState = <
  Source,
  PipelineError,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  RollbackPipelineError,
  SourceInput,
  SourceLayerError,
  SourceRequirements,
>({
  definition,
  itemState,
  runId,
  store,
}: {
  readonly definition: MigrationDefinition<
    Source,
    PipelineError,
    Cursor,
    IdentityKey,
    RollbackPipelineError,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >;
  readonly itemState: MigrationItemState;
  readonly runId: MigrationRunId;
  readonly store: typeof MigrationStore.Service;
}): Effect.Effect<
  RollbackItemOutcome,
  MigrationStoreError | RollbackPreflightError
> =>
  Effect.gen(function* () {
    const rollback = definition.rollback;

    if (rollback === undefined) {
      return yield* missingRollbackPipelineError(definition.id);
    }

    const tracking = yield* makeProcessScope({
      definitionId: definition.id,
      previousState: itemState,
      runId,
      sourceIdentity: itemState.sourceIdentity.encoded,
      ...(itemState.sourceVersion === undefined
        ? {}
        : { sourceVersion: itemState.sourceVersion }),
    });

    const rollbackOutcome = yield* runRollbackPipeline(
      rollback,
      definition.id,
      itemState,
      runId
    ).pipe(
      Effect.provide(Layer.succeed(Tracking, tracking)),
      Effect.as({ kind: "succeeded" as const }),
      Effect.catch((error) =>
        Effect.succeed({
          kind: "failed" as const,
          error,
        })
      )
    );

    if (rollbackOutcome.kind === "failed") {
      const updatedState = yield* appendFailedRollbackAttempt(
        itemState,
        runId,
        tracking,
        normalizeItemError("process", rollbackOutcome.error)
      );
      yield* store.upsertItemState(updatedState);
      return "failed" as const;
    }

    yield* store.deleteItemState(
      definition.id,
      itemState.sourceIdentity.encoded
    );
    return "rolled-back" as const;
  });

interface ProcessTargetedSourceIdentitiesOptions<
  Source,
  PipelineError,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  SourceInput,
  SourceLayerError,
  SourceRequirements,
> {
  readonly counts: MutableDefinitionCounts;
  readonly definition: MigrationDefinition<
    Source,
    PipelineError,
    Cursor,
    IdentityKey,
    unknown,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >;
  readonly itemStates: readonly MigrationItemState[];
  readonly mode: RunMode;
  readonly processConcurrency: PipelineExecutionConcurrency;
  readonly runId: MigrationRunId;
  readonly source: SourcePlugin<Source, Cursor, SourceInput, IdentityKey>;
  readonly store: typeof MigrationStore.Service;
}

const processTargetedSourceIdentities = <
  Source,
  PipelineError,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  SourceInput,
  SourceLayerError,
  SourceRequirements,
>({
  counts,
  definition,
  itemStates,
  mode,
  processConcurrency,
  runId,
  source,
  store,
}: ProcessTargetedSourceIdentitiesOptions<
  Source,
  PipelineError,
  Cursor,
  IdentityKey,
  SourceInput,
  SourceLayerError,
  SourceRequirements
>) =>
  Effect.gen(function* () {
    const sourceIdentities = sourceIdentitiesForMode(
      mode,
      selectBacklogStates(mode, itemStates)
    );

    yield* Effect.forEach(
      sourceIdentities,
      (sourceIdentity) =>
        Effect.gen(function* () {
          const previousState =
            itemStates.find(
              (itemState) => itemState.sourceIdentity.encoded === sourceIdentity
            ) ?? null;
          const readByIdentity = Effect.try({
            try: () =>
              SourceIdentity.fromEncoded(source.identity, sourceIdentity),
            catch: (cause) =>
              new SourcePluginError({
                message:
                  "Encoded source identity did not match Source Identity Schema",
                cause,
              }),
          }).pipe(
            Effect.flatMap((identity) => source.readByIdentity(identity))
          );
          const readByIdentityWithRetry =
            definition.sourceLookupRetry === undefined
              ? readByIdentity
              : definition.sourceLookupRetry(readByIdentity);
          const lookup = yield* readByIdentityWithRetry.pipe(
            Effect.map((sourceItem) =>
              sourceItem === null
                ? ({
                    kind: "missing" as const,
                    error: new SourcePluginError({
                      message: "Source identity was not found",
                      cause: { sourceIdentity },
                    }),
                  } as const)
                : ({ kind: "found" as const, sourceItem } as const)
            ),
            Effect.catch((error) =>
              Effect.succeed({ kind: "failed" as const, error } as const)
            )
          );

          if (lookup.kind === "failed" || lookup.kind === "missing") {
            if (previousState === null) {
              return yield* lookup.error;
            }

            yield* store.upsertItemState(
              makeSourceLookupFailedItemState(
                definition.id,
                runId,
                previousState,
                lookup.error
              )
            );
            const outcome = "failed" as const;
            yield* recordMigrationOutcome({
              counts,
              definitionId: definition.id,
              outcome,
              runId,
            });
            return outcome;
          }

          const outcome = yield* processSourceItem({
            definition,
            reprocessUnchangedTerminal: shouldReprocessUnchangedTerminal(mode),
            runId,
            sourceSchema: source.sourceSchema,
            sourceItem: lookup.sourceItem,
          });

          yield* recordMigrationOutcome({
            counts,
            definitionId: definition.id,
            outcome,
            runId,
          });
          return outcome;
        }),
      { concurrency: processConcurrency, discard: true }
    );

    return sourceIdentities;
  });

interface ProcessCursorDiscoveryOptions<
  Source,
  PipelineError,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  SourceInput,
  SourceLayerError,
  SourceRequirements,
> {
  readonly counts: MutableDefinitionCounts;
  readonly definition: MigrationDefinition<
    Source,
    PipelineError,
    Cursor,
    IdentityKey,
    unknown,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >;
  readonly excludedSourceIdentities: readonly EncodedSourceIdentity[];
  readonly processConcurrency: PipelineExecutionConcurrency;
  readonly reprocessUnchangedTerminal?: boolean;
  readonly runId: MigrationRunId;
  readonly source: SourcePlugin<Source, Cursor, SourceInput, IdentityKey>;
  readonly store: typeof MigrationStore.Service;
}

const processNextCursorWindow = <
  Source,
  PipelineError,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  SourceInput,
  SourceLayerError,
  SourceRequirements,
>({
  counts,
  definition,
  excludedSourceIdentities,
  processConcurrency,
  reprocessUnchangedTerminal = false,
  runId,
  source,
  store,
}: ProcessCursorDiscoveryOptions<
  Source,
  PipelineError,
  Cursor,
  IdentityKey,
  SourceInput,
  SourceLayerError,
  SourceRequirements
>) =>
  Effect.gen(function* () {
    const storedCursor = yield* store.getSourceCursor(definition.id);
    const cursor =
      storedCursor === null
        ? null
        : yield* decodeSourceCursor(source.cursorSchema, storedCursor);
    const read = source.read(cursor);
    const readWithRetry =
      definition.sourceCursorRetry === undefined
        ? read
        : definition.sourceCursorRetry(read);
    const readResult = yield* readWithRetry;

    yield* Effect.forEach(
      readResult.items,
      (sourceItem) =>
        excludedSourceIdentities.includes(sourceItem.identity.encoded)
          ? Effect.void
          : Effect.gen(function* () {
              const outcome = yield* processSourceItem({
                definition,
                reprocessUnchangedTerminal,
                runId,
                sourceSchema: source.sourceSchema,
                sourceItem,
              });
              yield* recordMigrationOutcome({
                counts,
                definitionId: definition.id,
                outcome,
                runId,
              });
            }),
      { concurrency: processConcurrency, discard: true }
    );

    yield* MigrationProgress.emit({
      counts: snapshotCounts(counts),
      definitionId: definition.id,
      itemsRead: readResult.items.length,
      kind: "source-cursor-window-completed",
      runId,
    });

    if (readResult.nextCursor === undefined) {
      return {
        kind: "done" as const,
      };
    }

    const encodedCursor = yield* encodeSourceCursor(
      source.cursorSchema,
      readResult.nextCursor
    );
    yield* store.setSourceCursor(definition.id, encodedCursor);

    return {
      kind: "continue" as const,
      committedCursor: readResult.nextCursor,
    };
  });

const processCursorDiscovery = <
  Source,
  PipelineError,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  SourceInput,
  SourceLayerError,
  SourceRequirements,
>({
  counts,
  definition,
  excludedSourceIdentities,
  processConcurrency,
  reprocessUnchangedTerminal = false,
  runId,
  source,
  store,
}: ProcessCursorDiscoveryOptions<
  Source,
  PipelineError,
  Cursor,
  IdentityKey,
  SourceInput,
  SourceLayerError,
  SourceRequirements
>) =>
  Effect.gen(function* () {
    let committedCursor: Cursor | undefined;

    while (true) {
      const result = yield* processNextCursorWindow({
        counts,
        definition,
        excludedSourceIdentities,
        processConcurrency,
        reprocessUnchangedTerminal,
        runId,
        source,
        store,
      });

      if (result.kind === "done") {
        break;
      }

      committedCursor = result.committedCursor;
    }

    return committedCursor;
  });

const processStubSourceIdentity = ({
  definition,
  runId,
  sourceIdentity,
  store,
}: {
  readonly definition: AnyMigrationDefinition;
  readonly runId: MigrationRunId;
  readonly sourceIdentity: EncodedSourceIdentity;
  readonly store: typeof MigrationStore.Service;
}): Effect.Effect<
  MigrationReference,
  MigrationReferenceLookupError | MigrationStoreError
> =>
  Effect.gen(function* () {
    const sourceIdentitySnapshot = yield* Effect.try({
      try: () =>
        SourceIdentity.fromEncoded(definition.source.identity, sourceIdentity),
      catch: (cause) =>
        new MigrationReferenceLookupError({
          message:
            "Encoded source identity did not match Source Identity Schema",
          cause,
        }),
    });
    const previousState = yield* store.getItemState(
      definition.id,
      sourceIdentity
    );
    const stubOutcome = yield* executeTrackingStub(
      definition,
      runId,
      sourceIdentity,
      previousState
    );

    if (stubOutcome.kind === "failed") {
      yield* store.upsertItemState(
        makeFailedStubReferenceState({
          definitionId: definition.id,
          error: stubOutcome.error,
          ...(stubOutcome.journal === undefined
            ? {}
            : { journal: stubOutcome.journal }),
          previousState,
          runId,
          sourceIdentity: sourceIdentitySnapshot,
        })
      );

      return yield* stubCreationFailedError(definition.id, sourceIdentity);
    }

    const state = makeNeedsUpdateStubReferenceState({
      definitionId: definition.id,
      ...(stubOutcome.journal === undefined
        ? {}
        : { journal: stubOutcome.journal }),
      previousState,
      runId,
      sourceIdentity: sourceIdentitySnapshot,
      trackingRecord: stubOutcome.trackingRecord,
    });
    yield* store.upsertItemState(state);

    return {
      definitionId: state.definitionId,
      sourceIdentity: state.sourceIdentity.encoded,
      status: state.status,
      trackingRecord: stubOutcome.trackingRecord,
    } satisfies MigrationReference;
  });

type StubReferenceError = MigrationReferenceLookupError | MigrationStoreError;

type StubDefinitionRunError =
  | MigrationReferenceLookupError
  | MigrationStoreError;

interface StubDefinitionRunLease {
  readonly definitionId: MigrationDefinitionId;
  failed: boolean;
  readonly locks: readonly MigrationDefinitionLock[];
  readonly ownsLifecycle: boolean;
  readonly runId: MigrationRunId;
  readonly store: typeof MigrationStore.Service;
}

interface ActiveStubRunScope {
  readonly definitionIds: readonly MigrationDefinitionId[];
  readonly runId: MigrationRunId;
  readonly store: typeof MigrationStore.Service;
}

interface StubRunScope {
  readonly createStubReference: CreateMigrationReferenceStub;
  readonly finalize: (
    primaryExit: Exit.Exit<unknown, unknown>
  ) => Effect.Effect<void, MigrationStoreError>;
}

const stubReferenceKey = (
  definitionId: MigrationDefinitionId,
  sourceIdentity: EncodedSourceIdentity
) => `${definitionId}\u0000${sourceIdentity}`;

const validateStubMigrationContract = (
  store: typeof MigrationStore.Service,
  definition: AnyMigrationDefinition
): Effect.Effect<void, StubDefinitionRunError> =>
  validateMigrationContract(store, definition).pipe(
    Effect.mapError((error) =>
      isMigrationRuntimeError(error)
        ? new MigrationReferenceLookupError({
            message: error.message,
            cause: error,
          })
        : error
    )
  );

const startStubDefinitionRun = (
  definition: AnyMigrationDefinition
): Effect.Effect<StubDefinitionRunLease, StubDefinitionRunError> =>
  Effect.gen(function* () {
    const store = yield* MigrationStore;
    const runId = yield* store.createRunId;
    const locks = yield* acquireDefinitionLocks(store, runId, [definition.id]);

    yield* validateStubMigrationContract(store, definition).pipe(
      Effect.catch((error) =>
        releaseDefinitionLocks(store, locks, Exit.fail(error)).pipe(
          Effect.flatMap(() => Effect.fail(error))
        )
      )
    );

    const runState = yield* store
      .beginRun(runId, [definition.id])
      .pipe(
        Effect.catch((error) =>
          releaseDefinitionLocks(store, locks, Exit.fail(error)).pipe(
            Effect.flatMap(() => Effect.fail(error))
          )
        )
      );

    return {
      definitionId: definition.id,
      failed: false,
      locks,
      ownsLifecycle: true,
      runId: runState.runId,
      store,
    };
  }).pipe(Effect.provide(definition.store));

const finishStubDefinitionRun = (
  lease: StubDefinitionRunLease,
  primaryExit: Exit.Exit<unknown, unknown>
): Effect.Effect<void, MigrationStoreError> =>
  Effect.gen(function* () {
    if (!lease.ownsLifecycle) {
      return;
    }

    const shouldFailRun = lease.failed || Exit.isFailure(primaryExit);
    const finalizedRunExit = yield* Effect.exit(
      shouldFailRun
        ? lease.store.failRun(lease.runId, [lease.definitionId])
        : lease.store.completeRun(lease.runId, [lease.definitionId])
    );

    yield* releaseDefinitionLocks(
      lease.store,
      lease.locks,
      Exit.isFailure(finalizedRunExit) ? finalizedRunExit : primaryExit
    );

    yield* finalizedRunExit;
  });

const makeStubRunScope = (activeRun: ActiveStubRunScope): StubRunScope => {
  const leases = new Map<MigrationDefinitionId, StubDefinitionRunLease>();
  const leaseRequests = new Map<
    MigrationDefinitionId,
    Deferred.Deferred<StubDefinitionRunLease, StubDefinitionRunError>
  >();
  const stubRequests = new Map<
    string,
    Deferred.Deferred<MigrationReference, StubReferenceError>
  >();

  for (const definitionId of activeRun.definitionIds) {
    leases.set(definitionId, {
      definitionId,
      failed: false,
      locks: [],
      ownsLifecycle: false,
      runId: activeRun.runId,
      store: activeRun.store,
    });
  }

  const getStubDefinitionRun = (
    definition: AnyMigrationDefinition
  ): Effect.Effect<StubDefinitionRunLease, StubDefinitionRunError> =>
    Effect.gen(function* () {
      const activeLease = leases.get(definition.id);

      if (activeLease !== undefined) {
        return activeLease;
      }

      const request = yield* Effect.sync(() => {
        const existing = leaseRequests.get(definition.id);

        if (existing !== undefined) {
          return {
            deferred: existing,
            owner: false,
          } as const;
        }

        const deferred = Deferred.makeUnsafe<
          StubDefinitionRunLease,
          StubDefinitionRunError
        >();
        leaseRequests.set(definition.id, deferred);

        return {
          deferred,
          owner: true,
        } as const;
      });

      if (!request.owner) {
        return yield* Deferred.await(request.deferred);
      }

      const leaseExit = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            startStubDefinitionRun(definition).pipe(
              Effect.tap((lease) =>
                Effect.sync(() => {
                  leases.set(definition.id, lease);
                })
              )
            )
          );
          yield* Deferred.done(request.deferred, exit);
          return exit;
        })
      );
      return yield* leaseExit;
    });

  const createStubReference: CreateMigrationReferenceStub = ({
    definition,
    sourceIdentity,
  }) =>
    Effect.gen(function* () {
      const key = stubReferenceKey(definition.id, sourceIdentity);
      const request = yield* Effect.sync(() => {
        const existing = stubRequests.get(key);

        if (existing !== undefined) {
          return {
            deferred: existing,
            owner: false,
          } as const;
        }

        const deferred = Deferred.makeUnsafe<
          MigrationReference,
          StubReferenceError
        >();
        stubRequests.set(key, deferred);

        return {
          deferred,
          owner: true,
        } as const;
      });

      if (!request.owner) {
        return yield* Deferred.await(request.deferred);
      }

      const referenceExit = yield* Effect.exit(
        Effect.gen(function* () {
          const lease = yield* getStubDefinitionRun(definition);
          const reference = yield* processStubSourceIdentity({
            definition,
            runId: lease.runId,
            sourceIdentity,
            store: lease.store,
          }).pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                lease.failed = true;
              })
            )
          );

          return reference;
        })
      );

      yield* Deferred.done(request.deferred, referenceExit);

      return yield* referenceExit;
    });

  const finalize = (
    primaryExit: Exit.Exit<unknown, unknown>
  ): Effect.Effect<void, MigrationStoreError> =>
    Effect.gen(function* () {
      const failures: StubRunFinalizationFailure[] = [];

      for (const lease of [...leases.values()].reverse()) {
        yield* finishStubDefinitionRun(lease, primaryExit).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              failures.push({
                definitionId: lease.definitionId,
                error,
                runId: lease.runId,
              });
            })
          )
        );
      }

      if (failures.length > 0) {
        return yield* stubRunScopeFinalizationError(failures);
      }
    });

  return {
    createStubReference,
    finalize,
  };
};

const withStubRunScope = <A, E, R = never>(
  activeRun: ActiveStubRunScope,
  body: (scope: StubRunScope) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | MigrationStoreError, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => makeStubRunScope(activeRun)),
    body,
    (scope, exit) => scope.finalize(exit)
  );

const runMigrationDefinition = <
  Source,
  PipelineError,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  SourceInput,
  SourceLayerError,
  SourceRequirements,
>(
  definition: MigrationDefinition<
    Source,
    PipelineError,
    Cursor,
    IdentityKey,
    unknown,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >,
  runId: MigrationRunId,
  mode: RunMode,
  update: boolean,
  createStubReference: CreateMigrationReferenceStub,
  processExecution?: PipelineExecutionOptions
): Effect.Effect<
  MigrationDefinitionRunSummary,
  RunMigrationError | SourceLayerError,
  SourceRequirements
> => {
  const program = Effect.gen(function* () {
    const source = yield* getSourcePlugin<
      Source,
      Cursor,
      SourceInput,
      IdentityKey
    >();
    const store = yield* MigrationStore;
    const processConcurrency = resolvePipelineExecutionOptions(
      processExecution,
      definition.execution?.process,
      "Process Pipeline Execution"
    ).concurrency;

    const counts = { ...emptyCounts };
    const itemStates = yield* store.listItemStates(definition.id);
    yield* MigrationProgress.emit({
      definitionId: definition.id,
      kind: "definition-started",
      runId,
    });
    yield* countDefinitionSourceItemTotal({
      definitionId: definition.id,
      ...(mode.kind === "item" ? { itemLimit: 1 } : {}),
      runId,
      source,
    });

    if (update) {
      yield* prepareUpdateRunDefinition({
        definitionId: definition.id,
        itemStates,
        runId,
        store,
      });

      yield* processCursorDiscovery({
        counts,
        definition,
        excludedSourceIdentities: [],
        processConcurrency,
        reprocessUnchangedTerminal: true,
        runId,
        source,
        store,
      });

      const summary = {
        definitionId: definition.id,
        status:
          counts.failed > 0 ? ("failed" as const) : ("succeeded" as const),
        counts,
      };

      yield* MigrationProgress.emit({
        counts: snapshotCounts(counts),
        definitionId: definition.id,
        kind: "definition-completed",
        runId,
        status: summary.status,
      });

      return summary;
    }

    const attemptedSourceIdentities = yield* processTargetedSourceIdentities({
      counts,
      definition,
      itemStates,
      mode,
      processConcurrency,
      runId,
      source,
      store,
    });

    if (isTargetedMode(mode)) {
      const summary = {
        definitionId: definition.id,
        status:
          counts.failed > 0 ? ("failed" as const) : ("succeeded" as const),
        counts,
      };

      yield* MigrationProgress.emit({
        counts: snapshotCounts(counts),
        definitionId: definition.id,
        kind: "definition-completed",
        runId,
        status: summary.status,
      });

      return summary;
    }

    yield* processCursorDiscovery({
      counts,
      definition,
      excludedSourceIdentities: attemptedSourceIdentities,
      processConcurrency,
      runId,
      source,
      store,
    });

    const summary = {
      definitionId: definition.id,
      status: counts.failed > 0 ? ("failed" as const) : ("succeeded" as const),
      counts,
    };

    yield* MigrationProgress.emit({
      counts: snapshotCounts(counts),
      definitionId: definition.id,
      kind: "definition-completed",
      runId,
      status: summary.status,
    });

    return summary;
  });
  const lookupLayer = makeMigrationReferenceLookupLayer({
    createStubReference,
  });
  const layer = Layer.mergeAll(
    definition.source.layer,
    definition.store,
    lookupLayer
  );

  return program.pipe(Effect.provide(layer));
};

const runMigrationDefinitionCursorWindow = <
  Source,
  PipelineError,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  SourceInput,
  SourceLayerError,
  SourceRequirements,
>(
  definition: MigrationDefinition<
    Source,
    PipelineError,
    Cursor,
    IdentityKey,
    unknown,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >,
  input: MigrationRunCursorWindowInput,
  createStubReference: CreateMigrationReferenceStub,
  processExecution?: PipelineExecutionOptions
): Effect.Effect<
  MigrationRunCursorWindowResult,
  RunMigrationError | SourceLayerError,
  SourceRequirements
> => {
  const program = Effect.gen(function* () {
    const source = yield* getSourcePlugin<
      Source,
      Cursor,
      SourceInput,
      IdentityKey
    >();
    const store = yield* MigrationStore;
    const processConcurrency = resolvePipelineExecutionOptions(
      processExecution,
      definition.execution?.process,
      "Process Pipeline Execution"
    ).concurrency;
    const counts = mutableCounts(input.state.counts);
    const storedCursor = yield* store.getSourceCursor(definition.id);
    const isFirstWindow =
      storedCursor === null &&
      input.state.excludedSourceIdentities.length === 0 &&
      isEmptyCounts(input.state.counts);
    let excludedSourceIdentities = input.state.excludedSourceIdentities;

    if (isFirstWindow) {
      const itemStates = yield* store.listItemStates(definition.id);
      yield* MigrationProgress.emit({
        definitionId: definition.id,
        kind: "definition-started",
        runId: input.runId,
      });
      yield* countDefinitionSourceItemTotal({
        definitionId: definition.id,
        runId: input.runId,
        source,
      });
      excludedSourceIdentities = yield* processTargetedSourceIdentities({
        counts,
        definition,
        itemStates,
        mode: normalRunMode,
        processConcurrency,
        runId: input.runId,
        source,
        store,
      });
    }

    const windowResult = yield* processNextCursorWindow({
      counts,
      definition,
      excludedSourceIdentities,
      processConcurrency,
      runId: input.runId,
      source,
      store,
    });
    const state = {
      counts: snapshotCounts(counts),
      excludedSourceIdentities,
    };

    if (windowResult.kind === "continue") {
      return {
        kind: "continue" as const,
        state,
      };
    }

    const summary = {
      counts: state.counts,
      definitionId: definition.id,
      status: counts.failed > 0 ? ("failed" as const) : ("succeeded" as const),
    };

    yield* MigrationProgress.emit({
      counts: state.counts,
      definitionId: definition.id,
      kind: "definition-completed",
      runId: input.runId,
      status: summary.status,
    });

    return {
      kind: "definition-completed" as const,
      state,
      summary,
    };
  });
  const lookupLayer = makeMigrationReferenceLookupLayer({
    createStubReference,
  });
  const layer = Layer.mergeAll(
    definition.source.layer,
    definition.store,
    lookupLayer
  );

  return program.pipe(Effect.provide(layer));
};

const executeMigrationRunDefinitionCursorWindow = <
  Source,
  PipelineError,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  SourceInput,
  SourceLayerError,
  SourceRequirements,
>(
  definition: MigrationDefinition<
    Source,
    PipelineError,
    Cursor,
    IdentityKey,
    unknown,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >,
  input: MigrationRunDefinitionCursorWindowInput,
  processExecution?: PipelineExecutionOptions
): Effect.Effect<
  MigrationRunCursorWindowResult,
  RunMigrationError | SourceLayerError,
  SourceRequirements
> =>
  Effect.gen(function* () {
    const store = yield* MigrationStore;

    yield* assertCurrentMigrationRunExecutionLease(
      store,
      input.lease,
      input.definitionIds
    );
    if (input.lease.runId !== input.runId) {
      return yield* lockOwnerMismatchError(input.lease);
    }

    return yield* withStubRunScope(
      {
        definitionIds: input.definitionIds,
        runId: input.runId,
        store,
      },
      (stubRunScope) =>
        runMigrationDefinitionCursorWindow(
          definition,
          input,
          stubRunScope.createStubReference,
          processExecution
        )
    );
  }).pipe(Effect.provide(definition.store));

const runRollbackMigrationDefinition = <
  Source,
  PipelineError,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  RollbackPipelineError,
  SourceInput,
  SourceLayerError,
  SourceRequirements,
>(
  definition: MigrationDefinition<
    Source,
    PipelineError,
    Cursor,
    IdentityKey,
    RollbackPipelineError,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >,
  runId: MigrationRunId,
  options: EncodedRollbackMigrationOptions
): Effect.Effect<
  RollbackDefinitionRunSummary,
  RollbackMigrationDefinitionError | RollbackPreflightError
> => {
  const program = Effect.gen(function* () {
    const store = yield* MigrationStore;
    const counts = { ...emptyRollbackCounts };
    const rollbackConcurrency = resolvePipelineExecutionOptions(
      options.execution?.rollback,
      definition.execution?.rollback,
      "Rollback Pipeline Execution"
    ).concurrency;
    yield* RollbackProgress.emit({
      definitionId: definition.id,
      kind: "definition-started",
      runId,
    });

    if (options.encodedSourceIdentities === undefined) {
      const itemStates = yield* store.listItemStates(definition.id);
      yield* Effect.forEach(
        itemStates,
        (itemState) =>
          Effect.gen(function* () {
            const outcome = yield* rollbackItemState({
              definition,
              itemState,
              runId,
              store,
            });
            yield* recordRollbackOutcome({
              counts,
              definitionId: definition.id,
              outcome,
              runId,
            });
          }),
        { concurrency: rollbackConcurrency, discard: true }
      );
    } else {
      yield* Effect.forEach(
        options.encodedSourceIdentities,
        (sourceIdentity) =>
          Effect.gen(function* () {
            const itemState = yield* store.getItemState(
              definition.id,
              sourceIdentity
            );

            if (itemState === null) {
              const outcome = "skipped" as const;
              yield* recordRollbackOutcome({
                counts,
                definitionId: definition.id,
                outcome,
                runId,
              });
              return;
            }

            const outcome = yield* rollbackItemState({
              definition,
              itemState,
              runId,
              store,
            });
            yield* recordRollbackOutcome({
              counts,
              definitionId: definition.id,
              outcome,
              runId,
            });
          }),
        { concurrency: rollbackConcurrency, discard: true }
      );
    }

    yield* store.deleteSourceCursor(definition.id);

    const status =
      counts.failed > 0 ? ("failed" as const) : ("succeeded" as const);
    yield* RollbackProgress.emit({
      counts: snapshotRollbackCounts(counts),
      definitionId: definition.id,
      kind: "definition-completed",
      runId,
      status,
    });

    return {
      counts,
      definitionId: definition.id,
      status,
    };
  });

  return program.pipe(Effect.provide(definition.store));
};

const hasSelectedItemState = (
  store: typeof MigrationStore.Service,
  definition: AnyMigrationDefinition,
  options: EncodedRollbackMigrationOptions
): Effect.Effect<boolean, MigrationStoreError> =>
  Effect.gen(function* () {
    if (options.encodedSourceIdentities !== undefined) {
      for (const sourceIdentity of options.encodedSourceIdentities) {
        const itemState = yield* store.getItemState(
          definition.id,
          sourceIdentity
        );

        if (itemState !== null) {
          return true;
        }
      }

      return false;
    }

    const itemStates = yield* store.listItemStates(definition.id);

    return itemStates.length > 0;
  });

const validateRollbackPipelinePreflight = (
  store: typeof MigrationStore.Service,
  definition: AnyMigrationDefinition,
  options: EncodedRollbackMigrationOptions
): Effect.Effect<void, MigrationStoreError | RollbackPreflightError> =>
  definition.rollback === undefined
    ? Effect.gen(function* () {
        const hasItemState = yield* hasSelectedItemState(
          store,
          definition,
          options
        );

        if (hasItemState) {
          return yield* missingRollbackPipelineError(definition.id);
        }
      })
    : Effect.void;

const definitionsByDependency = (
  definitions: readonly AnyMigrationDefinition[]
): ReadonlyMap<MigrationDefinitionId, readonly AnyMigrationDefinition[]> => {
  const dependents = new Map<MigrationDefinitionId, AnyMigrationDefinition[]>();

  for (const definition of definitions) {
    for (const dependencyId of definition.dependsOn ?? []) {
      const existing = dependents.get(dependencyId);

      if (existing === undefined) {
        dependents.set(dependencyId, [definition]);
      } else {
        existing.push(definition);
      }
    }
  }

  return dependents;
};

const validateRollbackDependencyPreflight = (
  store: typeof MigrationStore.Service,
  definitions: readonly AnyMigrationDefinition[],
  selectedDefinitions: readonly AnyMigrationDefinition[]
): Effect.Effect<void, MigrationStoreError | RollbackPreflightError> =>
  Effect.gen(function* () {
    const firstSelectedDefinition = selectedDefinitions[0];

    if (firstSelectedDefinition === undefined) {
      return;
    }

    const selectedDefinitionIds = new Set(
      selectedDefinitions.map((definition) => definition.id)
    );
    const dependentsByDependency = definitionsByDependency(definitions);

    for (const selectedDefinition of selectedDefinitions) {
      const visitedDefinitionIds = new Set<MigrationDefinitionId>();
      const activeDefinitionIds = new Set<MigrationDefinitionId>();

      const visitDependent = (
        dependentDefinition: AnyMigrationDefinition
      ): Effect.Effect<void, MigrationStoreError | RollbackPreflightError> =>
        Effect.gen(function* () {
          if (visitedDefinitionIds.has(dependentDefinition.id)) {
            return;
          }

          if (activeDefinitionIds.has(dependentDefinition.id)) {
            return yield* rollbackDependencyCycleError(dependentDefinition.id);
          }

          activeDefinitionIds.add(dependentDefinition.id);

          if (dependentDefinition.store !== firstSelectedDefinition.store) {
            return yield* rollbackDependencyStoreError(
              selectedDefinition.id,
              dependentDefinition.id
            );
          }

          if (!selectedDefinitionIds.has(dependentDefinition.id)) {
            const hasDependentItemState = yield* hasSelectedItemState(
              store,
              dependentDefinition,
              {}
            );

            if (hasDependentItemState) {
              return yield* unsafeDependentRollbackError(
                selectedDefinition.id,
                dependentDefinition.id
              );
            }
          }

          for (const transitiveDependent of dependentsByDependency.get(
            dependentDefinition.id
          ) ?? []) {
            yield* visitDependent(transitiveDependent);
          }

          activeDefinitionIds.delete(dependentDefinition.id);
          visitedDefinitionIds.add(dependentDefinition.id);
        });

      for (const dependentDefinition of dependentsByDependency.get(
        selectedDefinition.id
      ) ?? []) {
        yield* visitDependent(dependentDefinition);
      }
    }
  });

export function rollbackMigration<
  Source,
  PipelineError,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  RollbackPipelineError = PipelineError,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
>(
  definition: MigrationDefinition<
    Source,
    PipelineError,
    Cursor,
    IdentityKey,
    RollbackPipelineError,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >,
  optionsInput?: undefined
): Effect.Effect<
  RollbackRunSummary,
  RollbackMigrationDefinitionError | RollbackPreflightError
>;
export function rollbackMigration<
  Source,
  PipelineError,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  RollbackPipelineError = PipelineError,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
>(
  definition: MigrationDefinition<
    Source,
    PipelineError,
    Cursor,
    IdentityKey,
    RollbackPipelineError,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >,
  optionsInput: RollbackMigrationOptionsInput<IdentityKey> | undefined
): Effect.Effect<RollbackRunSummary, RollbackMigrationError>;
export function rollbackMigration<
  Source,
  PipelineError,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  RollbackPipelineError = PipelineError,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
>(
  definition: MigrationDefinition<
    Source,
    PipelineError,
    Cursor,
    IdentityKey,
    RollbackPipelineError,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >,
  optionsInput: RollbackMigrationOptionsInput<IdentityKey> = {}
): Effect.Effect<RollbackRunSummary, RollbackMigrationError> {
  const optionsEffect = Effect.try({
    try: () => makeRollbackMigrationOptions(optionsInput),
    catch: invalidRollbackRequestError,
  }).pipe(
    Effect.flatMap((options) =>
      encodeRollbackMigrationOptions(definition, options)
    )
  );

  return Effect.flatMap(optionsEffect, (options) => {
    const program = Effect.gen(function* () {
      const store = yield* MigrationStore;
      const definitionIds = [definition.id];
      const progressDefinitionIds = [definition.id];
      const run = yield* executeMigrationRun(
        store,
        definitionIds,
        (runId) =>
          Effect.gen(function* () {
            yield* RollbackProgress.emit({
              definitionIds: progressDefinitionIds,
              kind: "rollback-started",
              runId,
            });
            const summary = yield* runRollbackMigrationDefinition(
              definition,
              runId,
              options
            );

            return {
              status:
                summary.status === "failed"
                  ? ("failed" as const)
                  : ("succeeded" as const),
              value: [summary],
            };
          }).pipe(
            Effect.catch((error) =>
              RollbackProgress.emit({
                definitionIds: progressDefinitionIds,
                error,
                kind: "rollback-failed",
                runId,
              }).pipe(Effect.andThen(Effect.fail(error)))
            )
          ),
        () => validateRollbackPipelinePreflight(store, definition, options)
      );
      yield* RollbackProgress.emit({
        definitionIds: progressDefinitionIds,
        kind: "rollback-completed",
        runId: run.runState.runId,
        status: rollbackStatusForDefinitions(run.value),
      });

      return {
        kind: "rollback" as const,
        definitions: run.value,
        finishedAt: run.completedRun.finishedAt ?? new Date(),
        runId: run.runState.runId,
        startedAt: run.runState.startedAt,
        status: rollbackStatusForDefinitions(run.value),
      };
    });

    return program.pipe(Effect.provide(definition.store));
  });
}

const rollbackMigrationsWithRequest = <
  Definitions extends readonly AnyRollbackMigrationDefinition[],
>(
  request: EncodedRollbackRequest<Definitions>,
  executionOptions: MigrationRuntimeExecutionOptions = {}
): Effect.Effect<RollbackRunSummary, RollbackMigrationError> => {
  const orderedDefinitions = orderDefinitions(
    request.definitions,
    request.definitionIds
  );

  if (orderedDefinitions.kind === "failed") {
    return Effect.fail(
      new RollbackPreflightError({
        message: orderedDefinitions.error.message,
        cause: orderedDefinitions.error.cause,
      })
    );
  }

  const firstOrderedDefinition = orderedDefinitions.definitions[0];

  if (firstOrderedDefinition === undefined) {
    return Effect.fail(
      new RollbackRequestError({
        message:
          "Rollback request must include at least one Migration Definition",
      })
    );
  }

  const options: EncodedRollbackMigrationOptions =
    request.encodedSourceIdentities === undefined
      ? {
          ...(request.execution === undefined
            ? {}
            : { execution: request.execution }),
        }
      : {
          ...(request.execution === undefined
            ? {}
            : { execution: request.execution }),
          encodedSourceIdentities: request.encodedSourceIdentities,
        };

  if (
    options.encodedSourceIdentities !== undefined &&
    orderedDefinitions.definitions.length !== 1
  ) {
    return Effect.fail(
      new RollbackRequestError({
        message:
          "Rollback encodedSourceIdentities require exactly one selected Migration Definition",
      })
    );
  }

  const sharedStoreError = validateSharedStore(orderedDefinitions.definitions);

  if (sharedStoreError !== null) {
    return Effect.fail(
      new RollbackPreflightError({
        message: sharedStoreError.message,
        cause: sharedStoreError.cause,
      })
    );
  }

  const definitionIds = orderedDefinitions.definitions.map(
    (definition) => definition.id
  );
  const rollbackDefinitions = [...orderedDefinitions.definitions].reverse();
  const progressDefinitionIds = rollbackDefinitions.map(
    (definition) => definition.id
  );

  const program = Effect.gen(function* () {
    const store = yield* MigrationStore;
    const runRollbackBody = (runId: MigrationRunId) =>
      Effect.gen(function* () {
        yield* RollbackProgress.emit({
          definitionIds: progressDefinitionIds,
          kind: "rollback-started",
          runId,
        });
        const summaries: RollbackDefinitionRunSummary[] = [];

        for (const definition of rollbackDefinitions) {
          const summary = yield* runRollbackMigrationDefinition(
            definition,
            runId,
            options
          );
          summaries.push(summary);
        }

        return {
          status: rollbackStatusForDefinitions(summaries),
          value: summaries,
        };
      }).pipe(
        Effect.catch((error) =>
          RollbackProgress.emit({
            definitionIds: progressDefinitionIds,
            error,
            kind: "rollback-failed",
            runId,
          }).pipe(Effect.andThen(Effect.fail(error)))
        )
      );

    const run = yield* executeMigrationRun(
      store,
      definitionIds,
      runRollbackBody,
      () =>
        validateRollbackDependencyPreflight(
          store,
          request.definitions,
          orderedDefinitions.definitions
        ).pipe(
          Effect.andThen(
            Effect.forEach(
              rollbackDefinitions,
              (definition) =>
                validateRollbackPipelinePreflight(store, definition, options),
              { discard: true }
            )
          )
        ),
      executionOptions
    );
    yield* RollbackProgress.emit({
      definitionIds: progressDefinitionIds,
      kind: "rollback-completed",
      runId: run.runState.runId,
      status: rollbackStatusForDefinitions(run.value),
    });

    return {
      kind: "rollback" as const,
      definitions: run.value,
      finishedAt: run.completedRun.finishedAt ?? new Date(),
      runId: run.runState.runId,
      startedAt: run.runState.startedAt,
      status: rollbackStatusForDefinitions(run.value),
    };
  });

  return program.pipe(Effect.provide(firstOrderedDefinition.store));
};

export const rollbackMigrationsWithEncodedSourceIdentities = <
  Definitions extends readonly AnyRollbackMigrationDefinition[],
>(
  input: EncodedRollbackRequestInput<Definitions>,
  executionOptions: MigrationRuntimeExecutionOptions = {}
): Effect.Effect<RollbackRunSummary, RollbackMigrationError> => {
  const requestEffect = Effect.try({
    try: () => makeEncodedRollbackRequest(input),
    catch: invalidRollbackRequestError,
  });

  return Effect.flatMap(requestEffect, (request) =>
    rollbackMigrationsWithRequest(request, executionOptions)
  );
};

export const rollbackMigrations = <
  Definitions extends readonly AnyRollbackMigrationDefinition[],
>(
  input: RollbackRequestInput<Definitions>
): Effect.Effect<RollbackRunSummary, RollbackMigrationError> => {
  const requestEffect = Effect.try({
    try: () => makeRollbackRequest(input),
    catch: invalidRollbackRequestError,
  });

  return Effect.flatMap(requestEffect, (request) => {
    const orderedDefinitions = orderDefinitions(
      request.definitions,
      request.definitionIds
    );

    if (orderedDefinitions.kind === "failed") {
      return Effect.fail(
        new RollbackPreflightError({
          message: orderedDefinitions.error.message,
          cause: orderedDefinitions.error.cause,
        })
      );
    }

    const firstOrderedDefinition = orderedDefinitions.definitions[0];

    if (firstOrderedDefinition === undefined) {
      return Effect.fail(
        new RollbackRequestError({
          message:
            "Rollback request must include at least one Migration Definition",
        })
      );
    }

    const publicOptions: RollbackMigrationOptions =
      request.sourceIdentityKeys === undefined
        ? {
            ...(request.execution === undefined
              ? {}
              : { execution: request.execution }),
          }
        : {
            ...(request.execution === undefined
              ? {}
              : { execution: request.execution }),
            sourceIdentityKeys: request.sourceIdentityKeys,
          };

    if (
      publicOptions.sourceIdentityKeys !== undefined &&
      orderedDefinitions.definitions.length !== 1
    ) {
      return Effect.fail(rollbackSourceIdentityKeyDefinitionCountError);
    }

    return Effect.flatMap(
      encodeRollbackMigrationOptions(firstOrderedDefinition, publicOptions),
      (options) =>
        rollbackMigrationsWithRequest({
          definitions: request.definitions,
          ...(request.definitionIds === undefined
            ? {}
            : { definitionIds: request.definitionIds }),
          ...(request.execution === undefined
            ? {}
            : { execution: request.execution }),
          ...(options.encodedSourceIdentities === undefined
            ? {}
            : { encodedSourceIdentities: options.encodedSourceIdentities }),
        })
    );
  });
};

const runMigrationsWithRequest = <
  Definitions extends readonly AnyMigrationDefinition[],
>(
  request: EncodedRunRequest<Definitions>,
  executionOptions: MigrationRuntimeExecutionOptions = {}
): Effect.Effect<
  MigrationRunSummary,
  RunMigrationError | RunRequestSourceLayerError<Definitions>,
  RunRequestSourceRequirements<Definitions>
> => {
  const firstDefinition = request.definitions[0];

  if (firstDefinition === undefined) {
    return Effect.fail(emptyRunError);
  }

  const updateRunRequestError = validateUpdateRunRequest(request);

  if (updateRunRequestError !== null) {
    return Effect.fail(updateRunRequestError);
  }

  const orderedDefinitions = orderDefinitions(
    request.definitions,
    request.definitionIds
  );

  if (orderedDefinitions.kind === "failed") {
    return Effect.fail(orderedDefinitions.error);
  }

  const firstOrderedDefinition = orderedDefinitions.definitions[0];

  if (firstOrderedDefinition === undefined) {
    return Effect.fail(emptyRunError);
  }

  const sharedStoreError = validateSharedStore(orderedDefinitions.definitions);

  if (sharedStoreError !== null) {
    return Effect.fail(sharedStoreError);
  }

  const definitionIds = orderedDefinitions.definitions.map(
    (definition) => definition.id
  );

  const program = Effect.gen(function* () {
    const store = yield* MigrationStore;

    const run = yield* executeMigrationRun(
      store,
      definitionIds,
      (runId) =>
        withStubRunScope(
          {
            definitionIds,
            runId,
            store,
          },
          (stubRunScope) =>
            Effect.gen(function* () {
              const summaries: MigrationDefinitionRunSummary[] = [];

              for (const definition of orderedDefinitions.definitions) {
                const summary = yield* runMigrationDefinition(
                  definition,
                  runId,
                  request.mode ?? normalRunMode,
                  request.update === true,
                  stubRunScope.createStubReference,
                  request.execution?.process
                );
                summaries.push(summary);
              }

              return {
                status: runStatusForDefinitions(summaries),
                value: summaries,
              };
            })
        ),
      () => validateMigrationContracts(store, orderedDefinitions.definitions),
      executionOptions
    );

    return {
      runId: run.runState.runId,
      status: run.status,
      startedAt: run.runState.startedAt,
      finishedAt: run.completedRun.finishedAt ?? new Date(),
      definitions: run.value,
    };
  });

  return program.pipe(Effect.provide(firstOrderedDefinition.store));
};

export const runMigrationsWithEncodedRunMode = <
  Definitions extends readonly AnyMigrationDefinition[],
>(
  input: EncodedRunRequestInput<Definitions>,
  executionOptions: MigrationRuntimeExecutionOptions = {}
): Effect.Effect<
  MigrationRunSummary,
  RunMigrationError | RunRequestSourceLayerError<Definitions>,
  RunRequestSourceRequirements<Definitions>
> => {
  const requestEffect = Effect.try({
    try: () => makeEncodedRunRequest(input),
    catch: invalidRunRequestError,
  });

  return Effect.flatMap(requestEffect, (request) =>
    runMigrationsWithRequest(request, executionOptions)
  );
};

export const runMigrations = <
  Definitions extends readonly AnyMigrationDefinition[],
>(
  input: RunRequestInput<Definitions>
): Effect.Effect<
  MigrationRunSummary,
  RunMigrationError | RunRequestSourceLayerError<Definitions>,
  RunRequestSourceRequirements<Definitions>
> => {
  const requestEffect = Effect.try({
    try: () => makeRunRequest(input),
    catch: invalidRunRequestError,
  });

  return Effect.flatMap(requestEffect, (request) => {
    const orderedDefinitions = orderDefinitions(
      request.definitions,
      request.definitionIds
    );

    if (orderedDefinitions.kind === "failed") {
      return Effect.fail(orderedDefinitions.error);
    }

    return Effect.flatMap(
      normalizeRunMode(orderedDefinitions.definitions, request.mode),
      (mode) =>
        runMigrationsWithRequest({
          definitions: request.definitions,
          ...(request.definitionIds === undefined
            ? {}
            : { definitionIds: request.definitionIds }),
          ...(request.execution === undefined
            ? {}
            : { execution: request.execution }),
          mode,
          ...(request.update === undefined ? {} : { update: request.update }),
        })
    );
  });
};

export const runMigration = <
  Source,
  PipelineError,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
>(
  definition: MigrationDefinition<
    Source,
    PipelineError,
    Cursor,
    IdentityKey,
    unknown,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >,
  options: { readonly execution?: MigrationExecutionOptions } = {}
): Effect.Effect<
  MigrationRunSummary,
  RunMigrationError | SourceLayerError,
  SourceRequirements
> => {
  const runWithExecution = (
    execution: NormalizedMigrationExecutionOptions | undefined
  ) => {
    const program = Effect.gen(function* () {
      const store = yield* MigrationStore;
      const definitionIds = [definition.id];

      const run = yield* executeMigrationRun(
        store,
        definitionIds,
        (runId) => {
          const activeRun = {
            definitionIds,
            runId,
            store,
          };

          return withStubRunScope(activeRun, (stubRunScope) =>
            runMigrationDefinition(
              definition,
              runId,
              normalRunMode,
              false,
              stubRunScope.createStubReference,
              execution?.process
            ).pipe(
              Effect.map((summary) => ({
                status:
                  summary.status === "failed"
                    ? ("failed" as const)
                    : ("succeeded" as const),
                value: [summary],
              }))
            )
          );
        },
        () => validateMigrationContract(store, definition)
      );

      return {
        runId: run.runState.runId,
        status: run.status,
        startedAt: run.runState.startedAt,
        finishedAt: run.completedRun.finishedAt ?? new Date(),
        definitions: run.value,
      };
    });

    return program.pipe(Effect.provide(definition.store));
  };

  if (options.execution === undefined) {
    return runWithExecution(undefined);
  }

  return Effect.flatMap(
    Effect.try({
      try: () => normalizeMigrationExecutionOptions(options.execution),
      catch: invalidRunRequestError,
    }),
    runWithExecution
  );
};

export const executeMigrationRunPlanInline = <
  Definitions extends readonly AnyMigrationDefinition[],
>(
  plan: MigrationDefinitionExecutableRunPlan<Definitions>,
  options: MigrationRuntimeExecutionOptions = {}
): Effect.Effect<
  MigrationRunSummary,
  RunMigrationError | RunRequestSourceLayerError<Definitions>,
  RunRequestSourceRequirements<Definitions>
> =>
  runMigrationsWithEncodedRunMode<Definitions>(
    plan.target === undefined
      ? {
          definitions: plan.definitions,
          ...(plan.execution === undefined
            ? {}
            : { execution: plan.execution }),
          ...(plan.mode === undefined ? {} : { mode: plan.mode }),
          ...(plan.update === undefined ? {} : { update: plan.update }),
        }
      : {
          definitions: plan.definitions,
          ...(plan.execution === undefined
            ? {}
            : { execution: plan.execution }),
          mode: {
            kind: "item" as const,
            encodedSourceIdentity: plan.target.sourceIdentities[0],
          },
        },
    options
  );

export const startMigrationRunPlanInline = <
  Definitions extends readonly AnyMigrationDefinition[],
>(
  plan: MigrationDefinitionExecutableRunPlan<Definitions>
): Effect.Effect<
  ExecutionStartResult<MigrationRunSummary>,
  RunMigrationError | RunRequestSourceLayerError<Definitions>,
  RunRequestSourceRequirements<Definitions>
> =>
  executeMigrationRunPlanInline(plan).pipe(
    Effect.map((summary) => ({
      kind: "completed" as const,
      runId: summary.runId,
      summary,
    }))
  );

export const executeMigrationRollbackPlanInline = (
  plan: MigrationDefinitionExecutableRollbackPlan,
  options: MigrationRuntimeExecutionOptions = {}
): Effect.Effect<RollbackRunSummary, RollbackMigrationError> =>
  rollbackMigrationsWithEncodedSourceIdentities(
    {
      definitions: plan.registryDefinitions,
      definitionIds: [...plan.executionDefinitionIds].reverse(),
      ...(plan.execution === undefined ? {} : { execution: plan.execution }),
      ...(plan.target === undefined
        ? {}
        : { encodedSourceIdentities: plan.target.sourceIdentities }),
    },
    options
  );

export const startMigrationRollbackPlanInline = (
  plan: MigrationDefinitionExecutableRollbackPlan
): Effect.Effect<
  ExecutionStartResult<RollbackRunSummary>,
  RollbackMigrationError
> =>
  executeMigrationRollbackPlanInline(plan).pipe(
    Effect.map((summary) => ({
      kind: "completed" as const,
      runId: summary.runId,
      summary,
    }))
  );

export interface MigrationRunExecutorService {
  readonly begin: (
    input: MigrationRunBeginInput
  ) => Effect.Effect<MigrationRunState, RunMigrationError>;

  readonly complete: (
    input: MigrationRunCompletionInput
  ) => Effect.Effect<MigrationRunSummary, RunMigrationError>;

  readonly executeCursorWindow: <
    Source,
    PipelineError,
    Cursor,
    IdentityKey extends SourceIdentitySnapshotKey,
    SourceInput,
    SourceLayerError,
    SourceRequirements,
  >(
    definition: MigrationDefinition<
      Source,
      PipelineError,
      Cursor,
      IdentityKey,
      unknown,
      SourceInput,
      SourceLayerError,
      SourceRequirements
    >,
    input: MigrationRunDefinitionCursorWindowInput,
    processExecution?: PipelineExecutionOptions
  ) => Effect.Effect<
    MigrationRunCursorWindowResult,
    RunMigrationError | SourceLayerError,
    SourceRequirements
  >;

  readonly executePlan: <Definitions extends readonly AnyMigrationDefinition[]>(
    plan: MigrationDefinitionExecutableRunPlan<Definitions>,
    options?: MigrationRuntimeExecutionOptions
  ) => Effect.Effect<
    MigrationRunSummary,
    RunMigrationError | RunRequestSourceLayerError<Definitions>,
    RunRequestSourceRequirements<Definitions>
  >;

  readonly fail: (
    input: MigrationRunFailureInput
  ) => Effect.Effect<void, RunMigrationError>;

  readonly startPlan: <Definitions extends readonly AnyMigrationDefinition[]>(
    plan: MigrationDefinitionExecutableRunPlan<Definitions>
  ) => Effect.Effect<
    ExecutionStartResult<MigrationRunSummary>,
    RunMigrationError | RunRequestSourceLayerError<Definitions>,
    RunRequestSourceRequirements<Definitions>
  >;
}

const migrationRunExecutor: MigrationRunExecutorService = {
  begin: Effect.fn("MigrationRunExecutor.begin")((input) =>
    beginMigrationRunExecution(input)
  ),
  complete: Effect.fn("MigrationRunExecutor.complete")((input) =>
    completeMigrationRunExecution(input)
  ),
  executeCursorWindow: Effect.fn("MigrationRunExecutor.executeCursorWindow")(
    (definition, input, processExecution) =>
      executeMigrationRunDefinitionCursorWindow(
        definition,
        input,
        processExecution
      )
  ),
  executePlan: Effect.fn("MigrationRunExecutor.executePlan")((plan, options) =>
    executeMigrationRunPlanInline(plan, options)
  ),
  fail: Effect.fn("MigrationRunExecutor.fail")((input) =>
    failMigrationRunExecution(input)
  ),
  startPlan: Effect.fn("MigrationRunExecutor.startPlan")((plan) =>
    startMigrationRunPlanInline(plan)
  ),
};

export class MigrationRunExecutor extends Service<
  MigrationRunExecutor,
  MigrationRunExecutorService
>()("@migrate-sdk/MigrationRunExecutor") {
  static readonly begin = (input: MigrationRunBeginInput) =>
    Effect.flatMap(MigrationRunExecutor, (executor) => executor.begin(input));

  static readonly complete = (input: MigrationRunCompletionInput) =>
    Effect.flatMap(MigrationRunExecutor, (executor) =>
      executor.complete(input)
    );

  static readonly executeCursorWindow = <
    Source,
    PipelineError,
    Cursor,
    IdentityKey extends SourceIdentitySnapshotKey,
    SourceInput,
    SourceLayerError,
    SourceRequirements,
  >(
    definition: MigrationDefinition<
      Source,
      PipelineError,
      Cursor,
      IdentityKey,
      unknown,
      SourceInput,
      SourceLayerError,
      SourceRequirements
    >,
    input: MigrationRunDefinitionCursorWindowInput,
    processExecution?: PipelineExecutionOptions
  ) =>
    Effect.flatMap(MigrationRunExecutor, (executor) =>
      executor.executeCursorWindow(definition, input, processExecution)
    );

  static readonly executePlan = <
    Definitions extends readonly AnyMigrationDefinition[],
  >(
    plan: MigrationDefinitionExecutableRunPlan<Definitions>,
    options?: MigrationRuntimeExecutionOptions
  ) =>
    Effect.flatMap(MigrationRunExecutor, (executor) =>
      executor.executePlan(plan, options)
    );

  static readonly fail = (input: MigrationRunFailureInput) =>
    Effect.flatMap(MigrationRunExecutor, (executor) => executor.fail(input));

  static readonly startPlan = <
    Definitions extends readonly AnyMigrationDefinition[],
  >(
    plan: MigrationDefinitionExecutableRunPlan<Definitions>
  ) =>
    Effect.flatMap(MigrationRunExecutor, (executor) =>
      executor.startPlan(plan)
    );

  static readonly layer = Layer.succeed(
    MigrationRunExecutor,
    migrationRunExecutor
  );
}

export interface MigrationRollbackExecutorService {
  readonly executePlan: (
    plan: MigrationDefinitionExecutableRollbackPlan,
    options?: MigrationRuntimeExecutionOptions
  ) => Effect.Effect<RollbackRunSummary, RollbackMigrationError>;

  readonly startPlan: (
    plan: MigrationDefinitionExecutableRollbackPlan
  ) => Effect.Effect<
    ExecutionStartResult<RollbackRunSummary>,
    RollbackMigrationError
  >;
}

const migrationRollbackExecutor: MigrationRollbackExecutorService = {
  executePlan: Effect.fn("MigrationRollbackExecutor.executePlan")(
    (plan, options) => executeMigrationRollbackPlanInline(plan, options)
  ),
  startPlan: Effect.fn("MigrationRollbackExecutor.startPlan")((plan) =>
    startMigrationRollbackPlanInline(plan)
  ),
};

export class MigrationRollbackExecutor extends Service<
  MigrationRollbackExecutor,
  MigrationRollbackExecutorService
>()("@migrate-sdk/MigrationRollbackExecutor") {
  static readonly executePlan = (
    plan: MigrationDefinitionExecutableRollbackPlan,
    options?: MigrationRuntimeExecutionOptions
  ) =>
    Effect.flatMap(MigrationRollbackExecutor, (executor) =>
      executor.executePlan(plan, options)
    );

  static readonly startPlan = (
    plan: MigrationDefinitionExecutableRollbackPlan
  ) =>
    Effect.flatMap(MigrationRollbackExecutor, (executor) =>
      executor.startPlan(plan)
    );

  static readonly layer = Layer.succeed(
    MigrationRollbackExecutor,
    migrationRollbackExecutor
  );
}
