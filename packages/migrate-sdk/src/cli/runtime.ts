import { Effect, Layer } from "effect";
import { Service } from "effect/Context";

export interface MigrationCliRuntimeShape {
  readonly cwd: string;
  readonly stdoutColumns?: number;
  readonly stdoutIsTTY?: boolean;
  readonly writeProgress?: (chunk: string) => Effect.Effect<void>;
}

export class MigrationCliRuntime extends Service<
  MigrationCliRuntime,
  MigrationCliRuntimeShape
>()("migrate-sdk/cli/MigrationCliRuntime") {
  static readonly live = Layer.sync(MigrationCliRuntime, () => {
    const stdoutColumns = process.stdout.columns;

    return {
      cwd: process.cwd(),
      ...(stdoutColumns === undefined ? {} : { stdoutColumns }),
      stdoutIsTTY:
        process.stdout.isTTY === true && process.env.CI === undefined,
      writeProgress: (chunk: string) =>
        Effect.sync(() => {
          process.stdout.write(chunk);
        }),
    };
  });
}
