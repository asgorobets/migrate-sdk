import type { MigrationTuiCancellationResult } from "./execution.ts";
import type { MigrationTuiRow, MigrationTuiSnapshot } from "./runtime.ts";
import {
  type MigrationTuiShutdownController,
  type MigrationTuiSignalSource,
  makeMigrationTuiShutdownController,
  registerMigrationTuiSignalHandlers,
} from "./shutdown-controller.ts";

export interface MigrationTuiRenderSessionInput {
  readonly initialRows?: readonly MigrationTuiRow[];
  readonly lifecycle: MigrationTuiShutdownController;
  readonly onControlC: () => void;
  readonly onRenderError: (cause: unknown) => void;
  readonly recoveryNotice?: string;
}

export interface MigrationTuiRenderSession {
  readonly destroy: () => void;
}

interface MigrationTuiSupervisorRuntime {
  readonly detachForExit: () => Promise<MigrationTuiCancellationResult>;
  readonly refresh: () => Promise<MigrationTuiSnapshot>;
}

interface MigrationTuiLifecycleSupervisorOptions {
  readonly createSession: (
    input: MigrationTuiRenderSessionInput
  ) => Promise<MigrationTuiRenderSession>;
  readonly forceExit?: (exitCode: number) => void;
  readonly forceExitTimeoutMs?: number;
  readonly runtime: MigrationTuiSupervisorRuntime;
  readonly setExitCode?: (exitCode: number) => void;
  readonly signalSource?: MigrationTuiSignalSource;
  readonly writeError?: (message: string) => void;
}

interface ActiveRenderSession {
  readonly session: MigrationTuiRenderSession;
  readonly token: symbol;
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const errorDetails = (cause: unknown): string =>
  cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);

const recoveryNotice = (cause: unknown): string => {
  const message = errorMessage(cause).replaceAll(/\s+/g, " ").trim();
  return `UI recovered from a renderer error (${message}); migration state was reloaded.`;
};

export const makeMigrationTuiLifecycleSupervisor = (
  options: MigrationTuiLifecycleSupervisorOptions
) => {
  const completion = Promise.withResolvers<void>();
  const forceExitTimeoutMs = options.forceExitTimeoutMs ?? 5000;
  const forceExit = options.forceExit ?? ((exitCode) => process.exit(exitCode));
  const setExitCode =
    options.setExitCode ??
    ((exitCode: number) => (process.exitCode = exitCode));
  const signalSource =
    options.signalSource ?? (process as unknown as MigrationTuiSignalSource);
  const writeError =
    options.writeError ?? ((message: string) => process.stderr.write(message));
  let activeSession: ActiveRenderSession | undefined;
  let exitCode = 0;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let pendingToken: symbol | undefined;
  let recoveryAttempted = false;
  let started = false;
  let unregisterSignals: (() => void) | undefined;

  const destroySession = () => {
    const active = activeSession;
    activeSession = undefined;
    active?.session.destroy();
  };

  const finish = (nextExitCode: number): boolean => {
    if (finished) {
      return false;
    }

    finished = true;
    pendingToken = undefined;

    if (exitTimer !== undefined) {
      clearTimeout(exitTimer);
      exitTimer = undefined;
    }

    unregisterSignals?.();
    unregisterSignals = undefined;
    destroySession();
    setExitCode(nextExitCode);
    completion.resolve();
    return true;
  };

  const forceFinish = (nextExitCode: number, message: string) => {
    if (!finish(nextExitCode)) {
      return;
    }

    writeError(`${message}\n`);
    forceExit(nextExitCode);
  };

  const shutdown = makeMigrationTuiShutdownController({
    detachForExit: options.runtime.detachForExit,
    destroy: () => {
      finish(exitCode);
    },
  });

  const armExitTimer = () => {
    if (exitTimer !== undefined || finished) {
      return;
    }

    exitTimer = setTimeout(() => {
      forceFinish(
        exitCode,
        "migrate-tui: graceful shutdown timed out; the terminal was restored"
      );
    }, forceExitTimeoutMs);
  };

  const requestExit = (
    nextExitCode: number,
    forceWhenAlreadyRequested: boolean
  ): Promise<MigrationTuiCancellationResult> => {
    if (finished) {
      return Promise.resolve({ kind: "idle" });
    }

    if (forceWhenAlreadyRequested && shutdown.isExitRequested()) {
      forceFinish(
        nextExitCode,
        "migrate-tui: received a second interrupt; the terminal was restored"
      );
      return Promise.resolve({ kind: "idle" });
    }

    exitCode = nextExitCode;
    setExitCode(nextExitCode);
    armExitTimer();

    return shutdown.requestExit().catch((cause: unknown) => {
      const message = errorMessage(cause);
      forceFinish(
        1,
        `migrate-tui: unable to detach from the active migration (${message}); the terminal was restored`
      );
      throw cause;
    });
  };

  const lifecycle: MigrationTuiShutdownController = {
    executionSettled: shutdown.executionSettled,
    isExitRequested: shutdown.isExitRequested,
    requestExit: () => requestExit(0, false),
  };

  const failRenderer = (cause: unknown) => {
    const details = errorDetails(cause);

    if (finish(1)) {
      writeError(
        `migrate-tui: UI renderer failed after recovery\n${details}\n`
      );
    }
  };

  async function handleRendererError(token: symbol, cause: unknown) {
    const belongsToCurrentSession =
      activeSession?.token === token || pendingToken === token;

    if (finished || !belongsToCurrentSession) {
      return;
    }

    if (recoveryAttempted) {
      failRenderer(cause);
      return;
    }

    recoveryAttempted = true;

    if (activeSession?.token === token) {
      destroySession();
    }

    writeError(
      `migrate-tui: UI renderer failed; attempting one recovery\n${errorDetails(cause)}\n`
    );

    try {
      const snapshot = await options.runtime.refresh();

      if (finished) {
        return;
      }

      await openSession({
        initialRows: snapshot.rows,
        recoveryNotice: recoveryNotice(cause),
      });
    } catch (recoveryCause) {
      failRenderer(recoveryCause);
    }
  }

  async function openSession({
    initialRows,
    recoveryNotice: nextRecoveryNotice,
  }: {
    readonly initialRows?: readonly MigrationTuiRow[];
    readonly recoveryNotice?: string;
  } = {}): Promise<void> {
    const token = Symbol("MigrationTuiRenderSession");
    pendingToken = token;

    try {
      const session = await options.createSession({
        ...(initialRows === undefined ? {} : { initialRows }),
        lifecycle,
        onControlC: () => requestExit(130, true).catch(() => undefined),
        onRenderError: (cause) => handleRendererError(token, cause),
        ...(nextRecoveryNotice === undefined
          ? {}
          : { recoveryNotice: nextRecoveryNotice }),
      });

      if (finished || pendingToken !== token) {
        session.destroy();
        return;
      }

      pendingToken = undefined;
      activeSession = { session, token };
    } catch (cause) {
      if (pendingToken === token) {
        await handleRendererError(token, cause);
      }
    }
  }

  const start = async (): Promise<void> => {
    if (started) {
      return;
    }

    started = true;
    unregisterSignals = registerMigrationTuiSignalHandlers({
      onSignal: (_signal, nextExitCode) =>
        requestExit(nextExitCode, true).catch(() => undefined),
      source: signalSource,
    });
    await openSession();
  };

  return {
    lifecycle,
    start,
    wait: () => completion.promise,
  } as const;
};
