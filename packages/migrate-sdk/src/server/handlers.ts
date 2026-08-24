import { Context, Effect, type Stream } from "effect";
import type { MigrationDefinitionId } from "../domain/ids.ts";
import type { MigrationDefinitionLock } from "../domain/lock.ts";
import type { MigrationMessage } from "../domain/message.ts";
import {
  type MigrateBreakLockResult,
  type MigrateCancellationResult,
  type MigrateDashboard,
  type MigrateExecutionId,
  type MigrateExecutionReference,
  type MigrateObservationEvent,
  type MigrateOperationRequest,
  type MigratePreparedOperation,
  type MigrateProtocolError,
  MigrateRpcs,
  type MigrateServerInfo,
  type MigrateSourceIdentityHistoryEntry,
  type MigrateTarget,
} from "../protocol/index.ts";

export type MigratePrepareOperationInput = MigrateOperationRequest;

export interface MigrateServerService {
  readonly breakLock: (input: {
    readonly lock: MigrationDefinitionLock;
  }) => Effect.Effect<MigrateBreakLockResult, MigrateProtocolError>;
  readonly cancelExecution: (input: {
    readonly executionId?: MigrateExecutionId | undefined;
  }) => Effect.Effect<MigrateCancellationResult, MigrateProtocolError>;
  readonly getDashboard: Effect.Effect<MigrateDashboard, MigrateProtocolError>;
  readonly getMessages: (input: {
    readonly target: MigrateTarget;
  }) => Effect.Effect<readonly MigrationMessage[], MigrateProtocolError>;
  readonly getServerInfo: Effect.Effect<MigrateServerInfo>;
  readonly getSourceIdentityHistory: (input: {
    readonly definitionId: MigrationDefinitionId;
  }) => Effect.Effect<
    readonly MigrateSourceIdentityHistoryEntry[],
    MigrateProtocolError
  >;
  readonly normalizeSourceIdentity: (input: {
    readonly definitionId: MigrationDefinitionId;
    readonly sourceIdentity: string;
  }) => Effect.Effect<string, MigrateProtocolError>;
  readonly observeExecution: (input: {
    readonly executionId: MigrateExecutionId;
  }) => Stream.Stream<MigrateObservationEvent, MigrateProtocolError>;
  readonly prepareOperation: (
    input: MigratePrepareOperationInput
  ) => Effect.Effect<MigratePreparedOperation, MigrateProtocolError>;
  readonly scanSource: (input: {
    readonly concurrency?: number | undefined;
    readonly target: MigrateTarget;
  }) => Effect.Effect<MigrateDashboard, MigrateProtocolError>;
  readonly startOperation: (input: {
    readonly acceptedFingerprint: MigratePreparedOperation["fingerprint"];
    readonly request: MigrateOperationRequest;
  }) => Effect.Effect<MigrateExecutionReference, MigrateProtocolError>;
}

export class MigrateServer extends Context.Service<
  MigrateServer,
  MigrateServerService
>()("@migrate-sdk/server/MigrateServer") {}

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
