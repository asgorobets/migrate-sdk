import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { SourceIdentity, SourceItemTotal } from "migrate-sdk";
import { Source } from "../../services/source.ts";
import { InMemorySource } from "./in-memory-source.ts";

const ArticleSource = Schema.Struct({
  title: Schema.String,
});

const ArticleSourceIdentity = SourceIdentity.make({
  id: "test-article@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});

describe("InMemorySource", () => {
  it.effect(
    "counts the configured items without reading or looking up items",
    () =>
      Effect.gen(function* () {
        const state = InMemorySource.makeState();
        const source = InMemorySource.make({
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
        const sourceService = yield* Source.pipe(Effect.provide(source.layer));

        if (sourceService.countTotal === undefined) {
          throw new Error("Expected in-memory source total count");
        }

        const total = yield* sourceService.countTotal();

        expect(total).toEqual(SourceItemTotal.known(2));
        expect(state.readAttempts).toBe(0);
        expect(state.readByIdentityAttempts).toBe(0);
      })
  );

  it.effect("counts zero Source Items", () =>
    Effect.gen(function* () {
      const source = InMemorySource.make({
        identity: ArticleSourceIdentity,
        items: [],
        sourceSchema: ArticleSource,
      });
      const sourceService = yield* Source.pipe(Effect.provide(source.layer));

      if (sourceService.countTotal === undefined) {
        throw new Error("Expected in-memory source total count");
      }

      const total = yield* sourceService.countTotal();

      expect(total).toEqual(SourceItemTotal.known(0));
    })
  );
});
