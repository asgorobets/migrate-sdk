import { Effect } from "effect";
import type {
  ExecutionStartResult,
  MigrationDefinitionId,
  MigrationExecutableProgressCheckpoint,
  MigrationExecutionHandle,
  MigrationRunId,
  MigrationRunState,
} from "migrate-sdk";

export type MigrationTuiExecutionState =
  | {
      readonly definitionId: MigrationDefinitionId;
      readonly kind: "starting";
    }
  | {
      readonly adapter: string;
      readonly definitionId: MigrationDefinitionId;
      readonly kind: "running";
      readonly runId: MigrationRunId;
    }
  | {
      readonly adapter: string;
      readonly definitionId: MigrationDefinitionId;
      readonly executionId: string;
      readonly kind: "observing";
      readonly runId: MigrationRunId;
    }
  | {
      readonly definitionId: MigrationDefinitionId;
      readonly kind: "cancelling";
      readonly runId?: MigrationRunId;
    };

export type MigrationTuiCancellationResult =
  | {
      readonly kind: "idle";
    }
  | {
      readonly kind: "requested";
      readonly message: string;
    }
  | {
      readonly kind: "detached";
      readonly message: string;
    };

export interface MigrationTuiExecutionResult {
  readonly message: string;
  readonly outcome: "cancelled" | "completed" | "detached";
  readonly runId: MigrationRunId;
}

interface MigrationTuiExecutionControllerOptions {
  readonly onDetached?: () => void;
  readonly onProgressCheckpoint?: (
    checkpoint: MigrationExecutableProgressCheckpoint
  ) => void;
  readonly onProviderObservationError?: (cause: unknown) => void;
  readonly onStateChange?: (state: MigrationTuiExecutionState) => void;
}

interface DetachedRunObservationInput {
  readonly definitionId: MigrationDefinitionId;
  readonly execution: MigrationExecutionHandle & {
    readonly executionId: string;
  };
  readonly onProgressCheckpoint?: (
    checkpoint: MigrationExecutableProgressCheckpoint
  ) => void;
  readonly onProviderObservationError?: (cause: unknown) => void;
  readonly runId: MigrationRunId;
  readonly signal: AbortSignal;
}

interface MigrationTuiExecutionControllerInput {
  readonly observeDetachedRun: (
    input: DetachedRunObservationInput
  ) => Promise<MigrationRunState>;
}

interface ActiveExecution {
  cancel?: (() => Promise<void>) | undefined;
  cancelPromise?: Promise<void> | undefined;
  cancelRequested: boolean;
  readonly definitionId: MigrationDefinitionId;
  notify: (state: MigrationTuiExecutionState) => void;
  observer?: AbortController | undefined;
  runId?: MigrationRunId | undefined;
  readonly token: symbol;
}

const errorMessage = (cause: unknown): string => {
  if (cause instanceof Error) {
    return cause.message;
  }

  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }

  return String(cause);
};

const requestAttachedCancellation = (
  active: ActiveExecution
): Promise<void> => {
  if (active.cancel === undefined) {
    return Promise.resolve();
  }

  active.cancelPromise ??= active.cancel();
  return active.cancelPromise;
};

