import { DateTime, Effect, Schema } from "effect";

import {
  SourceIdentity,
  toEncodedSourceCursor,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceVersion,
} from "../domain/ids.ts";
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

  yield* store.beginRun({
    runId: originalRunId,
    definitionIds,
    operation: "run",
  });
  yield* store.beginRun({
    runId: newerRunId,
    definitionIds: [dependencyId],
    operation: "run",
  });
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

const completionScenarioDate = DateTime.toDateUtc(
  DateTime.makeUnsafe("2026-09-11T00:00:00.000Z")
);

/** Exercises completion, cursor reset, and operation-history independence. */
export const runMigrationCompletionScenario = Effect.fn(
  "runMigrationCompletionScenario"
)(function* (namespace: string) {
  const store = yield* MigrationStore;
  const definitionId = toMigrationDefinitionId(`${namespace}-completion`);
  const runId = toMigrationRunId(`${namespace}-forward`);
  const identity = SourceIdentity.make({
    id: "store-conformance@v1",
    schema: SourceIdentity.key("id", Schema.String),
  });
  const sourceIdentity = SourceIdentity.fromKey(identity, "one");
  const completion = {
    definitionId,
    runId,
    completedAt: completionScenarioDate,
    sourceCursor: toEncodedSourceCursor("high-water-mark"),
  };
  const read = Effect.gen(function* () {
    return {
      completion: yield* store.getDefinitionCompletion(definitionId),
      cursor: yield* store.getSourceCursor(definitionId),
      item: yield* store.getItemState(definitionId, sourceIdentity.encoded),
    };
  });
  const initial = yield* read;
  const item = {
    definitionId,
    lastRunId: runId,
    sourceIdentity,
    updatedAt: completion.completedAt,
    sourceVersion: toSourceVersion("v1"),
    status: "migrated" as const,
  };
  yield* store.upsertItemState(item);
  yield* store.recordSourcePassCompletion(completion);
  yield* store.setSourceCursor(definitionId, completion.sourceCursor);
  const rollbackRunId = toMigrationRunId(`${namespace}-rollback`);
  yield* store.queueRun({
    runId: rollbackRunId,
    definitionIds: [definitionId],
    operation: "rollback",
  });
  yield* store.beginRun({
    runId: rollbackRunId,
    definitionIds: [definitionId],
    operation: "rollback",
  });
  yield* store.completeRun(
    rollbackRunId,
    [definitionId],
    [{ definitionId, status: "succeeded" }]
  );
  yield* store.removeRolledBackItem({
    definitionId,
    sourceIdentity: SourceIdentity.fromKey(identity, "missing").encoded,
  });
  const afterNoop = yield* read;
  yield* store.removeRolledBackItem({
    definitionId,
    sourceIdentity: sourceIdentity.encoded,
  });
  const afterRemoval = yield* read;
  const latest = yield* store.getLatestRunState(definitionId);
  yield* store.recordSourcePassCompletion(completion);
  return {
    initial,
    completion,
    item,
    afterNoop,
    afterRemoval,
    latest,
    restored: yield* store.getDefinitionCompletion(definitionId),
  };
});
