import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import {
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  type Scope,
} from "effect";
import {
  type ActiveMigrationRun,
  type AnySelfContainedMigrationDefinition,
  type ExecutionStartResult,
  type MigrationDefinitionExecutableRollbackPlan,
  type MigrationDefinitionExecutableRunPlan,
  type MigrationDefinitionGroupId,
  type MigrationDefinitionId,
  type MigrationDefinitionLock,
  type MigrationDefinitionRegistryEntry,
  type MigrationDefinitionRegistryGroup,
  type MigrationDefinitionRegistryId,
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
  type MigrationRunSummary,
  MigrationStore,
  makeMigrationRunState,
  RollbackProgress,
  type RollbackRunSummary,
  SourceIdentity,
  type SourceIdentitySnapshotKey,
} from "migrate-sdk";
import {
  loadMigrationCliConfigWithPath,
  type MigrationCliConfig,
} from "migrate-sdk/cli";
import type {
  MigrateExecutionReference,
  MigratePreparedOperation,
  MigrateRunStopResult,
} from "migrate-sdk/protocol";
import {
  isTerminalRunState,
  waitForDurableRunState,
} from "./durable-observation.ts";
import type {
  MigrationTuiCancellationResult,
  MigrationTuiExecutionResult,
  MigrationTuiExecutionState,
} from "./execution.ts";

type MigrationTuiConfig = MigrationCliConfig<
  readonly AnySelfContainedMigrationDefinition[]
>;

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

class MigrationTuiProviderObservationError extends Schema.TaggedError<MigrationTuiProviderObservationError>()(
  "MigrationTuiProviderObservationError",
  {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
  }
) {}

class MigrationTuiExecutionError extends Schema.TaggedError<MigrationTuiExecutionError>()(
  "MigrationTuiExecutionError",
  {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
  }
) {}

