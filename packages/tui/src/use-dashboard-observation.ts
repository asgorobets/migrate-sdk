import type {
  MigrateActiveRun,
  MigrateDashboardResumeToken,
  MigrateDashboardRow,
} from "migrate-sdk/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MigrationTuiDashboardState,
  MigrationTuiRuntime,
} from "./runtime.ts";
import {
  observedRunActivity,
  type SessionActivityInput,
  type SessionRunActivitySnapshot,
} from "./session-activity.ts";

interface DashboardObservationState {
  readonly after?: MigrateDashboardResumeToken | undefined;
  readonly generation: number;
  readonly loading: boolean;
}

interface UseDashboardObservationOptions {
  readonly clearSourceScanStatuses: () => void;
  readonly initialDashboardState?: MigrationTuiDashboardState | undefined;
  readonly initialRows?: readonly MigrateDashboardRow[] | undefined;
  readonly loadStatusOnStartup?: boolean | undefined;
  readonly onDashboardStateChange?:
    | ((state: MigrationTuiDashboardState) => void)
    | undefined;
  readonly recordActivity: (activity: SessionActivityInput) => void;
  readonly recoveryNotice?: string | undefined;
  readonly runtime: MigrationTuiRuntime;
  readonly setNotice: (message: string | null) => void;
}

interface DashboardRefreshOptions {
  readonly coalesce?: boolean;
}

interface DashboardObservation {
  readonly activeRuns: readonly MigrateActiveRun[];
  readonly durableRows: readonly MigrateDashboardRow[];
  readonly refresh: (
    nextNotice?: string,
    options?: DashboardRefreshOptions
  ) => Promise<void>;
  readonly startObservation: (snapshot?: SessionRunActivitySnapshot) => void;
  readonly statusError: string | null;
  readonly statusLoading: boolean;
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const useDashboardObservation = ({
  clearSourceScanStatuses,
  initialDashboardState,
  initialRows,
  loadStatusOnStartup = true,
  onDashboardStateChange,
  recordActivity,
  recoveryNotice,
  runtime,
  setNotice,
}: UseDashboardObservationOptions): DashboardObservation => {
  const [dashboard, setDashboard] = useState<MigrationTuiDashboardState>(() =>
    initialDashboardState === undefined
      ? {
          rows: initialRows ?? runtime.rows,
          activeRuns: [],
          observing: loadStatusOnStartup,
        }
      : {
          ...initialDashboardState,
          observing:
            initialDashboardState.observing ||
            initialDashboardState.activeRuns.length > 0,
        }
  );
  const dashboardRef = useRef(dashboard);
  const { rows: durableRows, activeRuns } = dashboard;
  const [observationState, setObservationState] =
    useState<DashboardObservationState | null>(
      dashboard.observing ? { generation: 0, loading: true } : null
    );
  const [statusLoading, setStatusLoading] = useState(dashboard.observing);
  const [statusError, setStatusError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const generationRef = useRef(0);
  const observationPromiseRef = useRef<Promise<void> | undefined>(undefined);
  const refreshRequestRef = useRef(0);
  const pendingRefreshRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);
  const observedRunSnapshotRef = useRef<SessionRunActivitySnapshot | undefined>(
    initialDashboardState
  );
  const observedRuntimeRef = useRef(runtime);
  const updateDashboard = useCallback(
    (state: MigrationTuiDashboardState) => {
      dashboardRef.current = state;
      onDashboardStateChange?.(state);
      setDashboard(state);
    },
    [onDashboardStateChange]
  );
  const setObserving = useCallback(
    (observing: boolean) => {
      updateDashboard({ ...dashboardRef.current, observing });
    },
    [updateDashboard]
  );
  const applySnapshot = useCallback(
    (snapshot: SessionRunActivitySnapshot) => {
      for (const activity of observedRunActivity(
        observedRunSnapshotRef.current,
        snapshot
      )) {
        recordActivity(activity);
      }

      observedRunSnapshotRef.current = snapshot;
      updateDashboard({
        rows: snapshot.rows,
        activeRuns: snapshot.activeRuns,
        observing: snapshot.activeRuns.length > 0,
      });
    },
    [recordActivity, updateDashboard]
  );

  const refresh = useCallback(
    async (
      nextNotice = "Status reloaded",
      options?: DashboardRefreshOptions
    ) => {
      if (
        options?.coalesce &&
        pendingRefreshRef.current === refreshRequestRef.current
      ) {
        return;
      }
      const requestId = refreshRequestRef.current + 1;
      const nextGeneration = generationRef.current + 1;
      pendingRefreshRef.current = requestId;
      refreshRequestRef.current = requestId;
      generationRef.current = nextGeneration;
      setObserving(true);
      setStatusLoading(true);
      setStatusError(null);
      recordActivity({ kind: "status", message: "Reloading status…" });
      setObservationState(null);

      try {
        const stoppedObservation = observationPromiseRef.current;
        controllerRef.current?.abort();
        await stoppedObservation;

        if (!mountedRef.current || requestId !== refreshRequestRef.current) {
          return;
        }

        const snapshot = await runtime.refresh();

        if (!mountedRef.current || requestId !== refreshRequestRef.current) {
          return;
        }

        applySnapshot(snapshot);
        clearSourceScanStatuses();
        setNotice(nextNotice);
        if (snapshot.activeRuns.length > 0) {
          setObservationState({
            after: snapshot.resumeToken,
            generation: nextGeneration,
            loading: false,
          });
        }
      } catch (cause) {
        if (mountedRef.current && requestId === refreshRequestRef.current) {
          setObserving(false);
          const message = `Unable to load status: ${errorMessage(cause)}. Press R to retry.`;
          setStatusError(message);
          recordActivity({ kind: "error", message });
        }
      } finally {
        if (pendingRefreshRef.current === requestId) {
          pendingRefreshRef.current = undefined;
        }
        if (mountedRef.current && requestId === refreshRequestRef.current) {
          setStatusLoading(false);
        }
      }
    },
    [
      applySnapshot,
      clearSourceScanStatuses,
      runtime,
      recordActivity,
      setNotice,
      setObserving,
    ]
  );

  const startObservation = useCallback(
    (snapshot?: SessionRunActivitySnapshot) => {
      refreshRequestRef.current += 1;
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      controllerRef.current?.abort();
      if (snapshot !== undefined) {
        applySnapshot(snapshot);
      }
      setObserving(true);
      setStatusError(null);
      setStatusLoading(true);
      setObservationState({ generation, loading: true });
    },
    [applySnapshot, setObserving]
  );

  useEffect(() => {
    onDashboardStateChange?.(dashboardRef.current);
  }, [onDashboardStateChange]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (observedRuntimeRef.current !== runtime) {
      observedRuntimeRef.current = runtime;
      observedRunSnapshotRef.current = undefined;
    }
  }, [runtime]);

