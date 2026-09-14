import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Schema } from "effect";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationExecution,
  MigrationRuntimeError,
  MigrationStore,
  migrationDependencyIsSatisfied,
  SourceIdentity,
} from "migrate-sdk";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import {
  rollbackInlineDefinition,
  runInlineDefinition,
  runInlineRegistry,
} from "../testing/inline-registry-execution.ts";

import { getMigrationStatuses } from "./get-migration-statuses.ts";

const identity = SourceIdentity.make({
  id: "completion-test@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});
const payload = Schema.Struct({ name: Schema.String });

const fixture = (
  keys: readonly string[] = ["one", "two"],
  discovery: "full" | "incremental" = "full"
) => {
  const state = InMemoryMigrationStore.makeState();
  const store = InMemoryMigrationStore.layer(state);
  const failures = new Set<string>();
  const rollbackFailures = new Set<string>();
  const items = keys.map((key) => ({
    identityKey: key,
    item: { name: key },
    version: "v1",
  }));
  const authors = MigrationDefinition.make({
    id: "authors",
    source: InMemorySource.make({
      identity,
      sourceSchema: payload,
      discovery,
      batchSize: 1,
      items,
    }),
    store,
    process: (item) =>
      failures.has(item.identity.encoded)
        ? Effect.fail(
            new MigrationRuntimeError({ message: "Item could not migrate" })
          )
        : Effect.void,
    rollback: (item) =>
      rollbackFailures.has(item.sourceIdentity.encoded)
        ? Effect.fail(
            new MigrationRuntimeError({ message: "Item could not roll back" })
          )
        : Effect.void,
  });
  const books = MigrationDefinition.make({
    id: "books",
    dependencies: { required: [authors.id] },
    source: InMemorySource.make({ identity, sourceSchema: payload, items: [] }),
    store,
    process: () => Effect.void,
  });
  const runBooks = () =>
    runInlineRegistry({
      definitions: [authors, books],
      definitionIds: [books.id],
    });
  return {
    items,
    authors,
    books,
    state,
    store,
    failures,
    rollbackFailures,
    runBooks,
  };
};

describe("migration completion", () => {
  for (const discovery of ["full", "incremental"] as const) {
    it.effect(
      `unlocks dependents only when a limited pass reaches the source end (${discovery})`,
      () =>
        Effect.gen(function* () {
          const f = fixture(["one", "two"], discovery);
          const runLimited = () =>
            runInlineRegistry({
              definitions: [f.authors],
              definitionIds: [f.authors.id],
              limit: 1,
            });
          const first = yield* runLimited();
          expect(first.status).toBe("succeeded");
          expect(f.state.definitionCompletions.size).toBe(0);
          expect((yield* f.runBooks().pipe(Effect.flip)).message).toContain(
            "no completed source pass"
          );
          f.failures.add("two");
          const last = yield* runLimited();
          expect(last.status).toBe("failed");
          expect(f.state.definitionCompletions.get(f.authors.id)?.runId).toBe(
            last.runId
          );
          expect((yield* f.runBooks()).status).toBe("succeeded");
        })
    );

    it.effect(
      `preserves earlier completion through successful and failed limited work (${discovery})`,
      () =>
        Effect.gen(function* () {
          const f = fixture(["one", "two"], discovery);
          yield* runInlineDefinition(f.authors);
          const previous = f.state.definitionCompletions.get(f.authors.id);
          for (const key of ["three", "four", "five"]) {
            f.items.push({
              identityKey: key,
              item: { name: key },
              version: "v1",
            });
          }
          for (const failed of [false, true]) {
            f.failures.add("four");
            const result = yield* runInlineRegistry({
              definitions: [f.authors],
              definitionIds: [f.authors.id],
              limit: 1,
            });
            expect(result.status).toBe(failed ? "failed" : "succeeded");
            expect(f.state.definitionCompletions.get(f.authors.id)).toEqual(
              previous
            );
            expect((yield* f.runBooks()).status).toBe("succeeded");
          }
        })
    );

    it.effect(
      `requires source exhaustion to restore completion after rollback and limited work (${discovery})`,
      () =>
        Effect.gen(function* () {
          const f = fixture(["one", "two"], discovery);
          yield* runInlineDefinition(f.authors);
          yield* rollbackInlineDefinition(f.authors, {
            sourceIdentities: ["one"],
          });
          expect(f.state.definitionCompletions.size).toBe(0);
          const first = yield* runInlineRegistry({
            definitions: [f.authors],
            definitionIds: [f.authors.id],
            limit: 1,
          });
          expect(first.status).toBe("succeeded");
          expect(f.state.definitionCompletions.size).toBe(0);
          expect((yield* f.runBooks().pipe(Effect.flip)).message).toContain(
            "no completed source pass"
          );
          const last = yield* runInlineRegistry({
            definitions: [f.authors],
            definitionIds: [f.authors.id],
            limit: 1,
          });
          expect(last.definitions[0]?.counts.migrated).toBe(0);
          expect(f.state.definitionCompletions.get(f.authors.id)?.runId).toBe(
            last.runId
          );
          expect((yield* f.runBooks()).status).toBe("succeeded");
        })
    );
  }

  it.effect("records completion for an empty source with a limit", () =>
    Effect.gen(function* () {
      const f = fixture([]);
      const result = yield* runInlineRegistry({
        definitions: [f.authors],
        definitionIds: [f.authors.id],
        limit: 1,
      });
      expect(result.definitions[0]?.counts.migrated).toBe(0);
      expect(f.state.definitionCompletions.get(f.authors.id)?.runId).toBe(
        result.runId
      );
      expect((yield* f.runBooks()).status).toBe("succeeded");
    })
  );

  for (const scenario of ["missing item", "failed items"] as const) {
    it.effect(
      `preserves the incremental cursor after rollback of ${scenario}`,
      () =>
        Effect.gen(function* () {
          const f = fixture(["one", "two"], "incremental");
          yield* runInlineDefinition(f.authors);
          const cursor = f.state.sourceCursors.get(f.authors.id);
          const completion = f.state.definitionCompletions.get(f.authors.id);
          expect(cursor).toBeDefined();
          expect(completion).toBeDefined();

          f.rollbackFailures.add("one");
          f.rollbackFailures.add("two");
          const result = yield* rollbackInlineDefinition(
            f.authors,
            scenario === "missing item" ? { sourceIdentities: ["missing"] } : {}
          );

          expect(result.definitions[0]?.counts).toMatchObject({
            rolledBack: 0,
            failed: scenario === "failed items" ? 2 : 0,
            skipped: scenario === "missing item" ? 1 : 0,
          });
          expect(f.state.itemStates.size).toBe(2);
          expect(f.state.sourceCursors.get(f.authors.id)).toEqual(cursor);
          expect(f.state.definitionCompletions.get(f.authors.id)).toEqual(
            completion
          );
        })
    );
  }

  it.effect(
    "restarts incremental discovery after rollback cancellation removes an item",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const state = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(state);
        const authors = MigrationDefinition.make({
          id: "authors",
          store,
          source: InMemorySource.make({
            identity,
            sourceSchema: payload,
            discovery: "incremental",
            batchSize: 1,
            items: ["one", "two", "three"].map((key) => ({
              identityKey: key,
              item: { name: key },
              version: "v1",
            })),
          }),
          process: () => Effect.void,
          rollback: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.asVoid
            ),
          execution: { rollback: { concurrency: 1 } },
        });
        const execution = MigrationExecution.make({
          registry: MigrationDefinitionRegistry.make({
            definitions: [authors],
          }),
        });
        const initial = yield* execution.run({ definitionIds: [authors.id] });
        if (initial.kind !== "started" || initial.handle === undefined) {
          throw new Error("Expected run start");
        }
        yield* initial.handle.wait;
        expect(state.itemStates.size).toBe(3);
        expect(state.sourceCursors.has(authors.id)).toBe(true);
        const rollback = yield* execution.rollback({
          definitionIds: [authors.id],
        });
        if (rollback.kind !== "started" || rollback.handle === undefined) {
          throw new Error("Expected rollback start");
        }
        yield* Deferred.await(started);
        yield* rollback.handle.cancel;
        yield* Deferred.succeed(release, undefined);
        yield* rollback.handle.wait;
        expect(state.itemStates.size).toBe(2);
        expect(state.sourceCursors.has(authors.id)).toBe(false);
        expect(state.definitionCompletions.has(authors.id)).toBe(false);
        const rerun = yield* execution.run({ definitionIds: [authors.id] });
        if (rerun.kind !== "started" || rerun.handle === undefined) {
          throw new Error("Expected rerun start");
        }
        yield* rerun.handle.wait;
        expect(state.itemStates.size).toBe(3);
        expect(state.definitionCompletions.has(authors.id)).toBe(true);
      })
  );

  it.effect(
    "unlocks dependents after a full pass with item failures and needs-update entries",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        f.failures.add("two");
        const result = yield* runInlineDefinition(f.authors);
        expect(result.status).toBe("failed");
        expect(f.state.definitionCompletions.get(f.authors.id)?.runId).toBe(
          result.runId
        );
        expect((yield* f.runBooks()).status).toBe("succeeded");
        const first = f.state.itemStates.get(
          InMemoryMigrationStore.itemStateKey(f.authors.id, "one")
        );
        if (first === undefined) {
          throw new Error("Expected migrated item");
        }
        f.state.itemStates.set(
          InMemoryMigrationStore.itemStateKey(f.authors.id, "one"),
          { ...first, status: "needs-update", reason: "Changed source" }
        );
        expect((yield* f.runBooks()).status).toBe("succeeded");
        const report = yield* getMigrationStatuses({
          definitions: [f.authors],
        });
        const status = report.definitions[0];
        expect(status?.durable).toMatchObject({ failed: 1, needsUpdate: 1 });
        expect(status && migrationDependencyIsSatisfied(status)).toBe(true);
      })
  );

  it.effect(
    "does not establish completion from inventory, targeted runs, or retries alone",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        yield* getMigrationStatuses({
          definitions: [f.authors],
          scanSource: true,
        });
        expect(f.state.definitionCompletions.size).toBe(0);
        f.failures.add("one");
        yield* runInlineRegistry({
          definitions: [f.authors],
          mode: { kind: "item", sourceIdentityKey: "one" },
        });
        f.failures.clear();
        yield* runInlineRegistry({
          definitions: [f.authors],
          mode: { kind: "failed" },
        });
        expect(f.state.definitionCompletions.size).toBe(0);
        const error = yield* f.runBooks().pipe(Effect.flip);
        expect(error.message).toContain("no completed source pass");
        yield* runInlineDefinition(f.authors);
        expect((yield* f.runBooks()).status).toBe("succeeded");
      })
  );

  it.effect(
    "preserves existing completion across failed targeted runs and entirely failed rollbacks",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        yield* runInlineDefinition(f.authors);
        const completion = f.state.definitionCompletions.get(f.authors.id);
        f.failures.add("one");
        yield* runInlineRegistry({
          definitions: [f.authors],
          mode: { kind: "item", sourceIdentityKey: "one" },
        });
        expect(f.state.definitionCompletions.get(f.authors.id)).toEqual(
          completion
        );
        f.rollbackFailures.add("one");
        f.rollbackFailures.add("two");
        const rollback = yield* rollbackInlineDefinition(f.authors);
        expect(rollback.status).toBe("failed");
        expect(f.state.definitionCompletions.get(f.authors.id)).toEqual(
          completion
        );
        expect((yield* f.runBooks()).status).toBe("succeeded");
      })
  );

  it.effect(
    "invalidates completion on the first removal even if the remaining rollback fails",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        yield* runInlineDefinition(f.authors);
        f.rollbackFailures.add("two");
        const rollback = yield* rollbackInlineDefinition(f.authors);
        expect(rollback.status).toBe("failed");
        expect(rollback.definitions[0]?.counts).toMatchObject({
          rolledBack: 1,
          failed: 1,
        });
        expect(f.state.definitionCompletions.has(f.authors.id)).toBe(false);
        const error = yield* f.runBooks().pipe(Effect.flip);
        expect(error.message).toContain("no completed source pass");
        expect(f.state.latestRunStates.get(f.authors.id)?.operation).toBe(
          "rollback"
        );
        yield* runInlineDefinition(f.authors);
        expect((yield* f.runBooks()).status).toBe("succeeded");
      })
  );

  it.effect(
    "completes an empty source and preserves it through a no-op rollback",
    () =>
      Effect.gen(function* () {
        const f = fixture([]);
        yield* runInlineDefinition(f.authors);
        const completion = f.state.definitionCompletions.get(f.authors.id);
        expect(completion).toBeDefined();
        yield* rollbackInlineDefinition(f.authors);
        expect(f.state.definitionCompletions.get(f.authors.id)).toEqual(
          completion
        );
        expect((yield* f.runBooks()).status).toBe("succeeded");
        const store = yield* MigrationStore.pipe(Effect.provide(f.store));
        expect(yield* store.getDefinitionCompletion(f.authors.id)).toEqual(
          completion
        );
      })
  );
  it.effect(
    "keeps a forward pass complete after successful orphan cleanup",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        yield* runInlineDefinition(f.authors);
        f.items.pop();
        const result = yield* runInlineRegistry({
          definitions: [f.authors],
          rollbackOrphans: true,
        });
        expect(result.definitions[0]?.counts.rolledBack).toBe(1);
        expect(f.state.definitionCompletions.get(f.authors.id)?.runId).toBe(
          result.runId
        );
        expect((yield* f.runBooks()).status).toBe("succeeded");
      })
  );
});