export const makeMigrationTuiExecutionController = (
  input: MigrationTuiExecutionControllerInput
) => {
  let active: ActiveExecution | undefined;
  let executionState: MigrationTuiExecutionState | undefined;
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

  const execute = async <Summary extends { readonly status: string }>({
    definitionId,
    options,
    start,
  }: {
    readonly definitionId: MigrationDefinitionId;
    readonly options?: MigrationTuiExecutionControllerOptions | undefined;
    readonly start: () => Promise<ExecutionStartResult<Summary>>;
  }): Promise<MigrationTuiExecutionResult> => {
    if (active !== undefined) {
      throw new Error("Another migration is already running");
    }

    const token = Symbol("MigrationTuiExecution");
    const notify = (state: MigrationTuiExecutionState) => {
      publishExecutionState(state);
      options?.onStateChange?.(state);
    };
    const current: ActiveExecution = {
      cancelRequested: false,
      definitionId,
      notify,
      token,
    };
    active = current;
    notify({ definitionId, kind: "starting" });

    try {
      const started = await start();

      if (started.kind === "completed") {
        return {
          message: `Run ${started.runId} ${started.summary.status}`,
          outcome: "completed",
          runId: started.runId,
        };
      }

      current.runId = started.runId;

      if (started.handle !== undefined) {
        current.cancel = async () => {
          await Effect.runPromise(started.handle.cancel);
        };
        notify({
          adapter: started.execution.adapter,
          definitionId,
          kind: "running",
          runId: started.runId,
        });

        if (current.cancelRequested) {
          notify({
            definitionId,
            kind: "cancelling",
            runId: started.runId,
          });
          await requestAttachedCancellation(current);
        }

        const terminal = await Effect.runPromise(started.handle.wait);

        switch (terminal.kind) {
          case "cancelled":
            return {
              message: `Run ${terminal.state.runId} cancelled`,
              outcome: "cancelled",
              runId: terminal.state.runId,
            };
          case "execution-failed":
            throw new Error(errorMessage(terminal.cause));
          case "finished":
            return {
              message: `Run ${terminal.state.runId} ${terminal.summary.status}`,
              outcome: "completed",
              runId: terminal.state.runId,
            };
          default: {
            const unhandled: never = terminal;
            return unhandled;
          }
        }
      }

      const observer = new AbortController();
      current.observer = observer;
      notify({
        adapter: started.execution.adapter,
        definitionId,
        executionId: started.execution.executionId,
        kind: "observing",
        runId: started.runId,
      });

      try {
        const observation = input.observeDetachedRun({
          definitionId,
          execution: started.execution,
          ...(options?.onProgressCheckpoint === undefined
            ? {}
            : { onProgressCheckpoint: options.onProgressCheckpoint }),
          ...(options?.onProviderObservationError === undefined
            ? {}
            : {
                onProviderObservationError: options.onProviderObservationError,
              }),
          runId: started.runId,
          signal: observer.signal,
        });

        if (current.cancelRequested) {
          observer.abort();
        }

        const terminal = await observation;

        return {
          message: `Run ${terminal.runId} ${terminal.status}`,
          outcome: "completed",
          runId: terminal.runId,
        };
      } catch (cause) {
        if (observer.signal.aborted) {
          options?.onDetached?.();
          return {
            message: `Run ${started.runId} continues in the background`,
            outcome: "detached",
            runId: started.runId,
          };
        }
        throw cause;
      }
    } finally {
      if (active?.token === token) {
        active = undefined;
        publishExecutionState(undefined);
      }
    }
  };

  const cancelActiveExecution =
    async (): Promise<MigrationTuiCancellationResult> => {
      const current = active;

      if (current === undefined) {
        return { kind: "idle" };
      }

      current.cancelRequested = true;
      current.notify({
        definitionId: current.definitionId,
        kind: "cancelling",
        ...(current.runId === undefined ? {} : { runId: current.runId }),
      });

      if (current.cancel !== undefined) {
        await requestAttachedCancellation(current);
        return {
          kind: "requested",
          message: `Cancelling run ${current.runId}; waiting for active work to finish…`,
        };
      }

      if (current.observer !== undefined) {
        current.observer.abort();
        return {
          kind: "detached",
          message: `Run ${current.runId} will continue in the background after this screen closes…`,
        };
      }

      return {
        kind: "requested",
        message: "Exit requested; waiting for the run to start…",
      };
    };

  return {
    cancelActiveExecution,
    execute,
    getExecutionState: () => executionState,
    subscribeExecution: (
      listener: (state: MigrationTuiExecutionState | undefined) => void
    ) => {
      executionListeners.add(listener);

      return () => executionListeners.delete(listener);
    },
  } as const;
};
