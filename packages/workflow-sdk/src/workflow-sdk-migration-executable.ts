import { Effect, Exit, Filter, Layer, Schema, Stream } from "effect";
import {
  type ExecutionStartResult,
  type MigrationDefinitionExecutableRollbackPlan,
  type MigrationDefinitionExecutableRunPlan,
  type MigrationDefinitionId,
  type MigrationDefinitionLock,
  MigrationExecutable,
  type MigrationExecutableObservationOptions,
  type MigrationExecutableObservationResult,
  type MigrationProgressCounts,
  type MigrationRunId,
  MigrationRunId as MigrationRunIdSchema,
  type MigrationRunSummary,
  MigrationRuntimeError,
  MigrationStore,
  MigrationStoreError,
  type RollbackPreflightError,
  type RollbackRunSummary,
  toMigrationDefinitionId,
  toMigrationRunId,
} from "migrate-sdk";
import {
  type MigrationExecutionEnvelopeMissingRegistryIdError,
  makeMigrationRollbackExecutionEnvelope,
  makeMigrationRunExecutionEnvelope,
  validateMigrationRunDependencyPreflight,
  validateMigrationRunRollbackOrphansDependencyPreflight,
} from "migrate-sdk/core";
import type {
  WorkflowSdkMigrationExecutionEnvelope,
  WorkflowSdkMigrationRollbackEnvelope,
  WorkflowSdkMigrationRunEnvelope,
} from "./migration-envelope.ts";
import {
  WorkflowSdkMigrationProgressCheckpoint,
  workflowSdkMigrationProgressStreamNamespace,
} from "./migration-progress.ts";
import {
  WorkflowSdkClient,
  type WorkflowSdkClientError,
  type WorkflowSdkClientService,
  type WorkflowSdkMigrationWorkflow,
  type WorkflowSdkRun,
  type WorkflowSdkStartOptions,
  type WorkflowSdkWorkflowMetadata,
} from "./workflow-sdk-client.ts";

export interface WorkflowSdkMigrationExecutableLayerOptions {
  readonly adapterName?: string;
  readonly startOptions?:
    | WorkflowSdkStartOptions
    | ((
        envelope: WorkflowSdkMigrationExecutionEnvelope
      ) => WorkflowSdkStartOptions | undefined);
  readonly workflow: WorkflowSdkMigrationWorkflow | WorkflowSdkWorkflowMetadata;
}

const WorkflowSdkExecutionHandle = Schema.Struct({
  adapter: Schema.String,
  executionId: Schema.String,
});

export class WorkflowSdkMigrationExecutableStartError extends Schema.TaggedError<WorkflowSdkMigrationExecutableStartError>()(
  "WorkflowSdkMigrationExecutableStartError",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    runId: MigrationRunIdSchema,
  }
) {}

export class WorkflowSdkMigrationExecutableAttachError extends Schema.TaggedError<WorkflowSdkMigrationExecutableAttachError>()(
  "WorkflowSdkMigrationExecutableAttachError",
  {
    cause: Schema.Defect(),
    execution: WorkflowSdkExecutionHandle,
    message: Schema.String,
    runId: MigrationRunIdSchema,
  }
) {}

export class WorkflowSdkMigrationExecutableObservationError extends Schema.TaggedError<WorkflowSdkMigrationExecutableObservationError>()(
  "WorkflowSdkMigrationExecutableObservationError",
  {
    cause: Schema.Defect(),
    execution: WorkflowSdkExecutionHandle,
    message: Schema.String,
  }
) {}

const toMigrationProgressCounts = (
  counts: WorkflowSdkMigrationProgressCheckpoint["counts"]
): MigrationProgressCounts => ({
  failed: counts.failed,
  migrated: counts.migrated,
  needsUpdate: counts.needsUpdate,
  ...(counts.orphaned === undefined ? {} : { orphaned: counts.orphaned }),
  ...(counts.rollbackFailed === undefined
    ? {}
    : { rollbackFailed: counts.rollbackFailed }),
  ...(counts.rolledBack === undefined ? {} : { rolledBack: counts.rolledBack }),
  skipped: counts.skipped,
  unchanged: counts.unchanged,
});

