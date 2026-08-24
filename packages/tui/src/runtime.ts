import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Layer, Option, Schema } from "effect";
import {
  type AnySelfContainedMigrationDefinition,
  type MigrationDefinitionExecutableRollbackPlan,
  type MigrationDefinitionExecutableRunPlan,
  type MigrationDefinitionGroupId,
  type MigrationDefinitionId,
  type MigrationDefinitionLock,
  type MigrationDefinitionRegistryEntry,
  type MigrationDefinitionRegistryGroup,
  type MigrationDefinitionRegistryStatusReport,
  type MigrationDefinitionStatus,
  MigrationExecutable,
  type MigrationExecutableProgressCheckpoint,
  type MigrationExecutionOptions,
  type MigrationItemState,
  type MigrationMessage,
  MigrationProgress,
  type MigrationRunId,
  type MigrationRunState,
  MigrationStore,
  makeMigrationRunState,
  RollbackProgress,
  SourceIdentity,
  type SourceIdentitySnapshotKey,
} from "migrate-sdk";
import {
  loadMigrationCliConfigWithPath,
  type MigrationCliConfig,
  MigrationCliConfigLoadError,
} from "migrate-sdk/cli";
import {
  isTerminalRunState,
  waitForDurableRunState,
} from "./durable-observation.ts";
import {
  type MigrationTuiCancellationResult,
  type MigrationTuiExecutionState,
  makeMigrationTuiExecutionController,
} from "./execution-controller.ts";
import { makeMigrationTuiExecutionProgressScheduler } from "./execution-progress.ts";

type MigrationTuiConfig = MigrationCliConfig<
  readonly AnySelfContainedMigrationDefinition[]
>;

class MigrationTuiProviderObservationError extends Schema.TaggedError<MigrationTuiProviderObservationError>()(
  "MigrationTuiProviderObservationError",
  {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
  }
) {}

export type MigrationTuiAction =
  | "rescan"
  | "retry-failed"
  | "retry-skipped"
  | "rollback"
  | "run"
  | "update";

type MigrationTuiRunAction = Exclude<MigrationTuiAction, "rollback">;

export type MigrationTuiTarget =
  | {
      readonly definitionId: MigrationDefinitionId;
      readonly kind: "migration";
    }
  | {
      readonly groupId: MigrationDefinitionGroupId;
      readonly kind: "group";
    };

export type MigrationTuiPreparedOperation =
  | {
      readonly action: MigrationTuiRunAction;
      readonly dependencyChecks: readonly MigrationTuiDependencyCheck[];
      readonly observationDefinitionId: MigrationDefinitionId;
      readonly plan: MigrationDefinitionExecutableRunPlan<
        readonly AnySelfContainedMigrationDefinition[]
      >;
      readonly planRows: readonly MigrationTuiRow[];
      readonly sourceIdentities?: readonly string[];
      readonly target: MigrationTuiTarget;
    }
  | {
      readonly action: "rollback";
      readonly dependencyChecks: readonly [];
      readonly observationDefinitionId: MigrationDefinitionId;
      readonly plan: MigrationDefinitionExecutableRollbackPlan;
      readonly planRows: readonly MigrationTuiRow[];
      readonly target: MigrationTuiTarget;
    };

export interface MigrationTuiDependencyCheck {
  readonly dependencyId: MigrationDefinitionId;
  readonly requiredByDefinitionId: MigrationDefinitionId;
  readonly row?: MigrationTuiRow;
  readonly satisfied: boolean;
}

export interface MigrationTuiPrepareOptions {
  readonly execution?: MigrationExecutionOptions;
  readonly force?: boolean;
  readonly sourceIdentities?: readonly string[];
  readonly withDependencies?: boolean;
}

export interface MigrationTuiScanSourceOptions {
  readonly concurrency?: number;
}

export interface MigrationTuiSourceIdentityHistoryEntry {
  readonly sourceIdentity: string;
  readonly status: MigrationItemState["status"];
  readonly updatedAt: Date;
}

