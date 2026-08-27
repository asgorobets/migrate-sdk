import { Effect } from "effect";
import { MigrateHttpRpcs, MigrateStreamingRpcs } from "../protocol/index.ts";
import { MigrateServer, type MigrateServerService } from "./service.ts";

// biome-ignore lint/performance/noBarrelFile: The public server subpath exposes its service and RPC handler layer together.
export {
  type MigratePrepareOperationInput,
  MigrateServer,
  type MigrateServerBackend,
  type MigrateServerExecutionHandle,
  type MigrateServerExecutionObserver,
  type MigrateServerExecutionResult,
  type MigrateServerExecutionStopResult,
  type MigrateServerInput,
  type MigrateServerPreparedOperation,
  type MigrateServerRunProgress,
  type MigrateServerService,
} from "./service.ts";

const controlHandlers = (server: MigrateServerService) => ({
  BreakLock: server.breakLock,
  GetActiveRuns: () => server.getActiveRuns,
  GetDashboard: () => server.getDashboard,
  GetMessages: server.getMessages,
  GetServerInfo: () => server.getServerInfo,
  GetSourceIdentityHistory: server.getSourceIdentityHistory,
  NormalizeSourceIdentity: server.normalizeSourceIdentity,
  PrepareOperation: server.prepareOperation,
  ScanSource: server.scanSource,
  StartOperation: server.startOperation,
  StopRun: server.stopRun,
});

export const MigrateStreamingServerHandlers = MigrateStreamingRpcs.toLayer(
  Effect.gen(function* () {
    const server = yield* MigrateServer;

    return MigrateStreamingRpcs.of({
      ...controlHandlers(server),
      ObserveDashboard: server.observeDashboard,
      ObserveRun: server.observeRun,
    });
  })
);

export const MigrateHttpServerHandlers = MigrateHttpRpcs.toLayer(
  Effect.gen(function* () {
    const server = yield* MigrateServer;

    return MigrateHttpRpcs.of({
      ...controlHandlers(server),
      ObserveDashboardLease: server.observeDashboardLease,
      ObserveRunLease: server.observeRunLease,
    });
  })
);
