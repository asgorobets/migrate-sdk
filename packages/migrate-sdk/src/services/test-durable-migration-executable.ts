import { Effect, Exit, Layer, Schema } from "effect";
import { MigrationStoreError } from "../domain/errors.ts";
import {
  type MigrationExecutionEnvelope,
  type MigrationExecutionEnvelopeMissingRegistryIdError,
  makeMigrationRollbackExecutionEnvelope,
  makeMigrationRunExecutionEnvelope,
} from "../domain/execution-envelope.ts";
import type { MigrationDefinitionId } from "../domain/ids.ts";
import {
  MigrationRunId,
  type MigrationRunId as MigrationRunIdType,
} from "../domain/ids.ts";
import type { MigrationDefinitionLock } from "../domain/lock.ts";
import type {
  MigrationDefinitionExecutableRollbackPlan,
  MigrationDefinitionExecutableRunPlan,
} from "../domain/registry.ts";
import type { RollbackRunSummary } from "../domain/rollback.ts";
import type {
  ExecutionStartResult,
  MigrationExecutionHandle,
  MigrationRunState,
  MigrationRunSummary,
} from "../domain/run.ts";
import { MigrationExecutable } from "./migration-executable.ts";
import { MigrationStore } from "./migration-store.ts";

const TestDurableExecutionHandle = Schema.Struct({
  adapter: Schema.Literal("test-durable"),
  executionId: Schema.String,
});

export class TestDurableMigrationExecutableStartRejectedError extends Schema.TaggedErrorClass<TestDurableMigrationExecutableStartRejectedError>()(
  "TestDurableMigrationExecutableStartRejectedError",
  {
    message: Schema.String,
    runId: MigrationRunId,
  }
) {}

export class TestDurableMigrationExecutableAttachError extends Schema.TaggedErrorClass<TestDurableMigrationExecutableAttachError>()(
  "TestDurableMigrationExecutableAttachError",
  {
    cause: Schema.optional(Schema.Defect),
    execution: TestDurableExecutionHandle,
    message: Schema.String,
    runId: MigrationRunId,
  }
) {}

export interface TestDurableMigrationExecutableState {
  readonly envelopes: Map<MigrationRunIdType, MigrationExecutionEnvelope>;
  readonly executions: Map<MigrationRunIdType, MigrationExecutionHandle>;
  readonly locks: Map<MigrationRunIdType, readonly MigrationDefinitionLock[]>;
  nextExecutionNumber: number;
  readonly queuedRunStates: MigrationRunState[];
  rejectAttach: boolean;
  rejectStart: boolean;
}

export const makeTestDurableMigrationExecutableState = (
  input: {
    readonly rejectAttach?: boolean;
    readonly rejectStart?: boolean;
  } = {}
): TestDurableMigrationExecutableState => ({
  envelopes: new Map(),
  executions: new Map(),
  locks: new Map(),
  queuedRunStates: [],
  nextExecutionNumber: 1,
  rejectAttach: input.rejectAttach ?? false,
  rejectStart: input.rejectStart ?? false,
});

type TestDurableMigrationExecutableError =
  | TestDurableMigrationExecutableStartRejectedError
  | TestDurableMigrationExecutableAttachError
  | MigrationExecutionEnvelopeMissingRegistryIdError
  | MigrationStoreError;

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
  runId: MigrationRunIdType,
  definitionIds: readonly MigrationDefinitionId[]
): Effect.Effect<readonly MigrationDefinitionLock[], MigrationStoreError> =>
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
  runId: MigrationRunIdType,
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

const rejectStart = (
  runId: MigrationRunIdType
): TestDurableMigrationExecutableStartRejectedError =>
  new TestDurableMigrationExecutableStartRejectedError({
    runId,
    message: "Test durable provider rejected migration execution start",
  });

