import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { SourceIdentity } from "migrate-sdk";
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
    "counts the configured items without reading or looking up items",
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

        if (plugin.countTotal === undefined) {
          throw new Error("Expected in-memory source total count");
        }

        const total = yield* plugin.countTotal();

        expect(total).toBe(2);
        expect(state.readAttempts).toBe(0);
        expect(state.readByIdentityAttempts).toBe(0);
      })
  );

  it.effect("counts zero Source Items", () =>
    Effect.gen(function* () {
      const source = InMemorySourcePlugin.make({
        identity: ArticleSourceIdentity,
        items: [],
        sourceSchema: ArticleSource,
      });
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));

      if (plugin.countTotal === undefined) {
        throw new Error("Expected in-memory source total count");
      }

      const total = yield* plugin.countTotal();

      expect(total).toBe(0);
    })
  );
});
