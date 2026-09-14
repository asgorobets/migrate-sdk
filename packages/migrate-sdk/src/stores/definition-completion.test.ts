import { layer as nodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { SqlClient } from "effect/unstable/sql";
import {
  MigrationStore,
  SourceIdentity,
  toEncodedSourceCursor,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceVersion,
} from "migrate-sdk";
import { FileMigrationStore } from "migrate-sdk/stores/file";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import { SqlMigrationStore } from "migrate-sdk/stores/sql";
import { runMigrationCompletionScenario } from "migrate-sdk/testing";

const identity = SourceIdentity.make({
  id: "completion-store@v1",
  schema: SourceIdentity.key("id", Schema.String),
});
const id = toMigrationDefinitionId("authors");
const legacyOperationPattern = /"operation"\s*:\s*"run"\s*,/u;
const completedAt = new Date("2026-09-11T00:00:00.000Z");
const completion = {
  definitionId: id,
  runId: toMigrationRunId("forward-pass"),
  completedAt,
  sourceCursor: toEncodedSourceCursor("high-water-mark"),
};
const item = {
  definitionId: id,
  lastRunId: completion.runId,
  sourceIdentity: SourceIdentity.fromKey(identity, "one"),
  updatedAt: completedAt,
  sourceVersion: toSourceVersion("v1"),
  status: "migrated" as const,
};

const verifyCompletion = Effect.gen(function* () {
  const result = yield* runMigrationCompletionScenario("test");
  expect(result.initial).toEqual({
    completion: null,
    cursor: null,
    item: null,
  });
  expect(result.afterNoop).toEqual({
    completion: result.completion,
    cursor: result.completion.sourceCursor,
    item: result.item,
  });
  expect(result.afterRemoval).toEqual(result.initial);
  expect(result.latest).toMatchObject({
    operation: "rollback",
    status: "succeeded",
  });
  expect(result.restored).toEqual(result.completion);
});

describe("definition completion storage", () => {
  it.effect("invalidates only actual removals in memory", () =>
    verifyCompletion.pipe(Effect.provide(InMemoryMigrationStore.layer()))
  );
  it.effect("invalidates only actual removals in SQL", () =>
    verifyCompletion.pipe(
      Effect.provide(
        SqlMigrationStore.layerFromClient(
          SqliteClient.layer({ filename: ":memory:" })
        )
      )
    )
  );
  it.effect("invalidates only actual removals in files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* verifyCompletion.pipe(
        Effect.provide(FileMigrationStore.layer({ directory }))
      );
    }).pipe(Effect.provide(nodeFileSystemLayer))
  );

  it.effect(
    "rolls back SQL item deletion if completion invalidation fails",
    () =>
      Effect.gen(function* () {
        const store = yield* MigrationStore;
        const sql = yield* SqlClient.SqlClient;
        yield* store.upsertItemState(item);
        yield* store.recordSourcePassCompletion(completion);
        yield* sql`CREATE TRIGGER fail_completion_delete BEFORE DELETE ON migrate_sdk_completions
      BEGIN SELECT RAISE(ABORT, 'injected invalidation failure'); END`;
        yield* store
          .removeRolledBackItem({
            definitionId: id,
            sourceIdentity: item.sourceIdentity.encoded,
          })
          .pipe(Effect.flip);
        expect(yield* store.getDefinitionCompletion(id)).toEqual(completion);
        expect(
          yield* store.getItemState(id, item.sourceIdentity.encoded)
        ).toEqual(item);
      }).pipe(
        Effect.provide(
          SqlMigrationStore.layer().pipe(
            Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))
          )
        )
      )
  );

  for (const kind of ["memory", "file", "sqlite"] as const) {
    it.effect(
      `preserves unknown legacy operation through ${kind} lifecycle writes`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          const state = InMemoryMigrationStore.makeState();
          const layer = (() => {
            if (kind === "memory") {
              return InMemoryMigrationStore.layer(state);
            }
            if (kind === "file") {
              return FileMigrationStore.layer({ directory });
            }
            return SqlMigrationStore.layerFromClient(
              SqliteClient.layer({ filename: `${directory}/state.sqlite` })
            );
          })();
          const runId = toMigrationRunId("legacy-operation");
          yield* Effect.gen(function* () {
            const store = yield* MigrationStore;
            yield* store.queueRun({
              runId,
              definitionIds: [id],
              operation: "run",
            });
          }).pipe(Effect.provide(layer));
          if (kind === "memory") {
            const queued = state.runStates.get(runId);
            if (queued === undefined) {
              throw new Error("Missing seeded run");
            }
            const { operation: _operation, ...legacy } = queued;
            state.runStates.set(runId, legacy);
            state.latestRunStates.set(id, legacy);
          } else if (kind === "file") {
            for (const path of [
              `${directory}/runs/${runId}.json`,
              `${directory}/definitions/${id}/latest-run.json`,
            ]) {
              const json = yield* fs.readFileString(path);
              yield* fs.writeFileString(
                path,
                json.replace(legacyOperationPattern, "")
              );
            }
          } else {
            yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`UPDATE migrate_sdk_runs SET operation = NULL WHERE run_id = ${runId}`;
            }).pipe(
              Effect.provide(
                SqliteClient.layer({ filename: `${directory}/state.sqlite` })
              )
            );
          }
          yield* Effect.gen(function* () {
            const store = yield* MigrationStore;
            expect(
              (yield* store.getRunState(runId))?.operation
            ).toBeUndefined();
            const begun = yield* store.beginRun({
              runId,
              definitionIds: [id],
              operation: "rollback",
            });
            expect(begun.operation).toBeUndefined();
            yield* store.completeRun(
              runId,
              [id],
              [{ definitionId: id, status: "succeeded" }]
            );
            expect(
              (yield* store.getRunState(runId))?.operation
            ).toBeUndefined();
            expect(
              (yield* store.getLatestRunState(id))?.operation
            ).toBeUndefined();
          }).pipe(Effect.provide(layer));
        }).pipe(Effect.provide(nodeFileSystemLayer))
    );
  }

  for (const kind of ["file", "sqlite"] as const) {
    it.effect(
      `persists completion independently of history across ${kind} store reopen`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          const reopen = () =>
            kind === "file"
              ? FileMigrationStore.layer({ directory })
              : SqlMigrationStore.layerFromClient(
                  SqliteClient.layer({ filename: `${directory}/state.sqlite` })
                );
          yield* Effect.gen(function* () {
            const store = yield* MigrationStore;
            yield* store.upsertItemState(item);
            yield* store.recordSourcePassCompletion(completion);
          }).pipe(Effect.provide(reopen()));
          yield* Effect.gen(function* () {
            const store = yield* MigrationStore;
            expect(yield* store.getDefinitionCompletion(id)).toEqual(
              completion
            );
            yield* store.removeRolledBackItem({
              definitionId: id,
              sourceIdentity: item.sourceIdentity.encoded,
            });
          }).pipe(Effect.provide(reopen()));
          yield* Effect.gen(function* () {
            const store = yield* MigrationStore;
            expect(yield* store.getDefinitionCompletion(id)).toBeNull();
          }).pipe(Effect.provide(reopen()));
        }).pipe(Effect.provide(nodeFileSystemLayer))
    );
  }
});
