import { Effect, Stream } from "effect";
import type { MigrationDefinitionLock, MigrationRunId } from "migrate-sdk";
import type {
  MigrateExecutionId,
  MigrateExecutionState,
  MigrateObservationEvent,
  MigratePrepareOptions,
  MigrateTarget,
} from "migrate-sdk/protocol";
import type {
  MigrationTuiExecutionResult,
  MigrationTuiExecutionState,
} from "../execution-controller.ts";
import type {
  LoadMigrationTuiInput,
  MigrationTuiExecuteOptions,
  MigrationTuiRow,
  MigrationTuiRuntime,
  MigrationTuiSnapshot,
  MigrationTuiTarget,
} from "../runtime.ts";
import { connectLocalMigrateServer } from "./local-client.ts";

const toProtocolTarget = (target: MigrationTuiTarget): MigrateTarget => target;

const operationOptions = (
  operation: Parameters<MigrationTuiRuntime["execute"]>[0]
): MigratePrepareOptions => ({
  ...(operation.plan.execution === undefined
    ? {}
    : { execution: operation.plan.execution }),
  ...(operation.plan.force === undefined
    ? {}
    : { force: operation.plan.force }),
  ...(operation.sourceIdentities === undefined
    ? {}
    : { sourceIdentities: operation.sourceIdentities }),
  withDependencies: operation.plan.withDependencies,
});

const toTuiExecutionState = (
  state: MigrateExecutionState
): MigrationTuiExecutionState => {
  switch (state.kind) {
    case "starting":
      return { definitionId: state.definitionId, kind: "starting" };
    case "running":
      return {
        adapter: state.adapter,
        definitionId: state.definitionId,
        kind: "running",
        runId: state.runId,
      };
    case "observing":
      return {
        adapter: state.adapter,
        definitionId: state.definitionId,
        executionId: state.executionId,
        kind: "observing",
        runId: state.runId,
      };
    case "cancelling":
      return {
        definitionId: state.definitionId,
        kind: "cancelling",
        ...(state.runId === undefined ? {} : { runId: state.runId }),
      };
    default: {
      const unhandled: never = state;
      return unhandled;
    }
  }
};

const toTuiRow = (row: {
  readonly entry: {
    readonly dependencies: {
      readonly optional: MigrationTuiRow["entry"]["dependencies"]["optional"];
      readonly required: MigrationTuiRow["entry"]["dependencies"]["required"];
    };
    readonly group?: MigrationTuiRow["entry"]["group"] | undefined;
    readonly hasRollback: boolean;
    readonly id: MigrationTuiRow["entry"]["id"];
  };
  readonly status?: MigrationTuiRow["status"] | undefined;
}): MigrationTuiRow => ({
  entry: {
    dependencies: row.entry.dependencies,
    ...(row.entry.group === undefined ? {} : { group: row.entry.group }),
    hasRollback: row.entry.hasRollback,
    id: row.entry.id,
  },
  ...(row.status === undefined ? {} : { status: row.status }),
});

