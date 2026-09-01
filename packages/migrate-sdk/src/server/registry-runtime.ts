import { Deferred, Effect, Fiber, Layer, Option, Ref, Schema } from "effect";
import {
  type ActiveMigrationRun,
  type AnySelfContainedMigrationDefinition,
  activeMigrationRunFromState,
  type ExecutionStartResult,
  type MigrationDefinitionExecutableRollbackPlan,
  type MigrationDefinitionExecutableRunPlan,
  type MigrationDefinitionId,
  type MigrationDefinitionLock,
  type MigrationDefinitionRegistry,
  type MigrationDefinitionRegistryEntry,
  type MigrationDefinitionRegistryGroup,
  type MigrationDefinitionRegistryId,
  type MigrationDefinitionRegistryMessagesReport,
  type MigrationDefinitionRegistryStatusReport,
  type MigrationDefinitionStatus,
  type MigrationExecutableObservationResult,
  type MigrationExecutableProgressCheckpoint,
  type MigrationExecutableService,
  type MigrationExecutionOptions,
  type MigrationItemState,
  type MigrationMessage,
  MigrationProgress,
  type MigrationRunId,
  type MigrationRunState,
  type MigrationRunSummary,
  MigrationStore,
  makeMigrationRunState,
  RollbackProgress,
  type RollbackRunSummary,
  SourceIdentity,
  type SourceIdentitySnapshotKey,
  type SourceItemTotal,
} from "../index.ts";
import type {
  MigrateAction,
  MigrateActiveRun,
  MigrateBreakLockResult,
  MigrateDashboardRow,
  MigrateDefinitionIds,
  MigrateDefinitionSourceItemTotal,
  MigrateDependencyCheck,
  MigrateExecutionState,
  MigrateRegistryMessagesRequest,
  MigrateRegistryStatusRequest,
  MigrateSelection,
  MigrateSourceIdentityHistoryEntry,
  MigrateSourceItemTotal,
  MigrateTarget,
  MigrateTerminalSummary,
} from "../protocol/index.ts";
import { toMigrationDefinitionRegistrySelectionInput } from "../protocol/registry-selection.ts";
import { MigrationDefinitionSource } from "../services/migration-definition-source.ts";
import {
  isTerminalRunState,
  waitForDurableRunState,
} from "./durable-observation.ts";
import type {
  MigrateServerExecutionHandle,
  MigrateServerExecutionObserver,
  MigrateServerExecutionResult,
  MigrateServerExecutionStopResult,
} from "./service.ts";

const readStoredMigrationRunState = (
  store: (typeof MigrationStore)["Service"],
  runId: MigrationRunId,
  legacyDefinitionId: MigrationDefinitionId
) =>
  store
    .getRunState(runId)
    .pipe(
      Effect.flatMap((stored) =>
        stored === null
          ? store
              .getLatestRunState(legacyDefinitionId)
              .pipe(
                Effect.map((latest) =>
                  latest?.runId === runId ? makeMigrationRunState(latest) : null
                )
              )
          : Effect.succeed(stored)
      )
    );

class RegistryMigrateServerProviderObservationError extends Schema.TaggedError<RegistryMigrateServerProviderObservationError>()(
  "RegistryMigrateServerProviderObservationError",
  {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
  }
) {}

class RegistryMigrateServerExecutionError extends Schema.TaggedError<RegistryMigrateServerExecutionError>()(
  "RegistryMigrateServerExecutionError",
  {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
  }
) {}

const executionResultFromRunState = (
  state: MigrationRunState,
  message = `Run ${state.runId} ${state.status}`
): MigrateServerExecutionResult => {
  let outcome: MigrateServerExecutionResult["outcome"] = "completed";

  if (state.status === "cancelled") {
    outcome = "cancelled";
  } else if (state.status === "start-failed") {
    outcome = "failed";
  }

  return { message, outcome, runId: state.runId };
};

const projectTerminalSummary = (
  summary: MigrationRunSummary | RollbackRunSummary
): MigrateTerminalSummary =>
  "kind" in summary ? summary : { ...summary, kind: "run" };

const executionResultFromSummary = (
  summary: MigrationRunSummary | RollbackRunSummary
): MigrateServerExecutionResult => ({
  message: `Run ${summary.runId} ${summary.status}`,
  outcome: summary.status === "cancelled" ? "cancelled" : "completed",
  runId: summary.runId,
  summary: projectTerminalSummary(summary),
});

interface DetachedRunTerminal {
  readonly executionFailure?: unknown;
  readonly state: MigrationRunState;
  readonly summary?: MigrationRunSummary | RollbackRunSummary;
}

const executionResultFromDetachedTerminal = (
  terminal: DetachedRunTerminal
): MigrateServerExecutionResult => {
  if (terminal.executionFailure !== undefined) {
    return {
      message: causeMessage(terminal.executionFailure),
      outcome: "failed",
      runId: terminal.state.runId,
    };
  }

  return terminal.summary === undefined
    ? executionResultFromRunState(terminal.state)
    : executionResultFromSummary(terminal.summary);
};

class RegistryMigrateServerError extends Schema.TaggedError<RegistryMigrateServerError>()(
  "RegistryMigrateServerError",
  {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
  }
) {}

const causeMessage = (cause: unknown): string => {
  if (cause instanceof Error) {
    return cause.message;
  }

  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }

  return String(cause);
};

const migrateSourceItemTotalValue = (
  total: SourceItemTotal
): MigrateSourceItemTotal => {
  switch (total.kind) {
    case "known":
      return { count: total.count, kind: total.kind };
    case "lower-bound":
      return {
        kind: total.kind,
        minimum: total.minimum,
        reason: total.reason,
      };
    case "unknown":
      return { kind: total.kind, reason: total.reason };
    default: {
      const exhaustive: never = total;
      return exhaustive;
    }
  }
};

type MigrateRunAction = Exclude<MigrateAction, "rollback">;

