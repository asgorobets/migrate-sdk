import type { MigrationTuiDetachResult } from "./runtime.ts";

interface MigrationTuiShutdownControllerInput {
  readonly destroy: () => void;
  readonly detachForExit: () => Promise<MigrationTuiDetachResult>;
}

export type MigrationTuiExitSignal = "SIGHUP" | "SIGINT" | "SIGTERM";

export interface MigrationTuiSignalSource {
  readonly off: (signal: MigrationTuiExitSignal, listener: () => void) => void;
  readonly on: (signal: MigrationTuiExitSignal, listener: () => void) => void;
}

const signalExitCodes: Record<MigrationTuiExitSignal, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

export const registerMigrationTuiSignalHandlers = ({
  onSignal,
  source,
}: {
  readonly onSignal: (signal: MigrationTuiExitSignal, exitCode: number) => void;
  readonly source: MigrationTuiSignalSource;
}): (() => void) => {
  const listeners = new Map<MigrationTuiExitSignal, () => void>();

  for (const signal of Object.keys(
    signalExitCodes
  ) as MigrationTuiExitSignal[]) {
    const listener = () => onSignal(signal, signalExitCodes[signal]);
    listeners.set(signal, listener);
    source.on(signal, listener);
  }

  return () => {
    for (const [signal, listener] of listeners) {
      source.off(signal, listener);
    }
  };
};

export interface MigrationTuiShutdownController {
  readonly executionSettled: () => boolean;
  readonly isExitRequested: () => boolean;
  readonly requestExit: () => Promise<MigrationTuiDetachResult>;
}

export const makeMigrationTuiShutdownController = (
  input: MigrationTuiShutdownControllerInput
): MigrationTuiShutdownController => {
  let destroyed = false;
  let exitRequested = false;
  let request: Promise<MigrationTuiDetachResult> | undefined;

  const destroyOnce = () => {
    if (destroyed) {
      return;
    }

    destroyed = true;
    input.destroy();
  };

  const requestExit = (): Promise<MigrationTuiDetachResult> => {
    exitRequested = true;

    request ??= input.detachForExit().then(
      (cancellation) => {
        if (cancellation.kind === "idle") {
          destroyOnce();
        }

        return cancellation;
      },
      (cause: unknown) => {
        exitRequested = false;
        request = undefined;
        throw cause;
      }
    );

    return request;
  };

  return {
    executionSettled: () => {
      if (!exitRequested) {
        return false;
      }

      destroyOnce();
      return true;
    },
    isExitRequested: () => exitRequested,
    requestExit,
  };
};
