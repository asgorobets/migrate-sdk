import type { Stream } from "effect";
import type { RpcClient } from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type { Rpcs } from "effect/unstable/rpc/RpcGroup";
import type { MigrationRunId } from "../../domain/ids.ts";
import type {
  MigrateDashboardResumeToken,
  MigrateDashboardSnapshot,
  MigrateObservationEvent,
  MigrateProtocolError,
  MigrateStreamingRpcs,
} from "../../protocol/index.ts";

export type MigrateStreamingRpcClient = RpcClient<
  Rpcs<typeof MigrateStreamingRpcs>,
  RpcClientError
>;
type MigrateControlRpcClient = Omit<
  MigrateStreamingRpcClient,
  "ObserveDashboard" | "ObserveRun"
>;

export type MigrateClientService = MigrateControlRpcClient & {
  readonly observeDashboard: (input: {
    readonly after?: MigrateDashboardResumeToken | undefined;
  }) => Stream.Stream<
    MigrateDashboardSnapshot,
    MigrateProtocolError | RpcClientError
  >;
  readonly observeRun: (input: {
    readonly runId: MigrationRunId;
  }) => Stream.Stream<
    MigrateObservationEvent,
    MigrateProtocolError | RpcClientError
  >;
};

export const makeMigrateClientService = (
  client: MigrateControlRpcClient,
  observeDashboard: MigrateClientService["observeDashboard"],
  observeRun: MigrateClientService["observeRun"]
): MigrateClientService => ({
  BreakLock: client.BreakLock,
  GetActiveRuns: client.GetActiveRuns,
  GetDashboard: client.GetDashboard,
  GetMessages: client.GetMessages,
  GetRegistry: client.GetRegistry,
  GetRegistryMessages: client.GetRegistryMessages,
  GetRegistryStatus: client.GetRegistryStatus,
  GetServerInfo: client.GetServerInfo,
  GetSourceIdentityHistory: client.GetSourceIdentityHistory,
  GetSourceItemTotals: client.GetSourceItemTotals,
  NormalizeSourceIdentity: client.NormalizeSourceIdentity,
  PrepareOperation: client.PrepareOperation,
  ScanSource: client.ScanSource,
  StartOperation: client.StartOperation,
  StopRun: client.StopRun,
  observeDashboard,
  observeRun,
});

export const makeStreamingMigrateClientService = (
  client: MigrateStreamingRpcClient
): MigrateClientService =>
  makeMigrateClientService(
    client,
    (input) => client.ObserveDashboard(input),
    ({ runId }) => client.ObserveRun({ runId })
  );
