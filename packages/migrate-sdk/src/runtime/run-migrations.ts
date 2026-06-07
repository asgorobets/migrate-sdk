import { Deferred, Effect, Exit, Layer, Predicate, Schema } from "effect";
import type { MigrationDefinition } from "../domain/definition.ts";
import type {
  DestinationCommand,
  DestinationCommandPlan,
} from "../domain/destination.ts";
import {
  type DestinationPluginError,
  MigrationReferenceLookupError,
  MigrationRuntimeError,
  MigrationStoreError,
  RollbackPreflightError,
  RollbackRequestError,
  type SkipItem,
  SourcePluginError,
} from "../domain/errors.ts";
import type {
  DestinationIdentity,
  DestinationVersion,
  MigrationDefinitionId,
  MigrationRunId,
  SourceIdentity,
} from "../domain/ids.ts";
import { toEncodedSourceCursor } from "../domain/ids.ts";
import type { MigrationDefinitionLock } from "../domain/lock.ts";
import type {
  RollbackableMigrationItemState,
  RollbackDefinitionRunSummary,
  RollbackMigrationOptions,
  RollbackMigrationOptionsInput,
  RollbackPipeline,
  RollbackRunSummary,
} from "../domain/rollback.ts";
import { makeRollbackMigrationOptions } from "../domain/rollback.ts";
import type {
  AnyMigrationDefinition,
  MigrationDefinitionRunSummary,
  MigrationRunState,
  MigrationRunSummary,
  RunRequestInput,
} from "../domain/run.ts";
import { makeRunRequest } from "../domain/run.ts";
import { normalRunMode, type RunMode } from "../domain/run-mode.ts";
import type {
  FailedItemState,
  MigrationItemError,
  MigrationItemOutcome,
  MigrationItemState,
  NeedsUpdateItemState,
} from "../domain/state.ts";
import { DestinationPlugin } from "../services/destination-plugin.ts";
import type { MigrationReference } from "../services/migration-reference-lookup.ts";
import { MigrationStore } from "../services/migration-store.ts";
import {
  getSourcePlugin,
  type SourcePlugin,
} from "../services/source-plugin.ts";
import { executeDestinationCommandPlan } from "./destination-command-plan.ts";
import { normalizeItemError } from "./item-error.ts";
import {
  type CreateMigrationReferenceStub,
  makeMigrationReferenceLookupLayer,
} from "./migration-reference-lookup-layer.ts";
import { processSourceItem } from "./process-source-item.ts";

export type RunMigrationDefinitionError =
  | DestinationPluginError
  | SourcePluginError
  | MigrationStoreError;

export type RunMigrationError =
  | MigrationRuntimeError
  | RunMigrationDefinitionError;

export type RollbackMigrationDefinitionError =
  | DestinationPluginError
  | MigrationStoreError;

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

const invalidRollbackRequestError = (cause: unknown) =>
  cause instanceof RollbackRequestError
    ? cause
    : new RollbackRequestError({
        message: "Rollback request contains invalid input",
        cause,
      });

