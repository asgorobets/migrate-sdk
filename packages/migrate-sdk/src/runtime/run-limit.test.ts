import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { migrationDependencyIsSatisfied } from "../domain/status.ts";
import {
  MigrationDefinition,
  MigrationRuntimeError,
  MigrationStore,
  type ProcessBatchPipelineFor,
  SourceIdentity,
  skipItem,
  toEncodedSourceCursor,
} from "../index.ts";
import { InMemorySource } from "../sources/in-memory/index.ts";
import { InMemoryMigrationStore } from "../stores/in-memory/index.ts";
import { runInlineRegistry } from "../testing/inline-registry-execution.ts";

const makeFixture = (
  options: {
    readonly batch?: boolean;
    readonly batchSize?: number;
    readonly discovery?: "full" | "incremental";
    readonly invalidFirstItem?: boolean;
  } = {}
) => {
  const state = InMemoryMigrationStore.makeState();
  const sourceState = InMemorySource.makeState();
  const calls: string[] = [];
  const batches: string[][] = [];
  const outcomes = new Map<string, "failed" | "skipped">();
  const items = ["a", "b", "c", "d", "e", "f"].map((id) => ({
    identityKey: id,
    item: id === "a" && options.invalidFirstItem ? "" : id,
    version: "v1",
  }));
  const source = InMemorySource.make({
    identity: SourceIdentity.make({
      id: "limit-items@v1",
      schema: SourceIdentity.key("id", Schema.NonEmptyString),
    }),
    sourceSchema: Schema.NonEmptyString,
    items,
    state: sourceState,
    batchSize: options.batchSize ?? 6,
    discovery: options.discovery ?? "full",
  });
  const process = (id: string) =>
    Effect.gen(function* () {
      calls.push(id);
      yield* Effect.yieldNow;
      if (outcomes.get(id) === "failed") {
        return yield* new MigrationRuntimeError({ message: "Rejected item" });
      }
      return outcomes.get(id) === "skipped" ? skipItem("Not ready") : undefined;
    });
  const processBatch: ProcessBatchPipelineFor<
    typeof source,
    MigrationRuntimeError
  > = (batch) => {
    batches.push(batch.map((item) => item.source.identity.encoded));
    return batch.map((item) =>
      item.settle(process(item.source.identity.encoded))
    );
  };
  const base = {
    id: "articles",
    source,
    store: InMemoryMigrationStore.layer(state),
  };
  const definition = options.batch
    ? MigrationDefinition.make({ ...base, processBatch })
    : MigrationDefinition.make({
        ...base,
        process: (item) => process(item.identity.encoded),
      });
  const run = (limit?: number) =>
    runInlineRegistry({
      definitions: [definition],
      definitionIds: [definition.id],
      execution: { process: { concurrency: "unbounded" } },
      ...(limit === undefined ? {} : { limit }),
    });
  return {
    state,
    sourceState,
    calls,
    batches,
    outcomes,
    items,
    definition,
    run,
  };
};

