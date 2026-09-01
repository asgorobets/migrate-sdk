import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { MIGRATE_SDK_VERSION } from "../version.ts";
import { migrateCommand } from "./command.ts";
import { MigrationCliRuntime } from "./runtime.ts";

const runtimeLayer = MigrationCliRuntime.live.pipe(
  Layer.provideMerge(nodeServicesLayer)
);

export const run = Command.run(migrateCommand, {
  version: MIGRATE_SDK_VERSION,
}).pipe(Effect.provide(runtimeLayer));
