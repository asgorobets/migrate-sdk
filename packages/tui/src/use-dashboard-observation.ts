import type {
  MigrateActiveRun,
  MigrateDashboardResumeToken,
  MigrateDashboardRow,
} from "migrate-sdk/protocol";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { MigrationTuiRuntime } from "./runtime.ts";

interface DashboardObservationState {
  readonly after?: MigrateDashboardResumeToken | undefined;
  readonly generation: number;
}

interface UseDashboardObservationOptions {
  readonly clearSourceScanStatuses: () => void;
  readonly initialRows?: readonly MigrateDashboardRow[] | undefined;
  readonly recoveryNotice?: string | undefined;
  readonly runtime: MigrationTuiRuntime;
  readonly setBusy: Dispatch<SetStateAction<string>>;
  readonly setError: Dispatch<SetStateAction<string | null>>;
  readonly setNotice: Dispatch<SetStateAction<string | null>>;
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
  const resumeTokenRef = useRef<MigrateDashboardResumeToken | undefined>(
    undefined
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

        resumeTokenRef.current = snapshot.resumeToken;
        setDurableRows(snapshot.rows);
        setActiveRuns(snapshot.activeRuns);
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
    [clearSourceScanStatuses, runtime, setBusy, setError, setNotice]
  );

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

          resumeTokenRef.current = snapshot.resumeToken;
          setDurableRows(snapshot.rows);
          setActiveRuns(snapshot.activeRuns);

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
  }, [observationState, recoveryNotice, runtime, setBusy, setError, setNotice]);

  return { activeRuns, durableRows, refresh };
};
