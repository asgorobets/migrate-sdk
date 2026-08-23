import {
  Config,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Terminal,
} from "effect";
import { Service } from "effect/Context";
import { Prompt } from "effect/unstable/cli";
import type { SqlMigrationStoreSchemaPlan } from "../stores/sql/sql-migration-store-schema.ts";
import {
  type MigrationCliInterruptController,
  makeMigrationCliInterruptController,
} from "./interrupts.ts";

export interface MigrationCliRuntimeShape {
  readonly confirmSchemaUpgrade?: (
    plan: SqlMigrationStoreSchemaPlan
  ) => Effect.Effect<boolean>;
  readonly cwd: string;
  readonly interrupts?: MigrationCliInterruptController;
  readonly stdoutColumns?: number;
  readonly stdoutIsTTY?: boolean;
  readonly useColor?: boolean;
  readonly writeProgress?: (chunk: string) => Effect.Effect<void>;
}

export class MigrationCliRuntime extends Service<
  MigrationCliRuntime,
  MigrationCliRuntimeShape
>()("migrate-sdk/cli/MigrationCliRuntime") {
  static readonly live = Layer.effect(
    MigrationCliRuntime,
    Effect.gen(function* () {
      const ci = yield* Config.option(Config.string("CI"));
      const forceColor = yield* Config.option(Config.string("FORCE_COLOR"));
      const noColor = yield* Config.option(Config.string("NO_COLOR"));
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const terminal = yield* Terminal.Terminal;
      const forceColorValue = Option.getOrUndefined(forceColor);
      const stdoutColumns = process.stdout.columns;

      return {
        confirmSchemaUpgrade: (plan) =>
          Prompt.confirm({
            initial: false,
            message: `Upgrade SQL Migration Store schema from ${plan.currentVersion === null ? "not installed" : `version ${plan.currentVersion}`} to version ${plan.targetVersion}?`,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.provideService(Terminal.Terminal, terminal),
            Effect.orElseSucceed(() => false)
          ),
        cwd: process.cwd(),
        interrupts: makeMigrationCliInterruptController({
          confirmUnsafeExit: Prompt.confirm({
            initial: false,
            message:
              "Force shutdown now? This may leave destination changes without matching migration state, so a later run may retry partially applied work.",
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.provideService(Terminal.Terminal, terminal),
            Effect.orElseSucceed(() => false)
          ),
          forceExit: Effect.sync(() => process.exit(130)),
        }),
        ...(stdoutColumns === undefined ? {} : { stdoutColumns }),
        stdoutIsTTY: process.stdout.isTTY === true && Option.isNone(ci),
        useColor:
          Option.isNone(noColor) &&
          forceColorValue !== "0" &&
          (forceColorValue !== undefined ||
            (process.stdout.hasColors?.() ?? process.stdout.isTTY === true)),
        writeProgress: (chunk: string) =>
          Effect.sync(() => {
            process.stdout.write(chunk);
          }),
      };
    })
  );
}
