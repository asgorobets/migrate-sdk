import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { makeClient } from "effect/unstable/rpc/RpcTest";
import { MigrationRunId } from "../domain/ids.ts";
import {
  MIGRATE_PROTOCOL_VERSION,
  MigrateActiveRun,
  MigrateDashboard,
  MigrateHttpRpcs,
  MigrateObservationResumeToken,
  MigrateServerInfo,
  MigrateStreamingRpcs,
} from "../protocol/index.ts";
import {
  MigrateHttpServerHandlers,
  MigrateServer,
  MigrateStreamingServerHandlers,
} from "./handlers.ts";

const info = Schema.decodeUnknownSync(MigrateServerInfo)({
  environment: { id: "test" },
  protocolVersion: MIGRATE_PROTOCOL_VERSION,
  registryId: "catalog",
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

const activeRuns = Schema.decodeUnknownSync(Schema.Array(MigrateActiveRun))([
  {
    definitionIds: ["articles"],
    execution: { adapter: "workflow-sdk", executionId: "workflow-1" },
    observationDefinitionId: "articles",
    runId: "run-1",
    startedAt: "2026-08-25T12:00:00.000Z",
    status: "running",
    stopSupported: false,
  },
]);

const serverLayer = Layer.succeed(
  MigrateServer,
  MigrateServer.of({
    breakLock: () => Effect.die("not used"),
    getActiveRuns: Effect.succeed(activeRuns),
    getDashboard: Effect.succeed(dashboard),
    getMessages: () => Effect.succeed([]),
    getServerInfo: Effect.succeed(info),
    getSourceIdentityHistory: () => Effect.succeed([]),
    normalizeSourceIdentity: ({ sourceIdentity }) =>
      Effect.succeed(sourceIdentity),
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
    observeRunLease: () =>
      Effect.succeed({
        event: {
          resumeToken: MigrateObservationResumeToken.make("sha256:terminal"),
          event: {
            kind: "terminal" as const,
            message: "Run run-1 succeeded",
            outcome: "completed" as const,
            runId: MigrationRunId.make("run-1"),
          },
        },
        events: [],
        kind: "terminal" as const,
      }),
    prepareOperation: () => Effect.die("not used"),
    scanSource: () => Effect.succeed(dashboard),
    startOperation: () => Effect.die("not used"),
    stopRun: ({ runId }) =>
      Effect.succeed({
        kind: "requested" as const,
        message: `Stopping run ${runId}`,
        runId,
      }),
  })
);

const program = Effect.gen(function* () {
  const client = yield* makeClient(MigrateStreamingRpcs);
  const serverInfo = yield* client.GetServerInfo();
  const currentDashboard = yield* client.GetDashboard();
  const currentActiveRuns = yield* client.GetActiveRuns();
  const runEvents = yield* client
    .ObserveRun({ runId: MigrationRunId.make("run-1") })
    .pipe(Stream.runCollect);

  return {
    currentActiveRuns,
    currentDashboard,
    runEvents: [...runEvents],
    serverInfo,
  };
}).pipe(
  Effect.provide(
    MigrateStreamingServerHandlers.pipe(Layer.provide(serverLayer))
  )
);

const httpProgram = Effect.gen(function* () {
  const client = yield* makeClient(MigrateHttpRpcs);

  return yield* client.ObserveRunLease({
    runId: MigrationRunId.make("run-1"),
  });
}).pipe(
  Effect.provide(MigrateHttpServerHandlers.pipe(Layer.provide(serverLayer)))
);

describe("Migrate Server RPC handlers", () => {
  it.effect("serves unary and streaming operations through the protocol", () =>
    Effect.gen(function* () {
      const result = yield* program;
      const runLease = yield* httpProgram;

      expect(result.serverInfo).toEqual(info);
      expect(result.currentDashboard).toEqual(dashboard);
      expect(result.currentActiveRuns).toEqual(activeRuns);
      expect(result.runEvents).toEqual([
        { definitions: [], kind: "progress" },
        {
          kind: "terminal",
          message: "Run run-1 succeeded",
          outcome: "completed",
          runId: "run-1",
        },
      ]);
      expect(runLease).toEqual({
        event: {
          resumeToken: "sha256:terminal",
          event: {
            kind: "terminal",
            message: "Run run-1 succeeded",
            outcome: "completed",
            runId: "run-1",
          },
        },
        events: [],
        kind: "terminal",
      });
    })
  );
});