const attachError = (
  runId: MigrationRunIdType,
  execution: MigrationExecutionHandle,
  cause?: unknown
): TestDurableMigrationExecutableAttachError =>
  new TestDurableMigrationExecutableAttachError({
    runId,
    execution: execution as typeof TestDurableExecutionHandle.Type,
    message: "Test durable provider execution identity attachment failed",
    ...(cause === undefined ? {} : { cause }),
  });

const startProvider = (
  state: TestDurableMigrationExecutableState,
  envelope: MigrationExecutionEnvelope
): Effect.Effect<
  MigrationExecutionHandle,
  TestDurableMigrationExecutableStartRejectedError
> =>
  state.rejectStart
    ? Effect.fail(rejectStart(envelope.runId))
    : Effect.sync(() => {
        const execution = {
          adapter: "test-durable" as const,
          executionId: `test-execution-${state.nextExecutionNumber}`,
        };
        state.nextExecutionNumber += 1;
        state.envelopes.set(envelope.runId, envelope);

        return execution;
      });

const startDurablePlan = <Summary>({
  makeEnvelope,
  scopeDefinitionIds,
  state,
  storeLayer,
}: {
  readonly makeEnvelope: (
    runId: MigrationRunIdType,
    locks: readonly MigrationDefinitionLock[]
  ) => Effect.Effect<
    MigrationExecutionEnvelope,
    MigrationExecutionEnvelopeMissingRegistryIdError
  >;
  readonly scopeDefinitionIds: readonly MigrationDefinitionId[];
  readonly state: TestDurableMigrationExecutableState;
  readonly storeLayer: Layer.Layer<MigrationStore, MigrationStoreError>;
}): Effect.Effect<
  ExecutionStartResult<Summary>,
  TestDurableMigrationExecutableError
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
    const queuedRunState = yield* store
      .queueRun(runId, scopeDefinitionIds)
      .pipe(
        Effect.catch((error) =>
          releaseLocks(store, locks, error).pipe(
            Effect.andThen(Effect.fail(error))
          )
        )
      );
    state.queuedRunStates.push(queuedRunState);

    const execution = yield* startProvider(state, envelope).pipe(
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

    const failAttach = (cause?: unknown) =>
      Effect.fail(attachError(runId, execution, cause));

    if (state.rejectAttach) {
      return yield* failAttach();
    }

    yield* store
      .attachRunExecution(runId, scopeDefinitionIds, execution)
      .pipe(
        Effect.mapError((error) => attachError(runId, execution, error))
      );
    state.executions.set(runId, execution);
    state.locks.set(runId, locks);

    return {
      execution,
      kind: "started" as const,
      runId,
    };
  }).pipe(Effect.provide(storeLayer));

export const TestDurableMigrationExecutable = {
  layer: (state: TestDurableMigrationExecutableState) =>
    Layer.succeed(MigrationExecutable, {
      startRun: (plan: MigrationDefinitionExecutableRunPlan) => {
        const firstDefinition = plan.definitions[0];
        if (firstDefinition === undefined) {
          return Effect.die(
            new Error(
              "Test durable migration executable requires at least one selected migration definition"
            )
          );
        }

        return startDurablePlan<MigrationRunSummary>({
          makeEnvelope: (runId, locks) =>
            makeMigrationRunExecutionEnvelope(plan, { locks, runId }),
          scopeDefinitionIds: plan.includedDefinitionIds,
          state,
          storeLayer: firstDefinition.store,
        });
      },
      startRollback: (plan: MigrationDefinitionExecutableRollbackPlan) => {
        const firstDefinition = plan.definitions[0];
        if (firstDefinition === undefined) {
          return Effect.die(
            new Error(
              "Test durable migration executable requires at least one selected migration definition"
            )
          );
        }

        return startDurablePlan<RollbackRunSummary>({
          makeEnvelope: (runId, locks) =>
            makeMigrationRollbackExecutionEnvelope(plan, { locks, runId }),
          scopeDefinitionIds: plan.includedDefinitionIds,
          state,
          storeLayer: firstDefinition.store,
        });
      },
    }),
  makeState: makeTestDurableMigrationExecutableState,
} as const;
