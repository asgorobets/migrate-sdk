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
}

interface UseDashboardObservationOptions {
  readonly clearSourceScanStatuses: () => void;
  readonly initialRows?: readonly MigrateDashboardRow[] | undefined;
  readonly recordActivity: (activity: SessionActivityInput) => void;
  readonly recoveryNotice?: string | undefined;
  readonly runtime: MigrationTuiRuntime;
  readonly setBusy: (message: string) => void;
  readonly setError: (message: string | null) => void;
  readonly setNotice: (message: string | null) => void;
}

interface DashboardObservation {
  readonly activeRuns: readonly MigrateActiveRun[];
  readonly durableRows: readonly MigrateDashboardRow[];
  readonly refresh: (nextNotice?: string) => Promise<void>;
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const useDashboardObservation = ({
  clearSourceScanStatuses,
  initialRows,
  recordActivity,
  recoveryNotice,
  runtime,
  setBusy,
  setError,
  setNotice,
}: UseDashboardObservationOptions): DashboardObservation => {
  const [durableRows, setDurableRows] = useState(initialRows ?? runtime.rows);
  const [activeRuns, setActiveRuns] = useState<readonly MigrateActiveRun[]>([]);
  const [observationState, setObservationState] =
    useState<DashboardObservationState>({ generation: 0 });
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const generationRef = useRef(0);
  const observationPromiseRef = useRef<Promise<void> | undefined>(undefined);
  const refreshRequestRef = useRef(0);
  const observedRunSnapshotRef = useRef<SessionRunActivitySnapshot | undefined>(
    undefined
  );
  const observedRuntimeRef = useRef(runtime);
  const resumeTokenRef = useRef<MigrateDashboardResumeToken | undefined>(
    undefined
  );
  const applySnapshot = useCallback(
    (snapshot: MigrationTuiSnapshot) => {
      for (const activity of observedRunActivity(
        observedRunSnapshotRef.current,
        snapshot
      )) {
        recordActivity(activity);
      }

      observedRunSnapshotRef.current = snapshot;
      resumeTokenRef.current = snapshot.resumeToken;
      setDurableRows(snapshot.rows);
      setActiveRuns(snapshot.activeRuns);
    },
    [recordActivity]
  );

  const refresh = useCallback(
    async (nextNotice = "Status reloaded") => {
      const requestId = refreshRequestRef.current + 1;
      const nextGeneration = generationRef.current + 1;
      refreshRequestRef.current = requestId;
      generationRef.current = nextGeneration;
      setBusy("Reloading status…");
      setError(null);

      try {
        const stoppedObservation = observationPromiseRef.current;
        controllerRef.current?.abort();
        await stoppedObservation;

        const snapshot = await runtime.refresh();

        if (requestId !== refreshRequestRef.current) {
          return;
        }

        applySnapshot(snapshot);
        clearSourceScanStatuses();
        setNotice(nextNotice);
      } catch (cause) {
        if (requestId === refreshRequestRef.current) {
          setError(errorMessage(cause));
        }
      } finally {
        if (requestId === refreshRequestRef.current) {
          const after = resumeTokenRef.current;
          setBusy("");
          setObservationState(
            after === undefined
              ? { generation: nextGeneration }
              : { after, generation: nextGeneration }
          );
        }
      }
    },
    [
      applySnapshot,
      clearSourceScanStatuses,
      runtime,
      setBusy,
      setError,
      setNotice,
    ]
  );

  useEffect(() => {
    if (observedRuntimeRef.current !== runtime) {
      observedRuntimeRef.current = runtime;
      observedRunSnapshotRef.current = undefined;
    }
  }, [runtime]);

  useEffect(() => {
    const controller = new AbortController();
    const { after, generation } = observationState;
    let receivedSnapshot = false;
    const observation = runtime
      .observeDashboard({
        ...(after === undefined ? {} : { after }),
        onSnapshot: (snapshot) => {
          if (generation !== generationRef.current) {
            return;
          }

          applySnapshot(snapshot);

          if (!receivedSnapshot) {
            setBusy("");
            if (generation === 0) {
              setError(null);
              setNotice(recoveryNotice ?? "Status reloaded");
            }
          }
          receivedSnapshot = true;
        },
        signal: controller.signal,
      })
      .catch((cause: unknown) => {
        if (
          !controller.signal.aborted &&
          generation === generationRef.current
        ) {
          setBusy("");
          setError(`Unable to observe dashboard: ${errorMessage(cause)}`);
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
    runtime,
    setBusy,
    setError,
    setNotice,
  ]);

  return { activeRuns, durableRows, refresh };
};
