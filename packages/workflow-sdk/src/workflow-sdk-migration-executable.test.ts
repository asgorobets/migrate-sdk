import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationExecutable,
  type MigrationRunSummary,
  MigrationRuntimeError,
  MigrationStore,
  MigrationStoreError,
  RollbackPreflightError,
  SourceIdentity,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceVersion,
} from "migrate-sdk";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import { Run } from "workflow/api";
import type { WorkflowSdkMigrationExecutionEnvelope } from "./migration-envelope.ts";
import {
  WorkflowSdkClient,
  WorkflowSdkClientError,
  type WorkflowSdkMigrationWorkflow,
  type WorkflowSdkRun,
  type WorkflowSdkStartOptions,
  type WorkflowSdkWorkflowMetadata,
} from "./workflow-sdk-client.ts";
import {
  WorkflowSdkMigrationExecutable,
  WorkflowSdkMigrationExecutableAttachError,
  type WorkflowSdkMigrationExecutableLayerOptions,
  WorkflowSdkMigrationExecutableObservationError,
  WorkflowSdkMigrationExecutableStartError,
} from "./workflow-sdk-migration-executable.ts";

type MigrationExecutionEnvelope = WorkflowSdkMigrationExecutionEnvelope;

const ArticleSource = Schema.Struct({
  title: Schema.String,
});

