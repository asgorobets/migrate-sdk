import { describe, expect, it } from "@effect/vitest";
import { makeMemoryFilesSDK } from "@migrate-sdk/files-sdk/testing";
import { Effect } from "effect";
import { MigrationStore, toMigrationDefinitionId } from "migrate-sdk";
import {
  rollbackInlineDefinition,
  runInlineDefinition,
} from "migrate-sdk/testing";
import { makeObjectMigration } from "./object-migration.ts";

describe("Files integration example", () => {
  it.effect(
    "copies, resumes unchanged, updates, and rolls back with three separate clients",
    () =>
      Effect.gen(function* () {
        const source = makeMemoryFilesSDK({
          initial: { "input/a.txt": "alpha", "input/b.txt": "bravo" },
        });
        const destination = makeMemoryFilesSDK();
        const state = makeMemoryFilesSDK();
        const clients = {
          source: source.client,
          destination: destination.client,
          state: state.client,
        };
        const first = makeObjectMigration(clients);
        const summary = yield* runInlineDefinition(first);
        expect(summary.status).toBe("succeeded");
        expect(summary.definitions[0]?.counts.migrated).toBe(2);
        expect(
          yield* (yield* destination.service.download("output/a.txt")).text
        ).toBe("alpha");
        expect((yield* source.service.list()).items.map((o) => o.key)).toEqual([
          "input/a.txt",
          "input/b.txt",
        ]);
        const second = makeObjectMigration(clients);
        expect(
          (yield* runInlineDefinition(second)).definitions[0]?.counts.unchanged
        ).toBe(2);
        yield* source.service.upload("input/a.txt", "changed");
        expect(
          (yield* runInlineDefinition(makeObjectMigration(clients)))
            .definitions[0]?.counts.migrated
        ).toBe(1);
        const rollback = makeObjectMigration(clients);
        expect((yield* rollbackInlineDefinition(rollback)).status).toBe(
          "succeeded"
        );
        expect((yield* destination.service.list()).items).toEqual([]);
        const states = yield* MigrationStore.use((store) =>
          store.listItemStates(toMigrationDefinitionId("files-copy"))
        ).pipe(Effect.provide(rollback.store));
        expect(states).toEqual([]);
      })
  );
});
