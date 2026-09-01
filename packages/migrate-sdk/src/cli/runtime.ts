import {
  Config,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  type Redacted,
  Schema,
  type Stream,
  Terminal,
} from "effect";
import { Service } from "effect/Context";
import { Prompt } from "effect/unstable/cli";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import {
  connectMigrateServer,
  type MigrateServerConnectionInput,
} from "../client/node/index.ts";
import type { MigrationRunId } from "../domain/ids.ts";
import type { MigrationDefinitionLock } from "../domain/lock.ts";
import type {
  MigrateActiveRun,
  MigrateBreakLockResult,
  MigrateDashboardSnapshot,
  MigrateObservationEvent,
  MigrateOperationRequest,
  MigratePreparedOperation,
  MigrateProtocolError,
  MigrateRegistry,
  MigrateRegistryMessagesReport,
  MigrateRegistryMessagesRequest,
  MigrateRegistryStatusReport,
  MigrateRegistryStatusRequest,
  MigrateRunStartResult,
  MigrateRunStopResult,
} from "../protocol/index.ts";
import type { SqlMigrationStoreSchemaPlan } from "../stores/sql/sql-migration-store-schema.ts";
import {
  type MigrationCliInterruptController,
  makeMigrationCliInterruptController,
} from "./interrupts.ts";

export type MigrationRunObservationInterruptDecision =
  | "continue"
  | "detach"
  | "stop";

export type MigrationCliCommandShell = "posix" | "powershell";

export class MigrationCliConnectionError extends Schema.TaggedError<MigrationCliConnectionError>()(
  "MigrationCliConnectionError",
  {
    cause: Schema.Defect(),
    message: Schema.String,
  }
) {}

export type MigrationCliServerError = MigrateProtocolError | RpcClientError;

export interface MigrationCliServerConnection {
  readonly breakLock: (
    lock: MigrationDefinitionLock
  ) => Effect.Effect<MigrateBreakLockResult, MigrationCliServerError>;
  readonly dispose: () => Promise<void>;
  readonly getActiveRuns: Effect.Effect<
    readonly MigrateActiveRun[],
    MigrationCliServerError
  >;
  readonly getDashboard: Effect.Effect<
    MigrateDashboardSnapshot,
    MigrationCliServerError
  >;
  readonly getRegistry: Effect.Effect<MigrateRegistry, MigrationCliServerError>;
  readonly getRegistryMessages: (
    input: MigrateRegistryMessagesRequest
  ) => Effect.Effect<MigrateRegistryMessagesReport, MigrationCliServerError>;
  readonly getRegistryStatus: (
    input: MigrateRegistryStatusRequest
  ) => Effect.Effect<MigrateRegistryStatusReport, MigrationCliServerError>;
  readonly observeRun: (
    runId: MigrationRunId
  ) => Stream.Stream<MigrateObservationEvent, MigrationCliServerError>;
  readonly prepareOperation: (
    request: MigrateOperationRequest
  ) => Effect.Effect<MigratePreparedOperation, MigrationCliServerError>;
  readonly startOperation: (input: {
    readonly acceptedFingerprint: MigratePreparedOperation["fingerprint"];
    readonly request: MigrateOperationRequest;
  }) => Effect.Effect<MigrateRunStartResult, MigrationCliServerError>;
  readonly stopRun: (
    runId: MigrationRunId
  ) => Effect.Effect<MigrateRunStopResult, MigrationCliServerError>;
}

export interface MigrationCliRuntimeShape {
  readonly chooseRunObservationInterrupt?: (
    runId: MigrationRunId,
    options: { readonly stopRequested: boolean }
  ) => Effect.Effect<MigrationRunObservationInterruptDecision>;
  readonly commandShell?: MigrationCliCommandShell;
  readonly confirmSchemaUpgrade?: (
    plan: SqlMigrationStoreSchemaPlan
  ) => Effect.Effect<boolean>;
  readonly connectMigrateServer?: (
    input: MigrateServerConnectionInput
  ) => Effect.Effect<MigrationCliServerConnection, MigrationCliConnectionError>;
  readonly cwd: string;
  readonly interrupts?: MigrationCliInterruptController;
  readonly migrateServerBuildId?: string;
  readonly migrateServerToken?: Redacted.Redacted<string>;
  readonly startAcknowledgementTimeoutMs?: number;
  readonly stdoutColumns?: number;
  readonly stdoutIsTTY?: boolean;
  readonly useColor?: boolean;
  readonly writeProgress?: (chunk: string) => Effect.Effect<void>;
}

export class MigrationCliRuntime extends Service<
  MigrationCliRuntime,
  MigrationCliRuntimeShape