class MigrationTuiHostError extends Schema.TaggedError<MigrationTuiHostError>()(
  "MigrationTuiHostError",
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

export type MigrationTuiPreparedOperation = MigratePreparedOperation;

export type MigrationTuiExecutablePreparedOperation =
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

export type MigrationTuiActiveRun = ActiveMigrationRun & {
  readonly stopSupported: boolean;
};

export interface MigrationTuiSnapshot {
  readonly activeRuns: readonly MigrationTuiActiveRun[];
  readonly rows: readonly MigrationTuiRow[];
  readonly scannedSource: boolean;
}

export interface MigrationTuiBreakLockResult {
  readonly definitionId: MigrationDefinitionId;
  readonly kind: "already-clear" | "cleared";
}

export interface MigrationTuiExecutionObserver {
  readonly onObservationWarning?: (message: string) => void;
  readonly onProgress?: (progress: {
    readonly definitions: readonly MigrationDefinitionStatus[];
  }) => void;
  readonly onProgressError?: (cause: unknown) => void;
  readonly onStateChange?: (state: MigrationTuiExecutionState) => void;
}

export interface MigrationTuiExecuteOptions
  extends MigrationTuiExecutionObserver {
  readonly signal?: AbortSignal;
}

export interface ConfiguredMigrationExecution {
  readonly result: Effect.Effect<MigrationTuiExecutionResult, unknown>;
  readonly stop: Effect.Effect<MigrationTuiCancellationResult, unknown>;
}

type ConfiguredMigrationExecutionPhase =
  | { readonly kind: "starting" }
  | {
      readonly kind: "attached";
      readonly runId: MigrationRunId;
    }
  | {
      readonly kind: "detached";
      readonly runId: MigrationRunId;
    }
  | { readonly kind: "terminal" };

export interface MigrationTuiRuntime {
  readonly breakLock: (
    lock: MigrationDefinitionLock
  ) => Promise<MigrationTuiBreakLockResult>;
  readonly configPath: string;
  readonly detachForExit: () => Promise<MigrationTuiCancellationResult>;
  readonly detachRunObservation: (runId?: MigrationRunId) => boolean;
  readonly dispose?: (() => Promise<void>) | undefined;
  readonly groups: readonly MigrationDefinitionRegistryGroup[];
  readonly listActiveRuns: () => Promise<readonly MigrationTuiActiveRun[]>;
  readonly listMessages: (
    target: MigrationTuiTarget
  ) => Promise<readonly MigrationTuiMessage[]>;
  readonly listSourceIdentityHistory: (
    definitionId: MigrationDefinitionId
  ) => Promise<readonly MigrationTuiSourceIdentityHistoryEntry[]>;
  readonly normalizeSourceIdentity: (
    definitionId: MigrationDefinitionId,
    sourceIdentity: string
  ) => Promise<string>;
  readonly observeRun: (
    runId: MigrationRunId,
    options?: MigrationTuiExecuteOptions
  ) => Promise<MigrationTuiExecutionResult>;
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
  readonly start: (
    operation: MigrationTuiPreparedOperation
  ) => Promise<MigrateExecutionReference>;
  readonly stopRun: (runId: MigrationRunId) => Promise<MigrateRunStopResult>;
}

export interface ConfiguredMigrationHost {
  readonly breakLock: (
    lock: MigrationDefinitionLock
  ) => Effect.Effect<MigrationTuiBreakLockResult, unknown>;
  readonly configPath: string;
  readonly groups: readonly MigrationDefinitionRegistryGroup[];
  readonly hasActiveExecutions: () => boolean;
  readonly listActiveRuns: Effect.Effect<
    readonly MigrationTuiActiveRun[],
    unknown
  >;
  readonly listMessages: (
    target: MigrationTuiTarget
  ) => Effect.Effect<readonly MigrationTuiMessage[], unknown>;
  readonly listSourceIdentityHistory: (
    definitionId: MigrationDefinitionId
  ) => Effect.Effect<
    readonly MigrationTuiSourceIdentityHistoryEntry[],
    unknown
  >;
  readonly normalizeSourceIdentity: (
    definitionId: MigrationDefinitionId,
    sourceIdentity: string
  ) => Effect.Effect<string, unknown>;
  readonly observeRun: (
    runId: MigrationRunId,
    observer?: MigrationTuiExecutionObserver
  ) => Effect.Effect<MigrationTuiExecutionResult, unknown>;
  readonly prepare: (
    target: MigrationTuiTarget,
    action: MigrationTuiAction,
    options?: MigrationTuiPrepareOptions
  ) => Effect.Effect<MigrationTuiExecutablePreparedOperation, unknown>;
  readonly refresh: Effect.Effect<MigrationTuiSnapshot, unknown>;
  readonly registryId?: MigrationDefinitionRegistryId;
  readonly rows: readonly MigrationTuiRow[];
  readonly scanSource: (
    target: MigrationTuiTarget,
    options?: MigrationTuiScanSourceOptions
  ) => Effect.Effect<MigrationTuiSnapshot, unknown>;
  readonly startExecution: (
    operation: MigrationTuiExecutablePreparedOperation,
    observer?: MigrationTuiExecutionObserver
  ) => Effect.Effect<ConfiguredMigrationExecution>;
}

export interface LoadMigrationTuiInput {
  readonly configPath?: string;
  readonly cwd: string;
}

export interface LoadConfiguredMigrationHostInput
  extends LoadMigrationTuiInput {
  readonly progressFallbackIntervalMs?: number;
  readonly providerSettlementGraceMs?: number;
  readonly terminalPollIntervalMs?: number;
}

const loadConfig = (
  input: LoadMigrationTuiInput
): Effect.Effect<
  {
    readonly config: MigrationTuiConfig;
    readonly configPath: string;
  },
  unknown
> =>
  Effect.map(
    loadMigrationCliConfigWithPath({
      ...(input.configPath === undefined
        ? {}
        : { configPath: input.configPath }),
      cwd: input.cwd,
    }).pipe(Effect.provide(nodeServicesLayer)),
    (loaded) => ({
      config: loaded.config as MigrationTuiConfig,
      configPath: loaded.configPath,
    })
  );

const readItemStates = (
  config: MigrationTuiConfig,
  definitionId: MigrationDefinitionId
): Effect.Effect<readonly MigrationItemState[], unknown> => {
  const definition = Option.getOrUndefined(config.registry.get(definitionId));

  if (definition === undefined) {
    return Effect.fail(
      new MigrationTuiHostError({
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

export const loadConfiguredMigrationHost = (
  input: LoadConfiguredMigrationHostInput
): Effect.Effect<ConfiguredMigrationHost, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const loaded = yield* loadConfig(input);
    const config = loaded.config;
    const entries = config.registry.list();
    const groups = config.registry.groups();
    const registryId = Option.getOrUndefined(config.registry.id());
    const executable =
      config.executableLayer === undefined
        ? MigrationExecutable.inlineService
        : Context.get(
            yield* Layer.build(config.executableLayer),
            MigrationExecutable
          );
    const rows = entries.map((entry) => ({ entry }));
    const progressFallbackIntervalMs = input.progressFallbackIntervalMs ?? 5000;
    const providerSettlementGraceMs = input.providerSettlementGraceMs ?? 2000;
    const terminalPollIntervalMs = input.terminalPollIntervalMs ?? 500;

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

      return config.registry
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

    const readRunStateEffect = (
      runId: MigrationRunId
    ): Effect.Effect<MigrationRunState | null, unknown> =>
      Effect.gen(function* () {
        for (const entry of entries) {
          const definition = Option.getOrUndefined(
            config.registry.get(entry.id)
          );

          if (definition === undefined) {
            continue;
          }

          const state = yield* MigrationStore.pipe(
            Effect.flatMap((store) =>
              readStoredMigrationRunState(store, runId, entry.id)
            ),
            Effect.provide(definition.store)
          );

          if (state !== null) {
            return state;
          }
        }

        return null;
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
    }): Effect.Effect<MigrationRunState, unknown> => {
      const definition = Option.getOrUndefined(
        config.registry.get(definitionId)
      );

      if (definition === undefined) {
        return Effect.fail(
          new MigrationTuiExecutionError({
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
        });
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

        const providerGuard = providerObservation.pipe(
          Effect.flatMap((result) => {
            if (result.kind === "succeeded") {
              return Effect.never;
            }

            return Effect.sleep(providerSettlementGraceMs).pipe(
              Effect.andThen(readRunState),
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

      return observe;
    };
    const activeExecutions = new Set<symbol>();

    const getDefinition = (
      definitionId: MigrationDefinitionId
    ): Effect.Effect<
      AnySelfContainedMigrationDefinition,
      MigrationTuiHostError
    > => {
      const definition = Option.getOrUndefined(
        config.registry.get(definitionId)
      ) as AnySelfContainedMigrationDefinition | undefined;

      if (definition === undefined) {
        return Effect.fail(
          new MigrationTuiHostError({
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
            new MigrationTuiHostError({
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
    ): Effect.Effect<
      readonly MigrationTuiSourceIdentityHistoryEntry[],
      unknown
    > =>
      Effect.gen(function* () {
        const definition = yield* getDefinition(definitionId);
        const states = yield* readItemStates(config, definitionId);

        return yield* Effect.try({
          catch: (cause) =>
            new MigrationTuiHostError({
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
    ): Effect.Effect<MigrationTuiBreakLockResult, unknown> =>
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

    const withoutServerStop = (
      run: ActiveMigrationRun
    ): MigrationTuiActiveRun => ({
      ...run,
      stopSupported: false,
    });

    const readSnapshot = (
      scanTarget?: MigrationTuiTarget,
      scanOptions: MigrationTuiScanSourceOptions = {}
    ): Effect.Effect<MigrationTuiSnapshot, unknown> =>
      Effect.gen(function* () {
        const initial = yield* Effect.all({
          activeRuns: config.registry
            .activeRuns()
            .pipe(Effect.map((runs) => runs.map(withoutServerStop))),
          durableReport: config.registry.status({
            all: true,
            scanSource: false,
          }),
        });
        const { activeRuns, durableReport } = initial;
        const statuses = new Map(
          durableReport.definitions.map((status) => [
            status.definitionId,
            status,
          ])
        );

        if (scanTarget !== undefined) {
          const scannedReport: MigrationDefinitionRegistryStatusReport =
            yield* scanTarget.kind === "group"
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

    const readRows = readSnapshot().pipe(
      Effect.map((snapshot) => snapshot.rows)
    );

    const refresh = readSnapshot();

    const listActiveRunsEffect = config.registry
      .activeRuns()
      .pipe(Effect.map((runs) => runs.map(withoutServerStop)));

    const scanSource = (
      target: MigrationTuiTarget,
      options: MigrationTuiScanSourceOptions = {}
    ): Effect.Effect<MigrationTuiSnapshot, unknown> =>
      readSnapshot(target, options);

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
      target: MigrationTuiTarget,
      options: MigrationTuiPrepareOptions
    ): Effect.Effect<MigrationTuiExecutablePreparedOperation, unknown> =>
      Effect.gen(function* () {
        const withDependencies =
          options.withDependencies ?? target.kind === "migration";
        const plan = yield* target.kind === "group"
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
            });
        const observationDefinitionId =
          target.kind === "migration"
            ? target.definitionId
            : plan.executionDefinitionIds[0];

        if (observationDefinitionId === undefined) {
          return yield* new MigrationTuiExecutionError({
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
          target,
        };
      });

    const planRun = (
      target: MigrationTuiTarget,
      action: MigrationTuiRunAction,
      options: MigrationTuiPrepareOptions
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
        ...(options.sourceIdentities === undefined
          ? {}
          : { sourceIdentities: options.sourceIdentities }),
      };
      const commonOptions = {
        ...(options.force === undefined ? {} : { force: options.force }),
        withDependencies: options.withDependencies ?? false,
        ...runOptions,
      };

      return target.kind === "group"
        ? config.registry.executable().planRun({
            group: target.groupId,
            ...commonOptions,
          })
        : config.registry.executable().planRun({
            definitionIds: [target.definitionId],
            ...commonOptions,
          });
    };

    const dependencyChecksFor = (
      plan: MigrationDefinitionExecutableRunPlan<
        readonly AnySelfContainedMigrationDefinition[]
      >,
      rowsById: ReadonlyMap<MigrationDefinitionId, MigrationTuiRow>
    ): readonly MigrationTuiDependencyCheck[] =>
      (plan.requiredDependencyPreflight ?? []).map(
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

    const prepareRun = (
      target: MigrationTuiTarget,
      action: MigrationTuiRunAction,
      options: MigrationTuiPrepareOptions
    ): Effect.Effect<MigrationTuiExecutablePreparedOperation, unknown> =>
      Effect.gen(function* () {
        if (
          options.sourceIdentities !== undefined &&
          target.kind !== "migration"
        ) {
          return yield* new MigrationTuiExecutionError({
            message: "Select one migration to run specific source identities",
          });
        }

        const plan = yield* planRun(target, action, options);
        const observationDefinitionId =
          target.kind === "migration"
            ? target.definitionId
            : plan.executionDefinitionIds[0];

        if (observationDefinitionId === undefined) {
          return yield* new MigrationTuiExecutionError({
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
          ...(options.sourceIdentities === undefined
            ? {}
            : { sourceIdentities: options.sourceIdentities }),
          target,
        };
      });

    const prepare = (
      target: MigrationTuiTarget,
      action: MigrationTuiAction,
      options: MigrationTuiPrepareOptions = {}
    ): Effect.Effect<MigrationTuiExecutablePreparedOperation, unknown> =>
      action === "rollback"
        ? prepareRollback(target, options)
        : prepareRun(target, action, options);

    const makeExecutionProgress = (
      definitionIds: readonly MigrationDefinitionId[],
      options?: MigrationTuiExecutionObserver
    ) => {
      const definitionIdSet = new Set(definitionIds);
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
        definitionIdSet.has(definitionId)
          ? publish([definitionId])
          : Effect.void;
      const layer = Layer.merge(
        Layer.succeed(MigrationProgress, {
          emit: (event) =>
            event.kind === "source-cursor-window-completed" ||
            event.kind === "definition-completed"
              ? publishDefinition(event.definitionId)
              : Effect.void,
        }),
        Layer.succeed(RollbackProgress, {
          emit: (event) =>
            event.kind === "definition-completed"
              ? publishDefinition(event.definitionId)
              : Effect.void,
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
    ): Effect.Effect<MigrationTuiExecutionResult, unknown> =>
      readRunStateEffect(runId).pipe(
        Effect.flatMap((state) => {
          if (state === null || !isTerminalRunState(state)) {
            return Effect.fail(
              new MigrationTuiExecutionError({
                message: `Active migration run was not found: ${runId}`,
              })
            );
          }

          if (state.status === "failed" || state.status === "start-failed") {
            return Effect.fail(
              new MigrationTuiExecutionError({
                message: `Run ${state.runId} ${state.status}`,
              })
            );
          }

          return Effect.succeed({
            message: `Run ${state.runId} ${state.status}`,
            outcome:
              state.status === "cancelled"
                ? ("cancelled" as const)
                : ("completed" as const),
            runId: state.runId,
          });
        })
      );

    const observeRun = (
      runId: MigrationRunId,
      options?: MigrationTuiExecutionObserver
    ): Effect.Effect<MigrationTuiExecutionResult, unknown> =>
      Effect.scoped(
        Effect.gen(function* () {
          const activeRun = (yield* listActiveRunsEffect).find(
            (candidate) => candidate.runId === runId
          );

          if (activeRun === undefined) {
            return yield* readCompletedRunResult(runId);
          }

          const execution = activeRun.execution;

          if (execution === undefined) {
            return yield* new MigrationTuiExecutionError({
              message: `Migration run ${runId} does not have a reconnectable execution identity`,
            });
          }

          const progress = makeExecutionProgress(
            activeRun.definitionIds,
            options
          );
          yield* Effect.sync(() =>
            options?.onStateChange?.({
              adapter: execution.adapter,
              definitionId: activeRun.observationDefinitionId,
              executionId: execution.executionId,
              kind: "observing",
              runId,
            })
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

          if (
            terminal.status === "failed" ||
            terminal.status === "start-failed"
          ) {
            return yield* new MigrationTuiExecutionError({
              message: `Run ${terminal.runId} ${terminal.status}`,
            });
          }

          return {
            message: `Run ${terminal.runId} ${terminal.status}`,
            outcome:
              terminal.status === "cancelled"
                ? ("cancelled" as const)
                : ("completed" as const),
            runId: terminal.runId,
          };
        })
      );

    const startExecution = (
      operation: MigrationTuiExecutablePreparedOperation,
      options?: MigrationTuiExecutionObserver
    ): Effect.Effect<ConfiguredMigrationExecution> =>
      Effect.gen(function* () {
        const stopRequested = yield* Deferred.make<void>();
        const phase = yield* Ref.make<ConfiguredMigrationExecutionPhase>({
          kind: "starting",
        });
        const token = Symbol("ConfiguredMigrationExecution");
        const definitionIds = operation.plan.executionDefinitionIds;
        const progress = makeExecutionProgress(definitionIds, options);

        const notifyState = (state: MigrationTuiExecutionState) =>
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
              return {
                message: `Run ${started.runId} ${started.summary.status}`,
                outcome: "completed" as const,
                runId: started.runId,
              };
            }

            if (started.handle !== undefined) {
              const handle = started.handle;

              return yield* Effect.gen(function* () {
                yield* Ref.set(phase, {
                  kind: "attached",
                  runId: started.runId,
                });
                yield* notifyState({
                  adapter: started.execution.adapter,
                  definitionId: operation.observationDefinitionId,
                  kind: "running",
                  runId: started.runId,
                });
                yield* Deferred.await(stopRequested).pipe(
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
                    return yield* new MigrationTuiExecutionError({
                      cause: terminal.cause,
                      message: causeMessage(terminal.cause),
                    });
                  case "finished":
                    return {
                      message: `Run ${terminal.state.runId} ${terminal.summary.status}`,
                      outcome: "completed" as const,
                      runId: terminal.state.runId,
                    };
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
              kind: "detached",
              runId: started.runId,
            });
            yield* notifyState({
              adapter: started.execution.adapter,
              definitionId: operation.observationDefinitionId,
              executionId: started.execution.executionId,
              kind: "observing",
              runId: started.runId,
            });
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

            if (
              terminal.status === "failed" ||
              terminal.status === "start-failed"
            ) {
              return yield* new MigrationTuiExecutionError({
                message: `Run ${terminal.runId} ${terminal.status}`,
              });
            }

            return {
              message: `Run ${terminal.runId} ${terminal.status}`,
              outcome:
                terminal.status === "cancelled"
                  ? ("cancelled" as const)
                  : ("completed" as const),
              runId: terminal.runId,
            };
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
        const stop: Effect.Effect<MigrationTuiCancellationResult> = Ref.get(
          phase
        ).pipe(
          Effect.flatMap(
            (current): Effect.Effect<MigrationTuiCancellationResult> => {
              switch (current.kind) {
                case "attached":
                  return Deferred.succeed(stopRequested, undefined).pipe(
                    Effect.as({
                      kind: "requested" as const,
                      message: `Cancelling run ${current.runId}; waiting for active work to finish…`,
                    })
                  );
                case "detached":
                  return Effect.succeed({
                    kind: "detached" as const,
                    message: `Run ${current.runId} is owned by its execution provider and will continue in the background`,
                  });
                case "starting":
                  return Deferred.succeed(stopRequested, undefined).pipe(
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
      target: MigrationTuiTarget
    ): Effect.Effect<readonly MigrationTuiMessage[], unknown> =>
      config.registry
        .messages(
          target.kind === "migration"
            ? { definitionIds: [target.definitionId] }
            : { group: target.groupId }
        )
        .pipe(Effect.map((report) => report.messages));

    return {
      breakLock,
      configPath: loaded.configPath,
      groups,
      hasActiveExecutions: () => activeExecutions.size > 0,
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
    };
  });
