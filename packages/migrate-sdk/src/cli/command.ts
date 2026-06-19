import { Console, Effect, Option, Runtime } from "effect";
import { Argument, CliError, Command, Flag } from "effect/unstable/cli";
import type {
  MigrationExecutionOptions,
  PipelineExecutionConcurrency,
} from "../domain/execution.ts";
import {
  type MigrationDefinitionId,
  toMigrationDefinitionId,
} from "../domain/ids.ts";
import type {
  MigrationDefinitionRegistry,
  MigrationDefinitionRegistryPlanningError,
  MigrationDefinitionRegistryRollbackError,
  MigrationDefinitionRegistryRollbackInput,
  MigrationDefinitionRegistryRunError,
  MigrationDefinitionRegistryRunInput,
  MigrationDefinitionRegistryStatusError,
  MigrationDefinitionRegistryStatusInput,
} from "../domain/registry.ts";
import {
  loadMigrationCliConfig,
  type MigrationCliConfigLoadError,
} from "./config-loader.ts";
import {
  renderConfigLoadError,
  renderPlanningError,
  renderRegistryGraph,
  renderRegistryList,
  renderRollbackPlan,
  renderRollbackSummary,
  renderRunPlan,
  renderRunSummary,
  renderRuntimeError,
  renderStatusReport,
} from "./render.ts";
import { MigrationCliRuntime } from "./runtime.ts";

const config = Flag.string("config").pipe(
  Flag.optional,
  Flag.withDescription("Path to a migrate.config.ts, .mts, .js, or .mjs file")
);

const migrateBaseCommand = Command.make("migrate").pipe(
  Command.withSharedFlags({ config })
);

const shouldUseColor = (): boolean =>
  process.env.NO_COLOR === undefined &&
  process.env.FORCE_COLOR !== "0" &&
  (process.env.FORCE_COLOR !== undefined ||
    (process.stdout.hasColors?.() ?? process.stdout.isTTY === true));

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

const loadConfiguredRegistry = Effect.gen(function* () {
  const root = yield* migrateBaseCommand;
  const runtime = yield* MigrationCliRuntime;
  const configPath = Option.getOrUndefined(root.config);
  const loadedConfig = yield* Effect.catch(
    loadMigrationCliConfig({
      cwd: runtime.cwd,
      ...(configPath === undefined ? {} : { configPath }),
    }),
    failConfigLoad
  );

  return loadedConfig.registry;
});

const hasRegisteredDefinition = (
  registry: MigrationDefinitionRegistry,
  definitionId: MigrationDefinitionId
): boolean => registry.list().some((entry) => entry.id === definitionId);

const listCommand = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const registry = yield* loadConfiguredRegistry;

    yield* Console.log(
      renderRegistryList(registry, { colors: shouldUseColor() })
    );
  })
).pipe(Command.withDescription("List registered Migration Definitions"));

const graphDefinition = Argument.string("definition").pipe(Argument.optional);

const graphCommand = Command.make(
  "graph",
  { definition: graphDefinition },
  ({ definition }) =>
    Effect.gen(function* () {
      const registry = yield* loadConfiguredRegistry;
      const focusedDefinitionId = Option.getOrUndefined(definition);

      if (focusedDefinitionId !== undefined) {
        const definitionId = toMigrationDefinitionId(focusedDefinitionId);

        if (!hasRegisteredDefinition(registry, definitionId)) {
          return yield* failReportedCliMessage(
            `Migration Definition was not found in the registry: ${definitionId}`
          );
        }

        yield* Console.log(
          renderRegistryGraph(registry, definitionId, {
            colors: shouldUseColor(),
          })
        );
        return;
      }

      yield* Console.log(
        renderRegistryGraph(registry, undefined, { colors: shouldUseColor() })
      );
    })
).pipe(Command.withDescription("Inspect Migration Definition dependencies"));

const plan = Flag.boolean("plan").pipe(
  Flag.withDescription("Print the execution plan without running migrations")
);

const all = Flag.boolean("all").pipe(
  Flag.withDescription("Select every registered Migration Definition")
);

