import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { migrationTelemetryLayer } from "../telemetry.ts";
import { MIGRATE_SDK_VERSION } from "../version.ts";
import { migrateCommand } from "./command.ts";
import { MigrationCliRuntime } from "./runtime.ts";

const runtimeLayer = MigrationCliRuntime.live.pipe(
  Layer.provideMerge(nodeServicesLayer)
);

const command = migrateCommand.pipe(
  // --otel exports in the local execution server after it applies defaults.
  Command.provide(({ otel }) => (otel ? Layer.empty : migrationTelemetryLayer))
);

export const run = Command.run(command, {
  version: MIGRATE_SDK_VERSION,
}).pipe(Effect.provide(runtimeLayer));
