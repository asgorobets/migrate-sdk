import { DateTime, Effect, Layer } from "effect";
import {
  HttpMiddleware,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import {
  MigrationDefinitionId,
  type MigrationDefinitionLock,
  MigrationRunId,
  toMigrationDefinitionRegistryId,
} from "../../src/index.ts";
import type {
  MigrateActiveRun,
  MigrateDashboard,
  MigrateSelection,
  MigrateServerInfo,
} from "../../src/protocol/index.ts";
import { MIGRATE_PROTOCOL_VERSION } from "../../src/protocol/index.ts";
import {
  type MigrateServer,
  type MigrateServerBackend,
  MigrateServerHttp,
} from "../../src/server/index.ts";
import { MIGRATE_SDK_VERSION } from "../../src/version.ts";

export interface RemoteMigrateServerTestOperation {
  readonly kind: "run";
}

export const remoteMigrateDefinitionId = MigrationDefinitionId.make("articles");
export const remoteMigrateRunId = MigrationRunId.make("run-remote-1");
export const remoteMigrateActiveRun: MigrateActiveRun = {
  definitionIds: [remoteMigrateDefinitionId],
  execution: { adapter: "workflow-sdk", executionId: "workflow-1" },
  observationDefinitionId: remoteMigrateDefinitionId,
  runId: remoteMigrateRunId,
  startedAt: DateTime.toDateUtc(
    DateTime.makeUnsafe("2026-08-25T12:00:00.000Z")
  ),
  status: "running",
  stopSupported: false,
};
export const remoteMigrateDashboard: MigrateDashboard = {
  activeRuns: [remoteMigrateActiveRun],
  groups: [],
  rows: [
    {
      entry: {
        dependencies: { optional: [], required: [] },
        hasRollback: true,
        id: remoteMigrateDefinitionId,
      },
      status: {
        definitionId: remoteMigrateDefinitionId,
        discovery: "incremental",
        durable: { failed: 0, migrated: 12, needsUpdate: 0, skipped: 1 },
        lastRun: null,
        lock: null,
        warnings: [],
      },
    },
  ],
  scannedSource: false,
};
export const remoteMigrateServerIdentity = {
  environment: { id: "production", label: "Production" },
  registryId: toMigrationDefinitionRegistryId("catalog"),
};
export const remoteMigrateServerInfo: MigrateServerInfo = {
  ...remoteMigrateServerIdentity,
  protocolVersion: MIGRATE_PROTOCOL_VERSION,
  sdkVersion: MIGRATE_SDK_VERSION,
};

const authorizationMiddleware = (
  authorize: (
    request: HttpServerRequest.HttpServerRequest
  ) => Effect.Effect<boolean>
) =>
  HttpMiddleware.make((httpApp) =>
    HttpServerRequest.HttpServerRequest.pipe(
      Effect.flatMap((request) =>
        authorize(request).pipe(
          Effect.flatMap((authorized) =>
            authorized
              ? httpApp
              : Effect.succeed(
                  HttpServerResponse.text("Unauthorized", { status: 401 })
                )
          )
        )
      )
    )
  );

export const makeRemoteMigrateServerHttp = (
  serverLayer: Layer.Layer<MigrateServer>
) =>
  MigrateServerHttp.toWebHandler(
    MigrateServerHttp.layer.pipe(Layer.provide(serverLayer))
  );

export const makeAuthorizedRemoteMigrateServerHttp = (
  serverLayer: Layer.Layer<MigrateServer>,
  authorize: (
    request: HttpServerRequest.HttpServerRequest
  ) => Effect.Effect<boolean>
) =>
  MigrateServerHttp.toWebHandler(
    MigrateServerHttp.layer.pipe(Layer.provide(serverLayer)),
    authorizationMiddleware(authorize)
  );

const requestedDefinitionIds = (
  selection: MigrateSelection
): "all" | readonly MigrationDefinitionId[] => {
  switch (selection.kind) {
    case "all":
      return "all";
    case "definitions":
      return selection.definitionIds;
    case "group":
      return [remoteMigrateDefinitionId];
    default: {
      const unhandled: never = selection;
      return unhandled;
    }
  }
};

export const remoteMigrateServerBackend: MigrateServerBackend<RemoteMigrateServerTestOperation> =
  {
    breakLock: (lock: MigrationDefinitionLock) =>
      Effect.succeed({ definitionId: lock.definitionId, kind: "cleared" }),
    executeOperation: (_operation, observer) => {
      observer.onStateChange({
        adapter: "remote-test",
        definitionId: remoteMigrateDefinitionId,
        kind: "running",
        ownership: "server",
        runId: remoteMigrateRunId,
      });
      return Effect.succeed({
        result: Effect.succeed({
          message: `Run ${remoteMigrateRunId} succeeded`,
          outcome: "completed" as const,
          runId: remoteMigrateRunId,
        }),
        stop: Effect.succeed({
          kind: "requested" as const,
          message: `Stopping run ${remoteMigrateRunId}`,
        }),
      });
    },
    getActiveRuns: Effect.succeed([remoteMigrateActiveRun]),
    getDashboard: Effect.succeed(remoteMigrateDashboard),
    getMessages: () => Effect.succeed([]),
    getRegistry: Effect.succeed({
      entries: remoteMigrateDashboard.rows.map((row) => row.entry),
      groups: remoteMigrateDashboard.groups,
    }),
    getRegistryMessages: (request) =>
      Effect.succeed({
        includedDefinitionIds: [remoteMigrateDefinitionId],
        messages: [],
        notices: [],
        ...(request.selection.kind === "group"
          ? { requestedGroup: request.selection.groupId }
          : {}),
        requestedDefinitionIds: requestedDefinitionIds(request.selection),
      }),
    getRegistryStatus: (request) =>
      Effect.succeed({
        definitions: remoteMigrateDashboard.rows.flatMap((row) =>
          row.status === undefined ? [] : [row.status]
        ),
        includedDefinitionIds: [remoteMigrateDefinitionId],
        notices: [],
        ...(request.selection.kind === "group"
          ? { requestedGroup: request.selection.groupId }
          : {}),
        requestedDefinitionIds: requestedDefinitionIds(request.selection),
        scanSource: request.scanSource,
        warnings: [],
      }),
    getRunProgress: () =>
      Effect.succeed({
        definitions: remoteMigrateDashboard.rows.flatMap((row) =>
          row.status === undefined ? [] : [row.status]
        ),
        observationDefinitionId: remoteMigrateDefinitionId,
      }),
    getSourceIdentityHistory: () => Effect.succeed([]),
    getSourceItemTotals: () =>
      Effect.succeed([
        {
          definitionId: remoteMigrateDefinitionId,
          total: { count: 4, kind: "known" as const },
        },
      ]),
    normalizeSourceIdentity: (_definitionId, sourceIdentity) =>
      Effect.succeed(sourceIdentity),
    observeRun: (requestedRunId, observer) => {
      observer.onStateChange({
        adapter: "remote-test",
        definitionId: remoteMigrateDefinitionId,
        executionId: "workflow-1",
        kind: "running",
        ownership: "provider",
        runId: requestedRunId,
      });

      return Effect.succeed({
        message: `Run ${requestedRunId} succeeded`,
        outcome: "completed" as const,
        runId: requestedRunId,
      });
    },
    prepareOperation: (request) =>
      Effect.succeed({
        executable: { kind: "run" },
        operation: {
          action: request.action,
          dependencyChecks: [],
          observationDefinitionId: remoteMigrateDefinitionId,
          plan: {
            executionDefinitionIds: [remoteMigrateDefinitionId],
            executionPolicy: [
              {
                definitionId: remoteMigrateDefinitionId,
                discovery: "full",
                processConcurrency: 1,
                rollbackConcurrency: 1,
              },
            ],
            includedDefinitionIds: [remoteMigrateDefinitionId],
            notices: [],
            requestedDefinitionIds: [remoteMigrateDefinitionId],
            withDependencies: request.options.withDependencies ?? false,
          },
          planRows: remoteMigrateDashboard.rows,
          selection: request.selection,
        },
      }),
    scanSource: () => Effect.succeed(remoteMigrateDashboard),
  };
