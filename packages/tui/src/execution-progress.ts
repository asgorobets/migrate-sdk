export interface MigrationTuiExecutionProgressScheduler<DefinitionId> {
  readonly request: (definitionIds: readonly DefinitionId[]) => void;
  readonly start: () => void;
  readonly stop: () => Promise<void>;
}

const waitForFallback = (
  signal: AbortSignal,
  intervalMs: number
): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const complete = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", complete);
      resolve();
    };
    const timer = setTimeout(complete, intervalMs);
    signal.addEventListener("abort", complete, { once: true });
  });

export const makeMigrationTuiExecutionProgressScheduler = <
  DefinitionId extends string,
  Progress,
>(input: {
  readonly definitionIds: readonly DefinitionId[];
  readonly fallbackIntervalMs: number;
  readonly onError: (cause: unknown) => void;
  readonly onProgress: (progress: Progress) => void;
  readonly read: (
    definitionIds: readonly DefinitionId[],
    signal: AbortSignal
  ) => Promise<Progress>;
}): MigrationTuiExecutionProgressScheduler<DefinitionId> => {
  const controller = new AbortController();
  const pendingDefinitionIds = new Set<DefinitionId>();
  let activeRead: Promise<void> | undefined;
  let fallback: Promise<void> | undefined;
  let requestVersion = 0;
  let started = false;

  const drain = async (): Promise<void> => {
    while (!controller.signal.aborted && pendingDefinitionIds.size > 0) {
      const definitionIds = [...pendingDefinitionIds];
      pendingDefinitionIds.clear();

      try {
        const progress = await input.read(definitionIds, controller.signal);

        if (!controller.signal.aborted) {
          input.onProgress(progress);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          input.onError(cause);
        }
      }
    }
  };

  const startDrain = () => {
    if (activeRead !== undefined || controller.signal.aborted) {
      return;
    }

    const nextRead = drain().finally(() => {
      if (activeRead === nextRead) {
        activeRead = undefined;
      }

      if (pendingDefinitionIds.size > 0) {
        startDrain();
      }
    });
    activeRead = nextRead;
  };

  const request = (definitionIds: readonly DefinitionId[]) => {
    if (controller.signal.aborted) {
      return;
    }

    requestVersion += 1;
    for (const definitionId of definitionIds) {
      pendingDefinitionIds.add(definitionId);
    }
    startDrain();
  };

  const runFallback = async () => {
    while (!controller.signal.aborted) {
      const versionBeforeWait = requestVersion;
      await waitForFallback(controller.signal, input.fallbackIntervalMs);

      if (controller.signal.aborted) {
        continue;
      }

      if (requestVersion !== versionBeforeWait) {
        continue;
      }

      const inFlightRead = activeRead;
      if (inFlightRead !== undefined) {
        await inFlightRead;
        continue;
      }

      request(input.definitionIds);
      const fallbackRead = activeRead;
      if (fallbackRead !== undefined) {
        await fallbackRead;
      }
    }
  };

  return {
    request,
    start: () => {
      if (started) {
        return;
      }

      started = true;
      fallback = runFallback();
    },
    stop: async () => {
      controller.abort();
      await Promise.all([activeRead, fallback]);
    },
  };
};
