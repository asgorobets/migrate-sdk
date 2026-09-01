export interface VisibilitySource {
  readonly isHidden: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
}

interface StartVisibilityControlledObservationInput {
  readonly onFailure: (cause: unknown) => void;
  readonly run: (signal: AbortSignal) => Promise<void>;
  readonly visibility: VisibilitySource;
}

export interface VisibilityControlledObservation {
  readonly dispose: () => void;
}

export const startVisibilityControlledObservation = ({
  onFailure,
  run,
  visibility,
}: StartVisibilityControlledObservationInput): VisibilityControlledObservation => {
  let active: AbortController | undefined;
  let disposed = false;

  const stop = (): void => {
    const current = active;
    active = undefined;
    current?.abort();
  };

  const start = (): void => {
    if (disposed || visibility.isHidden() || active !== undefined) {
      return;
    }

    const controller = new AbortController();
    active = controller;
    run(controller.signal)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          onFailure(cause);
        }
      })
      .finally(() => {
        if (active === controller) {
          active = undefined;
        }
      });
  };

  const synchronize = (): void => {
    if (visibility.isHidden()) {
      stop();
    } else {
      start();
    }
  };

  const unsubscribe = visibility.subscribe(synchronize);
  synchronize();

  return {
    dispose: () => {
      disposed = true;
      unsubscribe();
      stop();
    },
  };
};

export const documentVisibility: VisibilitySource = {
  isHidden: () => document.visibilityState === "hidden",
  subscribe: (listener) => {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};
