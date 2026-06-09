import { Console, Effect, Option, Runtime } from "effect";
import { Argument, CliError, Command, Flag } from "effect/unstable/cli";
import {
  type MigrationDefinitionId,
  toMigrationDefinitionId,
} from "../domain/ids.ts";
import type { MigrationDefinitionRegistry } from "../domain/registry.ts";
import {
  loadMigrationCliConfig,
  type MigrationCliConfigLoadError,
} from "./config-loader.ts";
import {
  renderConfigLoadError,
  renderRegistryGraph,
  renderRegistryList,
} from "./render.ts";
import { MigrationCliRuntime } from "./runtime.ts";

const config = Flag.string("config").pipe(
  Flag.optional,
  Flag.withDescription("Path to a migrate.config.ts, .mts, .js, or .mjs file")
);

const migrateBaseCommand = Command.make("migrate-sdk").pipe(
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

export const migrateCommand = migrateBaseCommand.pipe(
  Command.withDescription("Migration SDK CLI"),
  Command.withSubcommands([listCommand, graphCommand])
);