const ArticleSourceIdentity = SourceIdentity.make({
  id: "workflow-sdk-article@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});

const makeArticlesSource = () =>
  InMemorySource.make({
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
const makeObservedRunSummary = (runId: string): MigrationRunSummary => ({
  definitions: [],
  finishedAt: new Date("2026-08-29T12:00:01.000Z"),
  runId: toMigrationRunId(runId),
  startedAt: new Date("2026-08-29T12:00:00.000Z"),
  status: "succeeded",
});
const makeObservedWorkflowRun = (
  runId: string,
  outcome: "cancelled" | "failed" | "succeeded"
): WorkflowSdkRun =>
  ({
    runId,
    get returnValue() {
      return outcome === "succeeded"
        ? Promise.resolve(makeObservedRunSummary(runId))
        : Promise.reject(new Error(`Workflow ${outcome}`));
    },
    get status() {
      return Promise.resolve(outcome === "succeeded" ? "completed" : outcome);
    },
  }) as unknown as WorkflowSdkRun;
const makeProgressWorkflowRun = (
  runId: string,
  onReadable?: (options: unknown) => void
): WorkflowSdkRun => {
  let complete: () => void = () => undefined;
  const terminal = new Promise<MigrationRunSummary>((resolve) => {
    complete = () => resolve(makeObservedRunSummary("run-progress"));
  });

  return {
    runId,
    getReadable: (options: {
      readonly namespace?: string;
      readonly startIndex?: number;
    }) => {
      onReadable?.(options);

      if (options.startIndex === undefined) {
        return Object.assign(new ReadableStream(), {
          getTailIndex: () => Promise.resolve(5),
        });
      }

      return Object.assign(
        new ReadableStream({
          start(controller) {
            controller.enqueue({
              counts: {
                failed: 0,
                migrated: 1,
                needsUpdate: 0,
                skipped: 0,
                unchanged: 0,
              },
              definitionId: "articles",
              kind: "source-cursor-window-completed",
              runId: "run-progress",
            });
            controller.close();
            setTimeout(complete, 0);
          },
        }),
        {
          getTailIndex: () => Promise.resolve(0),
        }
      );
    },
    get returnValue() {
      return terminal;
    },
    get status() {
      return Promise.resolve("completed");
    },
  } as unknown as WorkflowSdkRun;
};
type WorkflowSdkStartCall = [
  workflow: WorkflowSdkMigrationWorkflow | WorkflowSdkWorkflowMetadata,
  args: [MigrationExecutionEnvelope],
  options: WorkflowSdkStartOptions | undefined,
];
type WorkflowSdkStart = (
  ...args: WorkflowSdkStartCall
) => Promise<WorkflowSdkRun>;

interface WorkflowSdkMigrationExecutableTestLayerOptions
  extends WorkflowSdkMigrationExecutableLayerOptions {
  readonly getRun?: (executionId: string) => WorkflowSdkRun;
  readonly start: WorkflowSdkStart;
}

const makeWorkflowSdkMigrationExecutableTestLayer = ({
  getRun,
  start,
  ...options
}: WorkflowSdkMigrationExecutableTestLayerOptions) =>
  WorkflowSdkMigrationExecutable.layer(options).pipe(
    Layer.provide(
      Layer.succeed(WorkflowSdkClient, {
        getRun: (executionId) =>
          Effect.try({
            try: () => getRun?.(executionId) ?? makeWorkflowRun(executionId),
            catch: (cause) =>
              new WorkflowSdkClientError({
                cause,
                operation: "get-run",
              }),
          }),
        start: (input) =>
          Effect.tryPromise({
            try: () => start(input.workflow, [input.envelope], input.options),
            catch: (cause) =>
              new WorkflowSdkClientError({ cause, operation: "start" }),
          }),
      })
    )
  );

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
    "reattaches to Workflow SDK execution identities for native observation",
    () =>
      Effect.gen(function* () {
        const cases = [
          { expected: { kind: "cancelled" }, outcome: "cancelled" },
          {
            expected: {
              cause: expect.objectContaining({ message: "Workflow failed" }),
              kind: "failed",
            },
            outcome: "failed",
          },
        ] as const;

        for (const testCase of cases) {
          const executionId = `wrun-observe-${testCase.outcome}`;
          const executable = yield* MigrationExecutable.pipe(
            Effect.provide(
              makeWorkflowSdkMigrationExecutableTestLayer({
                getRun: (runId) =>
                  makeObservedWorkflowRun(runId, testCase.outcome),
                start: () => Promise.resolve(makeWorkflowRun("unused")),
                workflow: migrationExecutionWorkflow,
              })
            )
          );
          const waitForExecution = executable.waitForExecution;

          if (waitForExecution === undefined) {
            return yield* Effect.die(
              "Expected Workflow SDK execution observation"
            );
          }

          const result = yield* waitForExecution({
            adapter: "workflow-sdk",
            executionId,
          });

          expect(result).toEqual(testCase.expected);
        }

        const succeededExecutionId = "wrun-observe-succeeded";
        const executable = yield* MigrationExecutable.pipe(
          Effect.provide(
            makeWorkflowSdkMigrationExecutableTestLayer({
              getRun: (runId) => makeObservedWorkflowRun(runId, "succeeded"),
              start: () => Promise.resolve(makeWorkflowRun("unused")),
              workflow: migrationExecutionWorkflow,
            })
          )
        );
        const waitForExecution = executable.waitForExecution;

        if (waitForExecution === undefined) {
          return yield* Effect.die(
            "Expected Workflow SDK execution observation"
          );
        }

        expect(
          yield* waitForExecution({
            adapter: "workflow-sdk",
            executionId: succeededExecutionId,
          })
        ).toEqual({
          kind: "succeeded",
          summary: makeObservedRunSummary(succeededExecutionId),
        });
      })
  );

  it.effect(
    "interrupts observation without leaving Workflow SDK polling active",
    () =>
      Effect.gen(function* () {
        let returnValueReads = 0;
        let statusReads = 0;
        let resolveObservationStarted: () => void = () => undefined;
        const observationStarted = new Promise<void>((resolve) => {
          resolveObservationStarted = resolve;
        });
        const pendingRun = {
          runId: "wrun-interrupted",
          get returnValue() {
            returnValueReads += 1;
            resolveObservationStarted();
            return new Promise<never>(() => undefined);
          },
          get status() {
            statusReads += 1;
            resolveObservationStarted();
            return Promise.resolve("running");
          },
        } as unknown as WorkflowSdkRun;
        const executable = yield* MigrationExecutable.pipe(
          Effect.provide(
            makeWorkflowSdkMigrationExecutableTestLayer({
              getRun: () => pendingRun,
              start: () => Promise.resolve(makeWorkflowRun("unused")),
              workflow: migrationExecutionWorkflow,
            })
          )
        );
        const waitForExecution = executable.waitForExecution;

        if (waitForExecution === undefined) {
          return yield* Effect.die(
            "Expected Workflow SDK execution observation"
          );
        }

        const observationFiber = yield* waitForExecution({
          adapter: "workflow-sdk",
          executionId: pendingRun.runId,
        }).pipe(Effect.forkChild);

        yield* Effect.promise(() => observationStarted);
        expect(statusReads).toBe(1);
        expect(returnValueReads).toBe(0);

        yield* Fiber.interrupt(observationFiber);
        yield* TestClock.adjust("5 seconds");

        expect(statusReads).toBe(1);
        expect(returnValueReads).toBe(0);
      })
  );

  it.effect("streams committed cursor checkpoints during observation", () =>
    Effect.gen(function* () {
      const checkpoints: unknown[] = [];
      const readableOptions: unknown[] = [];
      const executable = yield* MigrationExecutable.pipe(
        Effect.provide(
          makeWorkflowSdkMigrationExecutableTestLayer({
            getRun: (runId) =>
              makeProgressWorkflowRun(runId, (options) =>
                readableOptions.push(options)
              ),
            start: () => Promise.resolve(makeWorkflowRun("unused")),
            workflow: migrationExecutionWorkflow,
          })
        )
      );
      const waitForExecution = executable.waitForExecution;

      if (waitForExecution === undefined) {
        return yield* Effect.die("Expected Workflow SDK execution observation");
      }

      const result = yield* waitForExecution(
        {
          adapter: "workflow-sdk",
          executionId: "wrun-progress",
        },
        {
          onProgressCheckpoint: (checkpoint) =>
            Effect.sync(() => checkpoints.push(checkpoint)),
        }
      );

      expect(result).toEqual({
        kind: "succeeded",
        summary: makeObservedRunSummary("run-progress"),
      });
      expect(readableOptions).toEqual([
        {
          namespace: "migrate-sdk-progress",
        },
        {
          namespace: "migrate-sdk-progress",
          startIndex: 5,
        },
      ]);
      expect(checkpoints).toEqual([
        {
          counts: {
            failed: 0,
            migrated: 1,
            needsUpdate: 0,
            skipped: 0,
            unchanged: 0,
          },
          definitionId: toMigrationDefinitionId("articles"),
          kind: "source-cursor-window-completed",
          runId: toMigrationRunId("run-progress"),
        },
      ]);
    })
  );

  it.effect(
    "reports progress stream failures through provider observation",
    () =>
      Effect.gen(function* () {
        const progressFailure = new Error("Progress stream unavailable");
        const run = {
          runId: "wrun-progress-failure",
          getReadable: () =>
            Object.assign(new ReadableStream(), {
              getTailIndex: () => Promise.reject(progressFailure),
            }),
          get returnValue() {
            return new Promise<never>(() => undefined);
          },
          get status() {
            return Promise.resolve("running");
          },
        } as unknown as WorkflowSdkRun;
        const executable = yield* MigrationExecutable.pipe(
          Effect.provide(
            makeWorkflowSdkMigrationExecutableTestLayer({
              getRun: () => run,
              start: () => Promise.resolve(makeWorkflowRun("unused")),
              workflow: migrationExecutionWorkflow,
            })
          )
        );
        const waitForExecution = executable.waitForExecution;

        if (waitForExecution === undefined) {
          return yield* Effect.die(
            "Expected Workflow SDK execution observation"
          );
        }

        const error = yield* waitForExecution(
          {
            adapter: "workflow-sdk",
            executionId: run.runId,
          },
          { onProgressCheckpoint: () => Effect.void }
        ).pipe(Effect.flip);

        expect(error).toBeInstanceOf(
          WorkflowSdkMigrationExecutableObservationError
        );

        if (
          !(error instanceof WorkflowSdkMigrationExecutableObservationError)
        ) {
          return yield* Effect.die("Expected a progress observation error");
        }

        expect(error.cause).toBe(progressFailure);
      })
  );

  it.effect("reattaches an unobserved provider run by execution id", () =>
    Effect.gen(function* () {
      const { registry } = makeFixture();
      let resolveTerminal: () => void = () => undefined;
      const terminal = new Promise<void>((resolve) => {
        resolveTerminal = resolve;
      });
      const startedRun = {
        runId: "wrun-unobserved",
        get returnValue() {
          return terminal;
        },
        get status() {
          return Promise.resolve("running");
        },
      } as unknown as WorkflowSdkRun;
      let getRunCalls = 0;
      const executable = yield* MigrationExecutable.pipe(
        Effect.provide(
          makeWorkflowSdkMigrationExecutableTestLayer({
            getRun: (runId) => {
              getRunCalls += 1;
              return makeObservedWorkflowRun(runId, "succeeded");
            },
            start: () => Promise.resolve(startedRun),
            workflow: migrationExecutionWorkflow,
          })
        )
      );
      const plan = yield* registry.executable().planRun({
        definitionIds: ["articles"],
      });
      const started = yield* executable.startRun(plan);

      expect(started.kind).toBe("started");
      resolveTerminal();
      yield* Effect.promise(
        () => new Promise<void>((resolve) => queueMicrotask(resolve))
      );

      if (
        started.kind !== "started" ||
        started.execution.executionId === undefined ||
        executable.waitForExecution === undefined
      ) {
        return yield* Effect.die("Expected an observable Workflow SDK run");
      }

      const observed = yield* executable.waitForExecution({
        adapter: started.execution.adapter,
        executionId: started.execution.executionId,
      });

      expect(observed).toEqual({
        kind: "succeeded",
        summary: makeObservedRunSummary(started.execution.executionId),
      });
      expect(getRunCalls).toBe(1);
    })
  );

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
            makeWorkflowSdkMigrationExecutableTestLayer({
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
          makeWorkflowSdkMigrationExecutableTestLayer({
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
          makeWorkflowSdkMigrationExecutableTestLayer({
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
              makeWorkflowSdkMigrationExecutableTestLayer({
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
    "rejects rollback-orphan runs when an unselected dependent has durable state",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const authorsId = toMigrationDefinitionId("authors");
        const articlesId = toMigrationDefinitionId("articles");
        const baseStore = InMemoryMigrationStore.layer(storeState);
        let preflightObservedSelectedLock = false;
        const store = Layer.effect(
          MigrationStore,
          Effect.gen(function* () {
            const base = yield* MigrationStore;

            return {
              ...base,
              listItemStates: (definitionId: typeof articlesId) =>
                Effect.sync(() => {
                  preflightObservedSelectedLock =
                    storeState.definitionLocks.has(authorsId);
                }).pipe(Effect.andThen(base.listItemStates(definitionId))),
            };
          })
        ).pipe(Layer.provide(baseStore));
        const authors = MigrationDefinition.make({
          id: authorsId,
          source: makeArticlesSource(),
          store,
          process: () => Effect.void,
          rollback: () => undefined,
        });
        const articles = MigrationDefinition.make({
          id: articlesId,
          dependencies: { required: [authorsId] },
          source: makeArticlesSource(),
          store,
          process: () => Effect.void,
          rollback: () => undefined,
        });
        const registry = MigrationDefinitionRegistry.make({
          id: "catalog",
          definitions: [authors, articles] as const,
        });
        const previousRunId = toMigrationRunId("run-previous");
        const articleIdentity = SourceIdentity.fromKey(
          ArticleSourceIdentity,
          "article-1"
        );
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey(
            articlesId,
            articleIdentity.encoded
          ),
          {
            definitionId: articlesId,
            lastRunId: previousRunId,
            sourceIdentity: articleIdentity,
            sourceVersion: toSourceVersion("source-version-1"),
            status: "migrated",
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          }
        );
        const calls: WorkflowSdkStartCall[] = [];
        const start: WorkflowSdkStart = (...args) => {
          calls.push(args);
          return Promise.resolve(makeWorkflowRun("wrun_1"));
        };
        const plan = yield* registry.executable().planRun({
          definitionIds: ["authors"],
          rollbackOrphans: true,
        });

        const error = yield* Effect.flip(
          MigrationExecutable.startRun(plan).pipe(
            Effect.provide(
              makeWorkflowSdkMigrationExecutableTestLayer({
                start,
                workflow: migrationExecutionWorkflow,
              })
            )
          )
        );

        expect(error).toBeInstanceOf(RollbackPreflightError);
        expect(error).toEqual(
          expect.objectContaining({
            message:
              "Rollback would leave dependent Migration Definition item state\nauthors cannot be rolled back while dependent articles still has item state.\nRollback articles first, rerun with --with-dependencies, or use --force.",
          })
        );
        expect(calls).toHaveLength(0);
        expect(preflightObservedSelectedLock).toBe(true);
        expect(storeState.definitionLocks.size).toBe(0);
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
              makeWorkflowSdkMigrationExecutableTestLayer({
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
              makeWorkflowSdkMigrationExecutableTestLayer({
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
              makeWorkflowSdkMigrationExecutableTestLayer({
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
              makeWorkflowSdkMigrationExecutableTestLayer({
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
              makeWorkflowSdkMigrationExecutableTestLayer({
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
        const layer = makeWorkflowSdkMigrationExecutableTestLayer({
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
