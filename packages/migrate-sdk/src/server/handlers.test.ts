import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { makeClient } from "effect/unstable/rpc/RpcTest";
import { MigrationRunId } from "../domain/ids.ts";
import {
  MigrateActiveRun,
  MigrateDashboard,
  MigrateExecutionId,
  MigrateRpcs,
  MigrateServerInfo,
} from "../protocol/index.ts";
import { MigrateServer, MigrateServerHandlers } from "./handlers.ts";

const info = Schema.decodeUnknownSync(MigrateServerInfo)({
  capabilities: ["dashboard", "observe-execution"],
  configPath: "/workspace/migrate.config.ts",
  environment: { id: "test" },
  protocolVersion: 2,
  registryId: "catalog",
  runtime: { name: "node", version: "24.16.0" },
  sdkVersion: "0.6.0",
});

const dashboard = Schema.decodeUnknownSync(MigrateDashboard)({
  activeRuns: [],
  groups: [],
  rows: [
    {
      entry: {
        dependencies: { optional: [], required: [] },
        hasRollback: true,
        id: "articles",
      },
    },
  ],
  scannedSource: false,
});

const executionId = MigrateExecutionId.make("execution-1");
const activeRuns = Schema.decodeUnknownSync(Schema.Array(MigrateActiveRun))([
  {
    definitionIds: ["articles"],
    execution: { adapter: "workflow-sdk", executionId: "workflow-1" },
    observationDefinitionId: "articles",
    runId: "run-1",
    startedAt: "2026-08-25T12:00:00.000Z",
    status: "running",
  },
]);

const serverLayer = Layer.succeed(
  MigrateServer,
  MigrateServer.of({
    breakLock: () => Effect.die("not used"),
    cancelExecution: () => Effect.succeed({ kind: "idle" as const }),
    getActiveRuns: Effect.succeed(activeRuns),
    getDashboard: Effect.succeed(dashboard),
    getMessages: () => Effect.succeed([]),
    getServerInfo: Effect.succeed(info),
    getSourceIdentityHistory: () => Effect.succeed([]),
    normalizeSourceIdentity: ({ sourceIdentity }) =>
      Effect.succeed(sourceIdentity),
    observeExecution: () =>
      Stream.fromIterable([
        {
          kind: "warning" as const,
          message: "Following durable migration state",
        },
        {
          kind: "terminal" as const,
          message: "Run run-1 succeeded",
          outcome: "completed" as const,
          runId: MigrationRunId.make("run-1"),
        },
      ]),
    observeRun: () =>
      Stream.fromIterable([
        {
          definitions: [],
          kind: "progress" as const,
        },
        {
          kind: "terminal" as const,
          message: "Run run-1 succeeded",
          outcome: "completed" as const,
          runId: MigrationRunId.make("run-1"),
        },
      ]),
    prepareOperation: () => Effect.die("not used"),
    scanSource: () => Effect.succeed(dashboard),
    startOperation: () => Effect.die("not used"),
  })
);

const program = Effect.gen(function* () {
  const client = yield* makeClient(MigrateRpcs);
  const serverInfo = yield* client.GetServerInfo();
  const currentDashboard = yield* client.GetDashboard();
  const currentActiveRuns = yield* client.GetActiveRuns();
  const events = yield* client
    .ObserveExecution({ executionId })
    .pipe(Stream.runCollect);
  const runEvents = yield* client
    .ObserveRun({ runId: MigrationRunId.make("run-1") })
    .pipe(Stream.runCollect);

  return {
    currentActiveRuns,
    currentDashboard,
    events: [...events],
    runEvents: [...runEvents],
    serverInfo,
  };
}).pipe(Effect.provide(MigrateServerHandlers.pipe(Layer.provide(serverLayer))));

describe("Migrate Server RPC handlers", () => {
  it.effect("serves unary and streaming operations through the protocol", () =>
    Effect.gen(function* () {
      const result = yield* program;

      expect(result.serverInfo).toEqual(info);
      expect(result.currentDashboard).toEqual(dashboard);
      expect(result.currentActiveRuns).toEqual(activeRuns);
      expect(result.events).toEqual([
        {
          kind: "warning",
          message: "Following durable migration state",
        },
        {
          kind: "terminal",
          message: "Run run-1 succeeded",
          outcome: "completed",
          runId: "run-1",
        },
      ]);
      expect(result.runEvents).toEqual([
        { definitions: [], kind: "progress" },
        {
          kind: "terminal",
          message: "Run run-1 succeeded",
          outcome: "completed",
          runId: "run-1",
        },
      ]);
    })
  );
});
