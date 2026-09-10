import { Effect, Layer, Schema } from "effect";
import {
  type MigrationDefinitionRegistryRunInput,
  MigrationRuntimeError,
  MigrationStore,
  type ProcessBatchPipelineFor,
  skipItem,
  Tracking,
  toEncodedSourceCursor,
} from "migrate-sdk";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationDefinitionRegistryCatalog,
  MigrationRunExecutor,
  MigrationRunStepExecutor,
  makeMigrationRunExecutionEnvelope,
  SourceIdentity,
} from "migrate-sdk/core";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import { describe, expect, it } from "vitest";
import {
  runMigrationExecutionWorkflow,
  type WorkflowSdkMigrationRunSteps,
} from "./migration-execution-workflow.ts";
import {
  beginMigrationRunExecutionEnvelope,
  cancelMigrationRunExecutionEnvelope,
  completeMigrationRunExecutionEnvelope,
  executeMigrationRunCursorWindow,
  executeMigrationRunRollbackOrphansPage,
  failMigrationRunExecutionEnvelope,
} from "./steps.ts";

const makeSteps = (
  registry: MigrationDefinitionRegistry,
  store?: Layer.Layer<MigrationStore>
) => {
  const runtime = Layer.mergeAll(
    MigrationDefinitionRegistryCatalog.layer({ registries: [registry] }),
    MigrationRunStepExecutor.defaultLayer,
    store ?? Layer.empty
  );
  const runEffect = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      MigrationDefinitionRegistryCatalog | MigrationRunStepExecutor
    >
  ) => Effect.runPromise(effect.pipe(Effect.provide(runtime)));
  return {
    begin: (input) => runEffect(beginMigrationRunExecutionEnvelope(input)),
    cancel: (input) => runEffect(cancelMigrationRunExecutionEnvelope(input)),
    complete: (input) =>
      runEffect(completeMigrationRunExecutionEnvelope(input)),
    executeCursorWindow: (input) =>
      runEffect(executeMigrationRunCursorWindow(input)),
    executeRollbackOrphansPage: (input) =>
      runEffect(executeMigrationRunRollbackOrphansPage(input)),
    fail: (input) => runEffect(failMigrationRunExecutionEnvelope(input)),
  } satisfies WorkflowSdkMigrationRunSteps;
};

type RunOptions = Omit<
  MigrationDefinitionRegistryRunInput,
  "definitionIds" | "all" | "group"
>;

const makeFixture = (
  options: { readonly batch?: boolean; readonly withDependency?: boolean } = {}
) => {
  const state = InMemoryMigrationStore.makeState();
  const store = InMemoryMigrationStore.layer(state);
  const sourceState = InMemorySource.makeState();
  const calls: string[] = [];
  const outcomes = new Map<string, "failed" | "skipped">();
  const identity = SourceIdentity.make({
    id: "workflow-modes@v1",
    schema: SourceIdentity.key("id", Schema.NonEmptyString),
  });
  const source = InMemorySource.make({
    identity,
    sourceSchema: Schema.String,
    batchSize: 1,
    state: sourceState,
    items: ["a", "b", "c"].map((id) => ({
      identityKey: id,
      item: id,
      version: "v1",
    })),
  });
  const tracking = Tracking.record({
    id: "workflow-tracking@v1",
    schema: Schema.Struct({ id: Schema.String }),
  });
  const process = Effect.fn(function* (id: string) {
    calls.push(id);
    switch (outcomes.get(id)) {
      case "failed":
        return yield* new MigrationRuntimeError({ message: "Rejected" });
      case "skipped":
        return skipItem("Not ready");
      default:
        return yield* Tracking.setRecord({ id: `destination-${id}` });
    }
  });
  const baseDefinition = {
    id: "articles",
    source,
    store,
    tracking,
    ...(options.withDependency
      ? { dependencies: { required: ["authors"] } }
      : {}),
  };
  const processBatch: ProcessBatchPipelineFor<
    typeof source,
    MigrationRuntimeError,
    typeof tracking
  > = (items) =>
    items.map((item) => item.settle(process(item.source.identity.encoded)));
  const definition = options.batch
    ? MigrationDefinition.make({ ...baseDefinition, processBatch })
    : MigrationDefinition.make({
        ...baseDefinition,
        process: (item) => process(item.identity.encoded),
      });
  const authors = MigrationDefinition.make({
    id: "authors",
    source,
    store,
    process: (item) =>
      Effect.sync(() => {
        calls.push(`author-${item.identity.encoded}`);
      }),
  });
  const registry = MigrationDefinitionRegistry.make({
    id: "workflow-modes",
    definitions: [authors, definition],
  });
  const steps = makeSteps(registry);
  const prepare = (request: RunOptions = {}) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const plan = yield* registry
          .executable()
          .planRun({ definitionIds: ["articles"], ...request });
        const service = yield* MigrationStore;
        const runId = yield* service.createRunId;
        const locks = yield* Effect.forEach(plan.includedDefinitionIds, (id) =>
          service.acquireDefinitionLock(id, runId)
        );
        yield* service.queueRun(runId, plan.includedDefinitionIds);
        const envelope = yield* makeMigrationRunExecutionEnvelope(plan, {
          runId,
          locks,
        });
        return { ...envelope, locks };
      }).pipe(Effect.provide(store))
    );
  const run = async (request: RunOptions = {}) =>
    runMigrationExecutionWorkflow(await prepare(request), steps);
  const runInline = (request: RunOptions = {}) =>
    Effect.runPromise(
      Effect.flatMap(
        registry
          .executable()
          .planRun({ definitionIds: ["articles"], ...request }),
        (plan) => MigrationRunExecutor.executePlan(plan)
      ).pipe(Effect.provide(MigrationRunExecutor.layer))
    );
  const cancel = (runId: Parameters<typeof state.runStates.get>[0]) =>
    Effect.runPromise(
      Effect.flatMap(MigrationStore, (service) =>
        service.requestRunCancellation(runId, [definition.id])
      ).pipe(Effect.provide(store))
    );
  return {
    calls,
    cancel,
    definition,
    outcomes,
    prepare,
    run,
    runInline,
    sourceState,
    state,
    steps,
    store,
  };
};