>()("migrate-sdk/cli/MigrationCliRuntime") {
  static readonly live = Layer.effect(
    MigrationCliRuntime,
    Effect.gen(function* () {
      const ci = yield* Config.option(Config.string("CI"));
      const forceColor = yield* Config.option(Config.string("FORCE_COLOR"));
      const noColor = yield* Config.option(Config.string("NO_COLOR"));
      const migrateServerToken = yield* Config.option(
        Config.redacted("MIGRATE_SERVER_TOKEN")
      );
      const migrateServerBuildId = yield* Config.option(
        Config.string("MIGRATE_SERVER_BUILD_ID")
      );
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const terminal = yield* Terminal.Terminal;
      const forceColorValue = Option.getOrUndefined(forceColor);
      const migrateServerTokenValue = Option.getOrUndefined(migrateServerToken);
      const migrateServerBuildIdValue =
        Option.getOrUndefined(migrateServerBuildId);
      const stdoutColumns = process.stdout.columns;
      return {
        chooseRunObservationInterrupt: (runId, { stopRequested }) =>
          Prompt.select({
            choices: [
              {
                description: "Leave the Migration Run active",
                selected: true,
                title: "Detach",
                value: "detach" as const,
              },
              ...(stopRequested
                ? []
                : [
                    {
                      description:
                        "Stop scheduling work, drain active items, and keep observing",
                      title: "Stop safely",
                      value: "stop" as const,
                    },
                  ]),
              {
                description: "Return to live progress",
                title: "Continue observing",
                value: "continue" as const,
              },
            ],
            message: stopRequested
              ? `Run ${runId} is draining. What should Migrate do?`
              : `What should Migrate do with run ${runId}?`,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.provideService(Terminal.Terminal, terminal),
            Effect.orElseSucceed(() => "detach" as const)
          ),
        confirmSchemaUpgrade: (plan) =>
          Prompt.confirm({
            initial: false,
            message: `Upgrade SQL Migration Store schema from ${plan.currentVersion === null ? "not installed" : `version ${plan.currentVersion}`} to version ${plan.targetVersion}?`,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.provideService(Terminal.Terminal, terminal),
            Effect.orElseSucceed(() => false)
          ),
        commandShell: process.platform === "win32" ? "powershell" : "posix",
        connectMigrateServer: (input) =>
          Effect.tryPromise({
            catch: (cause) =>
              new MigrationCliConnectionError({
                cause,
                message: cause instanceof Error ? cause.message : String(cause),
              }),
            try: () => connectMigrateServer(input),
          }).pipe(
            Effect.map((connection) => ({
              breakLock: (lock) => connection.client.BreakLock({ lock }),
              dispose: connection.dispose,
              getActiveRuns: connection.client.GetActiveRuns(),
              getDashboard: connection.client.GetDashboard(),
              getRegistry: connection.client.GetRegistry(),
              getRegistryMessages: (input) =>
                connection.client.GetRegistryMessages(input),
              getRegistryStatus: (input) =>
                connection.client.GetRegistryStatus(input),
              observeRun: (runId: MigrationRunId) =>
                connection.client.observeRun({ runId }),
              prepareOperation: (request) =>
                connection.client.PrepareOperation(request),
              startOperation: (input) =>
                connection.client.StartOperation(input),
              stopRun: (runId: MigrationRunId) =>
                connection.client.StopRun({ runId }),
            }))
          ),
        cwd: process.cwd(),
        interrupts: makeMigrationCliInterruptController({
          confirmUnsafeExit: Prompt.confirm({
            initial: false,
            message:
              "Force shutdown now? This may leave destination changes without matching migration state, so a later run may retry partially applied work.",
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.provideService(Terminal.Terminal, terminal),
            Effect.orElseSucceed(() => false)
          ),
          forceExit: Effect.sync(() => process.exit(130)),
        }),
        ...(stdoutColumns === undefined ? {} : { stdoutColumns }),
        stdoutIsTTY: process.stdout.isTTY === true && Option.isNone(ci),
        ...(migrateServerTokenValue === undefined
          ? {}
          : { migrateServerToken: migrateServerTokenValue }),
        ...(migrateServerBuildIdValue === undefined
          ? {}
          : { migrateServerBuildId: migrateServerBuildIdValue }),
        useColor:
          Option.isNone(noColor) &&
          forceColorValue !== "0" &&
          (forceColorValue !== undefined ||
            (process.stdout.hasColors?.() ?? process.stdout.isTTY === true)),
        writeProgress: (chunk: string) =>
          Effect.sync(() => {
            process.stdout.write(chunk);
          }),
      };
    })
  );
}
