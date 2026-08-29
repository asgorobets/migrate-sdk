import { Config, Context, Effect, Layer } from "effect";

export interface MigrateServerAccessValue {
  readonly token: string;
}

export function makeMigrateServerAccess(
  token: string
): MigrateServerAccessValue {
  return { token: token.trim() };
}

export class MigrateServerAccess extends Context.Service<
  MigrateServerAccess,
  MigrateServerAccessValue
>()("@migrate-sdk/examples/workflow-sdk/MigrateServerAccess") {
  static readonly layer = Layer.effect(
    MigrateServerAccess,
    Config.string("MIGRATE_SERVER_TOKEN").pipe(
      Config.withDefault(""),
      Effect.map(makeMigrateServerAccess)
    )
  );
}
