import { Effect, Exit, Layer, Schema } from "effect";
import {
  type ExecutionStartResult,
  type MigrationDefinitionExecutableRollbackPlan,
  type MigrationDefinitionExecutableRunPlan,
  type MigrationDefinitionId,
  type MigrationDefinitionLock,
  MigrationExecutable,
  type MigrationExecutionEnvelope,
  type MigrationExecutionEnvelopeMissingRegistryIdError,
  type MigrationExecutionHandle,
  type MigrationRunId,
  MigrationRunId as MigrationRunIdSchema,
  MigrationRuntimeError,
  type MigrationRunSummary,
  MigrationStore,
  MigrationStoreError,
  makeMigrationRollbackExecutionEnvelope,
  makeMigrationRunExecutionEnvelope,
  type RollbackRunSummary,
} from "migrate-sdk";
import type { Run, StartOptions } from "workflow/api";

export type WorkflowSdkRun = Run<unknown>;

export type WorkflowSdkMigrationWorkflow = (
  envelope: MigrationExecutionEnvelope
) => Promise<unknown>;

export interface WorkflowSdkWorkflowMetadata {
  readonly workflowId: string;
}

export type WorkflowSdkStartOptions = StartOptions;
type WorkflowSdkStartOptionsWithDeploymentId = Extract<
  WorkflowSdkStartOptions,
  { readonly deploymentId: "latest" | (string & {}) }
>;
type WorkflowSdkStartOptionsWithoutDeploymentId = Extract<
  WorkflowSdkStartOptions,
  { readonly deploymentId?: undefined }
>;

export interface WorkflowSdkStart {
  (
    workflow: WorkflowSdkMigrationWorkflow | WorkflowSdkWorkflowMetadata,
    args: [MigrationExecutionEnvelope],
    options: WorkflowSdkStartOptionsWithDeploymentId
  ): Promise<WorkflowSdkRun>;
  (
    workflow: WorkflowSdkMigrationWorkflow | WorkflowSdkWorkflowMetadata,
    args: [MigrationExecutionEnvelope],
    options?: WorkflowSdkStartOptionsWithoutDeploymentId
  ): Promise<WorkflowSdkRun>;
}

export interface WorkflowSdkMigrationExecutableLayerOptions {
  readonly adapterName?: string;
  readonly start: WorkflowSdkStart;
  readonly startOptions?:
    | WorkflowSdkStartOptions
    | ((
        envelope: MigrationExecutionEnvelope
      ) => WorkflowSdkStartOptions | undefined);
  readonly workflow: WorkflowSdkMigrationWorkflow | WorkflowSdkWorkflowMetadata;
}

const WorkflowSdkExecutionHandle = Schema.Struct({
  adapter: Schema.String,
  executionId: Schema.String,
});

export class WorkflowSdkMigrationExecutableStartError extends Schema.TaggedErrorClass<WorkflowSdkMigrationExecutableStartError>()(
  "WorkflowSdkMigrationExecutableStartError",
  {
    cause: Schema.Defect,
    message: Schema.String,
    runId: MigrationRunIdSchema,
  }
) {}

export class WorkflowSdkMigrationExecutableAttachError extends Schema.TaggedErrorClass<WorkflowSdkMigrationExecutableAttachError>()(
  "WorkflowSdkMigrationExecutableAttachError",
  {
    cause: Schema.Defect,
    execution: WorkflowSdkExecutionHandle,
    message: Schema.String,
    runId: MigrationRunIdSchema,
  }
) {}

type WorkflowSdkMigrationExecutableError =
  | WorkflowSdkMigrationExecutableStartError
  | WorkflowSdkMigrationExecutableAttachError
  | MigrationExecutionEnvelopeMissingRegistryIdError
  | MigrationRuntimeError
  | MigrationStoreError;

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
  execution: MigrationExecutionHandle,
  cause: unknown
): WorkflowSdkMigrationExecutableAttachError =>
  new WorkflowSdkMigrationExecutableAttachError({
    cause,
    runId,
    execution: execution as typeof WorkflowSdkExecutionHandle.Type,
    message: "Workflow SDK execution identity attachment failed",
  });

const makeStartOptions = (
  envelope: MigrationExecutionEnvelope,
  input: WorkflowSdkMigrationExecutableLayerOptions
): WorkflowSdkStartOptions | undefined =>
  typeof input.startOptions === "function"
    ? input.startOptions(envelope)
    : input.startOptions;

const startWorkflowRun = (
  envelope: MigrationExecutionEnvelope,
  input: WorkflowSdkMigrationExecutableLayerOptions
): Promise<WorkflowSdkRun> => {
  const options = makeStartOptions(envelope, input);

  return options?.deploymentId === undefined
    ? input.start(input.workflow, [envelope], options)
    : input.start(input.workflow, [envelope], options);
};

const startWorkflow = (
  envelope: MigrationExecutionEnvelope,
  input: WorkflowSdkMigrationExecutableLayerOptions
): Effect.Effect<
  MigrationExecutionHandle,
  WorkflowSdkMigrationExecutableStartError
> =>
  Effect.tryPromise({
    try: () => startWorkflowRun(envelope, input),
    catch: (cause) => makeStartError(envelope.runId, cause),
  }).pipe(
    Effect.map((run) => ({
      adapter: input.adapterName ?? "workflow-sdk",
      executionId: run.runId,
    }))
  );

const startDurablePlan = <Summary>({
  input,
  makeEnvelope,
  scopeDefinitionIds,
  storeLayer,
}: {
  readonly input: WorkflowSdkMigrationExecutableLayerOptions;
  readonly makeEnvelope: (
    runId: MigrationRunId,
    locks: readonly MigrationDefinitionLock[]
  ) => Effect.Effect<
    MigrationExecutionEnvelope,
    MigrationExecutionEnvelopeMissingRegistryIdError
  >;
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

    const execution = yield* startWorkflow(envelope, input).pipe(
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
  layer: (input: WorkflowSdkMigrationExecutableLayerOptions) =>
    Layer.succeed(MigrationExecutable, {
      startRun: (plan: MigrationDefinitionExecutableRunPlan) => {
        return Effect.flatMap(validateSharedStore(plan.definitions), (storeLayer) =>
          startDurablePlan<MigrationRunSummary>({
            input,
            makeEnvelope: (runId, locks) =>
              makeMigrationRunExecutionEnvelope(plan, { locks, runId }),
            scopeDefinitionIds: plan.includedDefinitionIds,
            storeLayer,
          })
        );
      },
      startRollback: (plan: MigrationDefinitionExecutableRollbackPlan) => {
        return Effect.flatMap(validateSharedStore(plan.definitions), (storeLayer) =>
          startDurablePlan<RollbackRunSummary>({
            input,
            makeEnvelope: (runId, locks) =>
              makeMigrationRollbackExecutionEnvelope(plan, { locks, runId }),
            scopeDefinitionIds: plan.includedDefinitionIds,
            storeLayer,
          })
        );
      },
    }),
} as const;