const observeWorkflowProgress = (
  run: WorkflowSdkRun,
  options: MigrationExecutableObservationOptions,
  observationError: (
    cause: unknown
  ) => WorkflowSdkMigrationExecutableObservationError
) =>
  Effect.tryPromise({
    try: async () => {
      const probe = run.getReadable({
        namespace: workflowSdkMigrationProgressStreamNamespace,
      });
      const tailIndex = await probe.getTailIndex();

      return tailIndex < 0
        ? run.getReadable<unknown>({
            namespace: workflowSdkMigrationProgressStreamNamespace,
          })
        : run.getReadable<unknown>({
            namespace: workflowSdkMigrationProgressStreamNamespace,
            startIndex: tailIndex,
          });
    },
    catch: observationError,
  }).pipe(
    Effect.flatMap((readable) =>
      Stream.fromReadableStream({
        evaluate: () => readable,
        onError: observationError,
      }).pipe(
        Stream.filterMap(
          Filter.fromPredicateOption(
            Schema.decodeUnknownOption(WorkflowSdkMigrationProgressCheckpoint)
          )
        ),
        Stream.runForEach(
          (checkpoint) =>
            options.onProgressCheckpoint?.({
              counts: toMigrationProgressCounts(checkpoint.counts),
              definitionId: toMigrationDefinitionId(checkpoint.definitionId),
              kind: checkpoint.kind,
              runId: toMigrationRunId(checkpoint.runId),
            }) ?? Effect.void
        )
      )
    )
  );

const observeWorkflowTerminal = (
  run: WorkflowSdkRun,
  observationError: (
    cause: unknown
  ) => WorkflowSdkMigrationExecutableObservationError
): Effect.Effect<
  MigrationExecutableObservationResult,
  WorkflowSdkMigrationExecutableObservationError
> => {
  const readStatus = Effect.tryPromise({
    try: () => run.status,
    catch: observationError,
  });
  const readTerminalReturnValue = Effect.tryPromise({
    try: () => run.returnValue,
    catch: observationError,
  });

  return Effect.gen(function* () {
    let status = yield* readStatus;

    while (status === "pending" || status === "running") {
      yield* Effect.sleep("1 second");
      status = yield* readStatus;
    }

    if (status === "cancelled") {
      return { kind: "cancelled" as const };
    }

    if (status === "failed") {
      return yield* readTerminalReturnValue.pipe(
        Effect.match({
          onFailure: (error) => ({
            cause: error.cause,
            kind: "failed" as const,
          }),
          onSuccess: () => ({ kind: "succeeded" as const }),
        })
      );
    }

    yield* readTerminalReturnValue;
    return { kind: "succeeded" as const };
  });
};

type WorkflowSdkMigrationExecutableError =
  | WorkflowSdkMigrationExecutableStartError
  | WorkflowSdkMigrationExecutableAttachError
  | MigrationExecutionEnvelopeMissingRegistryIdError
  | MigrationRuntimeError
  | MigrationStoreError
  | RollbackPreflightError;

const emptyPlanError = new MigrationRuntimeError({
  message:
    "Workflow SDK executable plan must include at least one Migration Definition",
});

const splitStorePlanError = (
  definitionId: MigrationDefinitionId,
  storeOwnerDefinitionId: MigrationDefinitionId
) =>
  new MigrationRuntimeError({
    message:
      "Workflow SDK executable plan requires one Migration Store for all included Migration Definitions",
    cause: { definitionId, storeOwnerDefinitionId },
  });

interface DefinitionWithStore {
  readonly id: MigrationDefinitionId;
  readonly store: Layer.Layer<MigrationStore, MigrationStoreError>;
}

const validateSharedStore = (
  definitions: readonly DefinitionWithStore[]
): Effect.Effect<
  Layer.Layer<MigrationStore, MigrationStoreError>,
  MigrationRuntimeError
> =>
  Effect.gen(function* () {
    const firstDefinition = definitions[0];

    if (firstDefinition === undefined) {
      return yield* emptyPlanError;
    }

    for (const definition of definitions) {
      if (definition.store !== firstDefinition.store) {
        return yield* splitStorePlanError(definition.id, firstDefinition.id);
      }
    }

    return firstDefinition.store;
  });

const releaseLocks = (
  store: typeof MigrationStore.Service,
  locks: readonly MigrationDefinitionLock[],
  primaryCause?: unknown
) =>
  Effect.gen(function* () {
    const failures: {
      readonly error: MigrationStoreError;
      readonly lock: MigrationDefinitionLock;
    }[] = [];

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
      return yield* new MigrationStoreError({
        message: "Unable to release Migration Definition Lock set",
        cause: {
          releaseFailures: failures.map(({ error, lock }) => ({
            definitionId: lock.definitionId,
            error,
            ownerRunId: lock.ownerRunId,
            token: lock.token,
          })),
          ...(primaryCause === undefined ? {} : { primaryCause }),
        },
      });
    }
  });

const acquireLocks = (
  store: typeof MigrationStore.Service,
  runId: MigrationRunId,
  definitionIds: readonly MigrationDefinitionId[]
) =>
  Effect.gen(function* () {
    const locks: MigrationDefinitionLock[] = [];

    for (const definitionId of definitionIds) {
      const lock = yield* store
        .acquireDefinitionLock(definitionId, runId)
        .pipe(
          Effect.catch((error) =>
            releaseLocks(store, locks, error).pipe(
              Effect.andThen(Effect.fail(error))
            )
          )
        );
      locks.push(lock);
    }

    return locks;
  });

