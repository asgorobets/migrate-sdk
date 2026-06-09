import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { migrateCommand } from "./command.ts";
import { MigrationCliRuntime } from "./runtime.ts";

const runtimeLayer = Layer.mergeAll(
  nodeServicesLayer,
  MigrationCliRuntime.live
);

export const run = Command.run(migrateCommand, {
  version: "0.0.0",
}).pipe(Effect.provide(runtimeLayer));