const missingRollbackPipelineError = (definitionId: MigrationDefinitionId) =>
  new RollbackPreflightError({
    message: "Migration Definition does not define a rollback pipeline",
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

interface MutableRollbackDefinitionCounts {
  failed: number;
  rolledBack: number;
  skipped: number;
}

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

const executeMigrationRun = <A, E>(
  store: typeof MigrationStore.Service,
  definitionIds: readonly MigrationDefinitionId[],
  body: (
    runId: MigrationRunId
  ) => Effect.Effect<MigrationRunBodyResult<A>, E | MigrationStoreError>,
  beforeBegin?: (
    runId: MigrationRunId
  ) => Effect.Effect<void, E | MigrationStoreError>
): Effect.Effect<MigrationRunExecutionResult<A>, E | MigrationStoreError> =>
  Effect.gen(function* () {
    const runId = yield* store.createRunId;

    return yield* Effect.acquireUseRelease(
      acquireDefinitionLocks(store, runId, definitionIds),
      () =>
        Effect.gen(function* () {
          if (beforeBegin !== undefined) {
            yield* beforeBegin(runId);
          }

          const runState = yield* store.beginRun(runId, definitionIds);
          const bodyResult = yield* body(runState.runId).pipe(
            Effect.catch((error) =>
              failRunAndRethrow(store, runState.runId, definitionIds, error)
            )
          );
          const completedRun =
            bodyResult.status === "failed"
              ? yield* store.failRun(runState.runId, definitionIds)
              : yield* store.completeRun(runState.runId, definitionIds);

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

const isTargetedMode = (mode: RunMode): boolean => mode.kind !== "normal";

const shouldReprocessUnchangedTerminal = (mode: RunMode): boolean =>
  mode.kind === "skipped" || mode.kind === "item";

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
): readonly SourceIdentity[] =>
  mode.kind === "item"
    ? [mode.sourceIdentity]
    : backlogStates.map((itemState) => itemState.sourceIdentity);

const previousDestinationIdentity = (
  previousState: MigrationItemState | null
) =>
  previousState !== null &&
  (previousState.status === "migrated" ||
    previousState.status === "failed" ||
    previousState.status === "needs-update")
    ? previousState.destinationIdentity
    : undefined;

const previousDestinationVersion = (
  previousState: MigrationItemState | null
) =>
  previousState !== null &&
  (previousState.status === "migrated" ||
    previousState.status === "failed" ||
    previousState.status === "needs-update")
    ? previousState.destinationVersion
    : undefined;

const stubNotConfiguredError = (definitionId: MigrationDefinitionId) =>
  new MigrationReferenceLookupError({
    message: "Migration Definition does not define Destination Stub creation",
    cause: { definitionId },
  });

const stubPlanMissingIdentityError = (definitionId: MigrationDefinitionId) =>
  new MigrationReferenceLookupError({
    message:
      "Destination Stub command plan did not produce a Destination Identity",
    cause: { definitionId },
  });

const stubCreationFailedError = (
  definitionId: MigrationDefinitionId,
  sourceIdentity: SourceIdentity
) =>
  new MigrationReferenceLookupError({
    message: "Destination Stub creation failed",
    cause: { definitionId, sourceIdentity },
  });

const isSkipItem = (error: unknown): error is SkipItem =>
  Predicate.isTagged(error, "SkipItem");

const makeFailedStubReferenceState = ({
  definitionId,
  destinationIdentity,
  destinationVersion,
  error,
  previousState,
  runId,
  sourceIdentity,
}: {
  readonly definitionId: MigrationDefinitionId;
  readonly destinationIdentity?: DestinationIdentity;
  readonly destinationVersion?: DestinationVersion;
  readonly error: MigrationItemError;
  readonly previousState: MigrationItemState | null;
  readonly runId: MigrationRunId;
  readonly sourceIdentity: SourceIdentity;
}): FailedItemState => ({
  definitionId,
  sourceIdentity,
  ...(previousState?.sourceVersion === undefined
    ? {}
    : { sourceVersion: previousState.sourceVersion }),
  ...((destinationIdentity ?? previousDestinationIdentity(previousState)) ===
  undefined
    ? {}
    : {
        destinationIdentity:
          destinationIdentity ?? previousDestinationIdentity(previousState),
      }),
  ...((destinationVersion ?? previousDestinationVersion(previousState)) ===
  undefined
    ? {}
    : {
        destinationVersion:
          destinationVersion ?? previousDestinationVersion(previousState),
      }),
  lastRunId: runId,
  updatedAt: new Date(),
  status: "failed",
  error,
});

const makeNeedsUpdateStubReferenceState = ({
  definitionId,
  destinationIdentity,
  destinationVersion,
  previousState,
  runId,
  sourceIdentity,
}: {
  readonly definitionId: MigrationDefinitionId;
  readonly destinationIdentity: DestinationIdentity;
  readonly destinationVersion?: DestinationVersion;
  readonly previousState: MigrationItemState | null;
  readonly runId: MigrationRunId;
  readonly sourceIdentity: SourceIdentity;
}): NeedsUpdateItemState => ({
  definitionId,
  sourceIdentity,
  ...(previousState?.sourceVersion === undefined
    ? {}
    : { sourceVersion: previousState.sourceVersion }),
  destinationIdentity,
  ...(destinationVersion === undefined ? {} : { destinationVersion }),
  lastRunId: runId,
  updatedAt: new Date(),
  reason: "Destination Stub requires update",
  status: "needs-update",
});

const executeStubPlan = <Command extends DestinationCommand, PipelineError>(
  definition: MigrationDefinition<unknown, Command, PipelineError, unknown>,
  runId: MigrationRunId,
  sourceIdentity: SourceIdentity,
  previousState: MigrationItemState | null
) =>
  Effect.gen(function* () {
    const stub = definition.stub;

    if (stub === undefined) {
      return yield* stubNotConfiguredError(definition.id);
    }

    const plan = yield* Effect.try({
      try: () =>
        stub(
          { sourceIdentity },
          {
            definitionId: definition.id,
            runId,
          }
        ),
      catch: (error) => error as PipelineError | SkipItem,
    }).pipe(
      Effect.flatMap((planOrEffect) =>
        Effect.isEffect(planOrEffect)
          ? (planOrEffect as Effect.Effect<
              DestinationCommandPlan<Command>,
              PipelineError | SkipItem
            >)
          : Effect.succeed(planOrEffect)
      ),
      Effect.mapError((error) =>
        isSkipItem(error)
          ? new MigrationReferenceLookupError({
              message: "Destination Stub creation skipped",
              cause: error,
            })
          : new MigrationReferenceLookupError({
              message: "Destination Stub command plan creation failed",
              cause: error,
            })
      )
    );

    const outcome = yield* Effect.gen(function* () {
      const destination = yield* DestinationPlugin;

      return yield* executeDestinationCommandPlan({
        commandDefinitions: definition.destination.commandDefinitions,
        context: {
          definitionId: definition.id,
          runId,
          sourceIdentity,
          ...(previousState === null ? {} : { previousState }),
        },
        destination,
        destinationRetry: definition.destinationRetry,
        plan,
      });
    }).pipe(Effect.provide(definition.destination.layer));

    if (outcome.kind === "failed") {
      return {
        kind: "failed" as const,
        ...(outcome.destinationIdentity === undefined
          ? {}
          : { destinationIdentity: outcome.destinationIdentity }),
        ...(outcome.destinationVersion === undefined
          ? {}
          : { destinationVersion: outcome.destinationVersion }),
        error: outcome.error,
      };
    }

    const destinationIdentity =
      outcome.destinationIdentity ?? previousDestinationIdentity(previousState);

    if (destinationIdentity === undefined) {
      return yield* stubPlanMissingIdentityError(definition.id);
    }

    return {
      kind: "succeeded" as const,
      destinationIdentity,
      ...(outcome.destinationVersion === undefined
        ? {}
        : { destinationVersion: outcome.destinationVersion }),
    };
  });

const makeSourceLookupFailedItemState = (
  definitionId: MigrationDefinitionId,
  runId: MigrationRunId,
  sourceIdentity: SourceIdentity,
  previousState: MigrationItemState,
  error: unknown
): FailedItemState => ({
  definitionId,
  sourceIdentity,
  ...(previousState.sourceVersion === undefined
    ? {}
    : { sourceVersion: previousState.sourceVersion }),
  ...(previousDestinationIdentity(previousState) === undefined
    ? {}
    : { destinationIdentity: previousDestinationIdentity(previousState) }),
  ...(previousDestinationVersion(previousState) === undefined
    ? {}
    : { destinationVersion: previousDestinationVersion(previousState) }),
  lastRunId: runId,
  updatedAt: new Date(),
  status: "failed",
  error: normalizeItemError("source", error),
});

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

const isRollbackableItemState = (
  itemState: MigrationItemState
): itemState is RollbackableMigrationItemState =>
  itemState.status === "migrated" ||
  itemState.status === "needs-update" ||
  (itemState.status === "failed" &&
    itemState.destinationIdentity !== undefined);

const runRollbackPipeline = <Command extends DestinationCommand, RollbackError>(
  rollback: RollbackPipeline<Command, RollbackError>,
  definitionId: MigrationDefinitionId,
  itemState: RollbackableMigrationItemState,
  runId: MigrationRunId
): Effect.Effect<DestinationCommandPlan<Command>, RollbackError> =>
  Effect.try({
    try: () =>
      rollback(itemState, {
        definitionId,
        runId,
      }),
    catch: (error) => error as RollbackError,
  }).pipe(
    Effect.flatMap((planOrEffect) =>
      Effect.isEffect(planOrEffect)
        ? (planOrEffect as Effect.Effect<
            DestinationCommandPlan<Command>,
            RollbackError
          >)
        : Effect.succeed(planOrEffect)
    )
  );

const rollbackItemState = <
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor,
  RollbackPipelineError,
>({
  counts,
  definition,
  itemState,
  runId,
  store,
}: {
  readonly counts: MutableRollbackDefinitionCounts;
  readonly definition: MigrationDefinition<
    Source,
    Command,
    PipelineError,
    Cursor,
    RollbackPipelineError
  >;
  readonly itemState: MigrationItemState;
  readonly runId: MigrationRunId;
  readonly store: typeof MigrationStore.Service;
}) =>
  Effect.gen(function* () {
    if (!isRollbackableItemState(itemState)) {
      counts.skipped += 1;
      return;
    }

    const rollback = definition.rollback;

    if (rollback === undefined) {
      return yield* missingRollbackPipelineError(definition.id);
    }

    const destination = yield* DestinationPlugin;

    const pipelineOutcome = yield* runRollbackPipeline(
      rollback,
      definition.id,
      itemState,
      runId
    ).pipe(
      Effect.map((plan) => ({
        kind: "command" as const,
        plan,
      })),
      Effect.catch(() =>
        Effect.succeed({
          kind: "pipeline-failed" as const,
        })
      )
    );

    if (pipelineOutcome.kind === "pipeline-failed") {
      counts.failed += 1;
      return;
    }

    const destinationOutcome = yield* executeDestinationCommandPlan({
      commandDefinitions: definition.destination.commandDefinitions,
      context: {
        definitionId: definition.id,
        previousState: itemState,
        runId,
        sourceIdentity: itemState.sourceIdentity,
        ...(itemState.sourceVersion === undefined
          ? {}
          : { sourceVersion: itemState.sourceVersion }),
      },
      destination,
      destinationRetry: definition.destinationRetry,
      plan: pipelineOutcome.plan,
      rejectIdentityCommands: true,
    });

    if (destinationOutcome.kind === "failed") {
      counts.failed += 1;
      return;
    }

    yield* store.deleteItemState(definition.id, itemState.sourceIdentity);
    counts.rolledBack += 1;
  });

interface ProcessTargetedSourceIdentitiesOptions<
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor,
> {
  readonly counts: MutableDefinitionCounts;
  readonly definition: MigrationDefinition<
    Source,
    Command,
    PipelineError,
    Cursor
  >;
  readonly itemStates: readonly MigrationItemState[];
  readonly mode: RunMode;
  readonly runId: MigrationRunId;
  readonly source: SourcePlugin<Source, Cursor>;
  readonly store: typeof MigrationStore.Service;
}

const processTargetedSourceIdentities = <
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor,
>({
  counts,
  definition,
  itemStates,
  mode,
  runId,
  source,
  store,
}: ProcessTargetedSourceIdentitiesOptions<
  Source,
  Command,
  PipelineError,
  Cursor
>) =>
  Effect.gen(function* () {
    const sourceIdentities = sourceIdentitiesForMode(
      mode,
      selectBacklogStates(mode, itemStates)
    );

    for (const sourceIdentity of sourceIdentities) {
      const previousState =
        itemStates.find(
          (itemState) => itemState.sourceIdentity === sourceIdentity
        ) ?? null;
      const readByIdentity = source.readByIdentity(sourceIdentity);
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
            sourceIdentity,
            previousState,
            lookup.error
          )
        );
        counts.failed += 1;
        continue;
      }

      const outcome = yield* processSourceItem({
        definition,
        reprocessUnchangedTerminal: shouldReprocessUnchangedTerminal(mode),
        runId,
        sourceSchema: source.sourceSchema,
        sourceItem: lookup.sourceItem,
      });

      addOutcomeToCounts(counts, outcome);
    }

    return sourceIdentities;
  });

interface ProcessCursorDiscoveryOptions<
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor,
> {
  readonly counts: MutableDefinitionCounts;
  readonly definition: MigrationDefinition<
    Source,
    Command,
    PipelineError,
    Cursor
  >;
  readonly excludedSourceIdentities: readonly SourceIdentity[];
  readonly runId: MigrationRunId;
  readonly source: SourcePlugin<Source, Cursor>;
  readonly store: typeof MigrationStore.Service;
}

const processCursorDiscovery = <
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor,
>({
  counts,
  definition,
  excludedSourceIdentities,
  runId,
  source,
  store,
}: ProcessCursorDiscoveryOptions<Source, Command, PipelineError, Cursor>) =>
  Effect.gen(function* () {
    const storedCursor = yield* store.getSourceCursor(definition.id);
    let cursor =
      storedCursor === null
        ? null
        : yield* decodeSourceCursor(source.cursorSchema, storedCursor);
    let committedCursor: Cursor | undefined;

    while (true) {
      const read = source.read(cursor);
      const readWithRetry =
        definition.sourceCursorRetry === undefined
          ? read
          : definition.sourceCursorRetry(read);
      const readResult = yield* readWithRetry;

      for (const sourceItem of readResult.items) {
        if (excludedSourceIdentities.includes(sourceItem.identity)) {
          continue;
        }

        const outcome = yield* processSourceItem({
          definition,
          runId,
          sourceSchema: source.sourceSchema,
          sourceItem,
        });

        addOutcomeToCounts(counts, outcome);
      }

      if (readResult.nextCursor === undefined) {
        break;
      }

      cursor = readResult.nextCursor;
      committedCursor = readResult.nextCursor;
      const encodedCursor = yield* encodeSourceCursor(
        source.cursorSchema,
        readResult.nextCursor
      );
      yield* store.setSourceCursor(definition.id, encodedCursor);
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
  readonly sourceIdentity: SourceIdentity;
  readonly store: typeof MigrationStore.Service;
}): Effect.Effect<
  MigrationReference,
  DestinationPluginError | MigrationReferenceLookupError | MigrationStoreError
> =>
  Effect.gen(function* () {
    const previousState = yield* store.getItemState(
      definition.id,
      sourceIdentity
    );
    const stubOutcome = yield* executeStubPlan(
      definition,
      runId,
      sourceIdentity,
      previousState
    );

    if (stubOutcome.kind === "failed") {
      yield* store.upsertItemState(
        makeFailedStubReferenceState({
          definitionId: definition.id,
          ...(stubOutcome.destinationIdentity === undefined
            ? {}
            : { destinationIdentity: stubOutcome.destinationIdentity }),
          ...(stubOutcome.destinationVersion === undefined
            ? {}
            : { destinationVersion: stubOutcome.destinationVersion }),
          error: stubOutcome.error,
          previousState,
          runId,
          sourceIdentity,
        })
      );

      return yield* stubCreationFailedError(definition.id, sourceIdentity);
    }

    const state = makeNeedsUpdateStubReferenceState({
      definitionId: definition.id,
      destinationIdentity: stubOutcome.destinationIdentity,
      ...(stubOutcome.destinationVersion === undefined
        ? {}
        : { destinationVersion: stubOutcome.destinationVersion }),
      previousState,
      runId,
      sourceIdentity,
    });
    yield* store.upsertItemState(state);

    return {
      definitionId: state.definitionId,
      destinationIdentity: state.destinationIdentity,
      ...(state.destinationVersion === undefined
        ? {}
        : { destinationVersion: state.destinationVersion }),
      sourceIdentity: state.sourceIdentity,
      status: state.status,
    } satisfies MigrationReference;
  });

type StubReferenceError =
  | DestinationPluginError
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
  sourceIdentity: SourceIdentity
) => `${definitionId}\u0000${sourceIdentity}`;

const startStubDefinitionRun = (
  definition: AnyMigrationDefinition
): Effect.Effect<StubDefinitionRunLease, MigrationStoreError> =>
  Effect.gen(function* () {
    const store = yield* MigrationStore;
    const runId = yield* store.createRunId;
    const locks = yield* acquireDefinitionLocks(store, runId, [definition.id]);
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
    Deferred.Deferred<StubDefinitionRunLease, MigrationStoreError>
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
  ): Effect.Effect<StubDefinitionRunLease, MigrationStoreError> =>
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
          MigrationStoreError
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

const withStubRunScope = <A, E>(
  activeRun: ActiveStubRunScope,
  body: (scope: StubRunScope) => Effect.Effect<A, E>
): Effect.Effect<A, E | MigrationStoreError> =>
  Effect.acquireUseRelease(
    Effect.sync(() => makeStubRunScope(activeRun)),
    body,
    (scope, exit) => scope.finalize(exit)
  );

const runMigrationDefinition = <
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor,
>(
  definition: MigrationDefinition<Source, Command, PipelineError, Cursor>,
  definitions: readonly AnyMigrationDefinition[],
  runId: MigrationRunId,
  mode: RunMode,
  createStubReference: CreateMigrationReferenceStub
): Effect.Effect<
  MigrationDefinitionRunSummary,
  RunMigrationDefinitionError
> => {
  const program = Effect.gen(function* () {
    const source = yield* getSourcePlugin<Source, Cursor>();
    const store = yield* MigrationStore;

    const counts = { ...emptyCounts };
    const itemStates = yield* store.listItemStates(definition.id);

    const attemptedSourceIdentities = yield* processTargetedSourceIdentities({
      counts,
      definition,
      itemStates,
      mode,
      runId,
      source,
      store,
    });

    if (isTargetedMode(mode)) {
      return {
        definitionId: definition.id,
        status:
          counts.failed > 0 ? ("failed" as const) : ("succeeded" as const),
        counts,
      };
    }

    yield* processCursorDiscovery({
      counts,
      definition,
      excludedSourceIdentities: attemptedSourceIdentities,
      runId,
      source,
      store,
    });

    return {
      definitionId: definition.id,
      status: counts.failed > 0 ? ("failed" as const) : ("succeeded" as const),
      counts,
    };
  });
  const lookupLayer = makeMigrationReferenceLookupLayer({
    createStubReference,
    definitions,
  });
  const layer = Layer.mergeAll(
    definition.source.layer,
    definition.destination.layer,
    definition.store,
    lookupLayer
  );

  return program.pipe(Effect.provide(layer));
};

const runRollbackMigrationDefinition = <
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor,
  RollbackPipelineError,
>(
  definition: MigrationDefinition<
    Source,
    Command,
    PipelineError,
    Cursor,
    RollbackPipelineError
  >,
  runId: MigrationRunId,
  options: RollbackMigrationOptions
): Effect.Effect<
  RollbackDefinitionRunSummary,
  RollbackMigrationDefinitionError | RollbackPreflightError
> => {
  const program = Effect.gen(function* () {
    const store = yield* MigrationStore;
    const counts = { ...emptyRollbackCounts };

    if (options.sourceIdentities === undefined) {
      const itemStates = yield* store.listItemStates(definition.id);

      for (const itemState of itemStates) {
        yield* rollbackItemState({
          counts,
          definition,
          itemState,
          runId,
          store,
        });
      }
    } else {
      for (const sourceIdentity of options.sourceIdentities) {
        const itemState = yield* store.getItemState(
          definition.id,
          sourceIdentity
        );

        if (itemState === null) {
          counts.skipped += 1;
          continue;
        }

        yield* rollbackItemState({
          counts,
          definition,
          itemState,
          runId,
          store,
        });
      }
    }

    return {
      counts,
      definitionId: definition.id,
      status: counts.failed > 0 ? ("failed" as const) : ("succeeded" as const),
    };
  });

  const layer = Layer.mergeAll(definition.destination.layer, definition.store);

  return program.pipe(Effect.provide(layer));
};

const hasSelectedRollbackableItemState = (
  store: typeof MigrationStore.Service,
  definition: AnyMigrationDefinition,
  options: RollbackMigrationOptions
): Effect.Effect<boolean, MigrationStoreError> =>
  Effect.gen(function* () {
    if (options.sourceIdentities !== undefined) {
      for (const sourceIdentity of options.sourceIdentities) {
        const itemState = yield* store.getItemState(
          definition.id,
          sourceIdentity
        );

        if (itemState !== null && isRollbackableItemState(itemState)) {
          return true;
        }
      }

      return false;
    }

    const itemStates = yield* store.listItemStates(definition.id);

    return itemStates.some(isRollbackableItemState);
  });

const validateRollbackPipelinePreflight = (
  store: typeof MigrationStore.Service,
  definition: AnyMigrationDefinition,
  options: RollbackMigrationOptions
): Effect.Effect<void, MigrationStoreError | RollbackPreflightError> =>
  definition.rollback === undefined
    ? Effect.gen(function* () {
        const hasRollbackableState = yield* hasSelectedRollbackableItemState(
          store,
          definition,
          options
        );

        if (hasRollbackableState) {
          return yield* missingRollbackPipelineError(definition.id);
        }
      })
    : Effect.void;

export function rollbackMigration<
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor = unknown,
  RollbackPipelineError = PipelineError,
>(
  definition: MigrationDefinition<
    Source,
    Command,
    PipelineError,
    Cursor,
    RollbackPipelineError
  >,
  optionsInput?: undefined
): Effect.Effect<
  RollbackRunSummary,
  RollbackMigrationDefinitionError | RollbackPreflightError
>;
export function rollbackMigration<
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor = unknown,
  RollbackPipelineError = PipelineError,
>(
  definition: MigrationDefinition<
    Source,
    Command,
    PipelineError,
    Cursor,
    RollbackPipelineError
  >,
  optionsInput: RollbackMigrationOptionsInput | undefined
): Effect.Effect<RollbackRunSummary, RollbackMigrationError>;
export function rollbackMigration<
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor = unknown,
  RollbackPipelineError = PipelineError,
>(
  definition: MigrationDefinition<
    Source,
    Command,
    PipelineError,
    Cursor,
    RollbackPipelineError
  >,
  optionsInput: RollbackMigrationOptionsInput = {}
): Effect.Effect<RollbackRunSummary, RollbackMigrationError> {
  const optionsEffect = Effect.try({
    try: () => makeRollbackMigrationOptions(optionsInput),
    catch: invalidRollbackRequestError,
  });

  return Effect.flatMap(optionsEffect, (options) => {
    const program = Effect.gen(function* () {
      const store = yield* MigrationStore;
      const definitionIds = [definition.id];
      const run = yield* executeMigrationRun(
        store,
        definitionIds,
        (runId) =>
          runRollbackMigrationDefinition(definition, runId, options).pipe(
            Effect.map((summary) => ({
              status:
                summary.status === "failed"
                  ? ("failed" as const)
                  : ("succeeded" as const),
              value: [summary],
            }))
          ),
        () => validateRollbackPipelinePreflight(store, definition, options)
      );

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

export const runMigrations = <
  Definitions extends readonly AnyMigrationDefinition[],
>(
  input: RunRequestInput<Definitions>
): Effect.Effect<MigrationRunSummary, RunMigrationError> => {
  const requestEffect = Effect.try({
    try: () => makeRunRequest(input),
    catch: invalidRunRequestError,
  });

  return Effect.flatMap(
    requestEffect,
    (request): Effect.Effect<MigrationRunSummary, RunMigrationError> => {
      const firstDefinition = request.definitions[0];

      if (firstDefinition === undefined) {
        return Effect.fail(emptyRunError);
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

      const sharedStoreError = validateSharedStore(
        orderedDefinitions.definitions
      );

      if (sharedStoreError !== null) {
        return Effect.fail(sharedStoreError);
      }

      const definitionIds = orderedDefinitions.definitions.map(
        (definition) => definition.id
      );

      const program = Effect.gen(function* () {
        const store = yield* MigrationStore;

        const run = yield* executeMigrationRun(store, definitionIds, (runId) =>
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
                    request.definitions,
                    runId,
                    request.mode ?? normalRunMode,
                    stubRunScope.createStubReference
                  );
                  summaries.push(summary);
                }

                return {
                  status: runStatusForDefinitions(summaries),
                  value: summaries,
                };
              })
          )
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
    }
  );
};

export const runMigration = <
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor = unknown,
>(
  definition: MigrationDefinition<Source, Command, PipelineError, Cursor>
): Effect.Effect<MigrationRunSummary, RunMigrationError> => {
  const program = Effect.gen(function* () {
    const store = yield* MigrationStore;
    const definitionIds = [definition.id];

    const run = yield* executeMigrationRun(store, definitionIds, (runId) => {
      const activeRun = {
        definitionIds,
        runId,
        store,
      };

      return withStubRunScope(activeRun, (stubRunScope) =>
        runMigrationDefinition(
          definition,
          [definition],
          runId,
          normalRunMode,
          stubRunScope.createStubReference
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
    });

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