const markStartFailedAndReleaseLocks = (
  store: typeof MigrationStore.Service,
  runId: MigrationRunId,
  definitionIds: readonly MigrationDefinitionId[],
  locks: readonly MigrationDefinitionLock[],
  primaryCause?: unknown
) =>
  Effect.gen(function* () {
    const markFailedExit = yield* Effect.exit(
      store.markRunStartFailed(runId, definitionIds)
    );

    yield* releaseLocks(store, locks, {
      ...(primaryCause === undefined ? {} : { primaryCause }),
      ...(Exit.isFailure(markFailedExit)
        ? { markStartFailedCause: markFailedExit.cause }
        : {}),
    });

    if (Exit.isFailure(markFailedExit)) {
      yield* markFailedExit;
    }
  });

const makeStartError = (
  runId: MigrationRunId,
  cause: unknown
): WorkflowSdkMigrationExecutableStartError =>
  new WorkflowSdkMigrationExecutableStartError({
    cause,
    runId,
    message: "Workflow SDK rejected migration execution start",
  });

const makeAttachError = (
  runId: MigrationRunId,
  execution: typeof WorkflowSdkExecutionHandle.Type,
  cause: unknown
): WorkflowSdkMigrationExecutableAttachError =>
  new WorkflowSdkMigrationExecutableAttachError({
    cause,
    runId,
    execution,
    message: "Workflow SDK execution identity attachment failed",
  });

const makeStartOptions = (
  envelope: WorkflowSdkMigrationExecutionEnvelope,
  input: WorkflowSdkMigrationExecutableLayerOptions
): WorkflowSdkStartOptions | undefined =>
  typeof input.startOptions === "function"
    ? input.startOptions(envelope)
    : input.startOptions;

const makeWorkflowSdkMigrationRunEnvelope = (
  plan: MigrationDefinitionExecutableRunPlan,
  runId: MigrationRunId,
  locks: readonly MigrationDefinitionLock[]
): Effect.Effect<
  WorkflowSdkMigrationRunEnvelope,
  MigrationExecutionEnvelopeMissingRegistryIdError
> =>
  makeMigrationRunExecutionEnvelope(plan, { runId }).pipe(
    Effect.map((envelope) => ({ ...envelope, locks }))
  );

const makeWorkflowSdkMigrationRollbackEnvelope = (
  plan: MigrationDefinitionExecutableRollbackPlan,
  runId: MigrationRunId,
  locks: readonly MigrationDefinitionLock[]
): Effect.Effect<
  WorkflowSdkMigrationRollbackEnvelope,
  MigrationExecutionEnvelopeMissingRegistryIdError
> =>
  makeMigrationRollbackExecutionEnvelope(plan, { runId }).pipe(
    Effect.map((envelope) => ({ ...envelope, locks }))
  );

const startWorkflowRun = (
  envelope: WorkflowSdkMigrationExecutionEnvelope,
  input: WorkflowSdkMigrationExecutableLayerOptions,
  client: WorkflowSdkClientService
): Effect.Effect<WorkflowSdkRun, WorkflowSdkClientError> => {
  const options = makeStartOptions(envelope, input);

  return client.start({
    envelope,
    workflow: input.workflow,
    ...(options === undefined ? {} : { options }),
  });
};

const startWorkflow = (
  envelope: WorkflowSdkMigrationExecutionEnvelope,
  input: WorkflowSdkMigrationExecutableLayerOptions,
  client: WorkflowSdkClientService
): Effect.Effect<
  typeof WorkflowSdkExecutionHandle.Type,
  WorkflowSdkMigrationExecutableStartError
> =>
  startWorkflowRun(envelope, input, client).pipe(
    Effect.mapError((error) => makeStartError(envelope.runId, error.cause)),
    Effect.map((run) => ({
      adapter: input.adapterName ?? "workflow-sdk",
      executionId: run.runId,
    }))
  );

const startDurablePlan = <Summary>({
  client,
  input,
  makeEnvelope,
  preflight,
  scopeDefinitionIds,
  storeLayer,
}: {
  readonly client: WorkflowSdkClientService;
  readonly input: WorkflowSdkMigrationExecutableLayerOptions;
  readonly makeEnvelope: (
    runId: MigrationRunId,
    locks: readonly MigrationDefinitionLock[]
  ) => Effect.Effect<
    WorkflowSdkMigrationExecutionEnvelope,
    MigrationExecutionEnvelopeMissingRegistryIdError
  >;
  readonly preflight?: (
    store: typeof MigrationStore.Service
  ) => Effect.Effect<void, MigrationStoreError | RollbackPreflightError>;
  readonly scopeDefinitionIds: readonly MigrationDefinitionId[];
  readonly storeLayer: Layer.Layer<MigrationStore, MigrationStoreError>;
}): Effect.Effect<
  ExecutionStartResult<Summary>,
  WorkflowSdkMigrationExecutableError
