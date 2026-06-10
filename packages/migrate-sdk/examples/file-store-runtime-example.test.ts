import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { rollbackMigration, runMigration } from "migrate-sdk";
import { makeFileStoreArticlesMigration } from "./file-store-runtime.ts";

describe("file store runtime example", () => {
  it.effect(
    "rolls back persisted migrated item states across fresh definitions",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const storeDirectory = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-sdk-file-store-",
        });
        const first = makeFileStoreArticlesMigration({ storeDirectory });

        const runSummary = yield* runMigration(first.migration);

        expect(runSummary.status).toBe("succeeded");
        expect(runSummary.definitions[0]?.counts).toEqual({
          migrated: 2,
          skipped: 1,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        });

        const rollback = makeFileStoreArticlesMigration({ storeDirectory });
        const rollbackSummary = yield* rollbackMigration(rollback.migration);

        expect(rollbackSummary.status).toBe("succeeded");
        expect(rollbackSummary.definitions[0]?.counts).toEqual({
          rolledBack: 2,
          skipped: 1,
          failed: 0,
        });
        expect(
          rollback.destinationFixture
            .executions()
            .map((execution) => execution.command.kind)
        ).toEqual(["DeleteEntry", "DeleteEntry"]);
        expect(rollback.destinationFixture.entries().size).toBe(0);

        const secondRun = makeFileStoreArticlesMigration({ storeDirectory });
        const secondRunSummary = yield* runMigration(secondRun.migration);

        expect(secondRunSummary.status).toBe("succeeded");
        expect(secondRunSummary.definitions[0]?.counts).toEqual({
          migrated: 2,
          skipped: 1,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        });

        const secondRollback = makeFileStoreArticlesMigration({
          storeDirectory,
        });
        const secondRollbackSummary = yield* rollbackMigration(
          secondRollback.migration
        );

        expect(secondRollbackSummary.status).toBe("succeeded");
        expect(secondRollbackSummary.definitions[0]?.counts).toEqual({
          rolledBack: 2,
          skipped: 1,
          failed: 0,
        });

        const thirdRollback = makeFileStoreArticlesMigration({
          storeDirectory,
        });
        const thirdRollbackSummary = yield* rollbackMigration(
          thirdRollback.migration
        );

        expect(thirdRollbackSummary.status).toBe("succeeded");
        expect(thirdRollbackSummary.definitions[0]?.counts).toEqual({
          rolledBack: 0,
          skipped: 1,
          failed: 0,
        });
      }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );
});
