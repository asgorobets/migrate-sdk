import { MssqlClient } from "@effect/sql-mssql";
import { MysqlClient } from "@effect/sql-mysql2";
import { PgClient } from "@effect/sql-pg";
import { describe, expect, it } from "@effect/vitest";
import { Effect, type Layer, Redacted, Schema } from "effect";
import {
  MigrationStore,
  type MigrationStoreError,
  SourceIdentity,
  toEncodedSourceCursor,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceVersion,
} from "migrate-sdk";
import { SqlMigrationStore } from "migrate-sdk/stores/sql";

const password = Redacted.make("migrate_sdk");
const TestSourceIdentity = SourceIdentity.make({
  id: "sql-smoke@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});

type StoreLayer = Layer.Layer<MigrationStore, MigrationStoreError>;

function makePostgresStore(): StoreLayer {
  return SqlMigrationStore.layerFromClient(
    PgClient.layer({
      database: "migrate_sdk",
      host: "127.0.0.1",
      password,
      port: 55_432,
      username: "migrate_sdk",
    })
  );
}

function makeMysqlStore(): StoreLayer {
  return SqlMigrationStore.layerFromClient(
    MysqlClient.layer({
      database: "migrate_sdk",
      host: "127.0.0.1",
      password,
      port: 53_306,
      username: "migrate_sdk",
    })
  );
}

function makeSqlServerStore(): StoreLayer {
  return SqlMigrationStore.layerFromClient(
    MssqlClient.layer({
      database: "master",
      password: Redacted.make("MigrateSdk!2026"),
      port: 51_433,
      server: "127.0.0.1",
      username: "sa",
    })
  );
}

function registerProviderSuite(
  provider: string,
  makeStoreLayer: () => StoreLayer
) {
  describe(provider, () => {
    it.effect("initializes and round-trips a source cursor", () =>
      Effect.gen(function* () {
        const store = yield* MigrationStore;
        const definitionId = toMigrationDefinitionId("smoke-cursor");
        const cursor = toEncodedSourceCursor('{"offset":20}');

        yield* store.setSourceCursor(definitionId, cursor);
        expect(yield* store.getSourceCursor(definitionId)).toBe(cursor);

        yield* store.deleteSourceCursor(definitionId);
        expect(yield* store.getSourceCursor(definitionId)).toBeNull();
      }).pipe(Effect.provide(makeStoreLayer()))
    );

    it.effect("keeps the run lifecycle consistent across definitions", () =>
      Effect.gen(function* () {
        const store = yield* MigrationStore;
        const definitionIds = [
          toMigrationDefinitionId("smoke-articles"),
          toMigrationDefinitionId("smoke-assets"),
        ];
        const runId = yield* store.createRunId;
        const execution = {
          adapter: "smoke-workflow",
          executionId: `execution-${runId}`,
        };

        const queued = yield* store.queueRun(runId, definitionIds);
        expect(queued).toEqual(
          expect.objectContaining({ runId, status: "queued" })
        );

        const attached = yield* store.attachRunExecution(
          runId,
          definitionIds,
          execution
        );
        expect(attached).toEqual(
          expect.objectContaining({ execution, runId, status: "queued" })
        );

        const running = yield* store.beginRun(runId, definitionIds);
        expect(running).toEqual(
          expect.objectContaining({ execution, runId, status: "running" })
        );

        const completed = yield* store.completeRun(runId, definitionIds);
        expect(completed).toEqual(
          expect.objectContaining({ execution, runId, status: "succeeded" })
        );
        expect(completed.finishedAt).toBeInstanceOf(Date);

        const latest = yield* Effect.forEach(definitionIds, (definitionId) =>
          store.getLatestRunState(definitionId)
        );
        expect(latest).toEqual([completed, completed]);
      }).pipe(Effect.provide(makeStoreLayer()))
    );

    it.effect("upserts item state and summarizes queryable statuses", () =>
      Effect.gen(function* () {
        const store = yield* MigrationStore;
        const definitionId = toMigrationDefinitionId("smoke-item-state");
        const runId = toMigrationRunId("smoke-item-state-run");
        const migrated = {
          definitionId,
          lastRunId: runId,
          sourceIdentity: SourceIdentity.fromKey(
            TestSourceIdentity,
            "article-1"
          ),
          sourceVersion: toSourceVersion("version-1"),
          status: "migrated" as const,
          updatedAt: new Date("2026-08-11T12:00:00.000Z"),
        };
        const updated = {
          ...migrated,
          sourceVersion: toSourceVersion("version-2"),
          updatedAt: new Date("2026-08-11T12:00:01.000Z"),
        };
        const failed = {
          definitionId,
          error: {
            errorTag: "SqlSmokeError",
            kind: "process" as const,
            message: "Unable to migrate article",
          },
          lastRunId: runId,
          sourceIdentity: SourceIdentity.fromKey(
            TestSourceIdentity,
            "article-2"
          ),
          status: "failed" as const,
          updatedAt: new Date("2026-08-11T12:00:02.000Z"),
        };

        yield* store.upsertItemState(migrated);
        yield* store.upsertItemState(updated);
        yield* store.upsertItemState(failed);

        expect(
          yield* store.getItemState(
            definitionId,
            updated.sourceIdentity.encoded
          )
        ).toEqual(updated);
        expect(yield* store.getItemStateSummary(definitionId)).toEqual({
          failed: 1,
          migrated: 1,
          needsUpdate: 0,
          skipped: 0,
        });
      }).pipe(Effect.provide(makeStoreLayer()))
    );

    it.effect("enforces lock ownership across independent clients", () =>
      Effect.gen(function* () {
        const definitionId = toMigrationDefinitionId("smoke-lock");
        const ownerRunId = toMigrationRunId("smoke-lock-owner");
        const contenderRunId = toMigrationRunId("smoke-lock-contender");

        const lock = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;
          return yield* store.acquireDefinitionLock(definitionId, ownerRunId);
        }).pipe(Effect.provide(makeStoreLayer()));

        const duplicateError = yield* Effect.flip(
          Effect.gen(function* () {
            const store = yield* MigrationStore;
            return yield* store.acquireDefinitionLock(
              definitionId,
              contenderRunId
            );
          }).pipe(Effect.provide(makeStoreLayer()))
        );
        expect(duplicateError.message).toBe(
          "Migration definition is already locked"
        );

        const persisted = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;
          return yield* store.getDefinitionLock(definitionId);
        }).pipe(Effect.provide(makeStoreLayer()));
        expect(persisted).toEqual(lock);

        yield* Effect.gen(function* () {
          const store = yield* MigrationStore;
          yield* store.releaseDefinitionLock(lock);
        }).pipe(Effect.provide(makeStoreLayer()));
      })
    );
  });
}

registerProviderSuite("PostgreSQL", makePostgresStore);
registerProviderSuite("MySQL", makeMysqlStore);
registerProviderSuite("SQL Server", makeSqlServerStore);