export type ExecutableMigrationOperation =
  | {
      readonly action: MigrateRunAction;
      readonly dependencyChecks: readonly MigrateDependencyCheck[];
      readonly observationDefinitionId: MigrationDefinitionId;
      readonly plan: MigrationDefinitionExecutableRunPlan<
        readonly AnySelfContainedMigrationDefinition[]
      >;
      readonly planRows: readonly MigrateDashboardRow[];
      readonly selection: MigrateSelection;
      readonly sourceIdentities?: readonly string[];
    }
  | {
      readonly action: "rollback";
      readonly dependencyChecks: readonly [];
      readonly observationDefinitionId: MigrationDefinitionId;
      readonly plan: MigrationDefinitionExecutableRollbackPlan;
      readonly planRows: readonly MigrateDashboardRow[];
      readonly selection: MigrateSelection;
      readonly sourceIdentities?: readonly string[];
    };

export interface MigrateServerScanOptions {
  readonly concurrency?: number;
}

export interface MigrateServerPrepareOptions {
  readonly execution?: MigrationExecutionOptions;
  readonly force?: boolean;
  readonly rollbackOrphans?: boolean;
  readonly sourceIdentities?: readonly string[];
  readonly withDependencies?: boolean;
}

export interface MigrateServerSnapshot {
  readonly activeRuns: readonly MigrateActiveRun[];
  readonly rows: readonly MigrateDashboardRow[];
  readonly scannedSource: boolean;
}

export type RegistryMigrateServerExecutionObserver =
  Partial<MigrateServerExecutionObserver>;

type MigrateServerExecutionPhase =
  | { readonly kind: "starting" }
  | {
      readonly kind: "server-owned";
      readonly runId: MigrationRunId;
    }
  | {
      readonly kind: "provider-owned";
      readonly runId: MigrationRunId;
    }
  | { readonly kind: "terminal" };

export interface RegistryMigrateServerRuntime {
  readonly breakLock: (
    lock: MigrationDefinitionLock
  ) => Effect.Effect<MigrateBreakLockResult, unknown>;
  readonly entries: readonly MigrationDefinitionRegistryEntry[];
  readonly getRegistryMessages: (
    input: MigrateRegistryMessagesRequest
  ) => Effect.Effect<MigrationDefinitionRegistryMessagesReport, unknown>;
  readonly getRegistryStatus: (
    input: MigrateRegistryStatusRequest
  ) => Effect.Effect<MigrationDefinitionRegistryStatusReport, unknown>;
  readonly getRunProgress: (
    runId: MigrationRunId,
    observationDefinitionId?: MigrationDefinitionId
  ) => Effect.Effect<
    | {
        readonly definitions: readonly MigrationDefinitionStatus[];
        readonly observationDefinitionId: MigrationDefinitionId;
      }
    | undefined,
    unknown
  >;
  readonly getSourceItemTotals: (
    definitionIds: MigrateDefinitionIds
  ) => Effect.Effect<readonly MigrateDefinitionSourceItemTotal[], unknown>;
  readonly groups: readonly MigrationDefinitionRegistryGroup[];
  readonly hasActiveExecutions: () => boolean;
  readonly listActiveRuns: Effect.Effect<readonly MigrateActiveRun[], unknown>;
  readonly listMessages: (
    target: MigrateTarget
  ) => Effect.Effect<readonly MigrationMessage[], unknown>;
  readonly listSourceIdentityHistory: (
    definitionId: MigrationDefinitionId
  ) => Effect.Effect<readonly MigrateSourceIdentityHistoryEntry[], unknown>;
  readonly normalizeSourceIdentity: (
    definitionId: MigrationDefinitionId,
    sourceIdentity: string
  ) => Effect.Effect<string, unknown>;
  readonly observeRun: (
    runId: MigrationRunId,
    observer?: RegistryMigrateServerExecutionObserver,
    observationDefinitionId?: MigrationDefinitionId
  ) => Effect.Effect<MigrateServerExecutionResult, unknown>;
  readonly prepare: (
    selection: MigrateSelection,
    action: MigrateAction,
    options?: MigrateServerPrepareOptions
  ) => Effect.Effect<ExecutableMigrationOperation, unknown>;
  readonly refresh: Effect.Effect<MigrateServerSnapshot, unknown>;
  readonly registryId?: MigrationDefinitionRegistryId;
  readonly rows: readonly MigrateDashboardRow[];
  readonly scanSource: (
    target: MigrateTarget,
    options?: MigrateServerScanOptions
  ) => Effect.Effect<MigrateServerSnapshot, unknown>;
  readonly startExecution: (
    operation: ExecutableMigrationOperation,
    observer?: RegistryMigrateServerExecutionObserver
  ) => Effect.Effect<MigrateServerExecutionHandle>;
  readonly stopRun: (
    runId: MigrationRunId
  ) => Effect.Effect<MigrateServerExecutionStopResult, unknown>;
  readonly watchDashboardRun: (
    run: MigrateActiveRun,
    invalidate: Effect.Effect<void>
  ) => Effect.Effect<void, unknown>;
}

export interface RegistryMigrateServerRuntimeOptions {
  readonly progressFallbackIntervalMs?: number;
  readonly providerSettlementGraceMs?: number;
  readonly terminalPollIntervalMs?: number;
}

export interface MakeRegistryMigrateServerRuntimeInput
  extends RegistryMigrateServerRuntimeOptions {
  readonly executable: MigrationExecutableService;
  readonly registry: MigrationDefinitionRegistry<
    readonly AnySelfContainedMigrationDefinition[]
  >;
}

const readItemStates = (
  registry: MigrationDefinitionRegistry<
    readonly AnySelfContainedMigrationDefinition[]
  >,
  definitionId: MigrationDefinitionId
): Effect.Effect<readonly MigrationItemState[], unknown> => {
  const definition = Option.getOrUndefined(registry.get(definitionId));

  if (definition === undefined) {
    return Effect.fail(
      new RegistryMigrateServerError({
        message: `Migration was not found: ${definitionId}`,
      })
    );
  }

  const read = Effect.gen(function* () {
    const store = yield* MigrationStore;

    return yield* store.listItemStates(definitionId);
  }).pipe(Effect.provide(definition.store));

  return read;
};

