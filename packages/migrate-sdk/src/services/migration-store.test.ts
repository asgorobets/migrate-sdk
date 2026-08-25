import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import { runSupersededMigrationRunScenario } from "migrate-sdk/testing";
import {
  SourceIdentityContractFingerprint,
  SourceIdentityContractId,
  toEncodedSourceIdentity,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceVersion,
} from "../domain/ids.ts";
import type { MigrationItemState } from "../domain/state.ts";
import {
  MigrationStore,
  validateMigrationDefinitionRunOutcomes,
} from "./migration-store.ts";

describe("MigrationStore definition outcomes", () => {
  it.effect(
    "completes a shared run after one definition starts a newer run",
    () =>
      Effect.gen(function* () {
        const result = yield* runSupersededMigrationRunScenario("memory");

        expect(result.originalRunState).toEqual(result.completed);
        expect(result.selectedLatest).toEqual(
          expect.objectContaining({
            definitionId: result.selectedId,
            runId: result.originalRunId,
            status: "succeeded",
          })
        );
        expect(result.dependencyLatest).toEqual(
          expect.objectContaining({
            definitionId: result.dependencyId,
            runId: result.newerRunId,
            status: "running",
          })
        );
      }).pipe(Effect.provide(InMemoryMigrationStore.layer()))
  );

  it.effect("rejects incomplete, duplicate, and unexpected outcomes", () =>
    Effect.gen(function* () {
      const authorsId = toMigrationDefinitionId("authors");
      const articlesId = toMigrationDefinitionId("articles");
      const assetsId = toMigrationDefinitionId("assets");
      const error = yield* Effect.flip(
        validateMigrationDefinitionRunOutcomes(
          [authorsId, articlesId],
          [
            { definitionId: authorsId, status: "succeeded" },
            { definitionId: authorsId, status: "failed" },
            { definitionId: assetsId, status: "skipped" },
          ]
        )
      );

      expect(error).toEqual(
        expect.objectContaining({
          _tag: "MigrationStoreError",
          cause: {
            duplicateDefinitionIds: [authorsId],
            missingDefinitionIds: [articlesId],
            unexpectedDefinitionIds: [assetsId],
          },
          message:
            "Migration Definition Run outcomes must match the Migration Run definitions",
        })
      );
    })
  );

  it.effect("does not mutate a run when terminal outcomes are incomplete", () =>
    Effect.gen(function* () {
      const store = yield* MigrationStore;
      const authorsId = toMigrationDefinitionId("authors");
      const articlesId = toMigrationDefinitionId("articles");
      const definitionIds = [authorsId, articlesId] as const;
      const runId = toMigrationRunId("run-incomplete-outcomes");

      yield* store.beginRun(runId, definitionIds);
      yield* Effect.flip(
        store.failRun(runId, definitionIds, [
          { definitionId: articlesId, status: "failed" },
        ])
      );

      expect(yield* store.getLatestRunState(authorsId)).toEqual(
        expect.objectContaining({ runId, status: "running" })
      );
      expect(yield* store.getLatestRunState(articlesId)).toEqual(
        expect.objectContaining({ runId, status: "running" })
      );
    }).pipe(Effect.provide(InMemoryMigrationStore.layer()))
  );
});

const migratedState = (
  identity: string,
  lastSourceInventoryRunId?: string
): MigrationItemState => ({
  definitionId: toMigrationDefinitionId("articles"),
  lastRunId: toMigrationRunId("run-migrate"),
  ...(lastSourceInventoryRunId === undefined
    ? {}
    : {
        lastSourceInventoryRunId: toMigrationRunId(lastSourceInventoryRunId),
      }),
  sourceIdentity: {
    encoded: toEncodedSourceIdentity(identity),
    fingerprint: SourceIdentityContractFingerprint.make("article-fingerprint"),
    id: SourceIdentityContractId.make("article-id"),
    key: identity,
  },
  sourceVersion: toSourceVersion("version-1"),
  status: "migrated",
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

describe("MigrationStore orphan methods", () => {
  it.effect(
    "observes existing state and pages unobserved state through deletion",
    () =>
      Effect.gen(function* () {
        const store = yield* MigrationStore;
        const definitionId = toMigrationDefinitionId("articles");
        const runId = toMigrationRunId("run-inventory");

        yield* store.upsertItemState(migratedState("article-c"));
        yield* store.upsertItemState(migratedState("article-a"));
        yield* store.upsertItemState(migratedState("article-b"));
        yield* store.observeItemState(
          definitionId,
          toEncodedSourceIdentity("article-b"),
          runId
        );
        yield* store.observeItemState(
          definitionId,
          toEncodedSourceIdentity("article-missing"),
          runId
        );

        expect(
          yield* store.getItemState(
            definitionId,
            toEncodedSourceIdentity("article-b")
          )
        ).toEqual(expect.objectContaining({ lastSourceInventoryRunId: runId }));
        expect(
          yield* store.getItemState(
            definitionId,
            toEncodedSourceIdentity("article-missing")
          )
        ).toBeNull();

        const firstPage = yield* store.listOrphanItemStates(
          definitionId,
          runId,
          { limit: 1 }
        );

        expect(
          firstPage.items.map((state) => state.sourceIdentity.encoded)
        ).toEqual(["article-a"]);
        expect(firstPage.nextAfterIdentity).toBe("article-a");

        yield* store.deleteItemState(
          definitionId,
          toEncodedSourceIdentity("article-a")
        );

        const secondPage = yield* store.listOrphanItemStates(
          definitionId,
          runId,
          {
            ...(firstPage.nextAfterIdentity === undefined
              ? {}
              : { afterIdentity: firstPage.nextAfterIdentity }),
            limit: 1,
          }
        );

        expect(
          secondPage.items.map((state) => state.sourceIdentity.encoded)
        ).toEqual(["article-c"]);
        expect(secondPage.nextAfterIdentity).toBeUndefined();
      }).pipe(Effect.provide(InMemoryMigrationStore.layer()))
  );
});
