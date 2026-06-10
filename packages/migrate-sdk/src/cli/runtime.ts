import { Layer } from "effect";
import { Service } from "effect/Context";

export interface MigrationCliRuntimeShape {
  readonly cwd: string;
}

export class MigrationCliRuntime extends Service<
  MigrationCliRuntime,
  MigrationCliRuntimeShape
>()("migrate-sdk/cli/MigrationCliRuntime") {
  static readonly live = Layer.sync(MigrationCliRuntime, () => ({
    cwd: process.cwd(),
  }));
}
