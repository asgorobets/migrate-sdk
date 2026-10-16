import { randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import { Files as FilesSDKClient } from "files-sdk";
import { Files, make } from "files-sdk/effect";
import { r2 } from "files-sdk/r2";
import { s3 } from "files-sdk/s3";
import {
  MigrationStore,
  toMigrationDefinitionId,
  toMigrationRunId,
} from "migrate-sdk";
import {
  runMigrationCompletionScenario,
  runSupersededMigrationRunScenario,
  useConfiguredSource,
} from "migrate-sdk/testing";
import { expect, it } from "vitest";
import { FilesSDKMigrationStore } from "./migration-store/index.ts";
import { FilesSDKSource } from "./source/index.ts";

const provider = process.env.FILES_LIVE_PROVIDER;

it.skipIf(provider !== "s3" && provider !== "r2")(
  "qualifies the selected provider in a disposable prefix",
  async () => {
    const bucket = process.env.FILES_LIVE_BUCKET;
    if (!bucket) {
      throw new Error("FILES_LIVE_BUCKET is required");
    }
    const adapter = provider === "r2" ? r2({ bucket }) : s3({ bucket });
    const client = new FilesSDKClient({
      adapter,
      prefix: `migrate-sdk-tests/${randomUUID()}`,
    });
    const files = make(client);
    const store = FilesSDKMigrationStore.layerFromClient({
      client,
      storageId: "live",
      namespace: "state",
      locking: "advisory",
      pageSize: 1,
    });
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* files.upload("input/a.txt", "a");
          yield* files.upload("input/b.txt", "b");
          const source = FilesSDKSource.objects({
            storageId: "live",
            prefix: "input/",
            pageSize: 1,
          }).provide(Layer.succeed(Files, files));
          yield* useConfiguredSource(source, (runtime) =>
            Effect.gen(function* () {
              const first = yield* runtime.read(null);
              expect(first.items).toHaveLength(1);
              expect(
                (yield* runtime.read(first.nextCursor ?? null)).items
              ).toHaveLength(1);
            })
          );
          const completion = yield* runMigrationCompletionScenario("live");
          expect(completion.afterRemoval.completion).toBeNull();
          const history = yield* runSupersededMigrationRunScenario("live");
          expect(history.dependencyLatest?.runId).toBe(history.newerRunId);
          const service = yield* MigrationStore;
          const lock = yield* service.acquireDefinitionLock(
            toMigrationDefinitionId("live-lock"),
            toMigrationRunId("live")
          );
          yield* service.assertDefinitionLocks([lock]);
          yield* service.releaseDefinitionLock(lock);
        }).pipe(Effect.provide(store))
      );
    } finally {
      const keys: string[] = [];
      for await (const object of client.listAll()) {
        keys.push(object.key);
      }
      for (const key of keys) {
        await client.delete(key);
      }
    }
  },
  120_000
);
