import type { MigrationDefinitionId } from "migrate-sdk";
import type {
  MigrateDefinitionIds,
  MigrateDefinitionSourceItemTotal,
  MigrateSourceItemTotal,
} from "migrate-sdk/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MigrationTuiRuntime } from "./runtime.ts";

const sourceItemTotalSelectionDebounceMs = 100;

interface SourceItemTotalSelection {
  readonly definitionIds: readonly MigrationDefinitionId[];
  readonly exactDefinitionIds: readonly MigrationDefinitionId[];
}

interface StableSourceItemTotalSelection extends SourceItemTotalSelection {
  readonly key: string;
}

export interface SourceItemTotalsQueryFailure {
  readonly cause: unknown;
}

export const useSourceItemTotals = ({
  definitionIds,
  exactDefinitionIds,
  runtime,
}: SourceItemTotalSelection & {
  readonly runtime: Pick<MigrationTuiRuntime, "getSourceItemTotals">;
}) => {
  const [totals, setTotals] = useState<
    ReadonlyMap<MigrationDefinitionId, MigrateSourceItemTotal>
  >(() => new Map());
  const [failure, setFailure] = useState<SourceItemTotalsQueryFailure | null>(
    null
  );
  const [cacheGeneration, setCacheGeneration] = useState(0);
  const totalsRef = useRef(totals);
  const requestsRef = useRef(
    new Map<
      MigrationDefinitionId,
      Promise<readonly MigrateDefinitionSourceItemTotal[]>
    >()
  );
  const cacheGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const selectionKey = JSON.stringify([definitionIds, exactDefinitionIds]);
  const selectionRef = useRef<StableSourceItemTotalSelection>({
    definitionIds,
    exactDefinitionIds,
    key: selectionKey,
  });
  if (selectionRef.current.key !== selectionKey) {
    selectionRef.current = {
      definitionIds,
      exactDefinitionIds,
      key: selectionKey,
    };
  }
  const selection = selectionRef.current;

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clear = useCallback(() => {
    const generation = cacheGenerationRef.current + 1;
    cacheGenerationRef.current = generation;
    requestsRef.current.clear();
    totalsRef.current = new Map();
    setCacheGeneration(generation);
    setFailure(null);
    setTotals(totalsRef.current);
  }, []);

  useEffect(() => {
    const exactIds = new Set(selection.exactDefinitionIds);

    setFailure(null);

    if (
      selection.definitionIds.length === 0 ||
      selection.definitionIds.every(
        (definitionId) =>
          exactIds.has(definitionId) || totalsRef.current.has(definitionId)
      )
    ) {
      return;
    }

    let active = true;
    const generation = cacheGeneration;
    const timer = setTimeout(() => {
      const requests = new Set<
        Promise<readonly MigrateDefinitionSourceItemTotal[]>
      >();
      const missingDefinitionIds: MigrationDefinitionId[] = [];

      for (const definitionId of selection.definitionIds) {
        if (exactIds.has(definitionId) || totalsRef.current.has(definitionId)) {
          continue;
        }

        const request = requestsRef.current.get(definitionId);

        if (request === undefined) {
          missingDefinitionIds.push(definitionId);
        } else {
          requests.add(request);
        }
      }

      const [firstMissingDefinitionId, ...remainingMissingDefinitionIds] =
        missingDefinitionIds;

      if (firstMissingDefinitionId !== undefined) {
        const requestedDefinitionIds: MigrateDefinitionIds = [
          firstMissingDefinitionId,
          ...remainingMissingDefinitionIds,
        ];
        const request = runtime.getSourceItemTotals(requestedDefinitionIds);

        for (const definitionId of requestedDefinitionIds) {
          requestsRef.current.set(definitionId, request);
        }
        requests.add(request);

        request
          .then((results) => {
            if (
              !mountedRef.current ||
              generation !== cacheGenerationRef.current
            ) {
              return;
            }

            setTotals((current) => {
              const next = new Map(current);

              for (const result of results) {
                next.set(result.definitionId, result.total);
              }

              totalsRef.current = next;
              return next;
            });
          })
          .finally(() => {
            for (const definitionId of requestedDefinitionIds) {
              if (requestsRef.current.get(definitionId) === request) {
                requestsRef.current.delete(definitionId);
              }
            }
          })
          .catch(() => undefined);
      }

      Promise.all(requests).then(
        () => {
          if (
            active &&
            generation === cacheGenerationRef.current &&
            mountedRef.current
          ) {
            setFailure(null);
          }
        },
        (cause: unknown) => {
          if (
            active &&
            generation === cacheGenerationRef.current &&
            mountedRef.current
          ) {
            setFailure({ cause });
          }
        }
      );
    }, sourceItemTotalSelectionDebounceMs);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [cacheGeneration, runtime, selection]);

  return { clear, failure, totals };
};
