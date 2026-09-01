import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Queue, Schema } from "effect";
import {
  emptyMigrationProgressCounts,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationExecutable,
  MigrationStore,
  MigrationStoreError,
  Source,
  SourceIdentity,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceVersion,
} from "../index.ts";
import { InMemoryMigrationStore } from "../stores/in-memory/in-memory-migration-store.ts";
import { makeRegistryMigrateServerRuntime } from "./registry-runtime.ts";

describe("registry migration server runtime", () => {
  it("constructs directly from an existing registry", () => {
    const runtime = makeRegistryMigrateServerRuntime({
      executable: MigrationExecutable.inlineService,
      registry: MigrationDefinitionRegistry.make({ definitions: [] }),
    });

    expect(runtime.rows).toEqual([]);
    expect(runtime.groups).toEqual([]);
  });

  it.effect("returns canonical empty registry reports", () =>
    Effect.gen(function* () {
      const runtime = makeRegistryMigrateServerRuntime({
        executable: MigrationExecutable.inlineService,
        registry: MigrationDefinitionRegistry.make({ definitions: [] }),
      });

      expect(
        yield* runtime.getRegistryStatus({
          scanSource: false,
          selection: { kind: "all" },
          withDependencies: false,
        })
      ).toEqual({
        definitions: [],
        includedDefinitionIds: [],
        notices: [],
        requestedDefinitionIds: "all",
        scanSource: false,
        warnings: [],
      });
      expect(
        yield* runtime.getRegistryMessages({
          selection: { kind: "all" },
          withDependencies: false,
        })
      ).toEqual({
        includedDefinitionIds: [],
        messages: [],
        notices: [],
        requestedDefinitionIds: "all",
      });
    })
  );

  it.effect(
    "preserves registry status selection and validation semantics",
    () =>
      Effect.gen(function* () {
        const identity = SourceIdentity.make({
          id: "registry-server-status@v1",
          schema: SourceIdentity.key("id", Schema.NonEmptyString),
        });
        const makeDefinition = (
          id: "authors" | "articles",
          required: readonly ReturnType<typeof toMigrationDefinitionId>[] = []
        ) =>
          MigrationDefinition.make({
            dependencies: { required },
            id: toMigrationDefinitionId(id),
            process: () => Effect.void,
            source: Source.make({
              cursorSchema: Schema.Struct({ offset: Schema.Int }),
              identity,
              lookupStrategy: "direct",
              read: () => Effect.succeed({ items: [] }),
              readByIdentity: () => Effect.succeed(null),
              sourceSchema: Schema.Struct({ title: Schema.String }),
            }),
            store: InMemoryMigrationStore.layer(),
          });
        const authorsId = toMigrationDefinitionId("authors");
        const articlesId = toMigrationDefinitionId("articles");
        const runtime = makeRegistryMigrateServerRuntime({
          executable: MigrationExecutable.inlineService,
          registry: MigrationDefinitionRegistry.make({
            definitions: [
              makeDefinition("authors"),
              makeDefinition("articles", [authorsId]),
            ] as const,
          }),
        });

        expect(
          yield* runtime
            .getRegistryStatus({
              scanSource: false,
              selection: {
                definitionIds: [articlesId],
                kind: "definitions",
              },
              withDependencies: false,
            })
            .pipe(Effect.flip)
        ).toMatchObject({
          _tag: "MigrationDefinitionRegistryMissingExplicitRequiredDependenciesError",
          definitionId: articlesId,
          missingDependencyIds: [authorsId],
        });

        const expanded = yield* runtime.getRegistryStatus({
          scanSource: false,
          selection: { definitionIds: [articlesId], kind: "definitions" },
          withDependencies: true,
        });
        expect(expanded.includedDefinitionIds).toEqual([authorsId, articlesId]);
        expect(
          expanded.definitions.map((status) => status.definitionId)
        ).toEqual([authorsId, articlesId]);

        expect(
          yield* runtime
            .getRegistryStatus({
              concurrency: 2,
              scanSource: false,
              selection: { kind: "all" },
              withDependencies: false,
            })
            .pipe(Effect.flip)
        ).toMatchObject({
          _tag: "MigrationStatusRequestError",
          message:
            "Status concurrency is only valid when source scanning is enabled",
        });
        expect(
          yield* runtime
            .getRegistryStatus({
              concurrency: 0,
              scanSource: true,
              selection: { kind: "all" },
              withDependencies: false,
            })
            .pipe(Effect.flip)
        ).toMatchObject({
          _tag: "MigrationStatusRequestError",
          message: "Status concurrency must be a positive integer",
        });
      })
  );

  it.effect("sorts registry messages globally across definitions", () =>
    Effect.gen(function* () {
      const identity = SourceIdentity.make({
        id: "registry-server-messages@v1",
        schema: SourceIdentity.key("id", Schema.NonEmptyString),
      });
      const state = InMemoryMigrationStore.makeState();
      const store = InMemoryMigrationStore.layer(state);
      const makeDefinition = (id: "authors" | "articles") =>
        MigrationDefinition.make({
          id: toMigrationDefinitionId(id),
          process: () => Effect.void,
          source: Source.make({
            cursorSchema: Schema.Struct({ offset: Schema.Int }),
            identity,
            lookupStrategy: "direct",
            read: () => Effect.succeed({ items: [] }),
            readByIdentity: () => Effect.succeed(null),
            sourceSchema: Schema.Struct({ title: Schema.String }),
          }),
          store,
        });
      const authorsId = toMigrationDefinitionId("authors");
      const articlesId = toMigrationDefinitionId("articles");
      const runId = toMigrationRunId("run-messages");
      const addSkippedItem = (
        definitionId: typeof authorsId,
        sourceIdentity: string,
        message: string,
        updatedAt: Date
      ) => {
        state.itemStates.set(
          InMemoryMigrationStore.itemStateKey(definitionId, sourceIdentity),
          {
            definitionId,
            lastRunId: runId,
            skipReason: message,
            sourceIdentity: SourceIdentity.fromKey(identity, sourceIdentity),
            sourceVersion: toSourceVersion("v1"),
            status: "skipped",
            updatedAt,
          }
        );
      };
      addSkippedItem(
        authorsId,
        "author-1",
        "Older author message",
        new Date("2026-08-29T11:00:00.000Z")
      );
      addSkippedItem(
        articlesId,
        "article-1",
        "Newer article message",
        new Date("2026-08-29T12:00:00.000Z")
      );
      const runtime = makeRegistryMigrateServerRuntime({
        executable: MigrationExecutable.inlineService,
        registry: MigrationDefinitionRegistry.make({
          definitions: [makeDefinition("authors"), makeDefinition("articles")],
        }),
      });

      const report = yield* runtime.getRegistryMessages({
        selection: { kind: "all" },
        withDependencies: false,
      });

      expect(report.messages.map((message) => message.message)).toEqual([
        "Newer article message",
        "Older author message",
      ]);
    })
  );

  it.effect(
    "reports server-owned execution failures independently of durable failed items",
    () => {
      const definitionId = toMigrationDefinitionId("executor-failure");
      const runId = toMigrationRunId("run-executor-failure");
      const failure = new Error("Executor process crashed");
      const storeLayer = InMemoryMigrationStore.layer(
        InMemoryMigrationStore.makeState()
      );
      const identity = SourceIdentity.make({
        id: "registry-server-executor-failure@v1",
        schema: SourceIdentity.key("id", Schema.NonEmptyString),
      });
      const definition = MigrationDefinition.make({
        id: definitionId,
        process: () => Effect.void,
        source: Source.make({
          cursorSchema: Schema.Struct({ offset: Schema.Int }),
          identity,
          lookupStrategy: "direct",
          read: () => Effect.succeed({ items: [] }),
          readByIdentity: () => Effect.succeed(null),
          sourceSchema: Schema.Struct({ title: Schema.String }),
        }),
        store: storeLayer,
      });
      const terminalState = {
        definitionIds: [definitionId],
        finishedAt: new Date("2026-08-29T12:00:01.000Z"),
        runId,
        startedAt: new Date("2026-08-29T12:00:00.000Z"),
        status: "failed" as const,
      };
      const runtime = makeRegistryMigrateServerRuntime({
        executable: {
          ...MigrationExecutable.inlineService,
          startRun: () =>
            Effect.succeed({
              execution: { adapter: "test-inline" },
              handle: {
                cancel: Effect.succeed(terminalState),
                get: Effect.succeed(terminalState),
                runId,
                wait: Effect.succeed({
                  cause: failure,
                  kind: "execution-failed" as const,
                  state: terminalState,
                }),
              },
              kind: "started" as const,
              runId,
            }),
        },
        registry: MigrationDefinitionRegistry.make({
          definitions: [definition],
        }),
      });

      return Effect.gen(function* () {
        const operation = yield* runtime.prepare(
          { definitionIds: [definitionId], kind: "definitions" },
          "run"
        );
        const execution = yield* runtime.startExecution(operation);

        expect(yield* execution.result).toEqual({
          message: failure.message,
          outcome: "failed",
          runId,
        });
      });
    }
  );

  it.effect(
    "requests cancellation through durable run state without execution memory",
    () =>
      Effect.gen(function* () {
        const definitionId = toMigrationDefinitionId("durable-stop");
        const runId = toMigrationRunId("run-durable-stop");
        const storeLayer = InMemoryMigrationStore.layer(
          InMemoryMigrationStore.makeState()
        );
        const identity = SourceIdentity.make({
          id: "registry-server-durable-stop@v1",
          schema: SourceIdentity.key("id", Schema.NonEmptyString),
        });
        const definition = MigrationDefinition.make({
          id: definitionId,
          process: () => Effect.void,
          source: Source.make({
            cursorSchema: Schema.Struct({ offset: Schema.Int }),
            identity,
            lookupStrategy: "direct",
            read: () => Effect.succeed({ items: [] }),
            readByIdentity: () => Effect.succeed(null),
            sourceSchema: Schema.Struct({ title: Schema.String }),
          }),
          store: storeLayer,
        });
        const runtime = makeRegistryMigrateServerRuntime({
          executable: MigrationExecutable.inlineService,
          registry: MigrationDefinitionRegistry.make({
            definitions: [definition],
          }),
        });

        yield* MigrationStore.pipe(
          Effect.flatMap((store) =>
            store.queueRun(runId, [definitionId]).pipe(
              Effect.andThen(store.acquireDefinitionLock(definitionId, runId)),
              Effect.andThen(
                store.attachRunExecution(runId, [definitionId], {
                  adapter: "workflow-sdk",
                  executionId: "workflow-run-1",
                })
              )
            )
          ),
          Effect.provide(storeLayer)
        );

        expect(yield* runtime.listActiveRuns).toEqual([
          expect.objectContaining({ runId, stopSupported: true }),
        ]);
        expect(yield* runtime.stopRun(runId)).toEqual({
          kind: "requested",
          message: `Cancelling run ${runId}; waiting for active work to finish…`,
        });
        const observedStates: unknown[] = [];
        const observation = yield* runtime
          .observeRun(runId, {
            onStateChange: (state) => {
              observedStates.push(state);
            },
          })
          .pipe(Effect.forkChild);

        yield* Effect.yieldNow;
        expect(observedStates).toContainEqual({
          definitionId,
          kind: "cancelling",
          runId,
        });
        yield* Fiber.interrupt(observation);
        expect(
          yield* MigrationStore.pipe(
            Effect.flatMap((store) => store.getRunState(runId)),
            Effect.provide(storeLayer)
          )
        ).toEqual(expect.objectContaining({ runId, status: "cancelling" }));
      })
  );

  it.effect(
    "validates requested definitions before counting a source or acquiring its store",
    () => {
      const definitionId = toMigrationDefinitionId("articles");
      const missingDefinitionId = toMigrationDefinitionId("missing");
      let countAttempts = 0;
      const identity = SourceIdentity.make({
        id: "registry-server-article@v1",
        schema: SourceIdentity.key("id", Schema.NonEmptyString),
      });
      const definition = MigrationDefinition.make({
        id: definitionId,
        process: () => Effect.void,
        source: Source.make({
          countTotal: () =>
            Effect.sync(() => {
              countAttempts += 1;
              return 2;
            }),
          cursorSchema: Schema.Struct({ offset: Schema.Int }),
          identity,
          lookupStrategy: "direct",
          read: () => Effect.succeed({ items: [] }),
          readByIdentity: () => Effect.succeed(null),
          sourceSchema: Schema.Struct({ title: Schema.String }),
        }),
        store: Layer.effect(
          MigrationStore,
          Effect.fail(
            new MigrationStoreError({ message: "Store must not be acquired" })
          )
        ),
      });
      const runtime = makeRegistryMigrateServerRuntime({
        executable: MigrationExecutable.inlineService,
        registry: MigrationDefinitionRegistry.make({
          definitions: [definition],
        }),
      });

      return Effect.gen(function* () {
        expect(
          yield* runtime.getSourceItemTotals([definitionId, definitionId])
        ).toEqual([{ definitionId, total: { count: 2, kind: "known" } }]);
        expect(countAttempts).toBe(1);

        const error = yield* runtime
          .getSourceItemTotals([definitionId, missingDefinitionId])
          .pipe(Effect.flip);

        expect(error).toMatchObject({
          message: `Migration was not found: ${missingDefinitionId}`,
        });
        expect(countAttempts).toBe(1);
      });
    }
  );

  it.effect(
    "uses provider checkpoints as dashboard invalidations without reading a migration store",
    () =>
      Effect.gen(function* () {
        const definitionId = toMigrationDefinitionId("articles");
        const runId = toMigrationRunId("run-1");
        const futureCheckpoint = yield* Deferred.make<void>();
        const invalidations = yield* Queue.unbounded<void>();
        const runtime = makeRegistryMigrateServerRuntime({
          executable: {
            ...MigrationExecutable.inlineService,
            waitForExecution: (_execution, options) =>
              Effect.gen(function* () {
                const checkpoint = {
                  counts: emptyMigrationProgressCounts,
                  definitionId,
                  kind: "source-cursor-window-completed",
                  runId,
                } as const;
                yield* options?.onProgressCheckpoint?.(checkpoint) ??
                  Effect.void;
                yield* Deferred.await(futureCheckpoint);
                yield* options?.onProgressCheckpoint?.(checkpoint) ??
                  Effect.void;
                return yield* Effect.never;
              }),
          },
          registry: MigrationDefinitionRegistry.make({ definitions: [] }),
        });
        const watcher = yield* runtime
          .watchDashboardRun(
            {
              definitionIds: [definitionId],
              execution: {
                adapter: "workflow-sdk",
                executionId: "workflow-run-1",
              },
              observationDefinitionId: definitionId,
              runId,
              startedAt: new Date("2026-08-26T12:00:00.000Z"),
              status: "running",
              stopSupported: false,
            },
            Queue.offer(invalidations, undefined).pipe(Effect.asVoid)
          )
          .pipe(Effect.forkChild);

        yield* Queue.take(invalidations);
        yield* Deferred.succeed(futureCheckpoint, undefined);
        yield* Queue.take(invalidations);
        yield* Fiber.interrupt(watcher);
      })
  );
});
