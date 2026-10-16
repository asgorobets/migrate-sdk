import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schema } from "effect";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationExecutable,
  MigrationStore,
  SourceIdentity,
  toMigrationDefinitionId,
} from "migrate-sdk";
import { makeRegistryMigrateServerRuntime } from "migrate-sdk/server";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { FilesSDKMigrationStore } from "./migration-store/index.ts";
import { makeMemoryFilesSDK } from "./testing/index.ts";

describe("Files store server lifecycle", () => {
  it.live(
    "detaches observation, rediscovers, cooperatively stops, and unlocks",
    () =>
      Effect.gen(function* () {
        const backend = makeMemoryFilesSDK();
        const store = FilesSDKMigrationStore.layerFromClient({
          client: backend.client,
          storageId: "state",
          namespace: "server",
          locking: "advisory",
        });
        const entered = yield* Deferred.make<void>();
        const drain = yield* Deferred.make<void>();
        const definitionId = toMigrationDefinitionId("server-fixture");
        const definition = MigrationDefinition.make({
          id: definitionId,
          store,
          source: InMemorySource.make({
            batchSize: 1,
            identity: SourceIdentity.make({
              id: "server-fixture@v1",
              schema: SourceIdentity.key("key", Schema.String),
            }),
            sourceSchema: Schema.Struct({}),
            items: ["one", "two"].map((key) => ({
              identityKey: key,
              version: "v1",
              item: {},
            })),
          }),
          process: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(drain))
            ),
        });
        const runtime = makeRegistryMigrateServerRuntime({
          registry: MigrationDefinitionRegistry.make({
            definitions: [definition],
          }),
          executable: MigrationExecutable.inlineService,
          terminalPollIntervalMs: 1,
          progressFallbackIntervalMs: 1,
        });
        const operation = yield* runtime.prepare(
          { kind: "definitions", definitionIds: [definitionId] },
          "run"
        );
        const execution = yield* runtime.startExecution(operation);
        const owner = yield* execution.result.pipe(Effect.forkChild);
        yield* Effect.addFinalizer(() => Deferred.succeed(drain, undefined));
        yield* Deferred.await(entered);
        const active = yield* runtime.listActiveRuns;
        const runId = active[0]?.runId;
        if (runId === undefined) {
          throw new Error("run was not discoverable");
        }
        const observer = yield* runtime
          .observeRun(runId)
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(observer);
        expect((yield* runtime.listActiveRuns)[0]?.runId).toBe(runId);
        expect((yield* runtime.stopRun(runId)).kind).toBe("requested");
        expect(
          (yield* MigrationStore.use((s) => s.getRunState(runId)).pipe(
            Effect.provide(store)
          ))?.status
        ).toBe("cancelling");
        yield* Deferred.succeed(drain, undefined);
        expect((yield* Fiber.join(owner)).outcome).toBe("cancelled");
        expect((yield* runtime.observeRun(runId)).outcome).toBe("cancelled");
        expect((yield* runtime.observeRun(runId)).outcome).toBe("cancelled");
        expect(
          yield* MigrationStore.use((s) =>
            s.getDefinitionLock(definitionId)
          ).pipe(Effect.provide(store))
        ).toBeNull();
      })
  );
});