  useEffect(() => {
    if (observationState === null) {
      return;
    }
    const controller = new AbortController();
    const { after, generation, loading } = observationState;
    if (loading) {
      recordActivity({ kind: "status", message: "Loading status…" });
    }
    let receivedSnapshot = false;
    const observation = runtime
      .observeDashboard({
        ...(after === undefined ? {} : { after }),
        onSnapshot: (snapshot) => {
          if (
            controller.signal.aborted ||
            generation !== generationRef.current
          ) {
            return;
          }

          applySnapshot(snapshot);

          if (!receivedSnapshot) {
            setStatusLoading(false);
            if (generation === 0) {
              setNotice(recoveryNotice ?? "Status reloaded");
            }
          }
          receivedSnapshot = true;
          if (snapshot.activeRuns.length === 0) {
            controller.abort();
            setObservationState(null);
          }
        },
        signal: controller.signal,
      })
      .catch((cause: unknown) => {
        if (
          !controller.signal.aborted &&
          generation === generationRef.current
        ) {
          setStatusLoading(false);
          setObserving(false);
          setObservationState(null);
          const message = `Unable to load status: ${errorMessage(cause)}. Press R to retry.`;
          setStatusError(message);
          recordActivity({ kind: "error", message });
        }
      });
    controllerRef.current = controller;
    observationPromiseRef.current = observation;

    return () => {
      controller.abort();

      if (controllerRef.current === controller) {
        controllerRef.current = undefined;
      }
      if (observationPromiseRef.current === observation) {
        observationPromiseRef.current = undefined;
      }
    };
  }, [
    applySnapshot,
    observationState,
    recoveryNotice,
    recordActivity,
    runtime,
    setNotice,
    setObserving,
  ]);

  return {
    activeRuns,
    durableRows,
    refresh,
    startObservation,
    statusError,
    statusLoading,
  };
};
