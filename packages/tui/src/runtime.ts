import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Option } from "effect";
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
  type MigrationItemState,
  type MigrationRunId,
  type MigrationRunState,
  MigrationStore,
  SourceIdentity,
  type SourceIdentitySnapshotKey,
} from "migrate-sdk";
import {
  loadMigrationCliConfigWithPath,
  type MigrationCliConfig,
  MigrationCliConfigLoadError,
} from "migrate-sdk/cli";
import { waitForDurableRunState } from "./durable-observation.ts";
import {
  type MigrationTuiCancellationResult,
  type MigrationTuiExecuteOptions,
  makeMigrationTuiExecutionController,
} from "./execution-controller.ts";

type MigrationTuiConfig = MigrationCliConfig<
  readonly AnySelfContainedMigrationDefinition[]
>;

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
  readonly force?: boolean;
  readonly sourceIdentities?: readonly string[];
  readonly withDependencies?: boolean;
}

export interface MigrationTuiSourceIdentityHistoryEntry {
  readonly sourceIdentity: string;
  readonly status: MigrationItemState["status"];
  readonly updatedAt: Date;
}

export interface MigrationTuiMessage {
  readonly definitionId: MigrationDefinitionId;
  readonly details?: string;
  readonly identity: string;
  readonly message: string;
  readonly severity: "error" | "info" | "warning";
  readonly source: "diagnostic" | "item" | "rollback";
  readonly updatedAt: Date;
}

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
    target: MigrationTuiTarget
  ) => Promise<MigrationTuiSnapshot>;
}

export interface LoadMigrationTuiInput {
  readonly configPath?: string;
  readonly cwd: string;
  readonly durablePollIntervalMs?: number;
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

const formatDetails = (
  details: readonly {
    readonly message: string;
    readonly path?: string | undefined;
  }[]
): string =>
  details
    .map((detail) =>
      detail.path === undefined
        ? detail.message
        : `${detail.path}: ${detail.message}`
    )
    .join("\n");

const itemMessages = (
  state: MigrationItemState
): readonly MigrationTuiMessage[] => {
  const messages: MigrationTuiMessage[] = [];
  const identity = state.sourceIdentity.encoded;

  if (state.status === "failed") {
    messages.push({
      definitionId: state.definitionId,
      ...(state.error.details === undefined
        ? {}
        : { details: formatDetails(state.error.details) }),
      identity,
      message: `${state.error.errorTag}: ${state.error.message}`,
      severity: "error",
      source: "item",
      updatedAt: state.updatedAt,
    });
  } else if (state.status === "skipped") {
    messages.push({
      definitionId: state.definitionId,
      identity,
      message: state.skipReason,
      severity: "info",
      source: "item",
      updatedAt: state.updatedAt,
    });
  } else if (state.status === "needs-update") {
    messages.push({
      definitionId: state.definitionId,
      identity,
      message: state.reason,
      severity: "warning",
      source: "item",
      updatedAt: state.updatedAt,
    });
  }

  for (const entry of state.journal?.process.entries ?? []) {
    if (entry.kind !== "diagnostic") {
      continue;
    }

    messages.push({
      definitionId: state.definitionId,
      ...(entry.details === undefined
        ? {}
        : { details: JSON.stringify(entry.details, null, 2) }),
      identity,
      message: entry.message,
      severity: entry.severity,
      source: "diagnostic",
      updatedAt: state.updatedAt,
    });
  }

  for (const attempt of state.journal?.rollbackAttempts ?? []) {
    messages.push({
      definitionId: state.definitionId,
      ...(attempt.error.details === undefined
        ? {}
        : { details: formatDetails(attempt.error.details) }),
      identity,
      message: `${attempt.error.errorTag}: ${attempt.error.message}`,
      severity: "error",
      source: "rollback",
      updatedAt: attempt.failedAt,
    });

    for (const entry of attempt.entries) {
      if (entry.kind !== "diagnostic") {
        continue;
      }

      messages.push({
        definitionId: state.definitionId,
        ...(entry.details === undefined
          ? {}
          : { details: JSON.stringify(entry.details, null, 2) }),
        identity,
        message: entry.message,
        severity: entry.severity,
        source: "rollback",
        updatedAt: attempt.failedAt,
      });
    }
  }

  return messages;
};

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
  const durablePollIntervalMs = input.durablePollIntervalMs ?? 500;

  const observeDetachedRun = ({
    definitionId,
    runId,
    signal,
  }: {
    readonly definitionId: MigrationDefinitionId;
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

      return yield* waitForDurableRunState({
        pollIntervalMs: durablePollIntervalMs,
        readLatestRunState: store.getLatestRunState(definitionId),
        runId,
      });
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
    scanTarget?: MigrationTuiTarget
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
                group: scanTarget.groupId,
                scanSource: true,
                withDependencies: true,
              })
            : config.registry.status({
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
    target: MigrationTuiTarget
  ): Promise<MigrationTuiSnapshot> => ({
    rows: await readRows(target),
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
            group: target.groupId,
            ...(options.force === undefined ? {} : { force: options.force }),
            withDependencies,
          })
        : config.registry.executable().planRollback({
            definitionIds: [target.definitionId],
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

  const execute = (
    operation: MigrationTuiPreparedOperation,
    options?: MigrationTuiExecuteOptions
  ): Promise<string> => {
    if (operation.action === "rollback") {
      return executionController.execute({
        definitionId: operation.observationDefinitionId,
        options,
        start: () =>
          Effect.runPromise(executable.startRollback(operation.plan)),
      });
    }

    return executionController.execute({
      definitionId: operation.observationDefinitionId,
      options,
      start: () => Effect.runPromise(executable.startRun(operation.plan)),
    });
  };

  const listMessages = async (
    target: MigrationTuiTarget
  ): Promise<readonly MigrationTuiMessage[]> => {
    const definitionIds =
      target.kind === "migration"
        ? [target.definitionId]
        : (groups.find((group) => group.id === target.groupId)?.definitionIds ??
          []);

    if (definitionIds.length === 0) {
      return Promise.reject(
        new Error(
          target.kind === "group"
            ? `Migration group was not found: ${target.groupId}`
            : `Migration was not found: ${target.definitionId}`
        )
      );
    }
    const states = (
      await Promise.all(
        definitionIds.map((definitionId) =>
          readItemStates(config, definitionId)
        )
      )
    ).flat();

    return states
      .flatMap(itemMessages)
      .sort(
        (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime()
      );
  };

  return {
    breakLock,
    cancelActiveExecution: executionController.cancelActiveExecution,
    configPath: loaded.configPath,
    execute,
    groups,
    listMessages,
    listSourceIdentityHistory,
    normalizeSourceIdentity,
    prepare,
    refresh,
    rows,
    scanSource,
  };
};
