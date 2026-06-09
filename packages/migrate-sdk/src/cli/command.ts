import { Console, Effect, Option, Runtime } from "effect";
import { CliError, Command, Flag } from "effect/unstable/cli";
import {
  loadMigrationCliConfig,
  type MigrationCliConfigLoadError,
} from "./config-loader.ts";
import { renderConfigLoadError, renderRegistryList } from "./render.ts";
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

const listCommand = Command.make("list", {}, () =>
  Effect.gen(function* () {
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

    yield* Console.log(renderRegistryList(loadedConfig.registry));
  })
).pipe(Command.withDescription("List registered Migration Definitions"));

export const migrateCommand = migrateBaseCommand.pipe(
  Command.withDescription("Migration SDK CLI"),
  Command.withSubcommands([listCommand])
);
