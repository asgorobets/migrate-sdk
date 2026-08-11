import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  MigrationStore,
  makeSourceVersionContractFingerprint,
  SourceIdentity,
  toEncodedSourceCursor,
  toMigrationDefinitionId,
  toMigrationDefinitionLockToken,
  toMigrationRunId,
  toSourceVersion,
} from "migrate-sdk";
import { SqlMigrationStore } from "migrate-sdk/stores/sql";

const TestSourceIdentity = SourceIdentity.make({
  id: "sql-store-test@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});

const sqliteClientLayer = SqliteClient.layer({
  disableWAL: true,
  filename: ":memory:",
});

const sqlStoreLayer = SqlMigrationStore.layer().pipe(
  Layer.provideMerge(sqliteClientLayer)
);

interface SqliteItemStateProjection {
  readonly error_tag: string | null;
  readonly last_run_id: string;
  readonly source_identity: string;
  readonly source_version: string | null;
  readonly status: string;
}

interface SqliteTableRow {
  readonly name: string;
}

describe("SqlMigrationStore", () => {
  it.effect("stores migration progress and reports item-state summaries", () =>
    Effect.gen(function* () {
      const store = yield* MigrationStore;
      const sql = yield* SqlClient.SqlClient;
      const definitionId = toMigrationDefinitionId("articles");
      const runId = toMigrationRunId("run-sql-store");
      const cursor = toEncodedSourceCursor('{"offset":20}');
      const contract = {
        definitionId,
        sourceIdentityContractFingerprint: TestSourceIdentity.fingerprint,
        sourceVersionContractFingerprint:
          makeSourceVersionContractFingerprint("updatedAt"),
      };
      const migrated = {
        definitionId,
        lastRunId: runId,
        sourceIdentity: SourceIdentity.fromKey(TestSourceIdentity, "article-1"),
        sourceVersion: toSourceVersion("version-1"),
        status: "migrated" as const,
        updatedAt: new Date("2026-08-10T12:00:00.000Z"),
      };
      const migratedUpdated = {
        ...migrated,
        sourceVersion: toSourceVersion("version-2"),
        updatedAt: new Date("2026-08-10T12:00:02.000Z"),
      };
      const failed = {
        definitionId,
        error: {
          errorTag: "SqlStoreTestError",
          kind: "process" as const,
          message: "Unable to migrate article",
        },
        lastRunId: runId,
        sourceIdentity: SourceIdentity.fromKey(TestSourceIdentity, "article-2"),
        status: "failed" as const,
        updatedAt: new Date("2026-08-10T12:00:01.000Z"),
      };

      yield* store.setSourceCursor(definitionId, cursor);
      yield* store.upsertMigrationContract(contract);
      yield* store.upsertItemState(migrated);
      yield* store.upsertItemState(failed);
      yield* store.upsertItemState(migratedUpdated);

      expect(yield* store.getSourceCursor(definitionId)).toBe(cursor);
      expect(yield* store.getMigrationContract(definitionId)).toEqual(contract);
      expect(yield* store.listItemStates(definitionId)).toEqual([
        migratedUpdated,
        failed,
      ]);
      expect(yield* store.getItemStateSummary(definitionId)).toEqual({
        failed: 1,
        migrated: 1,
        needsUpdate: 0,
        skipped: 0,
      });

      const tables = yield* sql<SqliteTableRow>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name LIKE 'migrate_sdk_%'
        ORDER BY name
      `;
      const itemStateRows = yield* sql<SqliteItemStateProjection>`
        SELECT
          error_tag,
          last_run_id,
          source_identity,
          source_version,
          status
        FROM migrate_sdk_item_states
        WHERE definition_id = ${definitionId}
        ORDER BY source_identity
      `;

      expect(tables.map(({ name }) => name)).toEqual([
        "migrate_sdk_contracts",
        "migrate_sdk_cursors",
        "migrate_sdk_item_states",
        "migrate_sdk_latest_runs",
        "migrate_sdk_locks",
        "migrate_sdk_run_definitions",
        "migrate_sdk_runs",
      ]);
      expect(itemStateRows).toEqual([
        {
          error_tag: null,
          last_run_id: runId,
          source_identity: migrated.sourceIdentity.encoded,
          source_version: migratedUpdated.sourceVersion,
          status: "migrated",
        },
        {
          error_tag: failed.error.errorTag,
          last_run_id: runId,
          source_identity: failed.sourceIdentity.encoded,
          source_version: null,
          status: "failed",
        },
      ]);

      yield* store.deleteSourceCursor(definitionId);
      yield* store.deleteItemState(
        definitionId,
        migrated.sourceIdentity.encoded
      );

      expect(yield* store.getSourceCursor(definitionId)).toBeNull();
      expect(
        yield* store.getItemState(definitionId, migrated.sourceIdentity.encoded)
      ).toBeNull();
    }).pipe(Effect.provide(sqlStoreLayer))
  );

  it.effect(
    "keeps shared run lifecycle state consistent across definitions",
    () =>
      Effect.gen(function* () {
        const store = yield* MigrationStore;
        const definitionIds = [
          toMigrationDefinitionId("articles"),
          toMigrationDefinitionId("assets"),
        ];
        const runId = toMigrationRunId("run-durable-sql");
        const execution = {
          adapter: "workflow",
          executionId: "workflow-run-1",
        };

        yield* store.queueRun(runId, definitionIds);
        yield* store.attachRunExecution(runId, definitionIds, execution);
        const cancelled = yield* store.markRunCancelled(runId, definitionIds);
        const states = yield* Effect.forEach(definitionIds, (definitionId) =>
          store.getLatestRunState(definitionId)
        );

        expect(cancelled).toEqual(
          expect.objectContaining({ execution, runId, status: "cancelled" })
        );
        expect(cancelled.finishedAt).toBeInstanceOf(Date);
        expect(states).toEqual([cancelled, cancelled]);
      }).pipe(Effect.provide(sqlStoreLayer))
  );

  it.effect("enforces definition-lock ownership", () =>
    Effect.gen(function* () {
      const store = yield* MigrationStore;
      const definitionId = toMigrationDefinitionId("articles");
      const ownerRunId = toMigrationRunId("run-lock-owner");
      const lock = yield* store.acquireDefinitionLock(definitionId, ownerRunId);

      const duplicateError = yield* Effect.flip(
        store.acquireDefinitionLock(
          definitionId,
          toMigrationRunId("run-lock-contender")
        )
      );
      const ownershipError = yield* Effect.flip(
        store.releaseDefinitionLock({
          ...lock,
          token: toMigrationDefinitionLockToken("lock-not-the-owner"),
        })
      );

      expect(duplicateError.message).toBe(
        "Migration definition is already locked"
      );
      expect(ownershipError.message).toBe(
        "Migration definition lock is owned by another runner"
      );
      expect(yield* store.getDefinitionLock(definitionId)).toEqual(lock);

      yield* store.assertDefinitionLocks([lock]);
      expect(yield* store.breakDefinitionLock(definitionId)).toEqual(lock);
      expect(yield* store.getDefinitionLock(definitionId)).toBeNull();
    }).pipe(Effect.provide(sqlStoreLayer))
  );
});
