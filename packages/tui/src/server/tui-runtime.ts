import { Effect, Stream } from "effect";
import type { MigrationDefinitionLock, MigrationRunId } from "migrate-sdk";
import type {
  MigrateDashboard,
  MigrateObservationEvent,
  MigratePreparedOperation,
  MigrateRunStartResult,
} from "migrate-sdk/protocol";
import type { MigrationTuiExecutionResult } from "../execution.ts";
import type {
  LoadMigrationTuiInput,
  MigrationTuiDetachResult,
  MigrationTuiExecuteOptions,
  MigrationTuiRuntime,
  MigrationTuiSnapshot,
} from "../runtime.ts";
import { connectLocalMigrateServer } from "./local-client.ts";
import { connectRemoteMigrateServer } from "./remote-client.ts";

export const makeMigrationTuiRuntime = async (
  input: LoadMigrationTuiInput
): Promise<MigrationTuiRuntime> => {
  const connection =
    input.server === undefined
      ? await connectLocalMigrateServer(input)
      : await connectRemoteMigrateServer(input.server);
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
  const snapshot = (
    dashboard: Pick<MigrateDashboard, "activeRuns" | "rows" | "scannedSource">
  ): MigrationTuiSnapshot => ({
    activeRuns: dashboard.activeRuns,
    rows: dashboard.rows,
    scannedSource: dashboard.scannedSource,
  });

  const consumeObservation = async <ObservationError>(
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

    await runPromise(
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
    runPromise(
      client.StartOperation({
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

  return {
    breakLock: (lock: MigrationDefinitionLock) =>
      runPromise(client.BreakLock({ lock })),
    environmentLabel: serverInfo.environment.label ?? serverInfo.environment.id,
    detachForExit,
    detachRunObservation,
    dispose: connection.dispose,
    groups: initialDashboard.groups,
    listActiveRuns: () => runPromise(client.GetActiveRuns()),
    listMessages: (target) => runPromise(client.GetMessages({ target })),
    listSourceIdentityHistory: (definitionId) =>
      runPromise(client.GetSourceIdentityHistory({ definitionId })),
    normalizeSourceIdentity: (definitionId, sourceIdentity) =>
      runPromise(
        client.NormalizeSourceIdentity({ definitionId, sourceIdentity })
      ),
    observeRun: async (runId, options) => {
      detachRunObservation();

      const controller = new AbortController();
      const observationSignal =
        options?.signal === undefined
          ? controller.signal
          : AbortSignal.any([controller.signal, options.signal]);
      const token = Symbol("MigrationTuiRunObservation");
      activeRunObservation = { controller, runId, token };

      try {
        return await consumeObservation(
          client.observeRun({ runId }),
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
      }
    },
    prepare: (target, action, options = {}) =>
      runPromise(
        client.PrepareOperation({
          action,
          options,
          target,
        })
      ),
    refresh: () => runPromise(client.GetDashboard()).then(snapshot),
    rows: initialDashboard.rows,
    scanSource: (target, options = {}) =>
      runPromise(
        client.ScanSource({
          ...(options.concurrency === undefined
            ? {}
            : { concurrency: options.concurrency }),
          target,
        })
      ).then(snapshot),
    start: startOperation,
    stopRun: (runId) => runPromise(client.StopRun({ runId })),
  };
};
