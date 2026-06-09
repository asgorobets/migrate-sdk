import { Console, Effect, Option, Runtime } from "effect";
import { Argument, CliError, Command, Flag } from "effect/unstable/cli";
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
} from "./render.ts";
import { MigrationCliRuntime } from "./runtime.ts";

const config = Flag.string("config").pipe(
  Flag.optional,
  Flag.withDescription("Path to a migrate.config.ts, .mts, .js, or .mjs file")
);

const migrateBaseCommand = Command.make("migrate").pipe(
  Command.withSharedFlags({ config })
);

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

    yield* Console.log(renderRegistryList(registry));
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

        yield* Console.log(renderRegistryGraph(registry, definitionId));
        return;
      }

      yield* Console.log(renderRegistryGraph(registry));
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

const failed = Flag.boolean("failed").pipe(
  Flag.withDescription("Plan a rerun of failed items")
);

const skipped = Flag.boolean("skipped").pipe(
  Flag.withDescription("Plan a rerun of skipped items")
);

const ids = Flag.string("ids").pipe(
  Flag.optional,
  Flag.withDescription("Comma-separated source identity targets")
);

const runDefinitions = Argument.string("definition").pipe(Argument.variadic());

const decodeSourceIdentityTarget = (
  segment: string
): Effect.Effect<string, CliError.UserError> =>
  Effect.try({
    try: () => decodeURIComponent(segment),
    catch: () => "--ids contains invalid percent encoding",
  }).pipe(
    Effect.catch((message) => failReportedCliMessage(message)),
    Effect.flatMap((decodedSegment) =>
      decodedSegment.length === 0
        ? failReportedCliMessage(
            "--ids must not contain empty source identities"
          )
        : Effect.succeed(decodedSegment)
    )
  );

const parseSourceIdentityTargets = (
  input: string
): Effect.Effect<readonly string[], CliError.UserError> => {
  const segments = input.split(",");

  if (segments.some((segment) => segment.length === 0)) {
    return failReportedCliMessage(
      "--ids must not contain empty comma-separated segments"
    );
  }

  return Effect.forEach(segments, decodeSourceIdentityTarget);
};

const makeRunPlanInput = (input: {
  readonly all: boolean;
  readonly definitionIds: readonly string[];
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
          ...(input.mode === undefined ? {} : { mode: { kind: input.mode } }),
          withDependencies: input.withDependencies,
        }
      : ({
          all: true,
          definitionIds: input.definitionIds,
          ...(input.sourceIdentities === undefined
            ? {}
            : { sourceIdentities: input.sourceIdentities }),
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
        ...(input.mode === undefined ? {} : { mode: { kind: input.mode } }),
        withDependencies: input.withDependencies,
      };
};

const makeRollbackPlanInput = (input: {
  readonly all: boolean;
  readonly definitionIds: readonly string[];
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
          withDependencies: input.withDependencies,
        }
      : ({
          all: true,
          definitionIds: input.definitionIds,
          ...(input.sourceIdentities === undefined
            ? {}
            : { sourceIdentities: input.sourceIdentities }),
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
        withDependencies: input.withDependencies,
      };
};

const isPlanningError = (
  error:
    | MigrationDefinitionRegistryRollbackError
    | MigrationDefinitionRegistryRunError
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

const runCommand = Command.make(
  "run",
  {
    all,
    definitions: runDefinitions,
    failed,
    ids,
    plan,
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
      const idsInput = Option.getOrUndefined(input.ids);
      const sourceIdentities =
        idsInput === undefined
          ? undefined
          : yield* parseSourceIdentityTargets(idsInput);
      let mode: "failed" | "skipped" | undefined;

      if (input.failed) {
        mode = "failed";
      } else if (input.skipped) {
        mode = "skipped";
      }
      const runInput = makeRunPlanInput({
        all: input.all,
        definitionIds: input.definitions,
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
          renderRunPlan(plan, { ...(mode === undefined ? {} : { mode }) })
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

      yield* Console.log(renderRunSummary(summary));
    })
).pipe(Command.withDescription("Plan or run Migration Definitions"));

const rollbackCommand = Command.make(
  "rollback",
  {
    all,
    definitions: runDefinitions,
    ids,
    plan,
    withDependencies,
  },
  (input) =>
    Effect.gen(function* () {
      const registry = yield* loadConfiguredRegistry;
      const idsInput = Option.getOrUndefined(input.ids);
      const sourceIdentities =
        idsInput === undefined
          ? undefined
          : yield* parseSourceIdentityTargets(idsInput);
      const rollbackInput = makeRollbackPlanInput({
        all: input.all,
        definitionIds: input.definitions,
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

        yield* Console.log(renderRollbackPlan(plan));
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

      yield* Console.log(renderRollbackSummary(summary));
    })
).pipe(Command.withDescription("Plan or rollback Migration Definitions"));

export const migrateCommand = migrateBaseCommand.pipe(
  Command.withDescription("Migration SDK CLI"),
  Command.withSubcommands([
    listCommand,
    graphCommand,
    runCommand,
    rollbackCommand,
  ])
);