const withDependencies = Flag.boolean("with-dependencies").pipe(
  Flag.withDescription("Expand required Migration Definition dependencies")
);

const scanSource = Flag.boolean("scan-source").pipe(
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
  Flag.withDescription("Plan a rerun of failed items")
);

const skipped = Flag.boolean("skipped").pipe(
  Flag.withDescription("Plan a rerun of skipped items")
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

const makeRunPlanInput = (input: {
  readonly all: boolean;
  readonly definitionIds: readonly string[];
  readonly execution?: MigrationExecutionOptions;
  readonly mode?: "failed" | "skipped";
  readonly sourceIdentities?: readonly string[];
  readonly withDependencies: boolean;
}): MigrationDefinitionRegistryRunInput => {
  if (input.all) {
    return input.definitionIds.length === 0
      ? {
          all: true,
          ...(input.sourceIdentities === undefined
            ? {}
            : { sourceIdentities: input.sourceIdentities }),
          ...(input.execution === undefined
            ? {}
            : { execution: input.execution }),
          ...(input.mode === undefined ? {} : { mode: { kind: input.mode } }),
          withDependencies: input.withDependencies,
        }
      : ({
          all: true,
          definitionIds: input.definitionIds,
          ...(input.sourceIdentities === undefined
            ? {}
            : { sourceIdentities: input.sourceIdentities }),
          ...(input.execution === undefined
            ? {}
            : { execution: input.execution }),
          ...(input.mode === undefined ? {} : { mode: { kind: input.mode } }),
          withDependencies: input.withDependencies,
        } as MigrationDefinitionRegistryRunInput);
  }

  return input.definitionIds.length === 0
    ? ({} as MigrationDefinitionRegistryRunInput)
    : {
        definitionIds: input.definitionIds as [string, ...string[]],
        ...(input.sourceIdentities === undefined
          ? {}
          : { sourceIdentities: input.sourceIdentities }),
        ...(input.execution === undefined
          ? {}
          : { execution: input.execution }),
        ...(input.mode === undefined ? {} : { mode: { kind: input.mode } }),
        withDependencies: input.withDependencies,
      };
};

const makeRollbackPlanInput = (input: {
  readonly all: boolean;
  readonly definitionIds: readonly string[];
  readonly execution?: MigrationExecutionOptions;
  readonly sourceIdentities?: readonly string[];
  readonly withDependencies: boolean;
}): MigrationDefinitionRegistryRollbackInput => {
  if (input.all) {
    return input.definitionIds.length === 0
      ? {
          all: true,
          ...(input.sourceIdentities === undefined
            ? {}
            : { sourceIdentities: input.sourceIdentities }),
          ...(input.execution === undefined
            ? {}
            : { execution: input.execution }),
          withDependencies: input.withDependencies,
        }
      : ({
          all: true,
          definitionIds: input.definitionIds,
          ...(input.sourceIdentities === undefined
            ? {}
            : { sourceIdentities: input.sourceIdentities }),
          ...(input.execution === undefined
            ? {}
            : { execution: input.execution }),
          withDependencies: input.withDependencies,
        } as MigrationDefinitionRegistryRollbackInput);
  }

  return input.definitionIds.length === 0
    ? ({} as MigrationDefinitionRegistryRollbackInput)
    : {
        definitionIds: input.definitionIds as [string, ...string[]],
        ...(input.sourceIdentities === undefined
          ? {}
          : { sourceIdentities: input.sourceIdentities }),
        ...(input.execution === undefined
          ? {}
          : { execution: input.execution }),
        withDependencies: input.withDependencies,
      };
};

const makeStatusInput = (input: {
  readonly all: boolean;
  readonly concurrency?: number;
  readonly definitionIds: readonly string[];
  readonly scanSource: boolean;
  readonly withDependencies: boolean;
}): MigrationDefinitionRegistryStatusInput => {
  const statusOptions = {
    ...(input.concurrency === undefined
      ? {}
      : { concurrency: input.concurrency }),
    scanSource: input.scanSource,
    withDependencies: input.withDependencies,
  };

  if (input.all) {
    return input.definitionIds.length === 0
      ? {
          all: true,
          ...statusOptions,
        }
      : ({
          all: true,
          definitionIds: input.definitionIds,
          ...statusOptions,
        } as MigrationDefinitionRegistryStatusInput);
  }

  return input.definitionIds.length === 0
    ? ({} as MigrationDefinitionRegistryStatusInput)
    : {
        definitionIds: input.definitionIds as [string, ...string[]],
        ...statusOptions,
      };
};

const isPlanningError = (
  error:
    | MigrationDefinitionRegistryRollbackError
    | MigrationDefinitionRegistryRunError
    | MigrationDefinitionRegistryStatusError
): error is MigrationDefinitionRegistryPlanningError => {
  switch (error._tag) {
    case "MigrationDefinitionRegistryInvalidSelectionError":
    case "MigrationDefinitionRegistryMissingExplicitRequiredDependenciesError":
    case "MigrationDefinitionRegistryUnknownDefinitionError":
      return true;
    default:
      return false;
  }
};

const renderRunCommandError = (
  error: MigrationDefinitionRegistryRunError,
  input: {
    readonly definitionIds: readonly string[];
    readonly hasTarget: boolean;
    readonly mode?: "failed" | "skipped";
  }
): string =>
  isPlanningError(error)
    ? renderPlanningError(error, {
        command: "run",
        definitionIds: input.definitionIds,
        hasTarget: input.hasTarget,
        ...(input.mode === undefined ? {} : { mode: input.mode }),
      })
    : renderRuntimeError(error);

const renderRollbackCommandError = (
  error: MigrationDefinitionRegistryRollbackError,
  input: {
    readonly definitionIds: readonly string[];
    readonly hasTarget: boolean;
  }
): string =>
  isPlanningError(error)
    ? renderPlanningError(error, {
        command: "rollback",
        definitionIds: input.definitionIds,
        hasTarget: input.hasTarget,
      })
    : renderRuntimeError(error);

const renderStatusCommandError = (
  error: MigrationDefinitionRegistryStatusError,
  input: {
    readonly definitionIds: readonly string[];
  }
): string => {
  if (isPlanningError(error)) {
    return renderPlanningError(error, {
      command: "status",
      definitionIds: input.definitionIds,
      hasTarget: false,
    });
  }

  if (error._tag === "MigrationStatusRequestError") {
    return error.message;
  }

  return renderRuntimeError(error);
};

const statusCommand = Command.make(
  "status",
  {
    all,
    concurrency: statusConcurrency,
    definitions: runDefinitions,
    scanSource,
    withDependencies,
  },
  (input) =>
    Effect.gen(function* () {
      const registry = yield* loadConfiguredRegistry;
      const concurrencyInput = Option.getOrUndefined(input.concurrency);
      const statusInput = makeStatusInput({
        all: input.all,
        ...(concurrencyInput === undefined
          ? {}
          : { concurrency: concurrencyInput }),
        definitionIds: input.definitions,
        scanSource: input.scanSource,
        withDependencies: input.withDependencies,
      });
      const report = yield* registry.status(statusInput).pipe(
        Effect.catch((error) =>
          failReportedCliMessage(
            renderStatusCommandError(error, {
              definitionIds: input.definitions,
            })
          )
        )
      );

      yield* Console.log(
        renderStatusReport(report, { colors: shouldUseColor() })
      );
    })
).pipe(Command.withDescription("Inspect Migration Definition status"));

const runCommand = Command.make(
  "run",
  {
    all,
    definitions: runDefinitions,
    failed,
    id,
    plan,
    concurrency: processConcurrency,
    skipped,
    withDependencies,
  },
  (input) =>
    Effect.gen(function* () {
      if (input.failed && input.skipped) {
        return yield* failReportedCliMessage(
          "Run planning cannot combine --failed and --skipped"
        );
      }

      const registry = yield* loadConfiguredRegistry;
      const idsInput = Option.getOrUndefined(input.id);
      const sourceIdentities =
        idsInput === undefined || idsInput.length === 0
          ? undefined
          : yield* parseSourceIdentityTargets(idsInput);
      let mode: "failed" | "skipped" | undefined;

      if (input.failed) {
        mode = "failed";
      } else if (input.skipped) {
        mode = "skipped";
      }
      const concurrencyInput = Option.getOrUndefined(input.concurrency);
      const execution =
        concurrencyInput === undefined
          ? undefined
          : {
              process: {
                concurrency: yield* parsePipelineExecutionConcurrency(
                  concurrencyInput,
                  "--concurrency"
                ),
              },
            };
      const runInput = makeRunPlanInput({
        all: input.all,
        definitionIds: input.definitions,
        ...(execution === undefined ? {} : { execution }),
        ...(mode === undefined ? {} : { mode }),
        ...(sourceIdentities === undefined ? {} : { sourceIdentities }),
        withDependencies: input.withDependencies,
      });

      if (input.plan) {
        const plan = yield* registry.planRun(runInput).pipe(
          Effect.catch((error) =>
            failReportedCliMessage(
              renderPlanningError(error, {
                command: "run",
                definitionIds: input.definitions,
                hasTarget: sourceIdentities !== undefined,
                ...(mode === undefined ? {} : { mode }),
              })
            )
          )
        );

        yield* Console.log(
          renderRunPlan(plan, {
            colors: shouldUseColor(),
            ...(mode === undefined ? {} : { mode }),
          })
        );
        return;
      }

      const summary = yield* registry.run(runInput).pipe(
        Effect.catch((error) =>
          failReportedCliMessage(
            renderRunCommandError(error, {
              definitionIds: input.definitions,
              hasTarget: sourceIdentities !== undefined,
              ...(mode === undefined ? {} : { mode }),
            })
          )
        )
      );

      yield* Console.log(
        renderRunSummary(summary, { colors: shouldUseColor() })
      );
    })
).pipe(Command.withDescription("Plan or run Migration Definitions"));

const rollbackCommand = Command.make(
  "rollback",
  {
    all,
    definitions: runDefinitions,
    id,
    plan,
    concurrency: rollbackConcurrency,
    withDependencies,
  },
  (input) =>
    Effect.gen(function* () {
      const registry = yield* loadConfiguredRegistry;
      const idsInput = Option.getOrUndefined(input.id);
      const sourceIdentities =
        idsInput === undefined || idsInput.length === 0
          ? undefined
          : yield* parseSourceIdentityTargets(idsInput);
      const concurrencyInput = Option.getOrUndefined(input.concurrency);
      const execution =
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
      const rollbackInput = makeRollbackPlanInput({
        all: input.all,
        definitionIds: input.definitions,
        ...(execution === undefined ? {} : { execution }),
        ...(sourceIdentities === undefined ? {} : { sourceIdentities }),
        withDependencies: input.withDependencies,
      });

      if (input.plan) {
        const plan = yield* registry.planRollback(rollbackInput).pipe(
          Effect.catch((error) =>
            failReportedCliMessage(
              renderPlanningError(error, {
                command: "rollback",
                definitionIds: input.definitions,
                hasTarget: sourceIdentities !== undefined,
              })
            )
          )
        );

        yield* Console.log(
          renderRollbackPlan(plan, { colors: shouldUseColor() })
        );
        return;
      }

      const summary = yield* registry.rollback(rollbackInput).pipe(
        Effect.catch((error) =>
          failReportedCliMessage(
            renderRollbackCommandError(error, {
              definitionIds: input.definitions,
              hasTarget: sourceIdentities !== undefined,
            })
          )
        )
      );

      yield* Console.log(
        renderRollbackSummary(summary, { colors: shouldUseColor() })
      );
    })
).pipe(Command.withDescription("Plan or rollback Migration Definitions"));

export const migrateCommand = migrateBaseCommand.pipe(
  Command.withDescription("Migration SDK CLI"),
  Command.withSubcommands([
    listCommand,
    graphCommand,
    statusCommand,
    runCommand,
    rollbackCommand,
  ])
);
