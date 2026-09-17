import type {
  MigrateActiveRun,
  MigrateDashboardResumeToken,
  MigrateDashboardRow,
} from "migrate-sdk/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MigrationTuiRuntime, MigrationTuiSnapshot } from "./runtime.ts";
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
  readonly initialRows?: readonly MigrateDashboardRow[] | undefined;
  readonly loadStatusOnStartup?: boolean | undefined;
  readonly recordActivity: (activity: SessionActivityInput) => void;
  readonly recoveryNotice?: string | undefined;
  readonly runtime: MigrationTuiRuntime;
  readonly setNotice: (message: string | null) => void;
}

interface DashboardObservation {
  readonly activeRuns: readonly MigrateActiveRun[];
  readonly durableRows: readonly MigrateDashboardRow[];
  readonly refresh: (nextNotice?: string) => Promise<void>;
  readonly startObservation: () => void;
  readonly statusError: string | null;
  readonly statusLoading: boolean;
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const useDashboardObservation = ({
  clearSourceScanStatuses,
  initialRows,
  loadStatusOnStartup = true,
  recordActivity,
  recoveryNotice,
  runtime,
  setNotice,
}: UseDashboardObservationOptions): DashboardObservation => {
  const [durableRows, setDurableRows] = useState(initialRows ?? runtime.rows);
  const [activeRuns, setActiveRuns] = useState<readonly MigrateActiveRun[]>([]);
  const [observationState, setObservationState] =
    useState<DashboardObservationState | null>(
      loadStatusOnStartup ? { generation: 0, loading: true } : null
    );
  const [statusLoading, setStatusLoading] = useState(loadStatusOnStartup);
  const [statusError, setStatusError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const generationRef = useRef(0);
  const observationPromiseRef = useRef<Promise<void> | undefined>(undefined);
  const refreshRequestRef = useRef(0);
  const refreshingRef = useRef(false);
  const mountedRef = useRef(true);
  const observedRunSnapshotRef = useRef<SessionRunActivitySnapshot | undefined>(
    undefined
  );
  const observedRuntimeRef = useRef(runtime);
  const applySnapshot = useCallback(
    (snapshot: MigrationTuiSnapshot) => {
      for (const activity of observedRunActivity(
        observedRunSnapshotRef.current,
        snapshot
      )) {
        recordActivity(activity);
      }

      observedRunSnapshotRef.current = snapshot;
      setDurableRows(snapshot.rows);
      setActiveRuns(snapshot.activeRuns);
    },
    [recordActivity]
  );

  const refresh = useCallback(
    async (nextNotice = "Status reloaded") => {
      if (refreshingRef.current) {
        return;
      }
      refreshingRef.current = true;
      const requestId = refreshRequestRef.current + 1;
      const nextGeneration = generationRef.current + 1;
      refreshRequestRef.current = requestId;
      generationRef.current = nextGeneration;
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
          const message = `Unable to load status: ${errorMessage(cause)}. Press R to retry.`;
          setStatusError(message);
          recordActivity({ kind: "error", message });
        }
      } finally {
        refreshingRef.current = false;
        if (mountedRef.current && requestId === refreshRequestRef.current) {
          setStatusLoading(false);
        }
      }
    },
    [applySnapshot, clearSourceScanStatuses, runtime, recordActivity, setNotice]
  );

  const startObservation = useCallback(() => {
    refreshRequestRef.current += 1;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    controllerRef.current?.abort();
    setStatusError(null);
    setStatusLoading(true);
    setObservationState({ generation, loading: true });
  }, []);

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