describe("Workflow migration run modes", () => {
  it("rehydrates composite source identities inside the step", async () => {
    const state = InMemoryMigrationStore.makeState();
    const store = InMemoryMigrationStore.layer(state);
    const identity = SourceIdentity.make({
      id: "localized-article@v1",
      schema: SourceIdentity.tuple([
        SourceIdentity.part("id", Schema.NonEmptyString),
        SourceIdentity.part("locale", Schema.NonEmptyString),
      ]),
    });
    const calls: (readonly [string, string])[] = [];
    const definition = MigrationDefinition.make({
      id: "articles",
      source: InMemorySource.make({
        identity,
        sourceSchema: Schema.String,
        items: [
          { identityKey: ["a", "en"], version: "v1", item: "English" },
          { identityKey: ["a", "fr"], version: "v1", item: "French" },
        ],
      }),
      store,
      process: (item) =>
        Effect.sync(() => {
          calls.push(item.identity.key);
        }),
    });
    const registry = MigrationDefinitionRegistry.make({
      id: "composite",
      definitions: [definition],
    });
    const envelope = await Effect.runPromise(
      Effect.gen(function* () {
        const plan = yield* registry
          .executable()
          .planRun({ definitionIds: ["articles"], sourceIdentities: ["a:fr"] });
        const service = yield* MigrationStore;
        const runId = yield* service.createRunId;
        const locks = [
          yield* service.acquireDefinitionLock(definition.id, runId),
        ];
        yield* service.queueRun(runId, [definition.id]);
        return {
          ...(yield* makeMigrationRunExecutionEnvelope(plan, { runId, locks })),
          locks,
        };
      }).pipe(Effect.provide(store))
    );
    await runMigrationExecutionWorkflow(envelope, makeSteps(registry));
    expect(calls).toEqual([["a", "fr"]]);
    expect(
      [...state.itemStates.values()].map((item) => item.sourceIdentity.encoded)
    ).toEqual([JSON.stringify(["a", "fr"])]);
  });

  it("reprocesses only selected identities without reading or changing the cursor", async () => {
    const fixture = makeFixture();
    await fixture.run();
    fixture.calls.splice(0);
    const cursor = toEncodedSourceCursor(JSON.stringify({ offset: 2 }));
    fixture.state.sourceCursors.set(fixture.definition.id, cursor);
    const reads = fixture.sourceState.readAttempts;
    const summary = await fixture.run({ sourceIdentities: ["a", "c"] });
    expect(fixture.calls).toEqual(["a", "c"]);
    expect(fixture.sourceState.readAttempts).toBe(reads);
    expect(fixture.state.sourceCursors.get(fixture.definition.id)).toBe(cursor);
    expect(summary.definitions[0]?.counts.migrated).toBe(2);
    expect(fixture.state.definitionLocks.size).toBe(0);
  });

  it.each([
    "failed",
    "skipped",
  ] as const)("runs only %s items without scanning", async (kind) => {
    const fixture = makeFixture();
    fixture.outcomes.set("b", kind);
    await fixture.run();
    fixture.outcomes.clear();
    fixture.calls.splice(0);
    const reads = fixture.sourceState.readAttempts;
    const summary = await fixture.run({ mode: { kind } });
    expect(fixture.calls).toEqual(["b"]);
    expect(fixture.sourceState.readAttempts).toBe(reads);
    expect(summary.definitions[0]?.counts.migrated).toBe(1);
    expect(fixture.state.definitionLocks.size).toBe(0);
  });

  it("updates unchanged items across windows without scheduling completed items again", async () => {
    const fixture = makeFixture();
    await fixture.run();
    fixture.calls.splice(0);
    await fixture.run();
    expect(fixture.calls).toEqual([]);
    fixture.state.sourceCursors.set(
      fixture.definition.id,
      toEncodedSourceCursor(JSON.stringify({ offset: 2 }))
    );
    const summary = await fixture.run({ update: true });
    expect(fixture.calls).toEqual(["a", "b", "c"]);
    expect(summary.definitions[0]?.counts).toMatchObject({
      migrated: 3,
      unchanged: 0,
    });
    expect(
      [...fixture.state.itemStates.values()].map((item) => item.status)
    ).toEqual(["migrated", "migrated", "migrated"]);
    expect(fixture.state.sourceCursors.has(fixture.definition.id)).toBe(false);
  });

  it("resumes update backlog before a saved cursor after a worker failure", async () => {
    const fixture = makeFixture();
    await fixture.run();
    fixture.calls.splice(0);
    fixture.outcomes.set("a", "failed");
    const envelope = await fixture.prepare({ update: true });
    await expect(
      runMigrationExecutionWorkflow(envelope, {
        ...fixture.steps,
        executeCursorWindow: async (input) => {
          await fixture.steps.executeCursorWindow(input);
          throw new Error("Worker stopped after committing a window");
        },
      })
    ).rejects.toThrow("Worker stopped");
    expect(fixture.calls).toEqual(["a"]);
    expect(
      [...fixture.state.itemStates.values()].map((item) => item.status)
    ).toEqual(["failed", "needs-update", "needs-update"]);
    expect(fixture.state.definitionLocks.size).toBe(0);
    fixture.calls.splice(0);
    fixture.outcomes.clear();
    const summary = await fixture.run();
    expect(fixture.calls).toEqual(["a", "b", "c"]);
    expect(summary.definitions[0]?.counts.migrated).toBe(3);
  });

  it("finalizes and releases locks when replanning the request fails", async () => {
    const fixture = makeFixture();
    const envelope = await fixture.prepare();
    await expect(
      runMigrationExecutionWorkflow(
        {
          ...envelope,
          request: {
            definitionIds: ["articles"],
            update: true,
            sourceIdentities: ["a"],
          },
        },
        fixture.steps
      )
    ).rejects.toThrow();
    expect(fixture.state.runStates.get(envelope.runId)?.status).toBe("failed");
    expect(fixture.state.definitionLocks.size).toBe(0);
    expect(fixture.calls).toEqual([]);
  });

  it("releases the original locks after a definition is renamed in the worker", async () => {
    const fixture = makeFixture();
    const envelope = await fixture.prepare();
    const registry = MigrationDefinitionRegistry.make({
      id: "workflow-modes",
      definitions: [
        MigrationDefinition.make({
          id: "posts",
          source: fixture.definition.source,
          store: fixture.store,
          process: () => Effect.void,
        }),
      ],
    });
    await expect(
      runMigrationExecutionWorkflow(envelope, makeSteps(registry))
    ).rejects.toThrow("Migration Definition was not found in the registry");
    expect(fixture.state.runStates.get(envelope.runId)?.status).toBe("failed");
    expect(fixture.state.definitionLocks.size).toBe(0);
    expect(fixture.state.itemStates.size).toBe(0);
    expect(fixture.calls).toEqual([]);
  });

  it("uses the supplied store when the worker no longer has the registry", async () => {
    const fixture = makeFixture();
    const envelope = await fixture.prepare();
    const registry = MigrationDefinitionRegistry.make({
      id: "replacement-registry",
      definitions: [],
    });
    await expect(
      runMigrationExecutionWorkflow(
        envelope,
        makeSteps(registry, fixture.store)
      )
    ).rejects.toThrow("Migration Definition Registry was not found");
    expect(fixture.state.runStates.get(envelope.runId)?.status).toBe("failed");
    expect(fixture.state.definitionLocks.size).toBe(0);
    expect(fixture.state.itemStates.size).toBe(0);
  });

  it("requires an explicit store after definition removal in a mixed-store registry", async () => {
    const fixture = makeFixture();
    const otherState = InMemoryMigrationStore.makeState();
    const otherStore = InMemoryMigrationStore.layer(otherState);
    const envelope = await fixture.prepare();
    const registry = MigrationDefinitionRegistry.make({
      id: "workflow-modes",
      definitions: [
        MigrationDefinition.make({
          id: "posts",
          source: fixture.definition.source,
          store: fixture.store,
          process: () => Effect.void,
        }),
        MigrationDefinition.make({
          id: "unrelated",
          source: fixture.definition.source,
          store: otherStore,
          process: () => Effect.void,
        }),
      ],
    });
    await expect(
      runMigrationExecutionWorkflow(envelope, makeSteps(registry))
    ).rejects.toThrow("finalization requires the original MigrationStore");
    expect(fixture.state.runStates.get(envelope.runId)?.status).toBe("queued");
    expect(fixture.state.definitionLocks.size).toBe(1);
    expect(otherState.runStates.size).toBe(0);

    // A supplied store must own the lease, even if it is otherwise available.
    await expect(
      runMigrationExecutionWorkflow(envelope, makeSteps(registry, otherStore))
    ).rejects.toThrow();
    expect(fixture.state.runStates.get(envelope.runId)?.status).toBe("queued");
    expect(fixture.state.definitionLocks.size).toBe(1);
    expect(otherState.runStates.size).toBe(0);
    expect(otherState.definitionLocks.size).toBe(0);

    await expect(
      runMigrationExecutionWorkflow(
        envelope,
        makeSteps(registry, fixture.store)
      )
    ).rejects.toThrow("Migration Definition was not found in the registry");
    expect(fixture.state.runStates.get(envelope.runId)?.status).toBe("failed");
    expect(fixture.state.definitionLocks.size).toBe(0);
    expect(otherState.runStates.size).toBe(0);
  });

  it("finalizes an unknown identity lookup failure without leaving locks", async () => {
    const fixture = makeFixture();
    const envelope = await fixture.prepare({ sourceIdentities: ["missing"] });
    await expect(
      runMigrationExecutionWorkflow(envelope, fixture.steps)
    ).rejects.toThrow("Source identity was not found");
    expect(fixture.state.runStates.get(envelope.runId)?.status).toBe("failed");
    expect(fixture.state.definitionLocks.size).toBe(0);
  });

  it.each([
    false,
    true,
  ])("matches inline mode semantics with processBatch=%s", async (batch) => {
    const workflow = makeFixture({ batch });
    const inline = makeFixture({ batch });
    for (const fixture of [workflow, inline]) {
      fixture.outcomes.set("b", "failed");
      fixture.outcomes.set("c", "skipped");
    }
    const requests: RunOptions[] = [
      {},
      { mode: { kind: "failed" } },
      { mode: { kind: "skipped" } },
      { sourceIdentities: ["a", "c"] },
      { update: true },
    ];
    for (const request of requests) {
      const actual = await workflow.run(request);
      const expected = await inline.runInline(request);
      expect(actual.definitions).toEqual(expected.definitions);
      expect(workflow.calls).toEqual(inline.calls);
      workflow.outcomes.clear();
      inline.outcomes.clear();
    }
  });

  it("runs included dependencies normally before targeted work", async () => {
    const fixture = makeFixture({ withDependency: true });
    const result = await fixture.run({
      sourceIdentities: ["b"],
      withDependencies: true,
    });
    expect(fixture.calls).toEqual(["author-a", "author-b", "author-c", "b"]);
    expect(
      result.definitions.map((definition) => definition.counts.migrated)
    ).toEqual([3, 1]);
    expect(fixture.state.definitionLocks.size).toBe(0);
  });

  it("preserves update tracking and backlog after cancellation between windows", async () => {
    const fixture = makeFixture();
    await fixture.run();
    const envelope = await fixture.prepare({ update: true });
    const result = await runMigrationExecutionWorkflow(envelope, {
      ...fixture.steps,
      executeCursorWindow: async (input) => {
        const window = await fixture.steps.executeCursorWindow(input);
        await fixture.cancel(envelope.runId);
        return window;
      },
    });
    expect(result.status).toBe("cancelled");
    expect([...fixture.state.itemStates.values()]).toMatchObject([
      { status: "migrated", trackingRecord: { id: "destination-a" } },
      { status: "needs-update", trackingRecord: { id: "destination-b" } },
      { status: "needs-update", trackingRecord: { id: "destination-c" } },
    ]);
    expect(fixture.state.definitionLocks.size).toBe(0);
    fixture.calls.splice(0);
    await fixture.run();
    expect(fixture.calls).toEqual(["b", "c"]);
  });
});
