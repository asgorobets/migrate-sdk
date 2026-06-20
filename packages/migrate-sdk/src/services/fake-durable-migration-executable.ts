import { Effect, Layer, Schema } from "effect";
import type { MigrationStoreError } from "../domain/errors.ts";
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

const FakeDurableExecutionHandle = Schema.Struct({
  adapter: Schema.Literal("fake-durable"),
  executionId: Schema.String,
});

export class FakeDurableMigrationExecutableStartRejectedError extends Schema.TaggedErrorClass<FakeDurableMigrationExecutableStartRejectedError>()(
  "FakeDurableMigrationExecutableStartRejectedError",
  {
    message: Schema.String,
    runId: MigrationRunId,
  }
) {}

export class FakeDurableMigrationExecutableAttachError extends Schema.TaggedErrorClass<FakeDurableMigrationExecutableAttachError>()(
  "FakeDurableMigrationExecutableAttachError",
  {
    cause: Schema.optional(Schema.Defect),
    execution: FakeDurableExecutionHandle,
    message: Schema.String,
    runId: MigrationRunId,
  }
) {}

export interface FakeDurableMigrationExecutableState {
  readonly envelopes: Map<MigrationRunIdType, MigrationExecutionEnvelope>;
  readonly executions: Map<MigrationRunIdType, MigrationExecutionHandle>;
  readonly locks: Map<MigrationRunIdType, readonly MigrationDefinitionLock[]>;
  nextExecutionNumber: number;
  readonly queuedRunStates: MigrationRunState[];
  rejectAttach: boolean;
  rejectStart: boolean;
}

export const makeFakeDurableMigrationExecutableState = (
  input: {
    readonly rejectAttach?: boolean;
    readonly rejectStart?: boolean;
  } = {}
): FakeDurableMigrationExecutableState => ({
  envelopes: new Map(),
  executions: new Map(),
  locks: new Map(),
  queuedRunStates: [],
  nextExecutionNumber: 1,
  rejectAttach: input.rejectAttach ?? false,
  rejectStart: input.rejectStart ?? false,
});

type FakeDurableMigrationExecutableError =
  | FakeDurableMigrationExecutableStartRejectedError
  | FakeDurableMigrationExecutableAttachError
  | MigrationExecutionEnvelopeMissingRegistryIdError
  | MigrationStoreError;

const releaseLocks = (
  store: typeof MigrationStore.Service,
  locks: readonly MigrationDefinitionLock[]
) =>
  Effect.forEach(locks, (lock) => store.releaseDefinitionLock(lock), {
    discard: true,
  }).pipe(Effect.orDie);

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
            releaseLocks(store, locks).pipe(Effect.andThen(Effect.fail(error)))
          )
        );
      locks.push(lock);
    }

    return locks;
  });

const rejectStart = (
  runId: MigrationRunIdType
): FakeDurableMigrationExecutableStartRejectedError =>
  new FakeDurableMigrationExecutableStartRejectedError({
    runId,
    message: "Fake durable provider rejected migration execution start",
  });

const attachError = (
  runId: MigrationRunIdType,
  execution: MigrationExecutionHandle,
  cause?: unknown
): FakeDurableMigrationExecutableAttachError =>
  new FakeDurableMigrationExecutableAttachError({
    runId,
    execution: execution as typeof FakeDurableExecutionHandle.Type,
    message: "Fake durable provider execution identity attachment failed",
    ...(cause === undefined ? {} : { cause }),
  });

const startProvider = (
  state: FakeDurableMigrationExecutableState,
  envelope: MigrationExecutionEnvelope
): Effect.Effect<
  MigrationExecutionHandle,
  FakeDurableMigrationExecutableStartRejectedError
> =>
  state.rejectStart
    ? Effect.fail(rejectStart(envelope.runId))
    : Effect.sync(() => {
        const execution = {
          adapter: "fake-durable" as const,
          executionId: `fake-execution-${state.nextExecutionNumber}`,
        };
        state.nextExecutionNumber += 1;
        state.envelopes.set(envelope.runId, envelope);

        return execution;
      });

const startDurablePlan = <Summary>({
  definitionIds,
  makeEnvelope,
  state,
  storeLayer,
}: {
  readonly definitionIds: readonly MigrationDefinitionId[];
  readonly makeEnvelope: (
    runId: MigrationRunIdType
  ) => Effect.Effect<
    MigrationExecutionEnvelope,
    MigrationExecutionEnvelopeMissingRegistryIdError
  >;
  readonly state: FakeDurableMigrationExecutableState;
  readonly storeLayer: Layer.Layer<MigrationStore, MigrationStoreError>;
}): Effect.Effect<
  ExecutionStartResult<Summary>,
  FakeDurableMigrationExecutableError
> =>
  Effect.gen(function* () {
    const store = yield* MigrationStore;
    const runId = yield* store.createRunId;
    const envelope = yield* makeEnvelope(runId);

    const locks = yield* acquireLocks(store, runId, definitionIds);
    const queuedRunState = yield* store
      .queueRun(runId, definitionIds)
      .pipe(
        Effect.catch((error) =>
          releaseLocks(store, locks).pipe(Effect.andThen(Effect.fail(error)))
        )
      );
    state.queuedRunStates.push(queuedRunState);

    const execution = yield* startProvider(state, envelope).pipe(
      Effect.catch((error) =>
        store
          .markRunStartFailed(runId, definitionIds)
          .pipe(
            Effect.andThen(releaseLocks(store, locks)),
            Effect.andThen(Effect.fail(error))
          )
      )
    );

    const failAttach = (cause?: unknown) =>
      store
        .markRunStartFailed(runId, definitionIds)
        .pipe(
          Effect.andThen(releaseLocks(store, locks)),
          Effect.andThen(Effect.fail(attachError(runId, execution, cause)))
        );

    if (state.rejectAttach) {
      return yield* failAttach();
    }

    yield* store
      .attachRunExecution(runId, definitionIds, execution)
      .pipe(Effect.catch((error) => failAttach(error)));
    state.executions.set(runId, execution);
    state.locks.set(runId, locks);

    return {
      execution,
      kind: "started" as const,
      runId,
    };
  }).pipe(Effect.provide(storeLayer));

export const FakeDurableMigrationExecutable = {
  layer: (state: FakeDurableMigrationExecutableState) =>
    Layer.succeed(MigrationExecutable, {
      startRun: (plan: MigrationDefinitionExecutableRunPlan) => {
        const firstDefinition = plan.definitions[0];
        if (firstDefinition === undefined) {
          return Effect.die(
            new Error(
              "Fake durable migration executable requires at least one selected migration definition"
            )
          );
        }

        return startDurablePlan<MigrationRunSummary>({
          definitionIds: plan.executionDefinitionIds,
          makeEnvelope: (runId) =>
            makeMigrationRunExecutionEnvelope(plan, { runId }),
          state,
          storeLayer: firstDefinition.store,
        });
      },
      startRollback: (plan: MigrationDefinitionExecutableRollbackPlan) => {
        const firstDefinition = plan.definitions[0];
        if (firstDefinition === undefined) {
          return Effect.die(
            new Error(
              "Fake durable migration executable requires at least one selected migration definition"
            )
          );
        }

        return startDurablePlan<RollbackRunSummary>({
          definitionIds: plan.executionDefinitionIds,
          makeEnvelope: (runId) =>
            makeMigrationRollbackExecutionEnvelope(plan, { runId }),
          state,
          storeLayer: firstDefinition.store,
        });
      },
    }),
  makeState: makeFakeDurableMigrationExecutableState,
} as const;
