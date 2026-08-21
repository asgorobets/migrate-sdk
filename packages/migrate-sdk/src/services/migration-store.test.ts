import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import {
  toEncodedSourceIdentity,
  toMigrationDefinitionId,
  toMigrationRunId,
} from "../domain/ids.ts";
import { MigrationStore } from "./migration-store.ts";

describe("MigrationStore orphan methods", () => {
  it.effect(
    "requires unfinished adapters to expose observe and list methods",
    () =>
      Effect.gen(function* () {
        const store = yield* MigrationStore;
        const definitionId = toMigrationDefinitionId("articles");
        const runId = toMigrationRunId("run-inventory");

        const observeError = yield* Effect.flip(
          store.observeItemState(
            definitionId,
            toEncodedSourceIdentity("article-1"),
            runId
          )
        );
        const listError = yield* Effect.flip(
          store.listOrphanItemStates(definitionId, runId, { limit: 100 })
        );

        expect(observeError).toEqual(
          expect.objectContaining({
            _tag: "MigrationStoreError",
            message:
              "InMemoryMigrationStore.observeItemState is not implemented",
          })
        );
        expect(listError).toEqual(
          expect.objectContaining({
            _tag: "MigrationStoreError",
            message:
              "InMemoryMigrationStore.listOrphanItemStates is not implemented",
          })
        );
      }).pipe(Effect.provide(InMemoryMigrationStore.layer()))
  );
});