const sourceIdentityPartText = (part: string | number | boolean): string =>
  encodeURIComponent(String(part));

const sourceIdentityKeyText = (key: SourceIdentitySnapshotKey): string =>
  Array.isArray(key)
    ? key.map(sourceIdentityPartText).join(":")
    : sourceIdentityPartText(key as string | number | boolean);

export const makeRegistryMigrateServerRuntime = (
  input: MakeRegistryMigrateServerRuntimeInput
): RegistryMigrateServerRuntime => {
  const registry = input.registry;
  const entries = registry.list();
  const groups = registry.groups();
  const definitionsById = new Map(
    registry.definitions().map((definition) => [definition.id, definition])
  );
  const registryId = Option.getOrUndefined(registry.id());
  const executable = input.executable;
  const rows = entries.map((entry) => ({ entry }));
  const progressFallbackIntervalMs = input.progressFallbackIntervalMs ?? 5000;
  const providerSettlementGraceMs = input.providerSettlementGraceMs ?? 2000;
  const terminalPollIntervalMs = input.terminalPollIntervalMs ?? 500;

  const getRegistryMessages = (input: MigrateRegistryMessagesRequest) =>
    registry.messages(toMigrationDefinitionRegistrySelectionInput(input));

  const getRegistryStatus = (input: MigrateRegistryStatusRequest) =>
    registry.status({
      ...toMigrationDefinitionRegistrySelectionInput(input),
      ...(input.concurrency === undefined
        ? {}
        : { concurrency: input.concurrency }),
      scanSource: input.scanSource,
    });

  const readExecutionProgressEffect = (
    definitionIds: readonly MigrationDefinitionId[]
  ): Effect.Effect<readonly MigrationDefinitionStatus[], unknown> => {
    const firstDefinitionId = definitionIds[0];

    if (firstDefinitionId === undefined) {
      return Effect.succeed([]);
    }

    const requestedDefinitionIds: readonly [
      MigrationDefinitionId,
      ...MigrationDefinitionId[],
    ] = [firstDefinitionId, ...definitionIds.slice(1)];
    const requestedDefinitionIdSet = new Set(requestedDefinitionIds);

    return registry
      .status({
        definitionIds: requestedDefinitionIds,
        scanSource: false,
        withDependencies: true,
      })
      .pipe(
        Effect.map((report) =>
          report.definitions.filter((definition) =>
            requestedDefinitionIdSet.has(definition.definitionId)
          )
        )
      );
  };

  const readLocatedRunStateEffect = (
    runId: MigrationRunId,
    observationDefinitionId?: MigrationDefinitionId
  ): Effect.Effect<
    | {
        readonly observationDefinitionId: MigrationDefinitionId;
        readonly state: MigrationRunState;
      }
    | undefined,
    unknown
  > =>
    Effect.gen(function* () {
      const readCandidate = (definitionId: MigrationDefinitionId) => {
        const definition = Option.getOrUndefined(registry.get(definitionId));

        if (definition === undefined) {
          return Effect.void;
        }

        return MigrationStore.pipe(
          Effect.flatMap((store) =>
            readStoredMigrationRunState(store, runId, definitionId)
          ),
          Effect.provide(definition.store)
        );
      };

      if (observationDefinitionId !== undefined) {
        const state = yield* readCandidate(observationDefinitionId);

        return state?.definitionIds.includes(observationDefinitionId)
          ? { observationDefinitionId, state }
          : undefined;
      }

      for (const entry of entries) {
        const state = yield* readCandidate(entry.id);

        if (state?.definitionIds.includes(entry.id)) {
          return { observationDefinitionId: entry.id, state };
        }
      }

      return;
    });

  const readRunStateEffect = (
    runId: MigrationRunId,
    observationDefinitionId?: MigrationDefinitionId
  ): Effect.Effect<MigrationRunState | null, unknown> =>
    readLocatedRunStateEffect(runId, observationDefinitionId).pipe(
      Effect.map((located) => located?.state ?? null)
    );

  const getRunProgress = (
    runId: MigrationRunId,
    observationDefinitionId?: MigrationDefinitionId
  ): Effect.Effect<
    | {
        readonly definitions: readonly MigrationDefinitionStatus[];
        readonly observationDefinitionId: MigrationDefinitionId;
      }
    | undefined,
    unknown
  > =>
    Effect.gen(function* () {
      const activeRun =
        observationDefinitionId === undefined
          ? (yield* listActiveRunsEffect).find(
              (candidate) => candidate.runId === runId
            )
          : undefined;
      const requestedObservationDefinitionId =
        observationDefinitionId ?? activeRun?.observationDefinitionId;
      const located = yield* readLocatedRunStateEffect(
        runId,
        requestedObservationDefinitionId
      );

      if (located === undefined) {
        return;
      }

      return {
        definitions: yield* readExecutionProgressEffect(
          located.state.definitionIds
        ),
        observationDefinitionId: located.observationDefinitionId,
      };
    });

  const observeDetachedRunEffect = ({
    definitionId,
    execution,
    onProgressCheckpoint,
    onProviderObservationError,
    runId,
  }: {
    readonly definitionId: MigrationDefinitionId;
    readonly execution: {
      readonly adapter: string;
      readonly executionId: string;
    };
    readonly onProgressCheckpoint?: (
      checkpoint: MigrationExecutableProgressCheckpoint
    ) => Effect.Effect<void>;
    readonly onProviderObservationError?: (cause: unknown) => void;
    readonly runId: MigrationRunId;
  }): Effect.Effect<DetachedRunTerminal, unknown> => {
    const definition = Option.getOrUndefined(registry.get(definitionId));

    if (definition === undefined) {
      return Effect.fail(
        new RegistryMigrateServerExecutionError({
          message: `Migration was not found: ${definitionId}`,
        })
      );
    }

    const observe = Effect.gen(function* () {
      const store = yield* MigrationStore;
      const readRunState = readStoredMigrationRunState(
        store,
        runId,
        definitionId
      );
      const durableObservation = waitForDurableRunState({
        pollIntervalMs: terminalPollIntervalMs,
        readRunState,
        runId,
      }).pipe(Effect.map((state) => ({ state })));
      const providerObservation = executable.waitForExecution?.(execution, {
        ...(onProgressCheckpoint === undefined
          ? {}
          : {
              onProgressCheckpoint: (checkpoint) =>
                checkpoint.runId === runId
                  ? onProgressCheckpoint(checkpoint)
                  : Effect.void,
            }),
      });

      if (providerObservation === undefined) {
        return yield* durableObservation;
      }

      const enrichDurableTerminal = (
        state: MigrationRunState,
        result: MigrationExecutableObservationResult
      ): Effect.Effect<DetachedRunTerminal> => {
        if (result.kind === "failed") {
          return Effect.succeed({
            executionFailure:
              result.cause ??
              new Error(`Provider execution ${execution.executionId} failed`),
            state,
          });
        }

        if (
          result.kind === "succeeded" &&
          result.summary !== undefined &&
          result.summary.runId !== runId
        ) {
          return Effect.sync(() =>
            onProviderObservationError?.(
              new Error(
                `Provider execution ${execution.executionId} returned summary for run ${result.summary?.runId}`
              )
            )
          ).pipe(Effect.as({ state }));
        }

        return Effect.succeed({
          state,
          ...(result.kind === "succeeded" && result.summary !== undefined
            ? { summary: result.summary }
            : {}),
        });
      };
      const observedProvider = providerObservation.pipe(
        Effect.match({
          onFailure: (cause) => ({ cause, kind: "unavailable" as const }),
          onSuccess: (result) => ({ kind: "observed" as const, result }),
        })
      );
      const providerFiber = yield* observedProvider.pipe(Effect.forkChild);
      const first = yield* Effect.raceFirst(
        durableObservation.pipe(
          Effect.map((terminal) => ({ kind: "durable" as const, terminal }))
        ),
        Fiber.join(providerFiber).pipe(
          Effect.map((provider) => ({ kind: "provider" as const, provider }))
        )
      );

      if (first.kind === "durable") {
        const provider = yield* Fiber.join(providerFiber).pipe(
          Effect.timeoutOption(providerSettlementGraceMs)
        );

        if (Option.isNone(provider)) {
          return first.terminal;
        }

        const providerResult = provider.value;

        if (providerResult.kind === "unavailable") {
          yield* Effect.sync(() =>
            onProviderObservationError?.(providerResult.cause)
          );
          return first.terminal;
        }

        return yield* enrichDurableTerminal(
          first.terminal.state,
          providerResult.result
        );
      }

      const providerResult = first.provider;

      if (providerResult.kind === "unavailable") {
        yield* Effect.sync(() =>
          onProviderObservationError?.(providerResult.cause)
        );
        return yield* durableObservation;
      }

      if (providerResult.result.kind === "succeeded") {
        const terminal = yield* durableObservation;
        return yield* enrichDurableTerminal(
          terminal.state,
          providerResult.result
        );
      }

      yield* Effect.sleep(providerSettlementGraceMs);
      const state = yield* readRunState;

      if (
        state !== null &&
        state.runId === runId &&
        isTerminalRunState(state)
      ) {
        return yield* enrichDurableTerminal(state, providerResult.result);
      }

      return yield* new RegistryMigrateServerProviderObservationError({
        message: `Provider execution ${execution.executionId} ${providerResult.result.kind} before run ${runId} reached durable terminal state`,
        ...(providerResult.result.kind === "failed" &&
        providerResult.result.cause !== undefined
          ? { cause: providerResult.result.cause }
          : {}),
      });
    }).pipe(Effect.provide(definition.store));

    return observe;
  };
  const activeExecutions = new Set<symbol>();

  const getDefinition = (
    definitionId: MigrationDefinitionId
  ): Effect.Effect<
    AnySelfContainedMigrationDefinition,
    RegistryMigrateServerError
  > => {
    const definition = Option.getOrUndefined(registry.get(definitionId)) as
      | AnySelfContainedMigrationDefinition
      | undefined;

    if (definition === undefined) {
      return Effect.fail(
        new RegistryMigrateServerError({
          message: `Migration was not found: ${definitionId}`,
        })
      );
    }

    return Effect.succeed(definition);
  };

  const normalizeSourceIdentity = (
    definitionId: MigrationDefinitionId,
    sourceIdentity: string
  ): Effect.Effect<string, unknown> =>
    Effect.gen(function* () {
      const definition = yield* getDefinition(definitionId);
      const identity = yield* Effect.try({
        catch: (cause) =>
          new RegistryMigrateServerError({
            cause,
            message: causeMessage(cause),
          }),
        try: () =>
          SourceIdentity.fromText(definition.source.identity, sourceIdentity),
      });

      return sourceIdentityKeyText(identity.key);
    });

  const listSourceIdentityHistory = (
    definitionId: MigrationDefinitionId
  ): Effect.Effect<readonly MigrateSourceIdentityHistoryEntry[], unknown> =>
    Effect.gen(function* () {
      const definition = yield* getDefinition(definitionId);
      const states = yield* readItemStates(registry, definitionId);

      return yield* Effect.try({
        catch: (cause) =>
          new RegistryMigrateServerError({
            cause,
            message: causeMessage(cause),
          }),
        try: () =>
          states
            .map((state) => {
              const identity = SourceIdentity.fromEncoded(
                definition.source.identity,
                state.sourceIdentity.encoded
              );

              return {
                sourceIdentity: sourceIdentityKeyText(identity.key),
                status: state.status,
                updatedAt: state.updatedAt,
              };
            })
            .sort(
              (left, right) =>
                right.updatedAt.getTime() - left.updatedAt.getTime()
            ),
      });
    });

  const breakLock = (
    expectedLock: MigrationDefinitionLock
  ): Effect.Effect<MigrateBreakLockResult, unknown> =>
    Effect.gen(function* () {
      const definition = yield* getDefinition(expectedLock.definitionId);
      const kind = yield* Effect.gen(function* () {
        const store = yield* MigrationStore;
        const currentLock = yield* store.getDefinitionLock(
          expectedLock.definitionId
        );

        if (currentLock === null) {
          return "already-clear" as const;
        }

        yield* store.releaseDefinitionLock(expectedLock);
        return "cleared" as const;
      }).pipe(Effect.provide(definition.store));

      return { definitionId: expectedLock.definitionId, kind };
    });

  const withDurableStop = (run: ActiveMigrationRun): MigrateActiveRun => ({
    ...run,
    stopSupported: true,
  });

  const readSnapshot = (
    scanTarget?: MigrateTarget,
    scanOptions: MigrateServerScanOptions = {}
  ): Effect.Effect<MigrateServerSnapshot, unknown> =>
    Effect.gen(function* () {
      const initial = yield* Effect.all({
        activeRuns: registry
          .activeRuns()
          .pipe(Effect.map((runs) => runs.map(withDurableStop))),
        durableReport: registry.status({
          all: true,
          scanSource: false,
        }),
      });
      const { activeRuns, durableReport } = initial;
      const statuses = new Map(
        durableReport.definitions.map((status) => [status.definitionId, status])
      );

      if (scanTarget !== undefined) {
        const scannedReport: MigrationDefinitionRegistryStatusReport =
          yield* scanTarget.kind === "group"
            ? registry.status({
                ...(scanOptions.concurrency === undefined
                  ? {}
                  : { concurrency: scanOptions.concurrency }),
                group: scanTarget.groupId,
                scanSource: true,
                withDependencies: true,
              })
            : registry.status({
                ...(scanOptions.concurrency === undefined
                  ? {}
                  : { concurrency: scanOptions.concurrency }),
                definitionIds: [scanTarget.definitionId],
                scanSource: true,
                withDependencies: true,
              });

        for (const status of scannedReport.definitions) {
          statuses.set(status.definitionId, status);
        }
      }

      return {
        activeRuns,
        rows: entries.map((entry) => {
          const status = statuses.get(entry.id);

          return {
            entry,
            ...(status === undefined ? {} : { status }),
          };
        }),
        scannedSource: scanTarget !== undefined,
      };
    });

  const readRows = readSnapshot().pipe(Effect.map((snapshot) => snapshot.rows));

  const refresh = readSnapshot();

  const listActiveRunsEffect = registry
    .activeRuns()
    .pipe(Effect.map((runs) => runs.map(withDurableStop)));

  const stopRun = (
    runId: MigrationRunId
  ): Effect.Effect<MigrateServerExecutionStopResult, unknown> =>
    Effect.gen(function* () {
      const activeRun = (yield* listActiveRunsEffect).find(
        (candidate) => candidate.runId === runId
      );

      if (activeRun === undefined) {
        return { kind: "idle" as const };
      }

      const definition = Option.getOrUndefined(
        registry.get(activeRun.observationDefinitionId)
      );

      if (definition === undefined) {
        return yield* new RegistryMigrateServerExecutionError({
          message: `Migration was not found: ${activeRun.observationDefinitionId}`,
        });
      }

      const state = yield* MigrationStore.pipe(
        Effect.flatMap((store) =>
          store.requestRunCancellation(runId, activeRun.definitionIds)
        ),
        Effect.provide(definition.store)
      );

      return state.status === "cancelling"
        ? {
            kind: "requested" as const,
            message: `Cancelling run ${runId}; waiting for active work to finish…`,
          }
        : { kind: "idle" as const };
    });

  const scanSource = (
    target: MigrateTarget,
    options: MigrateServerScanOptions = {}
  ): Effect.Effect<MigrateServerSnapshot, unknown> =>
    readSnapshot(target, options);

  const countDefinitionSourceItems = (
    definition: AnySelfContainedMigrationDefinition
  ): Effect.Effect<MigrateDefinitionSourceItemTotal> => {
    const count = Effect.gen(function* () {
      const source = yield* MigrationDefinitionSource.get(definition);

      if (source.countTotal === undefined) {
        return {
          kind: "unknown" as const,
          reason: "unsupported" as const,
        };
      }

      return migrateSourceItemTotalValue(yield* source.countTotal());
    }).pipe(
      Effect.provide(MigrationDefinitionSource.layer(definition)),
      Effect.orElseSucceed(() => ({
        kind: "unknown" as const,
        reason: "failed" as const,
      }))
    );

    return count.pipe(
      Effect.map((total) => ({ definitionId: definition.id, total }))
    );
  };

  const getSourceItemTotals = (
    definitionIds: MigrateDefinitionIds
  ): Effect.Effect<readonly MigrateDefinitionSourceItemTotal[], unknown> =>
    Effect.gen(function* () {
      const definitions: AnySelfContainedMigrationDefinition[] = [];

      for (const definitionId of new Set(definitionIds)) {
        const definition = definitionsById.get(definitionId);

        if (definition === undefined) {
          return yield* new RegistryMigrateServerError({
            message: `Migration was not found: ${definitionId}`,
          });
        }

        definitions.push(definition);
      }

      return yield* Effect.forEach(definitions, countDefinitionSourceItems);
    });

  const readPlanRows = (definitionIds: readonly MigrationDefinitionId[]) =>
    Effect.map(readRows, (statusRows) => {
      const rowsById = new Map(statusRows.map((row) => [row.entry.id, row]));
      const planRows = definitionIds.flatMap((definitionId) => {
        const row = rowsById.get(definitionId);

        return row === undefined ? [] : [row];
      });

      return { planRows, rowsById };
    });

  const prepareRollback = (
    selection: MigrateSelection,
    options: MigrateServerPrepareOptions
  ): Effect.Effect<ExecutableMigrationOperation, unknown> =>
    Effect.gen(function* () {
      const withDependencies =
        options.withDependencies ??
        (selection.kind === "definitions" &&
          selection.definitionIds.length === 1);
      const commonOptions = {
        ...(options.execution === undefined
          ? {}
          : { execution: options.execution }),
        ...(options.force === undefined ? {} : { force: options.force }),
        ...(options.sourceIdentities === undefined
          ? {}
          : { sourceIdentities: options.sourceIdentities }),
        withDependencies,
      };
      let plan: MigrationDefinitionExecutableRollbackPlan;

      if (selection.kind === "all") {
        plan = yield* registry
          .executable()
          .planRollback({ all: true, ...commonOptions });
      } else if (selection.kind === "group") {
        plan = yield* registry
          .executable()
          .planRollback({ group: selection.groupId, ...commonOptions });
      } else {
        plan = yield* registry.executable().planRollback({
          definitionIds: selection.definitionIds,
          ...commonOptions,
        });
      }
      const observationDefinitionId =
        selection.kind === "definitions" && selection.definitionIds.length === 1
          ? selection.definitionIds[0]
          : plan.executionDefinitionIds[0];

      if (observationDefinitionId === undefined) {
        return yield* new RegistryMigrateServerExecutionError({
          message: "No migrations are available to roll back",
        });
      }

      const { planRows } = yield* readPlanRows(plan.executionDefinitionIds);

      return {
        action: "rollback",
        dependencyChecks: [],
        observationDefinitionId,
        plan,
        planRows,
        selection,
        ...(plan.target === undefined
          ? {}
          : { sourceIdentities: plan.target.sourceIdentities }),
      };
    });

  const planRun = (
    selection: MigrateSelection,
    action: MigrateRunAction,
    options: MigrateServerPrepareOptions
  ) => {
    const runOptions = {
      ...(options.execution === undefined
        ? {}
        : { execution: options.execution }),
      ...(action === "retry-failed"
        ? { mode: { kind: "failed" as const } }
        : {}),
      ...(action === "retry-skipped"
        ? { mode: { kind: "skipped" as const } }
        : {}),
      ...(action === "rescan" ? { rescan: true } : {}),
      ...(action === "update" ? { update: true } : {}),
      ...(options.rollbackOrphans === true ? { rollbackOrphans: true } : {}),
      ...(options.sourceIdentities === undefined
        ? {}
        : { sourceIdentities: options.sourceIdentities }),
    };
    const commonOptions = {
      ...(options.force === undefined ? {} : { force: options.force }),
      withDependencies: options.withDependencies ?? false,
      ...runOptions,
    };

    if (selection.kind === "all") {
      return registry.executable().planRun({ all: true, ...commonOptions });
    }

    if (selection.kind === "group") {
      return registry
        .executable()
        .planRun({ group: selection.groupId, ...commonOptions });
    }

    return registry.executable().planRun({
      definitionIds: selection.definitionIds,
      ...commonOptions,
    });
  };

  const dependencyChecksFor = (
    plan: MigrationDefinitionExecutableRunPlan<
      readonly AnySelfContainedMigrationDefinition[]
    >,
    rowsById: ReadonlyMap<MigrationDefinitionId, MigrateDashboardRow>
  ): readonly MigrateDependencyCheck[] =>
    (plan.requiredDependencyPreflight ?? []).map(
      (edge): MigrateDependencyCheck => {
        const row = rowsById.get(edge.toDefinitionId);
        const status = row?.status;

        return {
          dependencyId: edge.toDefinitionId,
          requiredByDefinitionId: edge.fromDefinitionId,
          ...(row === undefined ? {} : { row }),
          satisfied:
            status?.lastRun?.status === "succeeded" &&
            status.durable.failed === 0,
        };
      }
    );

  const prepareRun = (
    selection: MigrateSelection,
    action: MigrateRunAction,
    options: MigrateServerPrepareOptions
  ): Effect.Effect<ExecutableMigrationOperation, unknown> =>
    Effect.gen(function* () {
      if (
        options.sourceIdentities !== undefined &&
        (selection.kind !== "definitions" ||
          selection.definitionIds.length !== 1)
      ) {
        return yield* new RegistryMigrateServerExecutionError({
          message: "Select one migration to run specific source identities",
        });
      }

      const plan = yield* planRun(selection, action, options);
      const observationDefinitionId =
        selection.kind === "definitions" && selection.definitionIds.length === 1
          ? selection.definitionIds[0]
          : plan.executionDefinitionIds[0];

      if (observationDefinitionId === undefined) {
        return yield* new RegistryMigrateServerExecutionError({
          message: "No migrations are available to run",
        });
      }

      const { planRows, rowsById } = yield* readPlanRows(
        plan.executionDefinitionIds
      );
      const dependencyChecks = dependencyChecksFor(plan, rowsById);

      return {
        action,
        dependencyChecks,
        observationDefinitionId,
        plan,
        planRows,
        ...(plan.target === undefined
          ? {}
          : { sourceIdentities: plan.target.sourceIdentities }),
        selection,
      };
    });

  const prepare = (
    selection: MigrateSelection,
    action: MigrateAction,
    options: MigrateServerPrepareOptions = {}
  ): Effect.Effect<ExecutableMigrationOperation, unknown> =>
    action === "rollback"
      ? prepareRollback(selection, options)
      : prepareRun(selection, action, options);

  const makeExecutionProgress = (
    definitionIds: readonly MigrationDefinitionId[],
    options?: RegistryMigrateServerExecutionObserver
  ) => {
    const definitionIdSet = new Set(definitionIds);
    const invalidateDashboard = Effect.sync(() =>
      options?.onDashboardInvalidation?.()
    );
    const publish = (
      requestedDefinitionIds: readonly MigrationDefinitionId[]
    ): Effect.Effect<void> =>
      options?.onProgress === undefined
        ? Effect.void
        : readExecutionProgressEffect(requestedDefinitionIds).pipe(
            Effect.tap((definitions) =>
              Effect.sync(() => options.onProgress?.({ definitions }))
            ),
            Effect.catch((error) =>
              Effect.sync(() => options.onProgressError?.(error))
            ),
            Effect.asVoid
          );
    const publishDefinition = (
      definitionId: MigrationDefinitionId
    ): Effect.Effect<void> =>
      definitionIdSet.has(definitionId) ? publish([definitionId]) : Effect.void;
    const layer = Layer.merge(
      Layer.succeed(MigrationProgress, {
        emit: (event) =>
          invalidateDashboard.pipe(
            Effect.andThen(
              event.kind === "source-cursor-window-completed" ||
                event.kind === "definition-completed"
                ? publishDefinition(event.definitionId)
                : Effect.void
            )
          ),
      }),
      Layer.succeed(RollbackProgress, {
        emit: (event) =>
          invalidateDashboard.pipe(
            Effect.andThen(
              event.kind === "definition-completed"
                ? publishDefinition(event.definitionId)
                : Effect.void
            )
          ),
      })
    );
    const startFallback =
      options?.onProgress === undefined
        ? Effect.void
        : Effect.sleep(progressFallbackIntervalMs).pipe(
            Effect.andThen(publish(definitionIds)),
            Effect.forever,
            Effect.forkScoped,
            Effect.asVoid
          );

    return { layer, publish, publishDefinition, startFallback } as const;
  };

  const readCompletedRunResult = (
    runId: MigrationRunId
  ): Effect.Effect<MigrateServerExecutionResult, unknown> =>
    readRunStateEffect(runId).pipe(
      Effect.flatMap((state) => {
        if (state === null || !isTerminalRunState(state)) {
          return Effect.fail(
            new RegistryMigrateServerExecutionError({
              message: `Active migration run was not found: ${runId}`,
            })
          );
        }

        return Effect.succeed(executionResultFromRunState(state));
      })
    );

  const locateRunForObservation = (
    runId: MigrationRunId,
    observationDefinitionId?: MigrationDefinitionId
  ): Effect.Effect<
    {
      readonly activeRun: MigrateActiveRun | undefined;
      readonly state: MigrationRunState | null | undefined;
    },
    unknown
  > =>
    Effect.gen(function* () {
      if (observationDefinitionId === undefined) {
        return {
          activeRun: (yield* listActiveRunsEffect).find(
            (candidate) => candidate.runId === runId
          ),
          state: undefined,
        };
      }

      const state = yield* readRunStateEffect(runId, observationDefinitionId);

      if (state === null) {
        return {
          activeRun: (yield* listActiveRunsEffect).find(
            (candidate) => candidate.runId === runId
          ),
          state,
        };
      }

      const activeRun = activeMigrationRunFromState(
        observationDefinitionId,
        state
      );

      return {
        activeRun: activeRun === null ? undefined : withDurableStop(activeRun),
        state,
      };
    });

  const observeRun = (
    runId: MigrationRunId,
    options?: RegistryMigrateServerExecutionObserver,
    observationDefinitionId?: MigrationDefinitionId
  ): Effect.Effect<MigrateServerExecutionResult, unknown> =>
    Effect.scoped(
      Effect.gen(function* () {
        const { activeRun, state } = yield* locateRunForObservation(
          runId,
          observationDefinitionId
        );

        if (activeRun === undefined) {
          if (state !== undefined && state !== null) {
            if (!isTerminalRunState(state)) {
              return yield* new RegistryMigrateServerExecutionError({
                message: `Active migration run was not found: ${runId}`,
              });
            }

            return executionResultFromRunState(state);
          }

          return yield* readCompletedRunResult(runId);
        }

        const execution = activeRun.execution;

        if (execution === undefined) {
          return yield* new RegistryMigrateServerExecutionError({
            message: `Migration run ${runId} does not have a reconnectable execution identity`,
          });
        }

        const progress = makeExecutionProgress(
          activeRun.definitionIds,
          options
        );
        yield* Effect.sync(() =>
          options?.onStateChange?.(
            activeRun.status === "cancelling"
              ? {
                  definitionId: activeRun.observationDefinitionId,
                  kind: "cancelling",
                  runId,
                }
              : {
                  adapter: execution.adapter,
                  definitionId: activeRun.observationDefinitionId,
                  executionId: execution.executionId,
                  kind: "running",
                  ownership: "provider",
                  runId,
                }
          )
        );
        yield* progress.startFallback;

        const terminal = yield* observeDetachedRunEffect({
          definitionId: activeRun.observationDefinitionId,
          execution,
          onProgressCheckpoint: (checkpoint) =>
            progress.publishDefinition(checkpoint.definitionId),
          onProviderObservationError: () =>
            options?.onObservationWarning?.(
              "Execution provider updates are unavailable; following durable migration state"
            ),
          runId,
        });

        yield* progress.publish(activeRun.definitionIds);

        return executionResultFromDetachedTerminal(terminal);
      })
    );

  const watchDashboardRun = (
    run: MigrateActiveRun,
    invalidate: Effect.Effect<void>
  ): Effect.Effect<void, unknown> => {
    const execution = run.execution;
    const waitForExecution = executable.waitForExecution;

    if (execution === undefined || waitForExecution === undefined) {
      return Effect.never;
    }

    return waitForExecution(execution, {
      onProgressCheckpoint: (checkpoint) =>
        checkpoint.runId === run.runId ? invalidate : Effect.void,
    }).pipe(Effect.asVoid, Effect.ensuring(invalidate));
  };

  const startExecution = (
    operation: ExecutableMigrationOperation,
    options?: RegistryMigrateServerExecutionObserver
  ): Effect.Effect<MigrateServerExecutionHandle> =>
    Effect.gen(function* () {
      const stopRequested = yield* Deferred.make<boolean>();
      const phase = yield* Ref.make<MigrateServerExecutionPhase>({
        kind: "starting",
      });
      const token = Symbol("RegistryMigrateServerExecution");
      const definitionIds = operation.plan.executionDefinitionIds;
      const progress = makeExecutionProgress(definitionIds, options);

      const notifyState = (state: MigrateExecutionState) =>
        Effect.sync(() => options?.onStateChange?.(state));

      const executeEffect = Effect.scoped(
        Effect.gen(function* () {
          yield* notifyState({
            definitionId: operation.observationDefinitionId,
            kind: "starting",
          });

          const startOperation: Effect.Effect<
            ExecutionStartResult<MigrationRunSummary | RollbackRunSummary>,
            unknown
          > = operation.action === "rollback"
            ? executable.startRollback(operation.plan).pipe(
                Effect.map(
                  (
                    result
                  ): ExecutionStartResult<
                    MigrationRunSummary | RollbackRunSummary
                  > => result
                ),
                Effect.provide(progress.layer)
              )
            : executable.startRun(operation.plan).pipe(
                Effect.map(
                  (
                    result
                  ): ExecutionStartResult<
                    MigrationRunSummary | RollbackRunSummary
                  > => result
                ),
                Effect.provide(progress.layer)
              );
          const started = yield* startOperation;

          if (started.kind === "completed") {
            yield* progress.publish(definitionIds);
            return executionResultFromSummary(started.summary);
          }

          if (started.handle !== undefined) {
            const handle = started.handle;

            return yield* Effect.gen(function* () {
              yield* Ref.set(phase, {
                kind: "server-owned",
                runId: started.runId,
              });
              yield* notifyState({
                adapter: started.execution.adapter,
                definitionId: operation.observationDefinitionId,
                kind: "running",
                ownership: "server",
                runId: started.runId,
              });
              yield* Deferred.await(stopRequested).pipe(
                Effect.flatMap((alreadyPersisted) =>
                  alreadyPersisted ? Effect.void : stopRun(started.runId)
                ),
                Effect.andThen(
                  notifyState({
                    definitionId: operation.observationDefinitionId,
                    kind: "cancelling",
                    runId: started.runId,
                  })
                ),
                Effect.andThen(handle.cancel),
                Effect.forkScoped({ startImmediately: true })
              );
              yield* progress.startFallback;

              const terminal = yield* handle.wait;

              yield* progress.publish(definitionIds);

              switch (terminal.kind) {
                case "cancelled":
                  return {
                    message: `Run ${terminal.state.runId} cancelled`,
                    outcome: "cancelled" as const,
                    runId: terminal.state.runId,
                  };
                case "execution-failed":
                  return {
                    message: causeMessage(terminal.cause),
                    outcome: "failed" as const,
                    runId: terminal.state.runId,
                  };
                case "finished":
                  return executionResultFromSummary(terminal.summary);
                default: {
                  const unhandled: never = terminal;
                  return unhandled;
                }
              }
            }).pipe(
              Effect.onInterrupt(() =>
                handle.cancel.pipe(Effect.andThen(handle.wait), Effect.ignore)
              )
            );
          }

          yield* Ref.set(phase, {
            kind: "provider-owned",
            runId: started.runId,
          });
          yield* notifyState({
            adapter: started.execution.adapter,
            definitionId: operation.observationDefinitionId,
            executionId: started.execution.executionId,
            kind: "running",
            ownership: "provider",
            runId: started.runId,
          });
          if (yield* Deferred.isDone(stopRequested)) {
            yield* stopRun(started.runId);
          }
          yield* progress.startFallback;

          const terminal = yield* observeDetachedRunEffect({
            definitionId: operation.observationDefinitionId,
            execution: started.execution,
            onProgressCheckpoint: (checkpoint) =>
              progress.publishDefinition(checkpoint.definitionId),
            onProviderObservationError: () =>
              options?.onObservationWarning?.(
                "Execution provider updates are unavailable; following durable migration state"
              ),
            runId: started.runId,
          });

          yield* progress.publish(definitionIds);

          return executionResultFromDetachedTerminal(terminal);
        })
      );

      const result = Effect.sync(() => {
        activeExecutions.add(token);
      }).pipe(
        Effect.andThen(executeEffect),
        Effect.ensuring(
          Ref.set(phase, { kind: "terminal" }).pipe(
            Effect.andThen(
              Effect.sync(() => {
                activeExecutions.delete(token);
              })
            )
          )
        )
      );
      const stop: Effect.Effect<MigrateServerExecutionStopResult, unknown> =
        Ref.get(phase).pipe(
          Effect.flatMap(
            (
              current
            ): Effect.Effect<MigrateServerExecutionStopResult, unknown> => {
              switch (current.kind) {
                case "server-owned":
                  return stopRun(current.runId).pipe(
                    Effect.tap((cancellation) =>
                      cancellation.kind === "requested"
                        ? Deferred.succeed(stopRequested, true)
                        : Effect.void
                    )
                  );
                case "provider-owned":
                  return stopRun(current.runId);
                case "starting":
                  return Deferred.succeed(stopRequested, false).pipe(
                    Effect.as({
                      kind: "requested" as const,
                      message: "Exit requested; waiting for the run to start…",
                    })
                  );
                case "terminal":
                  return Effect.succeed({ kind: "idle" as const });
                default: {
                  const unhandled: never = current;
                  return unhandled;
                }
              }
            }
          )
        );

      return { result, stop };
    });

  const listMessages = (
    target: MigrateTarget
  ): Effect.Effect<readonly MigrationMessage[], unknown> =>
    registry
      .messages(
        target.kind === "migration"
          ? { definitionIds: [target.definitionId] }
          : { group: target.groupId }
      )
      .pipe(Effect.map((report) => report.messages));

  return {
    breakLock,
    entries,
    getRegistryMessages,
    getRegistryStatus,
    groups,
    hasActiveExecutions: () => activeExecutions.size > 0,
    getRunProgress,
    getSourceItemTotals,
    listActiveRuns: listActiveRunsEffect,
    listMessages,
    listSourceIdentityHistory,
    normalizeSourceIdentity,
    observeRun,
    prepare,
    refresh,
    ...(registryId === undefined ? {} : { registryId }),
    rows,
    scanSource,
    startExecution,
    stopRun,
    watchDashboardRun,
  };
};