export type MigrationTuiMessage = MigrationMessage;

export interface MigrationTuiRow {
  readonly entry: MigrationDefinitionRegistryEntry;
  readonly status?: MigrationDefinitionStatus;
}

export interface MigrationTuiSnapshot {
  readonly rows: readonly MigrationTuiRow[];
  readonly scannedSource: boolean;
}

export interface MigrationTuiBreakLockResult {
  readonly definitionId: MigrationDefinitionId;
  readonly kind: "already-clear" | "cleared";
}

export interface MigrationTuiExecuteOptions {
  readonly onObservationWarning?: (message: string) => void;
  readonly onProgress?: (progress: {
    readonly definitions: readonly MigrationDefinitionStatus[];
  }) => void;
  readonly onProgressError?: (cause: unknown) => void;
  readonly onStateChange?: (state: MigrationTuiExecutionState) => void;
}

export interface MigrationTuiRuntime {
  readonly breakLock: (
    lock: MigrationDefinitionLock
  ) => Promise<MigrationTuiBreakLockResult>;
  readonly cancelActiveExecution: () => Promise<MigrationTuiCancellationResult>;
  readonly configPath: string;
  readonly execute: (
    operation: MigrationTuiPreparedOperation,
    options?: MigrationTuiExecuteOptions
  ) => Promise<string>;
  readonly getExecutionState: () => MigrationTuiExecutionState | undefined;
  readonly groups: readonly MigrationDefinitionRegistryGroup[];
  readonly listMessages: (
    target: MigrationTuiTarget
  ) => Promise<readonly MigrationTuiMessage[]>;
  readonly listSourceIdentityHistory: (
    definitionId: MigrationDefinitionId
  ) => Promise<readonly MigrationTuiSourceIdentityHistoryEntry[]>;
  readonly normalizeSourceIdentity: (
    definitionId: MigrationDefinitionId,
    sourceIdentity: string
  ) => string;
  readonly prepare: (
    target: MigrationTuiTarget,
    action: MigrationTuiAction,
    options?: MigrationTuiPrepareOptions
  ) => Promise<MigrationTuiPreparedOperation>;
  readonly refresh: () => Promise<MigrationTuiSnapshot>;
  readonly rows: readonly MigrationTuiRow[];
  readonly scanSource: (
    target: MigrationTuiTarget,
    options?: MigrationTuiScanSourceOptions
  ) => Promise<MigrationTuiSnapshot>;
  readonly subscribeExecution: (
    listener: (state: MigrationTuiExecutionState | undefined) => void
  ) => () => void;
}

export interface LoadMigrationTuiInput {
  readonly configPath?: string;
  readonly cwd: string;
  readonly progressFallbackIntervalMs?: number;
  readonly providerSettlementGraceMs?: number;
  readonly terminalPollIntervalMs?: number;
}

const loadConfig = async (
  input: LoadMigrationTuiInput
): Promise<{
  readonly config: MigrationTuiConfig;
  readonly configPath: string;
}> => {
  const loaded = await Effect.runPromise(
    loadMigrationCliConfigWithPath({
      ...(input.configPath === undefined
        ? {}
        : { configPath: input.configPath }),
      cwd: input.cwd,
    }).pipe(Effect.provide(nodeServicesLayer))
  );

  return {
    config: loaded.config as MigrationTuiConfig,
    configPath: loaded.configPath,
  };
};

export type MigrationTuiConfigError = MigrationCliConfigLoadError;
export const MigrationTuiConfigError = MigrationCliConfigLoadError;

const readItemStates = (
  config: MigrationTuiConfig,
  definitionId: MigrationDefinitionId
): Promise<readonly MigrationItemState[]> => {
  const definition = Option.getOrUndefined(config.registry.get(definitionId));

  if (definition === undefined) {
    return Promise.reject(
      new Error(`Migration was not found: ${definitionId}`)
    );
  }

  const read = Effect.gen(function* () {
    const store = yield* MigrationStore;

    return yield* store.listItemStates(definitionId);
  }).pipe(Effect.provide(definition.store));

  return Effect.runPromise(read);
};

