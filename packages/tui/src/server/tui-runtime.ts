import { Effect, Stream } from "effect";
import type { MigrationDefinitionLock, MigrationRunId } from "migrate-sdk";
import {
  connectLocalMigrateServer,
  connectRemoteMigrateServer,
  type MigrateConnection,
} from "migrate-sdk/client/node";
import type {
  MigrateDashboard,
  MigrateDashboardSnapshot,
  MigrateObservationEvent,
  MigratePreparedOperation,
  MigrateRunStartResult,
} from "migrate-sdk/protocol";
import type { MigrationTuiExecutionResult } from "../execution.ts";
import type {
  LoadMigrationTuiInput,
  MigrationTuiDashboardObservationOptions,
  MigrationTuiDetachResult,
  MigrationTuiExecuteOptions,
  MigrationTuiRuntime,
  MigrationTuiSnapshot,
} from "../runtime.ts";

type ConnectLocalMigrateServer = typeof connectLocalMigrateServer;

/** @internal Test composition seam. Use makeMigrationTuiRuntime in production. */
export const makeMigrationTuiRuntimeWithLocalConnection = async (
  input: LoadMigrationTuiInput,
  connectLocal: ConnectLocalMigrateServer
): Promise<MigrationTuiRuntime> => {
  const connect = (): Promise<MigrateConnection> => {
    if (input.server === undefined) {
      const nodeExecutable = process.env.MIGRATE_TUI_NODE_EXECUTABLE;
      return connectLocal({
        ...input,
        ...(nodeExecutable === undefined ? {} : { nodeExecutable }),
      });
    }

    return connectRemoteMigrateServer(input.server);
  };
  const connection = await connect();
  const { client, runPromise, serverInfo } = connection;
  const initialDashboard = await runPromise(client.GetDashboard()).catch(
    async (cause) => {
      await connection.dispose();
      throw cause;
    }
  );
  let activeRunObservation:
    | {
        readonly controller: AbortController;
        readonly runId: MigrationRunId;
        readonly token: symbol;
      }
    | undefined;
  const runtimeController = new AbortController();
  const activeLocalCommands = new Set<Promise<void>>();
  const sourceScanSnapshot = (
    dashboard: Pick<MigrateDashboard, "activeRuns" | "rows" | "scannedSource">
  ) => ({
    activeRuns: dashboard.activeRuns,
    rows: dashboard.rows,
    scannedSource: dashboard.scannedSource,
  });
  const snapshot = ({
    dashboard,
    resumeToken,
  }: MigrateDashboardSnapshot): MigrationTuiSnapshot => ({
    ...sourceScanSnapshot(dashboard),
    resumeToken,
  });

  const runCommand = <Value, CommandError>(
    command: (
      commandClient: MigrateConnection["client"]
    ) => Effect.Effect<Value, CommandError>
  ): Promise<Value> => {
    if (input.server !== undefined) {
      return runPromise(command(client), {
        signal: runtimeController.signal,
      });
    }

    const execution = (async () => {
      runtimeController.signal.throwIfAborted();
      const commandConnection = await connect();

      try {
        runtimeController.signal.throwIfAborted();
        return await commandConnection.runPromise(
          command(commandConnection.client),
          { signal: runtimeController.signal }
        );
      } finally {
        await commandConnection.dispose();
      }
    })();
    const settled = execution.then(
      () => {
        activeLocalCommands.delete(settled);
      },
      () => {
        activeLocalCommands.delete(settled);
      }
    );
    activeLocalCommands.add(settled);

    return execution;
  };

  const consumeObservation = async <ObservationError>(
    observationConnection: MigrateConnection,
    stream: Stream.Stream<MigrateObservationEvent, ObservationError>,
    runId: MigrationRunId,
    options?: MigrationTuiExecuteOptions,
    signal?: AbortSignal
  ): Promise<MigrationTuiExecutionResult> => {
    let completion:
      | Extract<MigrateObservationEvent, { readonly kind: "terminal" }>
      | {
          readonly kind: "detached";
          readonly message: string;
          readonly runId: MigrationRunId;
        }
      | undefined;

    await observationConnection.runPromise(
      stream.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            switch (event.kind) {
              case "progress":
                options?.onProgress?.({ definitions: event.definitions });
                break;
              case "state": {
                options?.onStateChange?.(event.state);
                break;
              }
              case "detached":
                completion = event;
                break;
              case "terminal":
                completion = event;
                break;
              case "warning":
                options?.onObservationWarning?.(event.message);
                break;
              default: {
                const unhandled: never = event;
                return unhandled;
              }
            }
          })
        )
      ),
      signal === undefined ? undefined : { signal }
    );

    if (completion === undefined) {
      throw new Error(
        `Observation ended before run ${runId} reached a terminal state`
      );
    }
    if (completion.kind === "terminal") {
      if (completion.outcome === "failed") {
        throw new Error(completion.message);
      }

      return {
        message: completion.message,
        outcome: completion.outcome,
        runId: completion.runId,
      };
    }

    return {
      message: completion.message,
      outcome: "detached",
      runId: completion.runId,
    };
  };

  const startOperation = (
    operation: MigratePreparedOperation
  ): Promise<MigrateRunStartResult> =>
    runCommand((commandClient) =>
      commandClient.StartOperation({
        acceptedFingerprint: operation.fingerprint,
        request: operation.request,
      })
    );

  const detachRunObservation = (runId?: MigrationRunId): boolean => {
    const active = activeRunObservation;

    if (
      active === undefined ||
      (runId !== undefined && active.runId !== runId)
    ) {
      return false;
    }

    activeRunObservation = undefined;
    active.controller.abort();
    return true;
  };

  const detachForExit = (): Promise<MigrationTuiDetachResult> => {
    if (activeRunObservation !== undefined) {
      const { runId } = activeRunObservation;
      detachRunObservation(runId);
      return Promise.resolve({
        kind: "detached",
        message: `Run ${runId} will continue after Migrate closes…`,
      });
    }

    return Promise.resolve({ kind: "idle" });
  };

  const dispose = async (): Promise<void> => {
    runtimeController.abort();
    detachRunObservation();
    await Promise.all(activeLocalCommands);
    await connection.dispose();
  };

  // Keep long-lived streams and local commands off the lifecycle transport.
  // Reusing an active local named-pipe connection is unreliable on Windows.

  return {
    breakLock: (lock: MigrationDefinitionLock) =>
      runCommand((commandClient) => commandClient.BreakLock({ lock })),
    environmentLabel: serverInfo.environment.label ?? serverInfo.environment.id,
    detachForExit,
    detachRunObservation,
    dispose,
    groups: initialDashboard.dashboard.groups,
    listActiveRuns: () =>
      runCommand((commandClient) => commandClient.GetActiveRuns()),
    listMessages: (target) =>
      runCommand((commandClient) => commandClient.GetMessages({ target })),
    listSourceIdentityHistory: (definitionId) =>
      runCommand((commandClient) =>
        commandClient.GetSourceIdentityHistory({ definitionId })
      ),
    getSourceItemTotals: (definitionIds) =>
      runCommand((commandClient) =>
        commandClient.GetSourceItemTotals({ definitionIds })
      ),
    normalizeSourceIdentity: (definitionId, sourceIdentity) =>
      runCommand((commandClient) =>
        commandClient.NormalizeSourceIdentity({ definitionId, sourceIdentity })
      ),
    observeDashboard: async ({
      after,
      onSnapshot,
      signal,
    }: MigrationTuiDashboardObservationOptions) => {
      const observationConnection = await connect();
      const observationSignal =
        signal === undefined
          ? runtimeController.signal
          : AbortSignal.any([runtimeController.signal, signal]);

      try {
        await observationConnection.runPromise(
          observationConnection.client
            .observeDashboard(after === undefined ? {} : { after })
            .pipe(
              Stream.runForEach((dashboardSnapshot) =>
                Effect.sync(() => onSnapshot(snapshot(dashboardSnapshot)))
              )
            ),
          { signal: observationSignal }
        );
      } finally {
        await observationConnection.dispose();
      }
    },
    observeRun: async (runId, options) => {
      detachRunObservation();

      const controller = new AbortController();
      const observationSignal =
        options?.signal === undefined
          ? AbortSignal.any([controller.signal, runtimeController.signal])
          : AbortSignal.any([
              controller.signal,
              runtimeController.signal,
              options.signal,
            ]);
      const token = Symbol("MigrationTuiRunObservation");
      activeRunObservation = { controller, runId, token };
      let observationConnection: MigrateConnection | undefined;

      try {
        observationConnection = await connect();
        return await consumeObservation(
          observationConnection,
          observationConnection.client.observeRun({ runId }),
          runId,
          options,
          observationSignal
        );
      } catch (cause) {
        if (observationSignal.aborted) {
          return {
            message: `Run ${runId} continues in the background`,
            outcome: "detached",
            runId,
          };
        }

        options?.onProgressError?.(cause);
        throw cause;
      } finally {
        if (activeRunObservation?.token === token) {
          activeRunObservation = undefined;
        }
        await observationConnection?.dispose();
      }
    },
    prepare: (selection, action, options = {}) =>
      runCommand((commandClient) =>
        commandClient.PrepareOperation({
          action,
          options,
          selection,
        })
      ),
    refresh: () =>
      runCommand((commandClient) => commandClient.GetDashboard()).then(
        snapshot
      ),
    rows: initialDashboard.dashboard.rows,
    scanSource: (target, options = {}) =>
      runCommand((commandClient) =>
        commandClient.ScanSource({
          ...(options.concurrency === undefined
            ? {}
            : { concurrency: options.concurrency }),
          target,
        })
      ).then(sourceScanSnapshot),
    start: startOperation,
    stopRun: (runId) =>
      runCommand((commandClient) => commandClient.StopRun({ runId })),
  };
};

export const makeMigrationTuiRuntime = (
  input: LoadMigrationTuiInput
): Promise<MigrationTuiRuntime> =>
  makeMigrationTuiRuntimeWithLocalConnection(input, connectLocalMigrateServer);
