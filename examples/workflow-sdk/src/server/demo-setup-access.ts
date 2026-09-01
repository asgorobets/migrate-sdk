import { Config, Context, Effect, Layer } from "effect";

export interface DemoSetupAccessValue {
  readonly token: string;
}

export function makeDemoSetupAccess(token: string): DemoSetupAccessValue {
  return { token: token.trim() };
}

export class DemoSetupAccess extends Context.Service<
  DemoSetupAccess,
  DemoSetupAccessValue
>()("@migrate-sdk/examples/workflow-sdk/DemoSetupAccess") {
  static readonly layer = Layer.effect(
    DemoSetupAccess,
    Config.string("DEMO_SETUP_TOKEN").pipe(
      Config.withDefault(""),
      Effect.map(makeDemoSetupAccess)
    )
  );
}