export const makeMigrationTuiRuntime = async (
  input: LoadMigrationTuiInput
): Promise<MigrationTuiRuntime> => {
  const connection = await connectLocalMigrateServer(input);
  const { client, runPromise, serverInfo } = connection;
  const initialDashboard = await runPromise(client.GetDashboard()).catch(
    async (cause) => {
      await connection.dispose();
      throw cause;
    }
  );
  let executionState: MigrationTuiExecutionState | undefined;
  let activeExecutionId: MigrateExecutionId | undefined;
  let activeRunObservation:
    | { readonly controller: AbortController; readonly runId: MigrationRunId }
    | undefined;
  const executionListeners = new Set<
    (state: MigrationTuiExecutionState | undefined) => void
  >();

  const publishExecutionState = (
    state: MigrationTuiExecutionState | undefined
  ) => {
    executionState = state;

    for (const listener of executionListeners) {
      listener(state);
    }
  };

  const snapshot = (dashboard: {
    readonly activeRuns: MigrationTuiSnapshot["activeRuns"];
    readonly rows:
      | Parameters<typeof toTuiRow>[0][]
      | readonly Parameters<typeof toTuiRow>[0][];
    readonly scannedSource: boolean;
  }): MigrationTuiSnapshot => ({
    activeRuns: dashboard.activeRuns,
    rows: dashboard.rows.map(toTuiRow),
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

    try {
      await runPromise(
        stream.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              switch (event.kind) {
                case "progress":
                  options?.onProgress?.({ definitions: event.definitions });
                  break;
                case "state": {
                  const state = toTuiExecutionState(event.state);
                  publishExecutionState(state);
                  options?.onStateChange?.(state);
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
    } finally {
      publishExecutionState(undefined);
    }

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

  return {
    breakLock: (lock: MigrationDefinitionLock) =>
      runPromise(client.BreakLock({ lock })),
    cancelActiveExecution: () => {
      if (activeRunObservation !== undefined) {
        const { controller, runId } = activeRunObservation;
        controller.abort();
        return Promise.resolve({
          kind: "detached" as const,
          message: `Run ${runId} will continue in the background after this screen closes…`,
        });
      }

      return runPromise(
        client.CancelExecution(
          activeExecutionId === undefined
            ? {}
            : { executionId: activeExecutionId }
        )
      );
    },
    configPath: serverInfo.configPath ?? "Migrate Server",
    dispose: connection.dispose,
    execute: async (operation, options) => {
      const reference = await runPromise(
        client.StartOperation({
          acceptedFingerprint: operation.fingerprint,
          request: {
            action: operation.action,
            options: operationOptions(operation),
            target: operation.target,
          },
        })
      );
      activeExecutionId = reference.executionId;

      try {
        return await consumeObservation(
          client.ObserveExecution({ executionId: reference.executionId }),
          reference.runId,
          options
        );
      } catch (cause) {
        options?.onProgressError?.(cause);
        throw cause;
      } finally {
        activeExecutionId = undefined;
      }
    },
    getExecutionState: () => executionState,
    groups: initialDashboard.groups,
    listActiveRuns: () => runPromise(client.GetActiveRuns()),
    listMessages: (target) =>
      runPromise(client.GetMessages({ target: toProtocolTarget(target) })),
    listSourceIdentityHistory: (definitionId) =>
      runPromise(client.GetSourceIdentityHistory({ definitionId })),
    normalizeSourceIdentity: (definitionId, sourceIdentity) =>
      runPromise(
        client.NormalizeSourceIdentity({ definitionId, sourceIdentity })
      ),
    observeRun: async (runId, options) => {
      if (
        activeExecutionId !== undefined ||
        activeRunObservation !== undefined
      ) {
        throw new Error("Another migration is already running");
      }

      const controller = new AbortController();
      activeRunObservation = { controller, runId };

      try {
        return await consumeObservation(
          client.ObserveRun({ runId }),
          runId,
          options,
          controller.signal
        );
      } catch (cause) {
        if (controller.signal.aborted) {
          return {
            message: `Run ${runId} continues in the background`,
            outcome: "detached",
            runId,
          };
        }

        options?.onProgressError?.(cause);
        throw cause;
      } finally {
        if (activeRunObservation?.controller === controller) {
          activeRunObservation = undefined;
        }
      }
    },
    prepare: (target, action, options = {}) =>
      runPromise(
        client.PrepareOperation({
          action,
          options,
          target: toProtocolTarget(target),
        })
      ),
    refresh: () => runPromise(client.GetDashboard()).then(snapshot),
    rows: initialDashboard.rows.map(toTuiRow),
    scanSource: (target, options = {}) =>
      runPromise(
        client.ScanSource({
          ...(options.concurrency === undefined
            ? {}
            : { concurrency: options.concurrency }),
          target: toProtocolTarget(target),
        })
      ).then(snapshot),
    subscribeExecution: (listener) => {
      executionListeners.add(listener);
      return () => executionListeners.delete(listener);
    },
  };
};
