import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  MigrationDefinition,
  MigrationStore,
  makeSourceVersionContractFingerprint,
  SourceIdentity,
  toEncodedSourceCursor,
  toMigrationDefinitionId,
  toMigrationDefinitionLockToken,
  toMigrationRunId,
  toSourceVersion,
} from "migrate-sdk";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { SqlMigrationStore } from "migrate-sdk/stores/sql";
import { runInlineRegistry } from "../../testing/inline-registry-execution.ts";

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

interface SqliteInventoryProjection {
  readonly last_source_inventory_run_id: string | null;
  readonly source_identity: string;
}

interface SqliteTableRow {
  readonly name: string;
}

interface SqliteIndexRow {
  readonly name: string;
}

interface SqliteColumnRow {
  readonly name: string;
}

describe("SqlMigrationStore", () => {
  it.effect(
    "rolls back SQL-backed orphaned state through the public TypeScript runner",
    () =>
      Effect.gen(function* () {
        const store = yield* MigrationStore;
        const sharedStoreLayer = Layer.succeed(MigrationStore, store);
        const rollbackCalls: string[] = [];
        const makeArticlesMigration = (
          items: readonly {
            readonly identityKey: string;
            readonly item: { readonly title: string };
            readonly version: string;
          }[]
        ) =>
          MigrationDefinition.make({
            id: "runner-articles",
            process: () => Effect.void,
            rollback: (state) =>
              Effect.sync(() => {
                rollbackCalls.push(state.sourceIdentity.encoded);
              }),
            source: InMemorySource.make({
              identity: TestSourceIdentity,
              items,
              sourceSchema: Schema.Struct({ title: Schema.String }),
            }),
            store: sharedStoreLayer,
          });
        const currentArticle = {
          identityKey: "article-current",
          item: { title: "Current article" },
          version: "source-version-1",
        };

        yield* runInlineRegistry({
          definitions: [
            makeArticlesMigration([
              currentArticle,
              {
                identityKey: "article-orphan",
                item: { title: "Orphaned article" },
                version: "source-version-1",
              },
            ]),
          ],
        });

        const summary = yield* runInlineRegistry({
          definitions: [makeArticlesMigration([currentArticle])],
          rollbackOrphans: true,
        });

        expect(summary.status).toBe("succeeded");
        expect(summary.definitions[0]?.counts).toEqual({
          failed: 0,
          migrated: 0,
          needsUpdate: 0,
          orphaned: 1,
          rollbackFailed: 0,
          rolledBack: 1,
          skipped: 0,
          unchanged: 1,
        });
        expect(rollbackCalls).toEqual(["article-orphan"]);
        expect(
          yield* store.listItemStates(
            toMigrationDefinitionId("runner-articles")
          )
        ).toEqual([
          expect.objectContaining({
            lastSourceInventoryRunId: summary.runId,
            sourceIdentity: expect.objectContaining({
              encoded: "article-current",
            }),
          }),
        ]);
      }).pipe(Effect.provide(sqlStoreLayer))
  );

  it.effect(
    "observes existing state and pages orphaned state after successful deletion",
    () =>
      Effect.gen(function* () {
        const store = yield* MigrationStore;
        const sql = yield* SqlClient.SqlClient;
        const definitionId = toMigrationDefinitionId("orphan-articles");
        const sourceInventoryRunId = toMigrationRunId("run-inventory-sql");
        const articleAIdentity = SourceIdentity.fromKey(
          TestSourceIdentity,
          "article-a"
        ).encoded;
        const makeItemState = (identity: string) => ({
          definitionId,
          lastRunId: toMigrationRunId("run-migrate-sql"),
          sourceIdentity: SourceIdentity.fromKey(TestSourceIdentity, identity),
          sourceVersion: toSourceVersion("source-version-1"),
          status: "migrated" as const,
          updatedAt: new Date("2026-08-10T12:00:00.000Z"),
        });

        yield* store.upsertItemState(makeItemState("article-c"));
        yield* store.upsertItemState(makeItemState("article-a"));
        yield* store.upsertItemState(makeItemState("article-b"));
        yield* store.observeItemState(
          definitionId,
          SourceIdentity.fromKey(TestSourceIdentity, "article-b").encoded,
          sourceInventoryRunId
        );
        yield* store.observeItemState(
          definitionId,
          SourceIdentity.fromKey(TestSourceIdentity, "article-missing").encoded,
          sourceInventoryRunId
        );
        const projections = yield* sql<SqliteInventoryProjection>`
          SELECT source_identity, last_source_inventory_run_id
          FROM migrate_sdk_item_states
          WHERE definition_id = ${definitionId}
          ORDER BY source_identity
        `;

        const firstPage = yield* store.listOrphanItemStates(
          definitionId,
          sourceInventoryRunId,
          { limit: 1 }
        );

        expect(firstPage.items).toHaveLength(1);
        expect(firstPage.nextAfterIdentity).toBe(
          firstPage.items[0]?.sourceIdentity.encoded
        );

        const firstIdentity = firstPage.items[0]?.sourceIdentity.encoded;

        if (firstIdentity === undefined) {
          return yield* Effect.die(
            "Expected the first orphan page to be nonempty"
          );
        }

        yield* store.deleteItemState(definitionId, firstIdentity);

        const secondPage = yield* store.listOrphanItemStates(
          definitionId,
          sourceInventoryRunId,
          {
            afterIdentity: firstIdentity,
            limit: 1,
          }
        );

        expect(secondPage.items).toHaveLength(1);
        expect(
          new Set([
            firstIdentity,
            ...secondPage.items.map((state) => state.sourceIdentity.encoded),
          ])
        ).toEqual(new Set([articleAIdentity, "article-c"]));
        expect(secondPage.nextAfterIdentity).toBeUndefined();
        expect(projections).toEqual([
          {
            last_source_inventory_run_id: null,
            source_identity: "article-a",
          },
          {
            last_source_inventory_run_id: sourceInventoryRunId,
            source_identity: "article-b",
          },
          {
            last_source_inventory_run_id: null,
            source_identity: "article-c",
          },
        ]);
      }).pipe(Effect.provide(sqlStoreLayer))
  );

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
      const itemStateColumns = yield* sql<SqliteColumnRow>`
        PRAGMA table_info(migrate_sdk_item_states)
      `;
      const orphanIndexes = yield* sql<SqliteIndexRow>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name = 'migrate_sdk_item_states_orphan_idx'
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
        "migrate_sdk_schema_migrations",
      ]);
      expect(itemStateColumns.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          "last_source_inventory_run_id",
          "last_source_inventory_run_key",
        ])
      );
      expect(orphanIndexes).toEqual([
        { name: "migrate_sdk_item_states_orphan_idx" },
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
        expect(states).toEqual(
          definitionIds.map((definitionId) => ({
            ...cancelled,
            definitionId,
            runStatus: "cancelled",
          }))
        );
      }).pipe(Effect.provide(sqlStoreLayer))
  );

  it.effect("persists each definition outcome from a failed shared run", () =>
    Effect.gen(function* () {
      const store = yield* MigrationStore;
      const authorsId = toMigrationDefinitionId("authors");
      const articlesId = toMigrationDefinitionId("articles");
      const definitionIds = [authorsId, articlesId] as const;
      const runId = toMigrationRunId("run-mixed-sql");

      yield* store.beginRun(runId, definitionIds);
      const failedRun = yield* store.failRun(runId, definitionIds, [
        { definitionId: authorsId, status: "succeeded" },
        { definitionId: articlesId, status: "failed" },
      ]);
      const states = yield* Effect.all([
        store.getLatestRunState(authorsId),
        store.getLatestRunState(articlesId),
      ]);

      expect(failedRun.status).toBe("failed");
      expect(states).toEqual([
        expect.objectContaining({
          definitionId: authorsId,
          runStatus: "failed",
          status: "succeeded",
        }),
        expect.objectContaining({
          definitionId: articlesId,
          runStatus: "failed",
          status: "failed",
        }),
      ]);
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
