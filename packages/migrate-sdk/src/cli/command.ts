import {
  Console,
  Effect,
  Fiber,
  Option,
  Redacted,
  Runtime,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { Argument, CliError, Command, Flag } from "effect/unstable/cli";
import type { SqlClient } from "effect/unstable/sql";
import type { AnySelfContainedMigrationDefinition } from "../domain/definition.ts";
import type { PipelineExecutionConcurrency } from "../domain/execution.ts";
import {
  type MigrationDefinitionId,
  toMigrationDefinitionGroupId,
  toMigrationDefinitionId,
  toMigrationRunId,
} from "../domain/ids.ts";
import { MigrationMessage } from "../domain/message.ts";
import type {
  MigrationDefinitionRegistry,
  MigrationDefinitionRegistryMessagesError,
  MigrationDefinitionRegistryMessagesReport,
  MigrationDefinitionRegistryPlanningError,
  MigrationDefinitionRegistrySelectionInput,
  MigrationDefinitionRegistryStatusError,
  MigrationDefinitionRegistryStatusInput,
  MigrationDefinitionRegistryStatusReport,
} from "../domain/registry.ts";
import type {
  MigrateAction,
  MigrateDashboardRow,
  MigrateOperationRequest,
  MigratePreparedOperation,
  MigrateSelection,
  MigrateTarget,
} from "../protocol/index.ts";
import { MigrationStore } from "../services/migration-store.ts";
import { SqlMigrationStore } from "../stores/sql/sql-migration-store.ts";
import type { SqlMigrationStoreSchemaPlan } from "../stores/sql/sql-migration-store-schema.ts";
import type { MigrationCliConfig } from "./config.ts";
import {
  loadMigrationCliConfig,
  type MigrationCliConfigLoadError,
} from "./config-loader.ts";
import type { ActiveMigrationCliInterrupts } from "./interrupts.ts";
import {
  type CliObservationProgressMode,
  type CliObservationProgressRenderer,
  makeCliObservationProgressRenderer,
} from "./observation-progress.ts";
import {
  renderActiveMigrationRuns,
  renderConfigLoadError,
  renderMessagesReport,
  renderMigrationObservationEvent,
  renderPlanningError,
  renderPreparedOperationDependencyFailure,
  renderPreparedOperationPlan,
  renderPreparedOperationWarnings,
  renderRegistryEntriesGraph,
  renderRegistryEntriesList,
  renderRegistryGraph,
  renderRegistryList,
  renderRunStopResult,
  renderRuntimeError,
  renderSqlMigrationStoreSchemaPlan,
  renderStatusReport,
} from "./render.ts";
import {
  MigrationCliConnectionError,
  MigrationCliRuntime,
  type MigrationCliServerConnection,
  type MigrationRunObservationInterruptDecision,
} from "./runtime.ts";

const config = Flag.string("config").pipe(
  Flag.optional,
  Flag.withDescription("Path to a migrate.config.ts, .mts, .js, or .mjs file")
);

const server = Flag.string("server").pipe(
  Flag.optional,
  Flag.withDescription("URL of a remote Migrate Server")
);

const migrateBaseCommand = Command.make("migrate").pipe(
  Command.withSharedFlags({ config, server })
);

const useColor = Effect.map(
  MigrationCliRuntime,
  (runtime) => runtime.useColor === true
);

type CliProgressMode = CliObservationProgressMode;

const renderStoredFailure = (failure: unknown): string => {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string"
  ) {
    return renderRuntimeError(
      failure as { readonly _tag: string; readonly message?: string }
    );
  }

  if (failure instanceof Error) {
    return `${failure.name}: ${failure.message}`;
  }

  if (
    typeof failure === "object" &&
    failure !== null &&
    "message" in failure &&
    typeof failure.message === "string"
  ) {
    return "name" in failure && typeof failure.name === "string"
      ? `${failure.name}: ${failure.message}`
      : failure.message;
  }

  return String(failure ?? "Migration run failed");
};

const failConfigLoad = (
  error: MigrationCliConfigLoadError
): Effect.Effect<never, CliError.UserError> =>
  Console.error(renderConfigLoadError(error)).pipe(
    Effect.andThen(
      Effect.fail(
        Object.assign(new CliError.UserError({ cause: error }), {
          [Runtime.errorReported]: false,
        })
      )
    )
  );

const failReportedCliMessage = (
  message: string
): Effect.Effect<never, CliError.UserError> =>
  Console.error(message).pipe(
    Effect.andThen(
      Effect.fail(
        Object.assign(new CliError.UserError({ cause: message }), {
          [Runtime.errorReported]: false,
        })
      )
    )
  );

export const failCancelledCliMessage = (
  message: string
): Effect.Effect<never, CliError.UserError> =>
  Console.log(message).pipe(
    Effect.andThen(
      Effect.fail(
        Object.assign(new CliError.UserError({ cause: message }), {
          [Runtime.errorExitCode]: 130,
          [Runtime.errorReported]: false,
        })
      )
    )
  );

const loadConfiguredConfig = Effect.gen(function* () {
  const root = yield* migrateBaseCommand;
  const runtime = yield* MigrationCliRuntime;
  const serverUrl = Option.getOrUndefined(root.server);

  if (serverUrl !== undefined) {
    return yield* failReportedCliMessage(
      "--server is not supported by local Migration Store schema commands"
    );
  }

  const configPath = Option.getOrUndefined(root.config);
  const loadedConfig = yield* Effect.catch(
    loadMigrationCliConfig({
      cwd: runtime.cwd,
      ...(configPath === undefined ? {} : { configPath }),
    }),
    failConfigLoad
  );

  return loadedConfig;
});

const loadConfiguredRegistry = Effect.map(
  loadConfiguredConfig,
  (loadedConfig) => loadedConfig.registry
);

interface CliMigrateConnection {
  readonly connection: MigrationCliServerConnection;
  readonly listActiveRuns: string;
  readonly observeAgain: (runId: string) => string;
  readonly observeAgainLabel: string;
}

