import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { SourceIdentity, SourceItemTotal } from "migrate-sdk";
import { SourcePlugin } from "../../services/source-plugin.ts";
import { InMemorySourcePlugin } from "./in-memory-source.ts";

const ArticleSource = Schema.Struct({
  title: Schema.String,
});

const ArticleSourceIdentity = SourceIdentity.make({
  id: "test-article@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});

describe("InMemorySourcePlugin", () => {
  it.effect(
    "discovers the configured item count without reading or looking up items",
    () =>
      Effect.gen(function* () {
        const state = InMemorySourcePlugin.makeState();
        const source = InMemorySourcePlugin.make({
          batchSize: 1,
          identity: ArticleSourceIdentity,
          items: [
            {
              identityKey: "article-1",
              item: { title: "Article 1" },
              version: "source-version-1",
            },
            {
              identityKey: "article-2",
              item: { title: "Article 2" },
              version: "source-version-1",
            },
          ],
          sourceSchema: ArticleSource,
          state,
        });
        const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));

        if (plugin.discoverSourceItemTotal === undefined) {
          throw new Error("Expected in-memory source total discovery");
        }

        const total = yield* plugin.discoverSourceItemTotal();

        expect(total).toEqual(SourceItemTotal.known(2));
        expect(state.readAttempts).toBe(0);
        expect(state.readByIdentityAttempts).toBe(0);
      })
  );

  it.effect("discovers zero Source Items as a known zero total", () =>
    Effect.gen(function* () {
      const source = InMemorySourcePlugin.make({
        identity: ArticleSourceIdentity,
        items: [],
        sourceSchema: ArticleSource,
      });
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));

      if (plugin.discoverSourceItemTotal === undefined) {
        throw new Error("Expected in-memory source total discovery");
      }

      const total = yield* plugin.discoverSourceItemTotal();

      expect(total).toEqual(SourceItemTotal.known(0));
    })
  );
});
