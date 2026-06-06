import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { Service } from "effect/Context";
import {
  defineSourcePlugin,
  SourcePluginError,
  type SourceReadResultInput,
  toSourceIdentity,
} from "migrate-sdk";
import { SourcePlugin } from "../services/source-plugin.ts";

const RemoteArticle = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  updatedAt: Schema.String,
});

type RemoteArticle = typeof RemoteArticle.Type;

const RemoteArticleCursor = Schema.Struct({
  page: Schema.Int,
});

type RemoteArticleCursor = typeof RemoteArticleCursor.Type;

interface ArticleListEntry {
  readonly id: string;
}

interface ArticleApiState {
  readonly detailCalls: string[];
}

class ArticleApi extends Service<
  ArticleApi,
  {
    readonly getDetails: (
      id: string
    ) => Effect.Effect<RemoteArticle, SourcePluginError>;
    readonly list: (cursor: RemoteArticleCursor | null) => Effect.Effect<
      {
        readonly entries: readonly ArticleListEntry[];
        readonly nextCursor?: RemoteArticleCursor;
      },
      SourcePluginError
    >;
  }
>()("@migrate-sdk/test/ArticleApi") {}

const makeArticleApiLayer = (state: ArticleApiState): Layer.Layer<ArticleApi> =>
  Layer.sync(ArticleApi, () => {
    const articles = new Map<string, RemoteArticle>([
      [
        "article-1",
        {
          id: "article-1",
          title: "One",
          updatedAt: "2026-06-05T10:00:00.000Z",
        },
      ],
      [
        "article-2",
        {
          id: "article-2",
          title: "Two",
          updatedAt: "2026-06-05T10:05:00.000Z",
        },
      ],
    ]);

    const getDetails = (id: string) =>
      Effect.gen(function* () {
        state.detailCalls.push(id);
        const article = articles.get(id);

        if (article === undefined) {
          return yield* new SourcePluginError({
            message: "Article detail was not found",
            cause: { id },
          });
        }

        return article;
      });

    const list = (cursor: RemoteArticleCursor | null) =>
      Effect.succeed({
        entries:
          cursor === null ? [{ id: "article-1" }, { id: "article-2" }] : [],
        ...(cursor === null
          ? { nextCursor: { page: 2 } satisfies RemoteArticleCursor }
          : {}),
      });

    return {
      getDetails,
      list,
    };
  });

describe("defineSourcePlugin", () => {
  it.effect(
    "normalizes source item inputs into a configured source plugin",
    () =>
      Effect.gen(function* () {
        const source = defineSourcePlugin({
          cursorSchema: RemoteArticleCursor,
          sourceSchema: RemoteArticle,
          lookupStrategy: "direct",
          read: () =>
            Effect.succeed({
              items: [
                {
                  identity: "article-1",
                  version: "2026-06-05T10:00:00.000Z",
                  item: {
                    id: "article-1",
                    title: "One",
                    updatedAt: "2026-06-05T10:00:00.000Z",
                  },
                },
              ],
            } satisfies SourceReadResultInput<
              RemoteArticle,
              RemoteArticleCursor
            >),
          readByIdentity: (identity) =>
            Effect.succeed({
              identity,
              version: "2026-06-05T10:00:00.000Z",
              item: {
                id: "article-1",
                title: "One",
                updatedAt: "2026-06-05T10:00:00.000Z",
              },
            }),
        });

        const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
        const page = yield* plugin.read(null);
        const firstItem = page.items[0];

        if (firstItem === undefined) {
          throw new Error("Expected source page to include one item");
        }

        const item = yield* plugin.readByIdentity(firstItem.identity);

        expect(plugin.cursorSchema).toBe(RemoteArticleCursor);
        expect(plugin.sourceSchema).toBe(RemoteArticle);
        expect(plugin.lookupStrategy).toBe("direct");
        expect(page.items[0]?.identity).toBe("article-1");
        expect(page.items[0]?.version).toBe("2026-06-05T10:00:00.000Z");
        expect(item?.identity).toBe("article-1");
      })
  );

  it.effect(
    "supports service-backed Effect pipelines inside source plugin methods",
    () =>
      Effect.gen(function* () {
        const state: ArticleApiState = { detailCalls: [] };
        const apiLayer = makeArticleApiLayer(state);
        const withArticleApi = <A>(
          effect: Effect.Effect<A, SourcePluginError, ArticleApi>
        ): Effect.Effect<A, SourcePluginError> =>
          effect.pipe(Effect.provide(apiLayer));

        const source = defineSourcePlugin({
          cursorSchema: RemoteArticleCursor,
          sourceSchema: RemoteArticle,
          make: () => ({
            lookupStrategy: "direct",
            read: Effect.fn("TestArticleSource.read")(
              (cursor: RemoteArticleCursor | null) =>
                withArticleApi(
                  Effect.gen(function* () {
                    const api = yield* ArticleApi;
                    const listing = yield* api.list(cursor);
                    const items = yield* Effect.forEach(
                      listing.entries,
                      (entry) =>
                        api.getDetails(entry.id).pipe(
                          Effect.map((article) => ({
                            identity: article.id,
                            version: article.updatedAt,
                            item: article,
                          }))
                        ),
                      { concurrency: 1 }
                    );

                    return {
                      items,
                      nextCursor: listing.nextCursor,
                    };
                  })
                )
            ),
            readByIdentity: Effect.fn("TestArticleSource.readByIdentity")(
              (identity) =>
                withArticleApi(
                  Effect.gen(function* () {
                    const api = yield* ArticleApi;
                    const article = yield* api.getDetails(identity);

                    return {
                      identity: article.id,
                      version: article.updatedAt,
                      item: article,
                    };
                  })
                )
            ),
          }),
        });

        const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
        const page = yield* plugin.read(null);
        const item = yield* plugin.readByIdentity(
          toSourceIdentity("article-2")
        );

        expect(page.items.map((sourceItem) => sourceItem.identity)).toEqual([
          "article-1",
          "article-2",
        ]);
        expect(page.nextCursor).toEqual({ page: 2 });
        expect(item?.item.title).toBe("Two");
        expect(state.detailCalls).toEqual([
          "article-1",
          "article-2",
          "article-2",
        ]);
      })
  );
});
