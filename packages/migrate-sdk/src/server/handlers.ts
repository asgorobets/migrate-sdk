import { Effect } from "effect";
import { MigrateRpcs } from "../protocol/index.ts";
import { MigrateServer } from "./service.ts";

// biome-ignore lint/performance/noBarrelFile: The public server subpath exposes its service and RPC handler layer together.
export {
  type MigratePrepareOperationInput,
  MigrateServer,
  type MigrateServerBackend,
  type MigrateServerExecutionObserver,
  type MigrateServerExecutionResult,
  type MigrateServerInput,
  type MigrateServerPreparedOperation,
  type MigrateServerService,
} from "./service.ts";

export const MigrateServerHandlers = MigrateRpcs.toLayer(
  Effect.gen(function* () {
    const server = yield* MigrateServer;

    return MigrateRpcs.of({
      BreakLock: server.breakLock,
      CancelExecution: server.cancelExecution,
      GetDashboard: () => server.getDashboard,
      GetMessages: server.getMessages,
      GetServerInfo: () => server.getServerInfo,
      GetSourceIdentityHistory: server.getSourceIdentityHistory,
      NormalizeSourceIdentity: server.normalizeSourceIdentity,
      ObserveExecution: server.observeExecution,
      PrepareOperation: server.prepareOperation,
      ScanSource: server.scanSource,
      StartOperation: server.startOperation,
    });
  })
);
