import { expect, it } from "@effect/vitest";
import { CommercetoolsMigrationStore } from "@migrate-sdk/commercetools/migration-store";
import { makeRecordingCustomObjectApiRoot } from "@migrate-sdk/commercetools/testing";
import { Effect, Schema } from "effect";
import {
  MigrationDefinition,
  MigrationStore,
  SourceIdentity,
  toMigrationRunId,
  toSourceVersion,
} from "migrate-sdk";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { runInlineRegistry } from "migrate-sdk/testing";

const Article = Schema.Struct({
  title: Schema.String,
});

const ArticleIdentity = SourceIdentity.make({
  id: "commercetools-store-article@v1",
  schema: SourceIdentity.key("articleId", Schema.String),
});

it.effect(
  "runs source inventory and orphan rollback through the Commercetools Migration Store",
  () => {
    const recording = makeRecordingCustomObjectApiRoot();
    const storeLayer = CommercetoolsMigrationStore.layerFromApiRoot({
      apiRoot: recording.apiRoot,
      container: "migrate-sdk",
      namespace: "rollback-orphans-integration",
      pageSize: 2,
      projectKey: "test-project",
    });
    const processCalls: string[] = [];
    const rollbackCalls: string[] = [];
    const definition = MigrationDefinition.make({
      id: "commercetools-store-articles",
      process: (item) =>
        Effect.sync(() => {
          processCalls.push(item.identity.encoded);
        }),
      rollback: (state) =>
        Effect.sync(() => {
          rollbackCalls.push(state.sourceIdentity.encoded);
        }),
      source: InMemorySource.make({
        identity: ArticleIdentity,
        items: [
          {
            identityKey: "article-current",
            item: { title: "Current article" },
            version: "source-version-1",
          },
        ],
        sourceSchema: Article,
      }),
      store: storeLayer,
    });
    const previousRunId = toMigrationRunId("run-previous");
    const currentIdentity = SourceIdentity.fromKey(
      ArticleIdentity,
      "article-current"
    );
    const orphanIdentity = SourceIdentity.fromKey(
      ArticleIdentity,
      "article-orphan"
    );
    const previousState = (sourceIdentity: typeof currentIdentity) => ({
      definitionId: definition.id,
      lastRunId: previousRunId,
      sourceIdentity,
      sourceVersion: toSourceVersion("source-version-1"),
      sourceVersionContractFingerprint:
        definition.source.sourceVersionContractFingerprint,
      status: "migrated" as const,
      updatedAt: new Date("2026-06-09T12:00:00.000Z"),
    });

    return Effect.gen(function* () {
      const store = yield* MigrationStore;

      yield* store.upsertMigrationContract({
        definitionId: definition.id,
        sourceIdentityContractFingerprint:
          definition.source.sourceIdentityContractFingerprint,
        sourceVersionContractFingerprint:
          definition.source.sourceVersionContractFingerprint,
      });
      yield* store.upsertItemState(previousState(currentIdentity));
      yield* store.upsertItemState(previousState(orphanIdentity));

      const summary = yield* runInlineRegistry({
        definitionIds: [definition.id],
        definitions: [definition] as const,
        rollbackOrphans: true,
      });

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions[0]).toEqual(
        expect.objectContaining({
          counts: {
            failed: 0,
            migrated: 0,
            needsUpdate: 0,
            orphaned: 1,
            rollbackFailed: 0,
            rolledBack: 1,
            skipped: 0,
            unchanged: 1,
          },
          definitionId: definition.id,
          status: "succeeded",
        })
      );
      expect(processCalls).toEqual([]);
      expect(rollbackCalls).toEqual([orphanIdentity.encoded]);
      expect(
        yield* store.getItemState(definition.id, currentIdentity.encoded)
      ).toEqual(
        expect.objectContaining({
          lastRunId: previousRunId,
          lastSourceInventoryRunId: summary.runId,
        })
      );
      expect(
        yield* store.getItemState(definition.id, orphanIdentity.encoded)
      ).toBeNull();
    }).pipe(Effect.provide(storeLayer));
  }
);
