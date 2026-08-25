import { Effect } from "effect";
import { toMigrationDefinitionId, toMigrationRunId } from "../domain/ids.ts";
import { MigrationStore } from "../services/migration-store.ts";

/**
 * Exercises the shared-run history invariant through the public MigrationStore
 * contract. A newer run may supersede one definition while the original run
 * still owns and completes its remaining definitions.
 */
export const runSupersededMigrationRunScenario = Effect.fn(
  "runSupersededMigrationRunScenario"
)(function* (namespace: string) {
  const store = yield* MigrationStore;
  const dependencyId = toMigrationDefinitionId(`${namespace}-dependency`);
  const selectedId = toMigrationDefinitionId(`${namespace}-selected`);
  const definitionIds = [dependencyId, selectedId] as const;
  const originalRunId = toMigrationRunId(`${namespace}-original-run`);
  const newerRunId = toMigrationRunId(`${namespace}-newer-run`);

  yield* store.beginRun(originalRunId, definitionIds);
  yield* store.beginRun(newerRunId, [dependencyId]);
  const completed = yield* store.completeRun(originalRunId, definitionIds, [
    { definitionId: dependencyId, status: "succeeded" },
    { definitionId: selectedId, status: "succeeded" },
  ]);

  return {
    completed,
    dependencyId,
    dependencyLatest: yield* store.getLatestRunState(dependencyId),
    newerRunId,
    originalRunId,
    originalRunState: yield* store.getRunState(originalRunId),
    selectedId,
    selectedLatest: yield* store.getLatestRunState(selectedId),
  };
});
