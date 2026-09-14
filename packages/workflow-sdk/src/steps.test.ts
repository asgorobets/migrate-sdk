import { Effect, Layer, Schema } from "effect";
import {
  type MigrationDefinitionRegistryRunInput,
  MigrationExecutable,
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
  MigrationRollbackExecutor,
  MigrationRunExecutor,
  MigrationRunStepExecutor,
  makeMigrationRunExecutionEnvelope,
  SourceIdentity,
} from "migrate-sdk/core";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import { describe, expect, it } from "vitest";
import { Run } from "workflow/api";
import {
  runMigrationExecutionWorkflow,
  type WorkflowSdkMigrationRunEnvelope,
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
import { WorkflowSdkClient } from "./workflow-sdk-client.ts";
import { WorkflowSdkMigrationExecutable } from "./workflow-sdk-migration-executable.ts";

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
  options: {
    readonly batch?: boolean;
    readonly batchSize?: number;
    readonly withDependency?: boolean;
  } = {}
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
  const sourceItems = ["a", "b", "c"].map((id) => ({
    identityKey: id,
    item: id,
    version: "v1",
  }));
  const source = InMemorySource.make({
    identity,
    sourceSchema: Schema.String,
    batchSize: options.batchSize ?? 1,
    state: sourceState,
    items: sourceItems,
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
    group: "catalog",
    source,
    store,
    tracking,
    rollback: () => Effect.void,
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
  const authorItems = sourceItems.map((item) => ({ ...item }));
  const authors = MigrationDefinition.make({
    id: "authors",
    group: "catalog",
    source: InMemorySource.make({
      identity,
      sourceSchema: Schema.String,
      batchSize: 3,
      items: authorItems,
    }),
    store,
    tracking,
    rollback: () => Effect.void,
    process: (item) => process(`author-${item.identity.encoded}`),
  });
  const registry = MigrationDefinitionRegistry.make({
    id: "workflow-modes",
    definitions: [definition, authors],
  });
  const steps = makeSteps(registry);
  const prepareSelection = (request: MigrationDefinitionRegistryRunInput) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const plan = yield* registry.executable().planRun(request);
        let envelope: WorkflowSdkMigrationRunEnvelope | undefined;
        const executableLayer = WorkflowSdkMigrationExecutable.layer({
          workflow: async () => undefined,
        }).pipe(
          Layer.provide(
            Layer.succeed(WorkflowSdkClient, {
              getRun: (id) => Effect.succeed(new Run<unknown>(id)),
              start: (input) =>
                Effect.sync(() => {
                  if (input.envelope.kind === "run") {
                    envelope = input.envelope;
                  }
                  return new Run<unknown>(`workflow-${input.envelope.runId}`);
                }),
            })
          )
        );
        yield* Effect.flatMap(MigrationExecutable, (executable) =>
          executable.startRun(plan)
        ).pipe(Effect.provide(executableLayer));
        if (envelope === undefined) {
          return yield* Effect.die(
            "Expected the Workflow adapter to dispatch a run"
          );
        }
        return envelope;
      })
    );
  const prepare = (request: RunOptions = {}) =>
    prepareSelection({ definitionIds: ["articles"], ...request });
  const runSelection = async (request: MigrationDefinitionRegistryRunInput) =>
    runMigrationExecutionWorkflow(await prepareSelection(request), steps);
  const run = (request: RunOptions = {}) =>
    runSelection({ definitionIds: ["articles"], ...request });
  const runInlineSelection = (request: MigrationDefinitionRegistryRunInput) =>
    Effect.runPromise(
      Effect.flatMap(registry.executable().planRun(request), (plan) =>
        MigrationRunExecutor.executePlan(plan)
      ).pipe(Effect.provide(MigrationRunExecutor.layer))
    );
  const runInline = (request: RunOptions = {}) =>
    runInlineSelection({ definitionIds: ["articles"], ...request });
  const cancel = (runId: Parameters<typeof state.runStates.get>[0]) =>
    Effect.runPromise(
      Effect.flatMap(MigrationStore, (service) =>
        service.requestRunCancellation(runId, [definition.id])
      ).pipe(Effect.provide(store))
    );
  return {
    authorItems,
    authors,
    calls,
    cancel,
    definition,
    outcomes,
    prepare,
    registry,
    run,
    runInline,
    runInlineSelection,
    runSelection,
    sourceState,
    sourceItems,
    state,
    steps,
    store,
  };
};