describe("normal source scans with a run limit", () => {
  it.effect(
    "uses the same success and readiness rules as an identity run",
    () =>
      Effect.gen(function* () {
        const targeted = makeFixture();
        const limited = makeFixture();
        const targetedSummary = yield* runInlineRegistry({
          definitions: [targeted.definition],
          definitionIds: [targeted.definition.id],
          sourceIdentities: ["a"],
        });
        const limitedSummary = yield* limited.run(1);
        expect(targeted.calls).toEqual(["a"]);
        expect(limited.calls).toEqual(targeted.calls);
        expect(limitedSummary.definitions).toEqual(targetedSummary.definitions);
        for (const fixture of [targeted, limited]) {
          const ready = yield* Effect.gen(function* () {
            const store = yield* MigrationStore;
            return migrationDependencyIsSatisfied({
              completion: yield* store.getDefinitionCompletion(
                fixture.definition.id
              ),
            });
          }).pipe(Effect.provide(fixture.definition.store));
          expect(ready).toBe(false);
        }
      })
  );

  for (const batch of [false, true]) {
    it.effect(
      `records completion when the final budgeted item fails (${batch ? "batch" : "item"})`,
      () =>
        Effect.gen(function* () {
          const fixture = makeFixture({ batch });
          fixture.outcomes.set("f", "failed");
          const result = yield* fixture.run(6);
          expect(result.status).toBe("failed");
          expect(result.definitions[0]?.counts).toMatchObject({
            migrated: 5,
            failed: 1,
          });
          expect(
            fixture.state.definitionCompletions.get(fixture.definition.id)
          ).toMatchObject({ runId: result.runId });
          expect(fixture.state.sourceCursors.size).toBe(0);
        })
    );

    it.effect(
      `processes the next eligible item on each run (${batch ? "batch" : "item"})`,
      () =>
        Effect.gen(function* () {
          const fixture = makeFixture({ batch });
          for (let index = 0; index < 6; index += 1) {
            const summary = yield* fixture.run(1);
            expect(fixture.calls).toEqual(
              ["a", "b", "c", "d", "e", "f"].slice(0, index + 1)
            );
            expect(summary.definitions[0]).toMatchObject({
              status: "succeeded",
              counts: { migrated: 1, unchanged: index },
            });
            expect(fixture.state.sourceCursors.has(fixture.definition.id)).toBe(
              false
            );
            const lastRun = yield* MigrationStore.pipe(
              Effect.flatMap((store) =>
                store.getLatestRunState(fixture.definition.id)
              ),
              Effect.provide(fixture.definition.store)
            );
            expect(lastRun?.status).toBe("succeeded");
            expect(
              migrationDependencyIsSatisfied({
                completion: fixture.state.definitionCompletions.get(
                  fixture.definition.id
                ),
              })
            ).toBe(index === 5);
          }
          const exhausted = yield* fixture.run(1);
          expect(exhausted.definitions[0]).toMatchObject({
            status: "succeeded",
            counts: { migrated: 0, unchanged: 6 },
          });
          expect(fixture.sourceState.readByIdentityAttempts).toBe(0);
        })
    );

    it.effect(
      `selects mixed states in source order within the budget (${batch ? "batch" : "item"})`,
      () =>
        Effect.gen(function* () {
          const fixture = makeFixture({ batch });
          yield* fixture.run();
          fixture.calls.splice(0);
          fixture.batches.splice(0);
          for (const [key, item] of fixture.state.itemStates) {
            if (item.status !== "migrated") {
              throw new Error("Expected seeded migrated item");
            }
            switch (item.sourceIdentity.encoded) {
              case "b":
                fixture.state.itemStates.delete(key);
                break;
              case "c":
                fixture.state.itemStates.set(key, {
                  ...item,
                  status: "needs-update",
                  reason: "Needs refresh",
                });
                break;
              case "d":
                fixture.state.itemStates.set(key, {
                  ...item,
                  status: "failed",
                  error: {
                    kind: "process",
                    errorTag: "Error",
                    message: "Failed before",
                  },
                });
                break;
              case "e":
                fixture.state.itemStates.set(key, {
                  ...item,
                  status: "skipped",
                  skipReason: "Skipped before",
                });
                break;
              default:
                break;
            }
          }
          const changed = fixture.items.find(
            (item) => item.identityKey === "f"
          );
          if (changed !== undefined) {
            changed.version = "v2";
          }
          for (const id of ["b", "c", "d", "e", "f"]) {
            const summary = yield* fixture.run(1);
            expect(fixture.calls.at(-1)).toBe(id);
            expect(summary.definitions[0]?.counts.migrated).toBe(1);
          }
          expect(fixture.calls).toEqual(["b", "c", "d", "e", "f"]);
          expect(fixture.sourceState.readByIdentityAttempts).toBe(0);
        })
    );

    it.effect(
      `counts failures and skips as attempts (${batch ? "batch" : "item"})`,
      () =>
        Effect.gen(function* () {
          const fixture = makeFixture({ batch });
          fixture.outcomes.set("a", "failed");
          fixture.outcomes.set("b", "skipped");
          const first = yield* fixture.run(2);
          expect(first).toMatchObject({
            status: "failed",
            definitions: [
              {
                status: "failed",
                counts: { migrated: 0, failed: 1, skipped: 1 },
              },
            ],
          });
          expect(fixture.calls).toEqual(["a", "b"]);
          expect(fixture.state.definitionCompletions.size).toBe(0);
          const second = yield* fixture.run(1);
          expect(second.definitions[0]?.counts.failed).toBe(1);
          expect(fixture.calls).toEqual(["a", "b", "a"]);
        })
    );

    it.effect(
      `counts source validation failures without admitting later items (${batch ? "batch" : "item"})`,
      () =>
        Effect.gen(function* () {
          const fixture = makeFixture({ batch, invalidFirstItem: true });
          const summary = yield* fixture.run(1);
          expect(summary.definitions[0]).toMatchObject({
            counts: { failed: 1, migrated: 0 },
          });
          expect(fixture.calls).toEqual([]);
          expect(fixture.state.itemStates.size).toBe(1);
        })
    );
  }

  for (const discovery of ["full", "incremental"] as const) {
    it.effect(
      `retains a partial page and advances only settled pages (${discovery})`,
      () =>
        Effect.gen(function* () {
          const fixture = makeFixture({ batchSize: 2, discovery });
          const first = yield* fixture.run(3);
          expect(first.definitions[0]).toMatchObject({
            status: "succeeded",
          });
          expect(fixture.calls).toEqual(["a", "b", "c"]);
          expect(fixture.state.definitionCompletions.size).toBe(0);
          expect(fixture.state.sourceCursors.get(fixture.definition.id)).toBe(
            toEncodedSourceCursor('{"offset":2}')
          );
          const second = yield* fixture.run(1);
          expect(second.definitions[0]?.counts).toMatchObject({
            migrated: 1,
            unchanged: 1,
          });
          expect(fixture.calls).toEqual(["a", "b", "c", "d"]);
          expect(fixture.state.definitionCompletions.size).toBe(0);
          expect(fixture.state.sourceCursors.get(fixture.definition.id)).toBe(
            toEncodedSourceCursor('{"offset":4}')
          );
          const third = yield* fixture.run(2);
          expect(third.definitions[0]?.status).toBe("succeeded");
          expect(
            fixture.state.definitionCompletions.get(fixture.definition.id)
          ).toMatchObject({
            runId: third.runId,
            sourceCursor: toEncodedSourceCursor('{"offset":4}'),
          });
          expect(fixture.calls).toEqual(["a", "b", "c", "d", "e", "f"]);
          expect(fixture.state.sourceCursors.get(fixture.definition.id)).toBe(
            discovery === "full"
              ? undefined
              : toEncodedSourceCursor('{"offset":4}')
          );
        })
    );
  }

  it.effect(
    "rejects unsupported or invalid limits before touching the source or store",
    () =>
      Effect.gen(function* () {
        const fixture = makeFixture();
        const requests = [
          { limit: 0 },
          { limit: -1 },
          { limit: 1.5 },
          { limit: Number.POSITIVE_INFINITY },
          { limit: Number.NaN },
          { limit: Number.MAX_SAFE_INTEGER + 1 },
          { limit: 1, update: true },
          { limit: 1, rollbackOrphans: true },
          { limit: 1, withDependencies: true },
          { limit: 1, mode: { kind: "failed" as const } },
          { limit: 1, mode: { kind: "skipped" as const } },
          { limit: 1, sourceIdentities: ["a"] },
        ];
        for (const request of requests) {
          const result = yield* runInlineRegistry({
            definitions: [fixture.definition],
            definitionIds: [fixture.definition.id],
            ...request,
          }).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
        }
        const all = yield* runInlineRegistry({
          definitions: [fixture.definition],
          all: true,
          limit: 1,
        }).pipe(Effect.result);
        expect(all._tag).toBe("Failure");
        expect(fixture.sourceState.readAttempts).toBe(0);
        expect(fixture.state.runStates.size).toBe(0);
        expect(fixture.state.itemStates.size).toBe(0);
        expect(fixture.state.definitionLocks.size).toBe(0);
      })
  );
});