const quoteCliArgument = (
  value: string,
  shell: "posix" | "powershell"
): string =>
  shell === "powershell"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'\\''`)}'`;

const renderObservationRecovery = (
  runId: ReturnType<typeof toMigrationRunId>,
  observeAgain: (runId: string) => string,
  observeAgainLabel: string,
  reason: string
): string =>
  [
    reason,
    `Run id ${runId}`,
    `${observeAgainLabel}: ${observeAgain(runId)}`,
  ].join("\n");

const acquireCliMigrateConnection = (
  recoveryRunId?: ReturnType<typeof toMigrationRunId>
) =>
  Effect.gen(function* () {
    const root = yield* migrateBaseCommand;
    const runtime = yield* MigrationCliRuntime;
    const configPath = Option.getOrUndefined(root.config);
    const serverUrl = Option.getOrUndefined(root.server);
    const commandShell = runtime.commandShell ?? "posix";
    const migrateServerToken =
      runtime.migrateServerToken === undefined
        ? undefined
        : Redacted.value(runtime.migrateServerToken).trim();
    let sharedFlags = "";

    if (serverUrl !== undefined) {
      sharedFlags = ` --server ${quoteCliArgument(serverUrl, commandShell)}`;
    } else if (configPath !== undefined) {
      sharedFlags = ` --config ${quoteCliArgument(configPath, commandShell)}`;
    }

    const observeAgain = (runId: string) =>
      `migrate${sharedFlags} runs observe ${quoteCliArgument(runId, commandShell)}`;
    const observeAgainLabel =
      commandShell === "powershell"
        ? "Observe again in PowerShell"
        : "Observe again";

    if (configPath !== undefined && serverUrl !== undefined) {
      return yield* failReportedCliMessage(
        "--config and --server cannot be used together"
      );
    }

    if (runtime.connectMigrateServer === undefined) {
      return yield* failReportedCliMessage(
        "This CLI runtime cannot connect to a Migrate Server"
      );
    }

    const connection = yield* runtime
      .connectMigrateServer(
        serverUrl === undefined
          ? {
              kind: "local",
              ...(runtime.migrateServerBuildId === undefined
                ? {}
                : { buildId: runtime.migrateServerBuildId }),
              ...(configPath === undefined ? {} : { configPath }),
              cwd: runtime.cwd,
            }
          : {
              kind: "remote",
              ...(migrateServerToken === undefined || migrateServerToken === ""
                ? {}
                : { bearerToken: migrateServerToken }),
              url: serverUrl,
            }
      )
      .pipe(
        Effect.catch((cause) =>
          failReportedCliMessage(
            recoveryRunId === undefined
              ? renderStoredFailure(cause)
              : renderObservationRecovery(
                  recoveryRunId,
                  observeAgain,
                  observeAgainLabel,
                  renderStoredFailure(cause)
                )
          )
        )
      );

    return {
      connection,
      listActiveRuns: `migrate${sharedFlags} runs list`,
      observeAgain,
      observeAgainLabel,
    } satisfies CliMigrateConnection;
  });

const releaseCliMigrateConnection = ({
  connection,
}: CliMigrateConnection): Effect.Effect<void> =>
  Effect.tryPromise({
    catch: (cause) =>
      new MigrationCliConnectionError({
        cause,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    try: () => connection.dispose(),
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Unable to close the Migrate Server connection").pipe(
        Effect.annotateLogs({ cause })
      )
    )
  );

const withCliMigrateConnection = <A, E, R>(
  use: (connection: CliMigrateConnection) => Effect.Effect<A, E, R>,
  recoveryRunId?: ReturnType<typeof toMigrationRunId>
) =>
  Effect.acquireUseRelease(
    acquireCliMigrateConnection(recoveryRunId),
    use,
    releaseCliMigrateConnection
  );

const reportCliConnectionErrors = <A, R>(
  effect: Effect.Effect<A, unknown, R>
): Effect.Effect<A, CliError.CliError, R> =>
  effect.pipe(
    Effect.catch((error) =>
      CliError.isCliError(error)
        ? Effect.fail(error)
        : failReportedCliMessage(renderStoredFailure(error))
    )
  );

const requireConfiguredSqlStore = (config: MigrationCliConfig) =>
  config.sqlStore === undefined
    ? failReportedCliMessage(
        "SQL Migration Store schema commands require sqlStore in defineMigrationCliConfig"
      )
    : Effect.succeed(config.sqlStore);

const withConfiguredSqlStore = <A, Error>(
  config: MigrationCliConfig,
  use: (options: {
    readonly tablePrefix?: string;
  }) => Effect.Effect<A, Error, MigrationCliRuntime | SqlClient.SqlClient>
): Effect.Effect<A, CliError.CliError, MigrationCliRuntime> =>
  Effect.gen(function* () {
    const target = yield* requireConfiguredSqlStore(config);

    return yield* use({
      ...(target.tablePrefix === undefined
        ? {}
        : { tablePrefix: target.tablePrefix }),
    }).pipe(
      Effect.provide(target.clientLayer),
      Effect.catch((error) =>
        CliError.isCliError(error)
          ? Effect.fail(error)
          : failReportedCliMessage(renderStoredFailure(error))
      )
    );
  });

const schemaJson = Flag.boolean("json").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print the schema plan as JSON")
);

const messagesJson = Flag.boolean("json").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print Migration Messages as JSON")
);

const acceptSchemaPlan = Flag.string("accept-plan").pipe(
  Flag.optional,
  Flag.withDescription(
    "Apply only when the current schema plan has this exact plan ID"
  )
);

const UnknownJsonString = Schema.fromJsonString(Schema.Unknown);
const MigrationMessagesFromJson = Schema.fromJsonString(
  Schema.Array(MigrationMessage)
);

const printSchemaPlan = (
  plan: SqlMigrationStoreSchemaPlan,
  json: boolean
): Effect.Effect<void, never, MigrationCliRuntime> =>
  Effect.gen(function* () {
    yield* Console.log(
      json
        ? yield* Schema.encodeEffect(UnknownJsonString)(plan).pipe(Effect.orDie)
        : renderSqlMigrationStoreSchemaPlan(plan, {
            colors: yield* useColor,
          })
    );
  });

const schemaStatusCommand = Command.make(
  "status",
  { json: schemaJson },
  ({ json }) =>
    Effect.gen(function* () {
      const config = yield* loadConfiguredConfig;

      yield* withConfiguredSqlStore(config, (options) =>
        Effect.gen(function* () {
          const plan = yield* SqlMigrationStore.planSchema(options);
          yield* printSchemaPlan(plan, json);
        })
      );
    })
).pipe(Command.withDescription("Inspect SQL Migration Store schema status"));

const schemaUpgradeCommand = Command.make(
  "upgrade",
  { acceptPlan: acceptSchemaPlan, json: schemaJson },
  (input) =>
    Effect.gen(function* () {
      const config = yield* loadConfiguredConfig;

      yield* withConfiguredSqlStore(config, (options) =>
        Effect.gen(function* () {
          const plan = yield* SqlMigrationStore.planSchema(options);
          const acceptedPlanId = Option.getOrUndefined(input.acceptPlan);

          if (plan.status === "current") {
            yield* printSchemaPlan(plan, input.json);
            return;
          }

          if (acceptedPlanId !== undefined && acceptedPlanId !== plan.planId) {
            yield* printSchemaPlan(plan, input.json);
            return yield* failReportedCliMessage(
              `--accept-plan does not match the current plan ID ${plan.planId}`
            );
          }

          if (
            plan.status !== "not-installed" &&
            plan.status !== "upgrade-required"
          ) {
            yield* printSchemaPlan(plan, input.json);
            return yield* failReportedCliMessage(
              `SQL Migration Store schema cannot be upgraded from ${plan.status}`
            );
          }

          if (acceptedPlanId === undefined) {
            yield* printSchemaPlan(plan, input.json);
            const runtime = yield* MigrationCliRuntime;

            if (
              input.json ||
              runtime.stdoutIsTTY !== true ||
              runtime.confirmSchemaUpgrade === undefined
            ) {
              return yield* failReportedCliMessage(
                `Schema upgrade requires --accept-plan ${plan.planId} in non-interactive mode`
              );
            }

            const confirmed = yield* runtime.confirmSchemaUpgrade(plan);

            if (!confirmed) {
              yield* Console.log("Schema upgrade cancelled.");
              return;
            }
          }

          const completedPlan = yield* SqlMigrationStore.applySchemaPlan(plan);
          yield* printSchemaPlan(completedPlan, input.json);
        })
      );
    })
).pipe(
  Command.withDescription("Apply an approved SQL Migration Store schema plan")
);

const schemaCommand = Command.make("schema").pipe(
  Command.withDescription("Manage SQL Migration Store schema versions"),
  Command.withSubcommands([schemaStatusCommand, schemaUpgradeCommand])
);

const storeCommand = Command.make("store").pipe(
  Command.withDescription("Manage Migration Store infrastructure"),
  Command.withSubcommands([schemaCommand])
);

type CliExecutableRegistry = MigrationDefinitionRegistry<
  readonly AnySelfContainedMigrationDefinition[]
>;

const toCliExecutableRegistry = (
  registry: MigrationDefinitionRegistry
): CliExecutableRegistry => registry as CliExecutableRegistry;

const hasRegisteredDefinition = (
  registry: MigrationDefinitionRegistry,
  definitionId: MigrationDefinitionId
): boolean => registry.list().some((entry) => entry.id === definitionId);

const listCommand = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const root = yield* migrateBaseCommand;

    if (Option.isSome(root.server)) {
      return yield* reportCliConnectionErrors(
        withCliMigrateConnection(({ connection }) =>
          Effect.gen(function* () {
            const snapshot = yield* connection.getDashboard;
            yield* Console.log(
              renderRegistryEntriesList(
                snapshot.dashboard.rows.map((row) => row.entry),
                { colors: yield* useColor }
              )
            );
          })
        )
      );
    }

    const registry = yield* loadConfiguredRegistry;

    yield* Console.log(
      renderRegistryList(registry, { colors: yield* useColor })
    );
  })
).pipe(Command.withDescription("List registered Migration Definitions"));

const graphDefinition = Argument.string("definition").pipe(Argument.optional);

const graphCommand = Command.make(
  "graph",
  { definition: graphDefinition },
  ({ definition }) =>
    Effect.gen(function* () {
      const focusedDefinitionId = Option.getOrUndefined(definition);
      const root = yield* migrateBaseCommand;

      if (Option.isSome(root.server)) {
        return yield* reportCliConnectionErrors(
          withCliMigrateConnection(({ connection }) =>
            Effect.gen(function* () {
              const snapshot = yield* connection.getDashboard;
              const entries = snapshot.dashboard.rows.map((row) => row.entry);

              if (
                focusedDefinitionId !== undefined &&
                !entries.some((entry) => entry.id === focusedDefinitionId)
              ) {
                return yield* failReportedCliMessage(
                  `Migration Definition was not found in the registry: ${focusedDefinitionId}`
                );
              }

              yield* Console.log(
                renderRegistryEntriesGraph(
                  entries,
                  focusedDefinitionId === undefined
                    ? undefined
                    : toMigrationDefinitionId(focusedDefinitionId),
                  { colors: yield* useColor }
                )
              );
            })
          )
        );
      }

      const loadedConfig = yield* loadConfiguredConfig;
      const registry = loadedConfig.registry;

      if (focusedDefinitionId !== undefined) {
        const definitionId = toMigrationDefinitionId(focusedDefinitionId);

        if (!hasRegisteredDefinition(registry, definitionId)) {
          return yield* failReportedCliMessage(
            `Migration Definition was not found in the registry: ${definitionId}`
          );
        }

        yield* Console.log(
          renderRegistryGraph(registry, definitionId, {
            colors: yield* useColor,
          })
        );
        return;
      }

      yield* Console.log(
        renderRegistryGraph(registry, undefined, {
          colors: yield* useColor,
        })
      );
    })
).pipe(Command.withDescription("Inspect Migration Definition dependencies"));

const plan = Flag.boolean("plan").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print the execution plan without running migrations")
);

const progress = Flag.choice("progress", ["auto", "log", "none"] as const).pipe(
  Flag.withDefault<CliProgressMode>("auto"),
  Flag.withDescription("Render live progress: auto, log, or none")
);

const all = Flag.boolean("all").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Select every registered Migration Definition")
);

const group = Flag.string("group").pipe(
  Flag.optional,
  Flag.withDescription("Select a Migration Definition group")
);

const withDependencies = Flag.boolean("with-dependencies").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Expand required Migration Definition dependencies")
);

const scanSource = Flag.boolean("scan-source").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Scan source inventory while reading status")
);

const statusConcurrency = Flag.integer("concurrency").pipe(
  Flag.optional,
  Flag.withAlias("c"),
  Flag.withDescription("Maximum concurrent source scans")
);

const processConcurrency = Flag.string("concurrency").pipe(
  Flag.optional,
  Flag.withAlias("c"),
  Flag.withDescription(
    'Maximum concurrent Process Pipeline executions; use a positive integer or "unbounded"'
  )
);

const rollbackConcurrency = Flag.string("concurrency").pipe(
  Flag.optional,
  Flag.withAlias("c"),
  Flag.withDescription(
    'Maximum concurrent Rollback Pipeline executions; use a positive integer or "unbounded"'
  )
);

const failed = Flag.boolean("failed").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Plan a rerun of failed items")
);

const skipped = Flag.boolean("skipped").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Plan a rerun of skipped items")
);

const rescan = Flag.boolean("rescan").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Reset the Source Cursor and scan from the beginning")
);

const rollbackOrphans = Flag.boolean("rollback-orphans").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Rollback Migration Item States absent from a completed source scan"
  )
);

const update = Flag.boolean("update").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Plan an update run")
);

const force = Flag.boolean("force").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Bypass Migration Definition dependency preflight")
);

const id = Flag.string("id").pipe(
  Flag.atMost(Number.MAX_SAFE_INTEGER),
  Flag.optional,
  Flag.withDescription("Repeatable source identity target")
);

const runDefinitions = Argument.string("definition").pipe(Argument.variadic());

const decodeSourceIdentityTarget = (
  segment: string
): Effect.Effect<string, CliError.UserError> =>
  Effect.try({
    try: () => decodeURIComponent(segment),
    catch: () => "--id contains invalid percent encoding",
  }).pipe(
    Effect.catch((message) => failReportedCliMessage(message)),
    Effect.flatMap(() =>
      segment.length === 0
        ? failReportedCliMessage("--id must not be empty")
        : Effect.succeed(segment)
    )
  );

const parseSourceIdentityTargets = (
  input: readonly string[]
): Effect.Effect<readonly string[], CliError.UserError> =>
  Effect.forEach(input, decodeSourceIdentityTarget);

const parsePipelineExecutionConcurrency = (
  input: string,
  flag: string
): Effect.Effect<PipelineExecutionConcurrency, CliError.UserError> => {
  if (input === "unbounded") {
    return Effect.succeed("unbounded");
  }

  const parsed = Number(input);

  return Number.isInteger(parsed) && parsed > 0
    ? Effect.succeed(parsed)
    : failReportedCliMessage(
        `${flag} must be a positive integer or "unbounded"`
      );
};

interface CliRegistrySelectionInput {
  readonly all: boolean;
  readonly definitionIds: readonly string[];
  readonly group?: string;
  readonly withDependencies: boolean;
}

const makeRegistrySelectionInput = (
  input: CliRegistrySelectionInput
): MigrationDefinitionRegistrySelectionInput => {
  if (input.group !== undefined) {
    return {
      group: input.group,
      ...(input.all ? { all: true } : {}),
      ...(input.definitionIds.length === 0
        ? {}
        : { definitionIds: input.definitionIds }),
      withDependencies: input.withDependencies,
    } as unknown as MigrationDefinitionRegistrySelectionInput;
  }

  if (input.all) {
    return {
      all: true,
      ...(input.definitionIds.length === 0
        ? {}
        : { definitionIds: input.definitionIds }),
      withDependencies: input.withDependencies,
    } as MigrationDefinitionRegistrySelectionInput;
  }

  return input.definitionIds.length === 0
    ? ({} as MigrationDefinitionRegistrySelectionInput)
    : {
        definitionIds: input.definitionIds as [string, ...string[]],
        withDependencies: input.withDependencies,
      };
};

const makeMigrateSelection = (
  input: Pick<CliRegistrySelectionInput, "all" | "definitionIds" | "group">
): Effect.Effect<MigrateSelection, CliError.UserError> => {
  const selectedKinds =
    Number(input.all) +
    Number(input.definitionIds.length > 0) +
    Number(input.group !== undefined);

  if (selectedKinds === 0) {
    return failReportedCliMessage(
      "Select migrations with definition IDs, --group, or --all"
    );
  }

  if (selectedKinds > 1) {
    return failReportedCliMessage(
      "Choose only one migration selection: definition IDs, --group, or --all"
    );
  }

  if (input.all) {
    return Effect.succeed({ kind: "all" });
  }

  if (input.group !== undefined) {
    return Effect.succeed({
      groupId: toMigrationDefinitionGroupId(input.group),
      kind: "group",
    });
  }

  const [firstDefinitionId, ...remainingDefinitionIds] = input.definitionIds;

  if (firstDefinitionId === undefined) {
    return failReportedCliMessage(
      "Select migrations with definition IDs, --group, or --all"
    );
  }

  return Effect.succeed({
    definitionIds: [
      toMigrationDefinitionId(firstDefinitionId),
      ...remainingDefinitionIds.map(toMigrationDefinitionId),
    ],
    kind: "definitions",
  });
};

const makeStatusInput = (
  input: CliRegistrySelectionInput & {
    readonly concurrency?: number;
    readonly scanSource: boolean;
  }
): MigrationDefinitionRegistryStatusInput =>
  ({
    ...makeRegistrySelectionInput(input),
    ...(input.concurrency === undefined
      ? {}
      : { concurrency: input.concurrency }),
    scanSource: input.scanSource,
  }) as MigrationDefinitionRegistryStatusInput;

const isPlanningError = (
  error: unknown
): error is MigrationDefinitionRegistryPlanningError => {
  if (typeof error !== "object" || error === null || !("_tag" in error)) {
    return false;
  }

  switch (error._tag) {
    case "MigrationDefinitionRegistryInvalidSelectionError":
    case "MigrationDefinitionRegistryMissingExplicitRequiredDependenciesError":
    case "MigrationDefinitionRegistryUnknownDefinitionError":
    case "MigrationDefinitionRegistryUnknownGroupError":
      return true;
    default:
      return false;
  }
};

const renderStatusCommandError = (
  error: MigrationDefinitionRegistryStatusError,
  input: {
    readonly definitionIds: readonly string[];
    readonly group?: string;
  }
): string => {
  if (isPlanningError(error)) {
    return renderPlanningError(error, {
      command: "status",
      definitionIds: input.definitionIds,
      ...(input.group === undefined ? {} : { group: input.group }),
      hasTarget: false,
    });
  }

  if (error._tag === "MigrationStatusRequestError") {
    return error.message;
  }

  return renderRuntimeError(error);
};

const renderMessagesCommandError = (
  error: MigrationDefinitionRegistryMessagesError,
  input: {
    readonly definitionIds: readonly string[];
    readonly group?: string;
  }
): string =>
  isPlanningError(error)
    ? renderPlanningError(error, {
        command: "messages",
        definitionIds: input.definitionIds,
        ...(input.group === undefined ? {} : { group: input.group }),
        hasTarget: false,
      })
    : renderRuntimeError(error);

interface RemoteReadSelection {
  readonly operation: MigratePreparedOperation;
  readonly selection: MigrateSelection;
}

function prepareRemoteReadSelection(
  connection: MigrationCliServerConnection,
  input: CliRegistrySelectionInput,
  renderError: (error: unknown) => string
): Effect.Effect<RemoteReadSelection, CliError.UserError> {
  return Effect.gen(function* () {
    const selection = yield* makeMigrateSelection(input);
    const operation = yield* connection
      .prepareOperation({
        action: "run",
        options: { withDependencies: input.withDependencies },
        selection,
      })
      .pipe(
        Effect.catch((error) => failReportedCliMessage(renderError(error)))
      );

    return { operation, selection };
  });
}

function remoteStatusScanTargets(
  selection: MigrateSelection,
  includedDefinitionIds: readonly MigrationDefinitionId[]
): readonly MigrateTarget[] {
  switch (selection.kind) {
    case "group":
      return [{ groupId: selection.groupId, kind: "group" }];
    case "definitions":
      return selection.definitionIds.map((definitionId) => ({
        definitionId,
        kind: "migration",
      }));
    case "all":
      return includedDefinitionIds.map((definitionId) => ({
        definitionId,
        kind: "migration",
      }));
    default: {
      const unhandled: never = selection;
      return unhandled;
    }
  }
}

function collectRemoteStatusRows(
  connection: MigrationCliServerConnection,
  selection: MigrateSelection,
  operation: MigratePreparedOperation,
  options: { readonly concurrency?: number; readonly scanSource: boolean }
): Effect.Effect<
  ReadonlyMap<MigrationDefinitionId, MigrateDashboardRow>,
  unknown
> {
  const rowsById = new Map(
    operation.planRows.map((row) => [row.entry.id, row])
  );

  if (!options.scanSource) {
    return Effect.succeed(rowsById);
  }

  return Effect.gen(function* () {
    const includedIds = new Set(operation.plan.includedDefinitionIds);
    const targets = remoteStatusScanTargets(
      selection,
      operation.plan.includedDefinitionIds
    );

    for (const target of targets) {
      const dashboard = yield* connection.scanSource({
        ...(options.concurrency === undefined
          ? {}
          : { concurrency: options.concurrency }),
        target,
      });

      for (const row of dashboard.rows) {
        if (includedIds.has(row.entry.id) && row.status?.source !== undefined) {
          rowsById.set(row.entry.id, row);
        }
      }
    }

    return rowsById;
  });
}

function makeRemoteStatusReport(
  operation: MigratePreparedOperation,
  rowsById: ReadonlyMap<MigrationDefinitionId, MigrateDashboardRow>,
  scanSource: boolean
): MigrationDefinitionRegistryStatusReport {
  const definitions = operation.plan.includedDefinitionIds.flatMap(
    (definitionId) => {
      const status = rowsById.get(definitionId)?.status;
      return status === undefined ? [] : [status];
    }
  );

  return {
    definitions,
    includedDefinitionIds: operation.plan.includedDefinitionIds,
    notices: operation.plan.notices,
    ...(operation.plan.requestedGroup === undefined
      ? {}
      : { requestedGroup: operation.plan.requestedGroup }),
    requestedDefinitionIds: operation.plan.requestedDefinitionIds,
    scanSource,
    warnings: definitions.flatMap((definition) => definition.warnings),
  };
}

function makeRemoteMessagesReport(
  operation: MigratePreparedOperation,
  messages: readonly MigrationMessage[]
): MigrationDefinitionRegistryMessagesReport {
  return {
    includedDefinitionIds: operation.plan.includedDefinitionIds,
    messages,
    notices: operation.plan.notices,
    ...(operation.plan.requestedGroup === undefined
      ? {}
      : { requestedGroup: operation.plan.requestedGroup }),
    requestedDefinitionIds: operation.plan.requestedDefinitionIds,
  };
}

const statusCommand = Command.make(
  "status",
  {
    all,
    concurrency: statusConcurrency,
    definitions: runDefinitions,
    group,
    scanSource,
    withDependencies,
  },
  (input) =>
    Effect.gen(function* () {
      const concurrencyInput = Option.getOrUndefined(input.concurrency);
      const groupInput = Option.getOrUndefined(input.group);
      const root = yield* migrateBaseCommand;

      if (Option.isSome(root.server)) {
        return yield* reportCliConnectionErrors(
          withCliMigrateConnection(({ connection }) =>
            Effect.gen(function* () {
              const { operation, selection } =
                yield* prepareRemoteReadSelection(
                  connection,
                  {
                    all: input.all,
                    definitionIds: input.definitions,
                    ...(groupInput === undefined ? {} : { group: groupInput }),
                    withDependencies: input.withDependencies,
                  },
                  (error) =>
                    isPlanningError(error)
                      ? renderStatusCommandError(error, {
                          definitionIds: input.definitions,
                          ...(groupInput === undefined
                            ? {}
                            : { group: groupInput }),
                        })
                      : renderStoredFailure(error)
                );
              const rowsById = yield* collectRemoteStatusRows(
                connection,
                selection,
                operation,
                {
                  ...(concurrencyInput === undefined
                    ? {}
                    : { concurrency: concurrencyInput }),
                  scanSource: input.scanSource,
                }
              );
              const report = makeRemoteStatusReport(
                operation,
                rowsById,
                input.scanSource
              );

              yield* Console.log(
                renderStatusReport(report, { colors: yield* useColor })
              );
            })
          )
        );
      }

      const loadedConfig = yield* loadConfiguredConfig;
      const registry = toCliExecutableRegistry(loadedConfig.registry);
      const statusInput = makeStatusInput({
        all: input.all,
        ...(concurrencyInput === undefined
          ? {}
          : { concurrency: concurrencyInput }),
        definitionIds: input.definitions,
        ...(groupInput === undefined ? {} : { group: groupInput }),
        scanSource: input.scanSource,
        withDependencies: input.withDependencies,
      });
      const report = yield* registry.status(statusInput).pipe(
        Effect.catch((error) =>
          failReportedCliMessage(
            renderStatusCommandError(error, {
              definitionIds: input.definitions,
              ...(groupInput === undefined ? {} : { group: groupInput }),
            })
          )
        )
      );

      yield* Console.log(
        renderStatusReport(report, { colors: yield* useColor })
      );
    })
).pipe(Command.withDescription("Inspect Migration Definition status"));

const messagesCommand = Command.make(
  "messages",
  {
    all,
    definitions: runDefinitions,
    group,
    json: messagesJson,
    withDependencies,
  },
  (input) =>
    Effect.gen(function* () {
      const groupInput = Option.getOrUndefined(input.group);
      const root = yield* migrateBaseCommand;

      if (Option.isSome(root.server)) {
        return yield* reportCliConnectionErrors(
          withCliMigrateConnection(({ connection }) =>
            Effect.gen(function* () {
              const { operation } = yield* prepareRemoteReadSelection(
                connection,
                {
                  all: input.all,
                  definitionIds: input.definitions,
                  ...(groupInput === undefined ? {} : { group: groupInput }),
                  withDependencies: input.withDependencies,
                },
                (error) =>
                  isPlanningError(error)
                    ? renderMessagesCommandError(error, {
                        definitionIds: input.definitions,
                        ...(groupInput === undefined
                          ? {}
                          : { group: groupInput }),
                      })
                    : renderStoredFailure(error)
              );
              const messages = (yield* Effect.forEach(
                operation.plan.includedDefinitionIds,
                (definitionId) =>
                  connection.getMessages({
                    definitionId,
                    kind: "migration",
                  })
              )).flat();
              const report = makeRemoteMessagesReport(operation, messages);

              if (input.json) {
                const json = yield* Schema.encodeEffect(
                  MigrationMessagesFromJson
                )(report.messages).pipe(Effect.orDie);
                yield* Console.log(json);
                return;
              }

              yield* Console.log(
                renderMessagesReport(report, { colors: yield* useColor })
              );
            })
          )
        );
      }

      const loadedConfig = yield* loadConfiguredConfig;
      const registry = loadedConfig.registry;
      const report = yield* registry
        .messages(
          makeRegistrySelectionInput({
            all: input.all,
            definitionIds: input.definitions,
            ...(groupInput === undefined ? {} : { group: groupInput }),
            withDependencies: input.withDependencies,
          })
        )
        .pipe(
          Effect.catch((error) =>
            failReportedCliMessage(
              renderMessagesCommandError(error, {
                definitionIds: input.definitions,
                ...(groupInput === undefined ? {} : { group: groupInput }),
              })
            )
          )
        );

      if (input.json) {
        const json = yield* Schema.encodeEffect(MigrationMessagesFromJson)(
          report.messages
        ).pipe(Effect.orDie);
        yield* Console.log(json);
        return;
      }

      yield* Console.log(
        renderMessagesReport(report, { colors: yield* useColor })
      );
    })
).pipe(Command.withDescription("Inspect durable Migration Messages"));

const unlockDefinition = Argument.string("definition").pipe(
  Argument.withDescription(
    "Migration Definition id whose lock should be cleared"
  )
);

const unlockCommand = Command.make(
  "unlock",
  { definition: unlockDefinition },
  ({ definition }) =>
    Effect.gen(function* () {
      const definitionId = toMigrationDefinitionId(definition);
      const root = yield* migrateBaseCommand;

      if (Option.isSome(root.server)) {
        return yield* reportCliConnectionErrors(
          withCliMigrateConnection(({ connection }) =>
            Effect.gen(function* () {
              const snapshot = yield* connection.getDashboard;
              const row = snapshot.dashboard.rows.find(
                (candidate) => candidate.entry.id === definitionId
              );

              if (row === undefined) {
                return yield* failReportedCliMessage(
                  `Migration Definition was not found in the registry: ${definitionId}`
                );
              }

              const lock = row.status?.lock;

              if (lock === undefined || lock === null) {
                yield* Console.log(
                  `Migration Definition lock is already clear: ${definitionId}`
                );
                return;
              }

              const result = yield* connection.breakLock(lock);

              if (result.kind === "already-clear") {
                yield* Console.log(
                  `Migration Definition lock is already clear: ${definitionId}`
                );
                return;
              }

              yield* Console.log(
                [
                  "Migration Definition lock cleared",
                  `Migration ID  ${definitionId}`,
                  `Owner Run ID  ${lock.ownerRunId}`,
                  `Token         ${lock.token}`,
                ].join("\n")
              );
            })
          )
        );
      }

      const loadedConfig = yield* loadConfiguredConfig;
      const registry = loadedConfig.registry;
      const migrationDefinition = Option.getOrUndefined(
        registry.get(definitionId)
      );

      if (migrationDefinition === undefined) {
        return yield* failReportedCliMessage(
          `Migration Definition was not found in the registry: ${definitionId}`
        );
      }

      const lock = yield* Effect.gen(function* () {
        const store = yield* MigrationStore;

        return yield* store.breakDefinitionLock(definitionId);
      }).pipe(
        Effect.provide(migrationDefinition.store),
        Effect.catch((error) =>
          failReportedCliMessage(renderRuntimeError(error))
        )
      );

      if (lock === null) {
        yield* Console.log(
          `Migration Definition lock is already clear: ${definitionId}`
        );
        return;
      }

      yield* Console.log(
        [
          "Migration Definition lock cleared",
          `Migration ID  ${definitionId}`,
          `Owner Run ID  ${lock.ownerRunId}`,
          `Token         ${lock.token}`,
        ].join("\n")
      );
    })
).pipe(Command.withDescription("Break a Migration Definition lock"));

const runIdArgument = Argument.string("run-id").pipe(
  Argument.withDescription("Migration Run id")
);

const consumeMigrationRunObservation = (
  connection: MigrationCliServerConnection,
  runId: ReturnType<typeof toMigrationRunId>,
  observeAgain: (runId: string) => string,
  observeAgainLabel: string,
  terminalSection: Semaphore.Semaphore,
  markObservationFinished: () => void,
  progress: CliObservationProgressRenderer
): Effect.Effect<void, CliError.UserError, MigrationCliRuntime> => {
  let completion:
    | Extract<
        Parameters<typeof renderMigrationObservationEvent>[0],
        { readonly kind: "detached" | "terminal" }
      >
    | undefined;

  return Effect.gen(function* () {
    const runtime = yield* MigrationCliRuntime;

    const consume = connection.observeRun(runId).pipe(
      Stream.runForEach((event) => {
        if (event.kind === "detached" || event.kind === "terminal") {
          return terminalSection.withPermit(
            progress.cleanup.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  completion = event;
                  markObservationFinished();
                })
              )
            )
          );
        }

        if (event.kind === "progress") {
          return progress.render(event);
        }

        const message = renderMigrationObservationEvent(event, {
          colors: runtime.useColor === true,
        });
        return progress.cleanup.pipe(
          Effect.andThen(
            event.kind === "warning"
              ? Console.error(message)
              : Console.log(message)
          )
        );
      }),
      Effect.catch((cause) =>
        terminalSection.withPermit(
          progress.cleanup.pipe(
            Effect.andThen(Effect.sync(markObservationFinished)),
            Effect.andThen(
              failReportedCliMessage(
                renderObservationRecovery(
                  runId,
                  observeAgain,
                  observeAgainLabel,
                  `Observation ended before reaching a terminal state: ${renderStoredFailure(cause)}`
                )
              )
            )
          )
        )
      ),
      Effect.flatMap(() =>
        terminalSection.withPermit(
          Effect.gen(function* () {
            if (completion === undefined) {
              markObservationFinished();
              return yield* failReportedCliMessage(
                renderObservationRecovery(
                  runId,
                  observeAgain,
                  observeAgainLabel,
                  "Observation ended before reaching a terminal state."
                )
              );
            }

            const message = renderMigrationObservationEvent(completion, {
              colors: runtime.useColor === true,
            });

            if (completion.kind === "detached") {
              return yield* Console.log(
                renderObservationRecovery(
                  completion.runId,
                  observeAgain,
                  observeAgainLabel,
                  completion.message
                )
              );
            }

            switch (completion.outcome) {
              case "completed":
                return yield* Console.log(message);
              case "cancelled":
                return yield* failCancelledCliMessage(message);
              case "failed":
                return yield* failReportedCliMessage(message);
              default: {
                const unhandled: never = completion.outcome;
                return unhandled;
              }
            }
          })
        )
      )
    );

    return yield* consume.pipe(Effect.ensuring(progress.cleanup));
  });
};

const stopObservedMigrationRun = (
  connection: MigrationCliServerConnection,
  runId: ReturnType<typeof toMigrationRunId>,
  terminalSection: Semaphore.Semaphore,
  observationIsFinished: () => boolean
) =>
  terminalSection.withPermit(
    Effect.gen(function* () {
      if (observationIsFinished()) {
        return Option.none();
      }

      const result = yield* connection.stopRun(runId);
      yield* Console.log(
        renderRunStopResult(result, { colors: yield* useColor })
      );
      return Option.some(result);
    })
  );

const detachObservedMigrationRun = <ObservationResult, ObservationError>(
  observationFiber: Fiber.Fiber<ObservationResult, ObservationError>,
  runId: ReturnType<typeof toMigrationRunId>,
  observeAgain: (runId: string) => string,
  observeAgainLabel: string,
  terminalSection: Semaphore.Semaphore,
  observationIsFinished: () => boolean
) =>
  terminalSection.withPermit(
    Effect.gen(function* () {
      if (observationIsFinished()) {
        return false;
      }

      yield* Fiber.interrupt(observationFiber);
      yield* Console.log(
        renderObservationRecovery(
          runId,
          observeAgain,
          observeAgainLabel,
          "Observation detached; the Migration Run continues."
        )
      );
      return true;
    })
  );

type MigrationRunObservationControlResult =
  | { readonly kind: "completed" }
  | { readonly kind: "detached" }
  | { readonly kind: "observing"; readonly stopRequested: boolean };

type MigrationRunObservationDecisionResult =
  | { readonly kind: "completed" }
  | {
      readonly decision: MigrationRunObservationInterruptDecision;
      readonly kind: "decision";
    };

const chooseMigrationRunObservationInterrupt = (
  runtime: typeof MigrationCliRuntime.Service,
  runId: ReturnType<typeof toMigrationRunId>,
  stopRequested: boolean
) =>
  runtime.stdoutIsTTY === true &&
  runtime.chooseRunObservationInterrupt !== undefined
    ? runtime.chooseRunObservationInterrupt(runId, { stopRequested })
    : Effect.succeed("detach" as const);

const applyMigrationRunObservationInterrupt = <
  ObservationResult,
  ObservationError,
>(
  decision: "continue" | "detach" | "stop",
  observationFiber: Fiber.Fiber<ObservationResult, ObservationError>,
  cliConnection: CliMigrateConnection,
  runId: ReturnType<typeof toMigrationRunId>,
  terminalSection: Semaphore.Semaphore,
  observationIsFinished: () => boolean,
  stopRequested: boolean
): Effect.Effect<
  MigrationRunObservationControlResult,
  unknown,
  MigrationCliRuntime
> => {
  if (decision === "continue") {
    return Effect.succeed({ kind: "observing", stopRequested });
  }

  if (decision === "stop") {
    return stopObservedMigrationRun(
      cliConnection.connection,
      runId,
      terminalSection,
      observationIsFinished
    ).pipe(
      Effect.map(
        (result): MigrationRunObservationControlResult =>
          Option.isNone(result)
            ? { kind: "completed" }
            : {
                kind: "observing",
                stopRequested:
                  stopRequested || result.value.kind === "requested",
              }
      )
    );
  }

  return detachObservedMigrationRun(
    observationFiber,
    runId,
    cliConnection.observeAgain,
    cliConnection.observeAgainLabel,
    terminalSection,
    observationIsFinished
  ).pipe(
    Effect.map(
      (detached): MigrationRunObservationControlResult =>
        detached ? { kind: "detached" } : { kind: "completed" }
    )
  );
};

const observeMigrationRunWithInterrupts = (
  cliConnection: CliMigrateConnection,
  runId: ReturnType<typeof toMigrationRunId>,
  progressMode: CliProgressMode,
  interrupts?: ActiveMigrationCliInterrupts,
  initialInterrupt = false
): Effect.Effect<void, CliError.CliError, MigrationCliRuntime> =>
  Effect.gen(function* () {
    const runtime = yield* MigrationCliRuntime;
    const terminalSection = yield* Semaphore.make(1);
    const progress = yield* makeCliObservationProgressRenderer(
      progressMode,
      runtime
    );
    let observationFinished = false;
    const observation = consumeMigrationRunObservation(
      cliConnection.connection,
      runId,
      cliConnection.observeAgain,
      cliConnection.observeAgainLabel,
      terminalSection,
      () => {
        observationFinished = true;
      },
      progress
    );

    if (interrupts === undefined) {
      return yield* observation;
    }

    const observationFiber = yield* observation.pipe(Effect.forkChild);
    let stopRequested = false;
    let pendingInterrupt = initialInterrupt;

    while (true) {
      if (!pendingInterrupt) {
        const next = yield* Effect.raceFirst(
          Fiber.join(observationFiber).pipe(
            Effect.as({ kind: "completed" as const })
          ),
          interrupts.wait.pipe(Effect.as({ kind: "interrupt" as const }))
        );

        if (next.kind === "completed") {
          return;
        }
      }
      pendingInterrupt = false;
      yield* progress.pause;

      const decisionOrCompletion: MigrationRunObservationDecisionResult =
        yield* Effect.raceFirst(
          Fiber.join(observationFiber).pipe(
            Effect.as({ kind: "completed" as const })
          ),
          chooseMigrationRunObservationInterrupt(
            runtime,
            runId,
            stopRequested
          ).pipe(
            Effect.map((decision) => ({
              decision,
              kind: "decision" as const,
            }))
          )
        );

      if (decisionOrCompletion.kind === "completed") {
        return;
      }

      const control: MigrationRunObservationControlResult =
        yield* applyMigrationRunObservationInterrupt(
          decisionOrCompletion.decision,
          observationFiber,
          cliConnection,
          runId,
          terminalSection,
          () => observationFinished,
          stopRequested
        );

      if (control.kind === "completed") {
        return yield* Fiber.join(observationFiber);
      }

      if (control.kind === "detached") {
        return;
      }

      yield* progress.resume;
      stopRequested = control.stopRequested;
    }
  }).pipe(
    Effect.catch((error) =>
      CliError.isCliError(error)
        ? Effect.fail(error)
        : failReportedCliMessage(
            renderObservationRecovery(
              runId,
              cliConnection.observeAgain,
              cliConnection.observeAgainLabel,
              `Observation ended before reaching a terminal state: ${renderStoredFailure(error)}`
            )
          )
    )
  );

const observeMigrationRun = (
  cliConnection: CliMigrateConnection,
  runId: ReturnType<typeof toMigrationRunId>,
  progressMode: CliProgressMode = "log"
): Effect.Effect<void, CliError.CliError, MigrationCliRuntime> =>
  Effect.gen(function* () {
    const runtime = yield* MigrationCliRuntime;

    if (runtime.interrupts === undefined) {
      return yield* observeMigrationRunWithInterrupts(
        cliConnection,
        runId,
        progressMode
      );
    }

    return yield* runtime.interrupts.withInterrupts((interrupts) =>
      observeMigrationRunWithInterrupts(
        cliConnection,
        runId,
        progressMode,
        interrupts
      )
    );
  });

const startPreparedOperationWithInterrupts = (
  cliConnection: CliMigrateConnection,
  operation: MigratePreparedOperation,
  progressMode: CliProgressMode,
  interrupts?: ActiveMigrationCliInterrupts
): Effect.Effect<void, unknown, MigrationCliRuntime> =>
  Effect.gen(function* () {
    const start = cliConnection.connection.startOperation({
      acceptedFingerprint: operation.fingerprint,
      request: operation.request,
    });

    if (interrupts === undefined) {
      const reference = yield* start;
      return yield* observeMigrationRunWithInterrupts(
        cliConnection,
        reference.runId,
        progressMode
      );
    }

    const startFiber = yield* start.pipe(Effect.forkChild);
    const first = yield* Effect.raceFirst(
      Fiber.join(startFiber).pipe(
        Effect.map((reference) => ({ kind: "started" as const, reference }))
      ),
      interrupts.wait.pipe(Effect.as({ kind: "interrupt" as const }))
    );

    if (first.kind === "started") {
      return yield* observeMigrationRunWithInterrupts(
        cliConnection,
        first.reference.runId,
        progressMode,
        interrupts
      );
    }

    const runtime = yield* MigrationCliRuntime;
    const acknowledgement = yield* Effect.raceFirst(
      Fiber.join(startFiber).pipe(
        Effect.map((reference) => ({ kind: "started" as const, reference }))
      ),
      interrupts.wait.pipe(Effect.as({ kind: "interrupted" as const }))
    ).pipe(
      Effect.timeoutOption(runtime.startAcknowledgementTimeoutMs ?? 10_000),
      Effect.catch((cause) =>
        failReportedCliMessage(
          [
            "The start acknowledgement failed after Ctrl+C; the Migration Run may still have started.",
            `List active runs: ${cliConnection.listActiveRuns}`,
            renderStoredFailure(cause),
          ].join("\n")
        )
      )
    );

    if (
      Option.isNone(acknowledgement) ||
      acknowledgement.value.kind === "interrupted"
    ) {
      return yield* failReportedCliMessage(
        [
          "The start acknowledgement is still unknown after Ctrl+C; the Migration Run may have started.",
          `List active runs: ${cliConnection.listActiveRuns}`,
        ].join("\n")
      );
    }

    const reference = acknowledgement.value.reference;

    return yield* observeMigrationRunWithInterrupts(
      cliConnection,
      reference.runId,
      progressMode,
      interrupts,
      true
    );
  });

const startPreparedOperation = (
  cliConnection: CliMigrateConnection,
  operation: MigratePreparedOperation,
  progressMode: CliProgressMode
): Effect.Effect<void, CliError.CliError, MigrationCliRuntime> =>
  Effect.gen(function* () {
    if (
      operation.plan.force !== true &&
      operation.dependencyChecks.some((dependency) => !dependency.satisfied)
    ) {
      return yield* failReportedCliMessage(
        renderPreparedOperationDependencyFailure(operation)
      );
    }

    const runtime = yield* MigrationCliRuntime;
    const execute = (interrupts?: ActiveMigrationCliInterrupts) =>
      startPreparedOperationWithInterrupts(
        cliConnection,
        operation,
        progressMode,
        interrupts
      );

    return yield* runtime.interrupts === undefined
      ? execute()
      : runtime.interrupts.withInterrupts(execute);
  }).pipe(
    Effect.catch((error) =>
      CliError.isCliError(error)
        ? Effect.fail(error)
        : failReportedCliMessage(renderStoredFailure(error))
    )
  );

const prepareCliOperation = (
  connection: MigrationCliServerConnection,
  request: MigrateOperationRequest
): Effect.Effect<MigratePreparedOperation, CliError.UserError> => {
  const renderError = (cause: unknown): string => {
    if (!isPlanningError(cause)) {
      return renderStoredFailure(cause);
    }

    let mode: "failed" | "skipped" | undefined;

    if (request.action === "retry-failed") {
      mode = "failed";
    } else if (request.action === "retry-skipped") {
      mode = "skipped";
    }

    return renderPlanningError(cause, {
      command: request.action === "rollback" ? "rollback" : "run",
      definitionIds:
        request.selection.kind === "definitions"
          ? request.selection.definitionIds
          : [],
      ...(request.selection.kind === "group"
        ? { group: request.selection.groupId }
        : {}),
      hasTarget: request.options.sourceIdentities !== undefined,
      ...(mode === undefined ? {} : { mode }),
      ...(request.action === "rescan" ? { rescan: true } : {}),
      ...(request.options.rollbackOrphans === true
        ? { rollbackOrphans: true }
        : {}),
      ...(request.action === "update" ? { update: true } : {}),
    });
  };

  return connection
    .prepareOperation(request)
    .pipe(Effect.catch((cause) => failReportedCliMessage(renderError(cause))));
};

const runsListCommand = Command.make("list", {}, () =>
  withCliMigrateConnection(({ connection }) =>
    Effect.gen(function* () {
      const activeRuns = yield* connection.getActiveRuns;
      yield* Console.log(
        renderActiveMigrationRuns(activeRuns, { colors: yield* useColor })
      );
    })
  ).pipe(
    Effect.catch((error) =>
      CliError.isCliError(error)
        ? Effect.fail(error)
        : failReportedCliMessage(renderStoredFailure(error))
    )
  )
).pipe(Command.withDescription("List active Migration Runs"));

const runsObserveCommand = Command.make(
  "observe",
  { runId: runIdArgument },
  ({ runId }) => {
    const migrationRunId = toMigrationRunId(runId);

    return withCliMigrateConnection(
      (connection) => observeMigrationRun(connection, migrationRunId),
      migrationRunId
    );
  }
).pipe(Command.withDescription("Observe a Migration Run"));

const runsStopCommand = Command.make(
  "stop",
  { runId: runIdArgument },
  ({ runId }) =>
    withCliMigrateConnection(({ connection }) =>
      Effect.gen(function* () {
        const result = yield* connection.stopRun(toMigrationRunId(runId));
        yield* Console.log(
          renderRunStopResult(result, { colors: yield* useColor })
        );
      })
    ).pipe(
      Effect.catch((error) =>
        CliError.isCliError(error)
          ? Effect.fail(error)
          : failReportedCliMessage(renderStoredFailure(error))
      )
    )
).pipe(Command.withDescription("Safely stop a Migration Run"));

const runsCommand = Command.make("runs").pipe(
  Command.withDescription("Observe and control Migration Runs"),
  Command.withSubcommands([
    runsListCommand,
    runsObserveCommand,
    runsStopCommand,
  ])
);

const runCommand = Command.make(
  "run",
  {
    all,
    definitions: runDefinitions,
    failed,
    group,
    id,
    force,
    plan,
    progress,
    concurrency: processConcurrency,
    rescan,
    rollbackOrphans,
    skipped,
    update,
    withDependencies,
  },
  (input) =>
    Effect.gen(function* () {
      const requestedActions = [
        input.failed,
        input.skipped,
        input.rescan,
        input.update,
      ].filter(Boolean).length;

      if (requestedActions > 1) {
        return yield* failReportedCliMessage(
          "Choose only one run mode: --failed, --skipped, --rescan, or --update"
        );
      }

      const groupInput = Option.getOrUndefined(input.group);
      const idsInput = Option.getOrUndefined(input.id);
      const sourceIdentities =
        idsInput === undefined || idsInput.length === 0
          ? undefined
          : yield* parseSourceIdentityTargets(idsInput);
      const concurrencyInput = Option.getOrUndefined(input.concurrency);
      const executionOptions =
        concurrencyInput === undefined
          ? undefined
          : {
              process: {
                concurrency: yield* parsePipelineExecutionConcurrency(
                  concurrencyInput,
                  "--concurrency"
                ),
              },
              ...(input.rollbackOrphans
                ? {
                    rollback: {
                      concurrency: yield* parsePipelineExecutionConcurrency(
                        concurrencyInput,
                        "--concurrency"
                      ),
                    },
                  }
                : {}),
            };
      const selection = yield* makeMigrateSelection({
        all: input.all,
        definitionIds: input.definitions,
        ...(groupInput === undefined ? {} : { group: groupInput }),
      });
      let action: MigrateAction = "run";

      if (input.failed) {
        action = "retry-failed";
      } else if (input.skipped) {
        action = "retry-skipped";
      } else if (input.rescan) {
        action = "rescan";
      } else if (input.update) {
        action = "update";
      }
      const request: MigrateOperationRequest = {
        action,
        options: {
          ...(executionOptions === undefined
            ? {}
            : { execution: executionOptions }),
          ...(input.force ? { force: true } : {}),
          ...(input.rollbackOrphans ? { rollbackOrphans: true } : {}),
          ...(sourceIdentities === undefined ? {} : { sourceIdentities }),
          withDependencies: input.withDependencies,
        },
        selection,
      };

      yield* withCliMigrateConnection((cliConnection) =>
        Effect.gen(function* () {
          const operation = yield* prepareCliOperation(
            cliConnection.connection,
            request
          );
          const colors = yield* useColor;

          if (input.plan) {
            yield* Console.log(
              renderPreparedOperationPlan(operation, { colors })
            );
            return;
          }

          const warnings = renderPreparedOperationWarnings(operation, {
            colors,
          });

          if (warnings !== "") {
            yield* Console.log(warnings);
          }

          yield* startPreparedOperation(
            cliConnection,
            operation,
            input.progress
          );
        })
      );
    })
).pipe(Command.withDescription("Plan or run Migration Definitions"));

const rollbackCommand = Command.make(
  "rollback",
  {
    all,
    definitions: runDefinitions,
    group,
    id,
    force,
    plan,
    progress,
    concurrency: rollbackConcurrency,
    withDependencies,
  },
  (input) =>
    Effect.gen(function* () {
      const groupInput = Option.getOrUndefined(input.group);
      const idsInput = Option.getOrUndefined(input.id);
      const sourceIdentities =
        idsInput === undefined || idsInput.length === 0
          ? undefined
          : yield* parseSourceIdentityTargets(idsInput);
      const concurrencyInput = Option.getOrUndefined(input.concurrency);
      const executionOptions =
        concurrencyInput === undefined
          ? undefined
          : {
              rollback: {
                concurrency: yield* parsePipelineExecutionConcurrency(
                  concurrencyInput,
                  "--concurrency"
                ),
              },
            };
      const selection = yield* makeMigrateSelection({
        all: input.all,
        definitionIds: input.definitions,
        ...(groupInput === undefined ? {} : { group: groupInput }),
      });
      const request: MigrateOperationRequest = {
        action: "rollback",
        options: {
          ...(executionOptions === undefined
            ? {}
            : { execution: executionOptions }),
          ...(input.force ? { force: true } : {}),
          ...(sourceIdentities === undefined ? {} : { sourceIdentities }),
          withDependencies: input.withDependencies,
        },
        selection,
      };

      yield* withCliMigrateConnection((cliConnection) =>
        Effect.gen(function* () {
          const operation = yield* prepareCliOperation(
            cliConnection.connection,
            request
          );

          if (input.plan) {
            yield* Console.log(
              renderPreparedOperationPlan(operation, {
                colors: yield* useColor,
              })
            );
            return;
          }

          yield* startPreparedOperation(
            cliConnection,
            operation,
            input.progress
          );
        })
      );
    })
).pipe(Command.withDescription("Plan or rollback Migration Definitions"));

export const migrateCommand = migrateBaseCommand.pipe(
  Command.withDescription("Migration SDK CLI"),
  Command.withSubcommands([
    listCommand,
    graphCommand,
    statusCommand,
    messagesCommand,
    storeCommand,
    unlockCommand,
    runsCommand,
    runCommand,
    rollbackCommand,
  ])
);
