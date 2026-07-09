import { Config, Effect, Layer, Option } from "effect";
import { Service } from "effect/Context";

export interface MigrationCliRuntimeShape {
  readonly cwd: string;
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
      const forceColorValue = Option.getOrUndefined(forceColor);
      const stdoutColumns = process.stdout.columns;

      return {
        cwd: process.cwd(),
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