describe("Workflow migration run modes", () => {
  it("finalizes a failed limited workflow when registration and execution order differ", async () => {
    const fixture = makeFixture({ withDependency: true });
    const envelope = await fixture.prepare({
      limit: 1,
      withDependencies: true,
    });
    expect(envelope.scopeDefinitionIds).toEqual([
      fixture.definition.id,
      fixture.authors.id,
    ]);
    expect(envelope.executionDefinitionIds).toEqual([
      fixture.authors.id,
      fixture.definition.id,
    ]);
    await expect(
      runMigrationExecutionWorkflow(envelope, {
        ...fixture.steps,
        executeCursorWindow: async (input) => {
          await fixture.steps.executeCursorWindow(input);
          throw new Error("Worker stopped after first limited migration");
        },
      })
    ).rejects.toThrow("Worker stopped after first limited migration");
    expect(fixture.calls).toEqual(["author-a"]);
    expect(fixture.state.runStates.get(envelope.runId)).toMatchObject({
      definitionIds: envelope.scopeDefinitionIds,
      status: "failed",
    });
    expect(fixture.state.definitionCompletions.size).toBe(0);
    expect(fixture.state.definitionLocks.size).toBe(0);
  });

  for (const adapter of ["inline", "workflow"] as const) {
    it(`preserves prior completion during limited group work and respects rollback invalidation (${adapter})`, async () => {
      const fixture = makeFixture({ withDependency: true });
      const run =
        adapter === "inline"
          ? fixture.runInlineSelection
          : fixture.runSelection;
      await run({ all: true });
      const previous = new Map(fixture.state.definitionCompletions);
      for (const items of [fixture.authorItems, fixture.sourceItems]) {
        items.push(
          ...["d", "e"].map((id) => ({
            identityKey: id,
            item: id,
            version: "v1",
          }))
        );
      }
      await run({ group: "catalog", limit: 1 });
      expect(fixture.state.definitionCompletions).toEqual(previous);
      await Effect.runPromise(
        Effect.flatMap(
          fixture.registry.executable().planRollback({
            definitionIds: ["authors"],
            sourceIdentities: ["a"],
            force: true,
          }),
          (plan) => MigrationRollbackExecutor.executePlan(plan)
        ).pipe(Effect.provide(MigrationRollbackExecutor.layer))
      );
      expect(fixture.state.definitionCompletions.has(fixture.authors.id)).toBe(
        false
      );
      const next = await run({ group: "catalog", limit: 1 });
      expect(
        next.definitions.map((definition) => definition.counts.migrated)
      ).toEqual([1, 1]);
      expect(fixture.calls.slice(-2)).toEqual(["author-a", "e"]);
      expect(fixture.state.definitionCompletions.has(fixture.authors.id)).toBe(
        false
      );
      await expect(
        run({ definitionIds: ["articles"], limit: 1 })
      ).rejects.toThrow("no completed source pass");
      expect(fixture.state.definitionLocks.size).toBe(0);
    });

    for (const batch of [false, true]) {
      for (const selection of [
        { definitionIds: ["articles", "authors"] },
        { all: true },
        { group: "catalog" },
        { definitionIds: ["articles"], withDependencies: true },
      ] satisfies MigrationDefinitionRegistryRunInput[]) {
        it(`gives each selected migration its own limit (${adapter}, ${batch ? "batch" : "item"}, ${JSON.stringify(selection)})`, async () => {
          const fixture = makeFixture({
            batch,
            batchSize: 2,
            withDependency: true,
          });
          const run =
            adapter === "inline"
              ? fixture.runInlineSelection
              : fixture.runSelection;
          const request = {
            ...selection,
            limit: 1,
            execution: { process: { concurrency: "unbounded" as const } },
          };
          const first = await run(request);
          expect(fixture.calls).toEqual(["author-a", "a"]);
          expect(
            first.definitions.map((definition) => definition.counts.migrated)
          ).toEqual([1, 1]);
          expect(fixture.state.definitionCompletions.size).toBe(0);
          expect(fixture.state.sourceCursors.size).toBe(0);

          const second = await run(request);
          expect(fixture.calls).toEqual(["author-a", "a", "author-b", "b"]);
          expect(
            second.definitions.map((definition) => definition.counts)
          ).toEqual([
            expect.objectContaining({ migrated: 1, unchanged: 1 }),
            expect.objectContaining({ migrated: 1, unchanged: 1 }),
          ]);
          expect(fixture.state.sourceCursors.get(fixture.definition.id)).toBe(
            toEncodedSourceCursor('{"offset":2}')
          );
          expect(fixture.state.sourceCursors.has(fixture.authors.id)).toBe(
            false
          );

          const third = await run(request);
          expect(fixture.calls).toEqual([
            "author-a",
            "a",
            "author-b",
            "b",
            "author-c",
            "c",
          ]);
          expect(
            third.definitions.map((definition) => definition.counts.migrated)
          ).toEqual([1, 1]);
          for (const definition of [fixture.authors, fixture.definition]) {
            expect(
              fixture.state.definitionCompletions.get(definition.id)?.runId
            ).toBe(third.runId);
          }
          expect(fixture.state.sourceCursors.size).toBe(0);
          expect(fixture.state.definitionLocks.size).toBe(0);
        });
      }

      it(`counts failures and skips without consuming the next migration's budget (${adapter}, ${batch ? "batch" : "item"})`, async () => {
        const fixture = makeFixture({ batch, withDependency: true });
        const run =
          adapter === "inline"
            ? fixture.runInlineSelection
            : fixture.runSelection;
        fixture.outcomes.set("author-a", "failed");
        fixture.outcomes.set("author-b", "skipped");
        const result = await run({ all: true, limit: 2 });
        expect(fixture.calls).toEqual(["author-a", "author-b", "a", "b"]);
        expect(result.status).toBe("failed");
        expect(result.definitions).toMatchObject([
          {
            definitionId: fixture.authors.id,
            status: "failed",
            counts: { failed: 1, skipped: 1, migrated: 0 },
          },
          {
            definitionId: fixture.definition.id,
            status: "succeeded",
            counts: { migrated: 2 },
          },
        ]);
        expect(fixture.state.definitionCompletions.size).toBe(0);
        expect(fixture.state.definitionLocks.size).toBe(0);
      });
    }

    it(`requires completion for an omitted prerequisite after a limited group run (${adapter})`, async () => {
      const fixture = makeFixture({ withDependency: true });
      const run =
        adapter === "inline"
          ? fixture.runInlineSelection
          : fixture.runSelection;
      await run({ group: "catalog", limit: 1 });
      await expect(
        run({ definitionIds: ["articles"], limit: 1 })
      ).rejects.toThrow("no completed source pass");
      expect(fixture.calls).toEqual(["author-a", "a"]);
      expect(fixture.state.definitionCompletions.size).toBe(0);
      expect(fixture.state.definitionLocks.size).toBe(0);
      await run({ definitionIds: ["articles"], limit: 1, force: true });
      expect(fixture.calls).toEqual(["author-a", "a", "b"]);
    });

    for (const authorCount of [0, 1]) {
      it(`continues after a prerequisite exhausts its source and records completion separately (${adapter}, ${authorCount} authors)`, async () => {
        const fixture = makeFixture({ withDependency: true });
        fixture.authorItems.splice(authorCount);
        const run =
          adapter === "inline"
            ? fixture.runInlineSelection
            : fixture.runSelection;
        const first = await run({
          definitionIds: ["articles"],
          withDependencies: true,
          limit: 1,
        });
        expect(fixture.calls).toEqual(
          authorCount === 0 ? ["a"] : ["author-a", "a"]
        );
        expect(
          fixture.state.definitionCompletions.get(fixture.authors.id)?.runId
        ).toBe(first.runId);
        expect(
          fixture.state.definitionCompletions.has(fixture.definition.id)
        ).toBe(false);
        const second = await run({ definitionIds: ["articles"], limit: 1 });
        expect(second.definitions[0]?.counts.migrated).toBe(1);
        expect(fixture.calls.at(-1)).toBe("b");
        expect(fixture.state.definitionLocks.size).toBe(0);
      });
    }
  }

  it.each([
    0, 1,
  ])("restores completion after orphan cleanup only with no earlier failures (%s)", async (earlierFailures) => {
    const fixture = makeFixture();
    await fixture.run();
    fixture.sourceItems.pop();
    const envelope = await fixture.prepare({ rollbackOrphans: true });
    const result = await runMigrationExecutionWorkflow(envelope, {
      ...fixture.steps,
      executeRollbackOrphansPage: (input) =>
        fixture.steps.executeRollbackOrphansPage({
          ...input,
          state: { ...input.state, rollbackFailed: earlierFailures },
        }),
    });
    expect(result.definitions[0]?.counts).toMatchObject({
      rolledBack: 1,
      rollbackFailed: earlierFailures,
    });
    expect(fixture.state.definitionCompletions.has(fixture.definition.id)).toBe(
      earlierFailures === 0
    );
    if (earlierFailures === 0) {
      expect(
        fixture.state.definitionCompletions.get(fixture.definition.id)?.runId
      ).toBe(result.runId);
    }
  });

  it("records a completed source pass despite item failures and preserves it through retries", async () => {
    const fixture = makeFixture();
    fixture.outcomes.set("b", "failed");
    const result = await fixture.run();
    expect(result.status).toBe("failed");
    const completion = fixture.state.definitionCompletions.get(
      fixture.definition.id
    );
    expect(completion?.runId).toBe(result.runId);
    await fixture.run({ mode: { kind: "failed" } });
    expect(
      fixture.state.definitionCompletions.get(fixture.definition.id)
    ).toEqual(completion);
  });

  it("does not establish whole-migration completion from targeted work", async () => {
    const fixture = makeFixture();
    await fixture.run({ sourceIdentities: ["a"] });
    expect(fixture.state.definitionCompletions.size).toBe(0);
    await fixture.run({ mode: { kind: "failed" } });
    expect(fixture.state.definitionCompletions.size).toBe(0);
  });

  it("requires reaching the end of the source after a worker stops mid-pass", async () => {
    const fixture = makeFixture();
    const envelope = await fixture.prepare();
    await expect(
      runMigrationExecutionWorkflow(envelope, {
        ...fixture.steps,
        executeCursorWindow: async (input) => {
          await fixture.steps.executeCursorWindow(input);
          throw new Error("Worker stopped mid-pass");
        },
      })
    ).rejects.toThrow("Worker stopped mid-pass");
    expect(fixture.state.definitionCompletions.size).toBe(0);
    const resumed = await fixture.run();
    expect(
      fixture.state.definitionCompletions.get(fixture.definition.id)?.runId
    ).toBe(resumed.runId);
  });

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
        yield* service.queueRun({
          runId,
          definitionIds: [definition.id],
          operation: "run",
        });
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

  for (const batch of [false, true]) {
    it(`preserves prior completion during failed limited work (${batch ? "batch" : "item"})`, async () => {
      const fixture = makeFixture({ batch });
      await fixture.run();
      const previous = fixture.state.definitionCompletions.get(
        fixture.definition.id
      );
      for (const id of ["d", "e"]) {
        fixture.sourceItems.push({ identityKey: id, item: id, version: "v1" });
      }
      fixture.outcomes.set("d", "failed");
      const result = await fixture.run({ limit: 1 });
      expect(result.status).toBe("failed");
      expect(
        fixture.state.definitionCompletions.get(fixture.definition.id)
      ).toEqual(previous);
    });

    it(`records completion at the source end even when the budgeted work fails (${batch ? "batch" : "item"})`, async () => {
      const fixture = makeFixture({ batch });
      fixture.outcomes.set("c", "failed");
      const result = await fixture.run({ limit: 3 });
      expect(result.status).toBe("failed");
      expect(
        fixture.state.definitionCompletions.get(fixture.definition.id)
      ).toMatchObject({ runId: result.runId });
      expect(fixture.state.sourceCursors.size).toBe(0);
    });

    it(`limits eligible attempts across workflow windows (${batch ? "batch" : "item"})`, async () => {
      const fixture = makeFixture({ batch });
      const first = await fixture.run({ limit: 2 });
      expect(first).toMatchObject({
        status: "succeeded",
        definitions: [
          {
            status: "succeeded",
            counts: { migrated: 2 },
          },
        ],
      });
      expect(fixture.calls).toEqual(["a", "b"]);
      expect(fixture.state.definitionCompletions.size).toBe(0);
      expect(fixture.state.sourceCursors.get(fixture.definition.id)).toBe(
        toEncodedSourceCursor('{"offset":2}')
      );
      expect(fixture.state.definitionLocks.size).toBe(0);
      const second = await fixture.run({ limit: 1 });
      expect(second.definitions[0]).toMatchObject({
        status: "succeeded",
        counts: { migrated: 1 },
      });
      expect(fixture.calls).toEqual(["a", "b", "c"]);
      expect(
        fixture.state.definitionCompletions.get(fixture.definition.id)
      ).toMatchObject({ runId: second.runId });
      expect(fixture.state.sourceCursors.has(fixture.definition.id)).toBe(
        false
      );
    });

    it(`continues a partially processed workflow page (${batch ? "batch" : "item"})`, async () => {
      const fixture = makeFixture({ batch, batchSize: 3 });
      await fixture.run({ limit: 1 });
      const second = await fixture.run({ limit: 1 });
      expect(second.definitions[0]).toMatchObject({
        status: "succeeded",
        counts: { migrated: 1, unchanged: 1 },
      });
      expect(fixture.calls).toEqual(["a", "b"]);
      expect(fixture.state.definitionCompletions.size).toBe(0);
      expect(fixture.state.sourceCursors.has(fixture.definition.id)).toBe(
        false
      );
      expect(fixture.state.definitionLocks.size).toBe(0);
    });
  }

  it("resumes at the saved cursor after failure and revisits earlier failures on the next full scan", async () => {
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
    expect(fixture.calls).toEqual(["b", "c"]);
    expect(summary.definitions[0]?.counts.migrated).toBe(2);
    expect(
      [...fixture.state.itemStates.values()].map((item) => item.status)
    ).toEqual(["failed", "migrated", "migrated"]);
    fixture.calls.splice(0);
    await fixture.run();
    expect(fixture.calls).toEqual(["a"]);
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
    const completion = fixture.state.definitionCompletions.get(
      fixture.definition.id
    );
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
    expect(
      fixture.state.definitionCompletions.get(fixture.definition.id)
    ).toEqual(completion);
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