const sourceIdentityPartText = (part: string | number | boolean): string =>
  encodeURIComponent(String(part));

const sourceIdentityKeyText = (key: SourceIdentitySnapshotKey): string =>
  Array.isArray(key)
    ? key.map(sourceIdentityPartText).join(":")
    : sourceIdentityPartText(key as string | number | boolean);

export const makeMigrationTuiRuntime = async (
  input: LoadMigrationTuiInput
): Promise<MigrationTuiRuntime> => {
  const loaded = await loadConfig(input);
  const config = loaded.config;
  const entries = config.registry.list();
  const groups = config.registry.groups();
  const executable =
    config.executableLayer === undefined
      ? MigrationExecutable.inlineService
      : await Effect.runPromise(
          MigrationExecutable.pipe(Effect.provide(config.executableLayer))
        );
  const rows = entries.map((entry) => ({ entry }));
  const progressFallbackIntervalMs = input.progressFallbackIntervalMs ?? 5000;
  const providerSettlementGraceMs = input.providerSettlementGraceMs ?? 2000;
  const terminalPollIntervalMs = input.terminalPollIntervalMs ?? 500;

  const readExecutionProgress = async (
    definitionIds: readonly MigrationDefinitionId[],
    signal?: AbortSignal
  ): Promise<readonly MigrationDefinitionStatus[]> => {
    const firstDefinitionId = definitionIds[0];

    if (firstDefinitionId === undefined) {
      return [];
    }

    const report = await Effect.runPromise(
      config.registry.status({
        definitionIds: [firstDefinitionId, ...definitionIds.slice(1)],
        scanSource: false,
        withDependencies: false,
      }),
      signal === undefined ? undefined : { signal }
    );

    return report.definitions;
  };

  const observeDetachedRun = ({
    definitionId,
    execution,
    onProgressCheckpoint,
    onProviderObservationError,
    runId,
    signal,
  }: {
    readonly definitionId: MigrationDefinitionId;
    readonly execution: {
      readonly adapter: string;
      readonly executionId: string;
    };
    readonly onProgressCheckpoint?: (
      checkpoint: MigrationExecutableProgressCheckpoint
    ) => void;
    readonly onProviderObservationError?: (cause: unknown) => void;
    readonly runId: MigrationRunId;
    readonly signal: AbortSignal;
  }): Promise<MigrationRunState> => {
    const definition = Option.getOrUndefined(config.registry.get(definitionId));

    if (definition === undefined) {
      return Promise.reject(
        new Error(`Migration was not found: ${definitionId}`)
      );
    }

    const observe = Effect.gen(function* () {
      const store = yield* MigrationStore;
      const readLatestRunState = store.getLatestRunState(definitionId).pipe(
        Effect.map((state) =>
          state === null ? null : makeMigrationRunState(state)
        )
      );
      const durableObservation = waitForDurableRunState({
        pollIntervalMs: terminalPollIntervalMs,
        readLatestRunState,
        runId,
      });
      const providerObservation = executable.waitForExecution?.(execution, {
        ...(onProgressCheckpoint === undefined
          ? {}
          : {
              onProgressCheckpoint: (checkpoint) =>
                checkpoint.runId === runId
                  ? Effect.sync(() => onProgressCheckpoint(checkpoint))
                  : Effect.void,
            }),
      });

      if (providerObservation === undefined) {
        return yield* durableObservation;
      }

      const providerGuard = providerObservation.pipe(
        Effect.flatMap((result) => {
          if (result.kind === "succeeded") {
            return Effect.never;
          }

          return Effect.sleep(providerSettlementGraceMs).pipe(
            Effect.andThen(readLatestRunState),
            Effect.flatMap((state) => {
              if (
                state !== null &&
                state.runId === runId &&
                isTerminalRunState(state)
              ) {
                return Effect.succeed(state);
              }

              return Effect.fail(
                new MigrationTuiProviderObservationError({
                  message: `Provider execution ${execution.executionId} ${result.kind} before run ${runId} reached durable terminal state`,
                  ...(result.kind === "failed" && result.cause !== undefined
                    ? { cause: result.cause }
                    : {}),
                })
              );
            })
          );
        }),
        Effect.catch((cause) =>
          cause instanceof MigrationTuiProviderObservationError
            ? Effect.fail(cause)
            : Effect.sync(() => onProviderObservationError?.(cause)).pipe(
                Effect.andThen(Effect.never)
              )
        )
      );

      return yield* Effect.raceFirst(durableObservation, providerGuard);
    }).pipe(Effect.provide(definition.store));

    return Effect.runPromise(observe, { signal });
  };
  const executionController = makeMigrationTuiExecutionController({
    observeDetachedRun,
  });

  const getDefinition = (definitionId: MigrationDefinitionId) => {
    const definition = Option.getOrUndefined(config.registry.get(definitionId));

    if (definition === undefined) {
      throw new Error(`Migration was not found: ${definitionId}`);
    }

    return definition;
  };

  const normalizeSourceIdentity = (
    definitionId: MigrationDefinitionId,
    sourceIdentity: string
  ): string => {
    const definition = getDefinition(definitionId);
    const identity = SourceIdentity.fromText(
      definition.source.identity,
      sourceIdentity
    );

    return sourceIdentityKeyText(identity.key);
  };

  const listSourceIdentityHistory = async (
    definitionId: MigrationDefinitionId
  ): Promise<readonly MigrationTuiSourceIdentityHistoryEntry[]> => {
    const definition = getDefinition(definitionId);
    const states = await readItemStates(config, definitionId);

    return states
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
        (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime()
      );
  };

  const breakLock = async (
    expectedLock: MigrationDefinitionLock
  ): Promise<MigrationTuiBreakLockResult> => {
    const definition = getDefinition(expectedLock.definitionId);
    const kind = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* MigrationStore;
        const currentLock = yield* store.getDefinitionLock(
          expectedLock.definitionId
        );

        if (currentLock === null) {
          return "already-clear" as const;
        }

        yield* store.releaseDefinitionLock(expectedLock);
        return "cleared" as const;
      }).pipe(Effect.provide(definition.store))
    );

    return { definitionId: expectedLock.definitionId, kind };
  };

  const readRows = async (
    scanTarget?: MigrationTuiTarget,
    scanOptions: MigrationTuiScanSourceOptions = {}
  ): Promise<readonly MigrationTuiRow[]> => {
    const durableReport = await Effect.runPromise(
      config.registry.status({ all: true, scanSource: false })
    );
    const statuses = new Map(
      durableReport.definitions.map((status) => [status.definitionId, status])
    );

    if (scanTarget !== undefined) {
      const scannedReport: MigrationDefinitionRegistryStatusReport =
        await Effect.runPromise(
          scanTarget.kind === "group"
            ? config.registry.status({
                ...(scanOptions.concurrency === undefined
                  ? {}
                  : { concurrency: scanOptions.concurrency }),
                group: scanTarget.groupId,
                scanSource: true,
                withDependencies: true,
              })
            : config.registry.status({
                ...(scanOptions.concurrency === undefined
                  ? {}
                  : { concurrency: scanOptions.concurrency }),
                definitionIds: [scanTarget.definitionId],
                scanSource: true,
                withDependencies: true,
              })
        );

      for (const status of scannedReport.definitions) {
        statuses.set(status.definitionId, status);
      }
    }

    return entries.map((entry) => {
      const status = statuses.get(entry.id);

      return {
        entry,
        ...(status === undefined ? {} : { status }),
      };
    });
  };

  const refresh = async (): Promise<MigrationTuiSnapshot> => ({
    rows: await readRows(),
    scannedSource: false,
  });

  const scanSource = async (
    target: MigrationTuiTarget,
    options: MigrationTuiScanSourceOptions = {}
  ): Promise<MigrationTuiSnapshot> => ({
    rows: await readRows(target, options),
    scannedSource: true,
  });

  const readPlanRows = async (
    definitionIds: readonly MigrationDefinitionId[]
  ) => {
    const statusRows = await readRows();
    const rowsById = new Map(statusRows.map((row) => [row.entry.id, row]));
    const planRows = definitionIds.flatMap((definitionId) => {
      const row = rowsById.get(definitionId);

      return row === undefined ? [] : [row];
    });

    return { planRows, rowsById };
  };

  const prepareRollback = async (
    target: MigrationTuiTarget,
    options: MigrationTuiPrepareOptions
  ): Promise<MigrationTuiPreparedOperation> => {
    const withDependencies =
      options.withDependencies ?? target.kind === "migration";
    const plan = await Effect.runPromise(
      target.kind === "group"
        ? config.registry.executable().planRollback({
            ...(options.execution === undefined
              ? {}
              : { execution: options.execution }),
            group: target.groupId,
            ...(options.force === undefined ? {} : { force: options.force }),
            withDependencies,
          })
        : config.registry.executable().planRollback({
            definitionIds: [target.definitionId],
            ...(options.execution === undefined
              ? {}
              : { execution: options.execution }),
            ...(options.force === undefined ? {} : { force: options.force }),
            withDependencies,
          })
    );
    const observationDefinitionId =
      target.kind === "migration"
        ? target.definitionId
        : plan.executionDefinitionIds[0];

    if (observationDefinitionId === undefined) {
      throw new Error("No migrations are available to roll back");
    }

    const { planRows } = await readPlanRows(plan.executionDefinitionIds);

    return {
      action: "rollback",
      dependencyChecks: [],
      observationDefinitionId,
      plan,
      planRows,
      target,
    };
  };

  const prepareRun = async (
    target: MigrationTuiTarget,
    action: MigrationTuiRunAction,
    options: MigrationTuiPrepareOptions
  ): Promise<MigrationTuiPreparedOperation> => {
    if (options.sourceIdentities !== undefined && target.kind !== "migration") {
      throw new Error("Select one migration to run specific source identities");
    }

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
      ...(options.sourceIdentities === undefined
        ? {}
        : { sourceIdentities: options.sourceIdentities }),
    };
    const plan = await Effect.runPromise(
      target.kind === "group"
        ? config.registry.executable().planRun({
            group: target.groupId,
            ...(options.force === undefined ? {} : { force: options.force }),
            withDependencies: options.withDependencies ?? false,
            ...runOptions,
          })
        : config.registry.executable().planRun({
            definitionIds: [target.definitionId],
            ...(options.force === undefined ? {} : { force: options.force }),
            withDependencies: options.withDependencies ?? false,
            ...runOptions,
          })
    );
    const observationDefinitionId =
      target.kind === "migration"
        ? target.definitionId
        : plan.executionDefinitionIds[0];

    if (observationDefinitionId === undefined) {
      throw new Error("No migrations are available to run");
    }

    const { planRows, rowsById } = await readPlanRows(
      plan.executionDefinitionIds
    );
    const dependencyChecks = (plan.requiredDependencyPreflight ?? []).map(
      (edge): MigrationTuiDependencyCheck => {
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

    return {
      action,
      dependencyChecks,
      observationDefinitionId,
      plan,
      planRows,
      ...(options.sourceIdentities === undefined
        ? {}
        : { sourceIdentities: options.sourceIdentities }),
      target,
    };
  };

  const prepare = (
    target: MigrationTuiTarget,
    action: MigrationTuiAction,
    options: MigrationTuiPrepareOptions = {}
  ): Promise<MigrationTuiPreparedOperation> =>
    action === "rollback"
      ? prepareRollback(target, options)
      : prepareRun(target, action, options);

  const execute = async (
    operation: MigrationTuiPreparedOperation,
    options?: MigrationTuiExecuteOptions
  ): Promise<string> => {
    const onProgress = options?.onProgress;
    const progress =
      onProgress === undefined
        ? undefined
        : makeMigrationTuiExecutionProgressScheduler({
            definitionIds: operation.plan.executionDefinitionIds,
            fallbackIntervalMs: progressFallbackIntervalMs,
            onError: (cause) => options?.onProgressError?.(cause),
            onProgress: (definitions) => onProgress({ definitions }),
            read: readExecutionProgress,
          });
    const progressDefinitionIds = new Set(
      operation.plan.executionDefinitionIds
    );
    const requestProgress = (definitionId: MigrationDefinitionId) => {
      if (progress !== undefined && progressDefinitionIds.has(definitionId)) {
        progress.request([definitionId]);
      }
    };
    const progressLayer = Layer.merge(
      Layer.succeed(MigrationProgress, {
        emit: (event) => {
          if (
            event.kind === "source-cursor-window-completed" ||
            event.kind === "definition-completed"
          ) {
            requestProgress(event.definitionId);
          }

          return Effect.void;
        },
      }),
      Layer.succeed(RollbackProgress, {
        emit: (event) => {
          if (event.kind === "definition-completed") {
            requestProgress(event.definitionId);
          }

          return Effect.void;
        },
      })
    );
    let cancellationRequested = false;
    let detached = false;
    const executionOptions = {
      onDetached: () => {
        detached = true;
      },
      onProgressCheckpoint: (
        checkpoint: MigrationExecutableProgressCheckpoint
      ) => requestProgress(checkpoint.definitionId),
      onProviderObservationError: () =>
        options?.onObservationWarning?.(
          "Execution provider updates are unavailable; following durable migration state"
        ),
      onStateChange: (state: MigrationTuiExecutionState) => {
        options?.onStateChange?.(state);

        if (state.kind === "cancelling") {
          cancellationRequested = true;
        }

        if (state.kind === "observing" || state.kind === "running") {
          progress?.start();
        }
      },
    };

    try {
      const result = await (operation.action === "rollback"
        ? executionController.execute({
            definitionId: operation.observationDefinitionId,
            options: executionOptions,
            start: () =>
              Effect.runPromise(
                executable
                  .startRollback(operation.plan)
                  .pipe(Effect.provide(progressLayer))
              ),
          })
        : executionController.execute({
            definitionId: operation.observationDefinitionId,
            options: executionOptions,
            start: () =>
              Effect.runPromise(
                executable
                  .startRun(operation.plan)
                  .pipe(Effect.provide(progressLayer))
              ),
          }));

      await progress?.stop();

      if (!(cancellationRequested || detached) && onProgress !== undefined) {
        try {
          onProgress({
            definitions: await readExecutionProgress(
              operation.plan.executionDefinitionIds
            ),
          });
        } catch (cause) {
          options?.onProgressError?.(cause);
        }
      }

      return result;
    } finally {
      await progress?.stop();
    }
  };

  const listMessages = async (
    target: MigrationTuiTarget
  ): Promise<readonly MigrationTuiMessage[]> => {
    const report = await Effect.runPromise(
      config.registry.messages(
        target.kind === "migration"
          ? { definitionIds: [target.definitionId] }
          : { group: target.groupId }
      )
    );

    return report.messages;
  };

  return {
    breakLock,
    cancelActiveExecution: executionController.cancelActiveExecution,
    configPath: loaded.configPath,
    execute,
    getExecutionState: executionController.getExecutionState,
    groups,
    listMessages,
    listSourceIdentityHistory,
    normalizeSourceIdentity,
    prepare,
    refresh,
    rows,
    scanSource,
    subscribeExecution: executionController.subscribeExecution,
  };
};
