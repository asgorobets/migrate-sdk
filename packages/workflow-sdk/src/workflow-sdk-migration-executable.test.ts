import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import {
  InMemoryMigrationStore,
  InMemorySourcePlugin,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationExecutable,
  type MigrationExecutionEnvelope,
  MigrationRuntimeError,
  MigrationStore,
  MigrationStoreError,
  SourceIdentity,
  toMigrationDefinitionId,
  toMigrationRunId,
} from "migrate-sdk";
import { Run, start as workflowStart } from "workflow/api";
import {
  WorkflowSdkMigrationExecutable,
  WorkflowSdkMigrationExecutableAttachError,
  WorkflowSdkMigrationExecutableStartError,
  type WorkflowSdkMigrationWorkflow,
  type WorkflowSdkStart,
  type WorkflowSdkStartOptions,
  type WorkflowSdkWorkflowMetadata,
} from "./workflow-sdk-migration-executable.ts";

const ArticleSource = Schema.Struct({
  title: Schema.String,
});

const ArticleSourceIdentity = SourceIdentity.make({
  id: "workflow-sdk-article@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});

const makeArticlesSource = () =>
  InMemorySourcePlugin.make({
    identity: ArticleSourceIdentity,
    sourceSchema: ArticleSource,
    items: [
      {
        identityKey: "article-1",
        version: "source-version-1",
        item: {
          title: "Workflow SDK article",
        },
      },
    ],
  });

const migrationExecutionWorkflow = async () => undefined;
const makeWorkflowRun = (runId: string) => new Run<unknown>(runId);
const assertWorkflowSdkStart = (_start: WorkflowSdkStart) => undefined;
assertWorkflowSdkStart(workflowStart);
type WorkflowSdkStartCall = [
  workflow: WorkflowSdkMigrationWorkflow | WorkflowSdkWorkflowMetadata,
  args: [MigrationExecutionEnvelope],
  options: WorkflowSdkStartOptions | undefined,
];

const makeFixture = (
  input: {
    readonly attachFails?: boolean;
    readonly markStartFailedFails?: boolean;
    readonly releaseFails?: boolean;
  } = {}
) => {
  const storeState = InMemoryMigrationStore.makeState();
  const articlesId = toMigrationDefinitionId("articles");
  const baseStore = InMemoryMigrationStore.layer(storeState);
  const store =
    input.attachFails || input.markStartFailedFails || input.releaseFails
      ? Layer.effect(
          MigrationStore,
          Effect.gen(function* () {
            const base = yield* MigrationStore;
            return {
              ...base,
              ...(input.attachFails
                ? {
                    attachRunExecution: () =>
                      Effect.fail(
                        new MigrationStoreError({
                          message: "Attach failed",
                        })
                      ),
                  }
                : {}),
              ...(input.markStartFailedFails
                ? {
                    markRunStartFailed: () =>
                      Effect.fail(
                        new MigrationStoreError({
                          message: "Mark start-failed failed",
                        })
                      ),
                  }
                : {}),
              ...(input.releaseFails
                ? {
                    releaseDefinitionLock: () =>
                      Effect.fail(
                        new MigrationStoreError({
                          message: "Release failed",
                        })
                      ),
                  }
                : {}),
            };
          })
        ).pipe(Layer.provide(baseStore))
      : baseStore;
  const articles = MigrationDefinition.make({
    id: articlesId,
    source: makeArticlesSource(),
    store,
    process: () => Effect.void,
    rollback: () => undefined,
  });
  const registry = MigrationDefinitionRegistry.make({
    id: "catalog",
    definitions: [articles] as const,
  });

  return {
    articlesId,
    registry,
    storeState,
  };
};

describe("WorkflowSdkMigrationExecutable", () => {
  it.effect(
    "starts executable run plans through Workflow SDK and attaches the workflow run id",
    () =>
      Effect.gen(function* () {
        const { articlesId, registry, storeState } = makeFixture();
        const calls: WorkflowSdkStartCall[] = [];
        const start: WorkflowSdkStart = (...args) => {
          calls.push(args);
          return Promise.resolve(makeWorkflowRun("wrun_1"));
        };
        const plan = yield* registry.executable().planRun({
          definitionIds: ["articles"],
        });

        const result = yield* MigrationExecutable.startRun(plan).pipe(
          Effect.provide(
            WorkflowSdkMigrationExecutable.layer({
              start,
              workflow: migrationExecutionWorkflow,
              startOptions: {
                deploymentId: "latest",
              },
            })
          )
        );

        expect(result).toEqual({
          execution: {
            adapter: "workflow-sdk",
            executionId: "wrun_1",
          },
          kind: "started",
          runId: toMigrationRunId("run-1"),
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.[0]).toBe(migrationExecutionWorkflow);
        expect(calls[0]?.[1]).toEqual([
          expect.objectContaining({
            executionDefinitionIds: [articlesId],
            kind: "run",
            locks: [
              expect.objectContaining({
                definitionId: articlesId,
                ownerRunId: toMigrationRunId("run-1"),
              }),
            ],
            registryId: "catalog",
            runId: toMigrationRunId("run-1"),
            scopeDefinitionIds: [articlesId],
          }),
        ]);
        expect(calls[0]?.[2]).toEqual({
          deploymentId: "latest",
        });
        expect(storeState.latestRunStates.get(articlesId)).toEqual(
          expect.objectContaining({
            execution: {
              adapter: "workflow-sdk",
              executionId: "wrun_1",
            },
            runId: toMigrationRunId("run-1"),
            status: "queued",
          })
        );
        expect(storeState.definitionLocks.get(articlesId)).toEqual(
          expect.objectContaining({
            ownerRunId: toMigrationRunId("run-1"),
          })
        );
      })
  );

  it.effect("starts executable rollback plans through Workflow SDK", () =>
    Effect.gen(function* () {
      const { articlesId, registry, storeState } = makeFixture();
      const calls: WorkflowSdkStartCall[] = [];
      const start: WorkflowSdkStart = (...args) => {
        calls.push(args);
        return Promise.resolve(makeWorkflowRun("wrun_rollback"));
      };
      const plan = yield* registry.executable().planRollback({
        definitionIds: ["articles"],
      });

      const result = yield* MigrationExecutable.startRollback(plan).pipe(
        Effect.provide(
          WorkflowSdkMigrationExecutable.layer({
            start,
            workflow: migrationExecutionWorkflow,
          })
        )
      );

      expect(result).toEqual({
        execution: {
          adapter: "workflow-sdk",
          executionId: "wrun_rollback",
        },
        kind: "started",
        runId: toMigrationRunId("run-1"),
      });
      expect(calls[0]?.[1]).toEqual([
        expect.objectContaining({
          executionDefinitionIds: [articlesId],
          kind: "rollback",
          locks: [
            expect.objectContaining({
              definitionId: articlesId,
              ownerRunId: toMigrationRunId("run-1"),
            }),
          ],
          registryId: "catalog",
          runId: toMigrationRunId("run-1"),
          scopeDefinitionIds: [articlesId],
        }),
      ]);
      expect(storeState.latestRunStates.get(articlesId)).toEqual(
        expect.objectContaining({
          execution: {
            adapter: "workflow-sdk",
            executionId: "wrun_rollback",
          },
          runId: toMigrationRunId("run-1"),
          status: "queued",
        })
      );
    })
  );

  it.effect("locks rollback plans by scope order, not execution order", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const storeLayer = InMemoryMigrationStore.layer(storeState);
      const authorsId = toMigrationDefinitionId("authors");
      const articlesId = toMigrationDefinitionId("articles");
      const authors = MigrationDefinition.make({
        id: authorsId,
        source: makeArticlesSource(),
        store: storeLayer,
        process: () => Effect.void,
        rollback: () => undefined,
      });
      const articles = MigrationDefinition.make({
        id: articlesId,
        dependencies: {
          required: [authorsId],
        },
        source: makeArticlesSource(),
        store: storeLayer,
        process: () => Effect.void,
        rollback: () => undefined,
      });
      const registry = MigrationDefinitionRegistry.make({
        id: "catalog",
        definitions: [authors, articles] as const,
      });
      const calls: WorkflowSdkStartCall[] = [];
      const start: WorkflowSdkStart = (...args) => {
        calls.push(args);
        return Promise.resolve(makeWorkflowRun("wrun_rollback"));
      };
      const plan = yield* registry.executable().planRollback({
        all: true,
      });

      const result = yield* MigrationExecutable.startRollback(plan).pipe(
        Effect.provide(
          WorkflowSdkMigrationExecutable.layer({
            start,
            workflow: migrationExecutionWorkflow,
          })
        )
      );

      expect(result.kind).toBe("started");
      const envelope = calls[0]?.[1][0];
      expect(envelope).toEqual(
        expect.objectContaining({
          executionDefinitionIds: [articlesId, authorsId],
          scopeDefinitionIds: [authorsId, articlesId],
        })
      );
      expect(envelope?.locks?.map((lock) => lock.definitionId)).toEqual([
        authorsId,
        articlesId,
      ]);
      expect(Array.from(storeState.definitionLocks.keys())).toEqual([
        authorsId,
        articlesId,
      ]);
    })
  );

  it.effect(
    "rejects executable run plans whose included definitions use different stores",
    () =>
      Effect.gen(function* () {
        const authorsStoreState = InMemoryMigrationStore.makeState();
        const articlesStoreState = InMemoryMigrationStore.makeState();
        const authorsId = toMigrationDefinitionId("authors");
        const articlesId = toMigrationDefinitionId("articles");
        const authors = MigrationDefinition.make({
          id: authorsId,
          source: makeArticlesSource(),
          store: InMemoryMigrationStore.layer(authorsStoreState),
          process: () => Effect.void,
          rollback: () => undefined,
        });
        const articles = MigrationDefinition.make({
          id: articlesId,
          dependencies: {
            required: [authorsId],
          },
          source: makeArticlesSource(),
          store: InMemoryMigrationStore.layer(articlesStoreState),
          process: () => Effect.void,
          rollback: () => undefined,
        });
        const registry = MigrationDefinitionRegistry.make({
          id: "catalog",
          definitions: [authors, articles] as const,
        });
        const calls: WorkflowSdkStartCall[] = [];
        const start: WorkflowSdkStart = (...args) => {
          calls.push(args);
          return Promise.resolve(makeWorkflowRun("wrun_1"));
        };
        const plan = yield* registry.executable().planRun({
          all: true,
        });

        const error = yield* Effect.flip(
          MigrationExecutable.startRun(plan).pipe(
            Effect.provide(
              WorkflowSdkMigrationExecutable.layer({
                start,
                workflow: migrationExecutionWorkflow,
              })
            )
          )
        );

        expect(error).toBeInstanceOf(MigrationRuntimeError);
        expect(error).toEqual(
          expect.objectContaining({
            message:
              "Workflow SDK executable plan requires one Migration Store for all included Migration Definitions",
          })
        );
        expect(calls).toHaveLength(0);
        expect(authorsStoreState.definitionLocks.size).toBe(0);
        expect(articlesStoreState.definitionLocks.size).toBe(0);
      })
  );

  it.effect(
    "rejects executable rollback plans whose included definitions use different stores",
    () =>
      Effect.gen(function* () {
        const authorsStoreState = InMemoryMigrationStore.makeState();
        const articlesStoreState = InMemoryMigrationStore.makeState();
        const authorsId = toMigrationDefinitionId("authors");
        const articlesId = toMigrationDefinitionId("articles");
        const authors = MigrationDefinition.make({
          id: authorsId,
          source: makeArticlesSource(),
          store: InMemoryMigrationStore.layer(authorsStoreState),
          process: () => Effect.void,
          rollback: () => undefined,
        });
        const articles = MigrationDefinition.make({
          id: articlesId,
          dependencies: {
            required: [authorsId],
          },
          source: makeArticlesSource(),
          store: InMemoryMigrationStore.layer(articlesStoreState),
          process: () => Effect.void,
          rollback: () => undefined,
        });
        const registry = MigrationDefinitionRegistry.make({
          id: "catalog",
          definitions: [authors, articles] as const,
        });
        const calls: WorkflowSdkStartCall[] = [];
        const start: WorkflowSdkStart = (...args) => {
          calls.push(args);
          return Promise.resolve(makeWorkflowRun("wrun_rollback"));
        };
        const plan = yield* registry.executable().planRollback({
          all: true,
        });

        const error = yield* Effect.flip(
          MigrationExecutable.startRollback(plan).pipe(
            Effect.provide(
              WorkflowSdkMigrationExecutable.layer({
                start,
                workflow: migrationExecutionWorkflow,
              })
            )
          )
        );

        expect(error).toBeInstanceOf(MigrationRuntimeError);
        expect(error).toEqual(
          expect.objectContaining({
            message:
              "Workflow SDK executable plan requires one Migration Store for all included Migration Definitions",
          })
        );
        expect(calls).toHaveLength(0);
        expect(authorsStoreState.definitionLocks.size).toBe(0);
        expect(articlesStoreState.definitionLocks.size).toBe(0);
      })
  );

  it.effect(
    "marks the migration run start-failed when Workflow SDK rejects start",
    () =>
      Effect.gen(function* () {
        const { articlesId, registry, storeState } = makeFixture();
        const startCause = new Error("workflow rejected");
        const start: WorkflowSdkStart = () => Promise.reject(startCause);
        const plan = yield* registry.executable().planRun({
          definitionIds: ["articles"],
        });

        const error = yield* Effect.flip(
          MigrationExecutable.startRun(plan).pipe(
            Effect.provide(
              WorkflowSdkMigrationExecutable.layer({
                start,
                workflow: migrationExecutionWorkflow,
              })
            )
          )
        );

        expect(error).toBeInstanceOf(WorkflowSdkMigrationExecutableStartError);
        expect(error).toEqual(
          expect.objectContaining({
            cause: startCause,
            message: "Workflow SDK rejected migration execution start",
            runId: toMigrationRunId("run-1"),
          })
        );
        expect(storeState.latestRunStates.get(articlesId)).toEqual(
          expect.objectContaining({
            runId: toMigrationRunId("run-1"),
            status: "start-failed",
          })
        );
        expect(storeState.definitionLocks.size).toBe(0);
      })
  );

  it.effect(
    "releases workflow locks when marking a rejected workflow start fails",
    () =>
      Effect.gen(function* () {
        const { articlesId, registry, storeState } = makeFixture({
          markStartFailedFails: true,
        });
        const start: WorkflowSdkStart = () =>
          Promise.reject(new Error("workflow rejected"));
        const plan = yield* registry.executable().planRun({
          definitionIds: ["articles"],
        });

        const error = yield* Effect.flip(
          MigrationExecutable.startRun(plan).pipe(
            Effect.provide(
              WorkflowSdkMigrationExecutable.layer({
                start,
                workflow: migrationExecutionWorkflow,
              })
            )
          )
        );

        expect(error).toBeInstanceOf(MigrationStoreError);
        expect(error).toEqual(
          expect.objectContaining({
            message: "Mark start-failed failed",
          })
        );
        expect(storeState.latestRunStates.get(articlesId)).toEqual(
          expect.objectContaining({
            runId: toMigrationRunId("run-1"),
            status: "queued",
          })
        );
        expect(storeState.definitionLocks.size).toBe(0);
      })
  );

  it.effect(
    "returns a typed store error when lock cleanup fails after Workflow SDK rejects start",
    () =>
      Effect.gen(function* () {
        const { articlesId, registry, storeState } = makeFixture({
          releaseFails: true,
        });
        const start: WorkflowSdkStart = () =>
          Promise.reject(new Error("workflow rejected"));
        const plan = yield* registry.executable().planRun({
          definitionIds: ["articles"],
        });

        const error = yield* Effect.flip(
          MigrationExecutable.startRun(plan).pipe(
            Effect.provide(
              WorkflowSdkMigrationExecutable.layer({
                start,
                workflow: migrationExecutionWorkflow,
              })
            )
          )
        );

        expect(error).toBeInstanceOf(MigrationStoreError);
        expect(error).toEqual(
          expect.objectContaining({
            message: "Unable to release Migration Definition Lock set",
          })
        );
        expect(storeState.latestRunStates.get(articlesId)).toEqual(
          expect.objectContaining({
            runId: toMigrationRunId("run-1"),
            status: "start-failed",
          })
        );
        expect(storeState.definitionLocks.get(articlesId)).toEqual(
          expect.objectContaining({
            ownerRunId: toMigrationRunId("run-1"),
          })
        );
      })
  );

  it.effect(
    "keeps workflow locks when attaching the execution handle fails",
    () =>
      Effect.gen(function* () {
        const { articlesId, registry, storeState } = makeFixture({
          attachFails: true,
        });
        const start: WorkflowSdkStart = () =>
          Promise.resolve(makeWorkflowRun("wrun_1"));
        const plan = yield* registry.executable().planRun({
          definitionIds: ["articles"],
        });

        const error = yield* Effect.flip(
          MigrationExecutable.startRun(plan).pipe(
            Effect.provide(
              WorkflowSdkMigrationExecutable.layer({
                start,
                workflow: migrationExecutionWorkflow,
              })
            )
          )
        );

        expect(error).toBeInstanceOf(WorkflowSdkMigrationExecutableAttachError);
        expect(error).toEqual(
          expect.objectContaining({
            execution: {
              adapter: "workflow-sdk",
              executionId: "wrun_1",
            },
            message: "Workflow SDK execution identity attachment failed",
            runId: toMigrationRunId("run-1"),
          })
        );
        expect(storeState.latestRunStates.get(articlesId)).toEqual(
          expect.objectContaining({
            runId: toMigrationRunId("run-1"),
            status: "queued",
          })
        );
        expect(storeState.latestRunStates.get(articlesId)).not.toHaveProperty(
          "execution"
        );
        expect(storeState.definitionLocks.get(articlesId)).toEqual(
          expect.objectContaining({
            ownerRunId: toMigrationRunId("run-1"),
          })
        );
      })
  );

  it.effect(
    "rejects overlapping selected definitions while workflow locks are held",
    () =>
      Effect.gen(function* () {
        const { articlesId, registry, storeState } = makeFixture();
        const start: WorkflowSdkStart = () =>
          Promise.resolve(makeWorkflowRun("wrun_1"));
        const layer = WorkflowSdkMigrationExecutable.layer({
          start,
          workflow: migrationExecutionWorkflow,
        });
        const plan = yield* registry.executable().planRun({
          definitionIds: ["articles"],
        });
        const started = yield* MigrationExecutable.startRun(plan).pipe(
          Effect.provide(layer)
        );
        expect(started.kind).toBe("started");

        const error = yield* Effect.flip(
          MigrationExecutable.startRun(plan).pipe(Effect.provide(layer))
        );

        expect(error).toBeInstanceOf(MigrationStoreError);
        expect(error).toEqual(
          expect.objectContaining({
            message: "Migration definition is already locked",
          })
        );
        expect(storeState.definitionLocks.get(articlesId)).toEqual(
          expect.objectContaining({
            ownerRunId: toMigrationRunId("run-1"),
          })
        );
      })
  );
});