> =>
  Effect.gen(function* () {
    const store = yield* MigrationStore;
    const runId = yield* store.createRunId;
    const locks = yield* acquireLocks(store, runId, scopeDefinitionIds);
    if (preflight !== undefined) {
      yield* preflight(store).pipe(
        Effect.catch((error) =>
          releaseLocks(store, locks, error).pipe(
            Effect.andThen(Effect.fail(error))
          )
        )
      );
    }
    const envelope = yield* makeEnvelope(runId, locks).pipe(
      Effect.catch((error) =>
        releaseLocks(store, locks, error).pipe(
          Effect.andThen(Effect.fail(error))
        )
      )
    );

    yield* store
      .queueRun(runId, scopeDefinitionIds)
      .pipe(
        Effect.catch((error) =>
          releaseLocks(store, locks, error).pipe(
            Effect.andThen(Effect.fail(error))
          )
        )
      );

    const execution = yield* startWorkflow(envelope, input, client).pipe(
      Effect.catch((error) =>
        markStartFailedAndReleaseLocks(
          store,
          runId,
          scopeDefinitionIds,
          locks,
          error
        ).pipe(Effect.andThen(Effect.fail(error)))
      )
    );
    yield* store
      .attachRunExecution(runId, scopeDefinitionIds, execution)
      .pipe(
        Effect.mapError((error) => makeAttachError(runId, execution, error))
      );
    return {
      execution,
      kind: "started" as const,
      runId,
    };
  }).pipe(Effect.provide(storeLayer));

export const WorkflowSdkMigrationExecutable = {
  layer: (
    input: WorkflowSdkMigrationExecutableLayerOptions
  ): Layer.Layer<MigrationExecutable, never, WorkflowSdkClient> =>
    Layer.effect(
      MigrationExecutable,
      Effect.gen(function* () {
        const client = yield* WorkflowSdkClient;
        const adapterName = input.adapterName ?? "workflow-sdk";

        return {
          startRun: (plan: MigrationDefinitionExecutableRunPlan) =>
            validateMigrationRunDependencyPreflight(plan).pipe(
              Effect.andThen(
                Effect.flatMap(
                  validateSharedStore(plan.definitions),
                  (storeLayer) =>
                    startDurablePlan<MigrationRunSummary>({
                      client,
                      input,
                      makeEnvelope: (runId, locks) =>
                        makeWorkflowSdkMigrationRunEnvelope(plan, runId, locks),
                      preflight: (store) =>
                        validateMigrationRunRollbackOrphansDependencyPreflight(
                          plan
                        ).pipe(Effect.provideService(MigrationStore, store)),
                      scopeDefinitionIds: plan.includedDefinitionIds,
                      storeLayer,
                    })
                )
              )
            ),
          startRollback: (plan: MigrationDefinitionExecutableRollbackPlan) =>
            Effect.flatMap(
              validateSharedStore(plan.definitions),
              (storeLayer) =>
                startDurablePlan<RollbackRunSummary>({
                  client,
                  input,
                  makeEnvelope: (runId, locks) =>
                    makeWorkflowSdkMigrationRollbackEnvelope(
                      plan,
                      runId,
                      locks
                    ),
                  scopeDefinitionIds: plan.includedDefinitionIds,
                  storeLayer,
                })
            ),
          waitForExecution: (
            execution,
            options: MigrationExecutableObservationOptions = {}
          ) => {
            if (execution.adapter !== adapterName) {
              return Effect.fail(
                new WorkflowSdkMigrationExecutableObservationError({
                  cause: { adapterName },
                  execution,
                  message: `Workflow SDK cannot observe execution from adapter ${execution.adapter}`,
                })
              );
            }

            const observationError = (cause: unknown) =>
              new WorkflowSdkMigrationExecutableObservationError({
                cause,
                execution,
                message: `Unable to observe Workflow SDK execution ${execution.executionId}`,
              });
            const getRun = client
              .getRun(execution.executionId)
              .pipe(Effect.mapError((error) => observationError(error.cause)));

            return getRun.pipe(
              Effect.flatMap((run) => {
                const terminal = observeWorkflowTerminal(run, observationError);

                if (options.onProgressCheckpoint === undefined) {
                  return terminal;
                }

                const progress = observeWorkflowProgress(
                  run,
                  options,
                  observationError
                ).pipe(Effect.andThen(Effect.never));

                return Effect.raceFirst(terminal, progress);
              })
            );
          },
        };
      })
    ),
} as const;
