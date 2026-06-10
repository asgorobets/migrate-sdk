import { layer as nodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { layer as nodePathLayer } from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { Service } from "effect/Context";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { SourcePluginError } from "migrate-sdk";
import type {
  DocumentFetcher,
  DocumentFetchResult,
  DocumentFileTextFetcherCursor,
} from "migrate-sdk/sources/document";
import { DocumentFetchers } from "migrate-sdk/sources/document";
import { expectTypeOf } from "vitest";

const sha256HexPattern = /^[a-f0-9]{64}$/;
const testPlatformLayer = Layer.mergeAll(nodeFileSystemLayer, nodePathLayer);

const ArticleDocument = Schema.Struct({
  body: Schema.String,
  id: Schema.String,
  title: Schema.String,
});

type ArticleDocument = typeof ArticleDocument.Type;

const ArticlePageCursor = Schema.Struct({
  offset: Schema.Int,
});

type ArticlePageCursor = typeof ArticlePageCursor.Type;

interface ArticleDocumentApiState {
  readonly detailCalls: string[];
  listCalls: number;
}

class ArticleDocumentApi extends Service<
  ArticleDocumentApi,
  {
    readonly getArticle: (
      id: string
    ) => Effect.Effect<ArticleDocument, SourcePluginError>;
    readonly listArticleIds: (
      cursor: ArticlePageCursor | null
    ) => Effect.Effect<
      {
        readonly ids: readonly string[];
        readonly nextCursor?: ArticlePageCursor | undefined;
      },
      SourcePluginError
    >;
  }
>()("@migrate-sdk/test/ArticleDocumentApi") {}

const makeArticleDocumentApiLayer = (
  state: ArticleDocumentApiState
): Layer.Layer<ArticleDocumentApi> =>
  Layer.sync(ArticleDocumentApi, () => {
    const articles = new Map<string, ArticleDocument>([
      [
        "article-1",
        {
          body: "First body",
          id: "article-1",
          title: "First",
        },
      ],
      [
        "article-2",
        {
          body: "Second body",
          id: "article-2",
          title: "Second",
        },
      ],
      [
        "article-3",
        {
          body: "Third body",
          id: "article-3",
          title: "Third",
        },
      ],
    ]);

    const getArticle = (id: string) =>
      Effect.gen(function* () {
        state.detailCalls.push(id);
        const article = articles.get(id);

        if (article === undefined) {
          return yield* new SourcePluginError({
            message: "Article was not found",
            cause: { id },
          });
        }

        return article;
      });

    const listArticleIds = (cursor: ArticlePageCursor | null) =>
      Effect.sync(() => {
        state.listCalls += 1;
        const offset = cursor?.offset ?? 0;
        const ids = Array.from(articles.keys()).slice(offset, offset + 2);
        const nextOffset = offset + ids.length;

        return {
          ids,
          ...(nextOffset < articles.size
            ? { nextCursor: { offset: nextOffset } satisfies ArticlePageCursor }
            : {}),
        };
      });

    return {
      getArticle,
      listArticleIds,
    };
  });

describe("DocumentFetchers.fileText", () => {
  it("exports reusable fetcher contracts", () => {
    const fetcher = DocumentFetchers.fileText({
      path: "./companies.json",
      platform: testPlatformLayer,
    });

    expectTypeOf(fetcher).toMatchTypeOf<
      DocumentFetcher<string, DocumentFileTextFetcherCursor>
    >();
    expectTypeOf<DocumentFileTextFetcherCursor>().toEqualTypeOf<null>();
    expectTypeOf<
      DocumentFetchResult<string, DocumentFileTextFetcherCursor>
    >().toEqualTypeOf<{
      readonly fingerprint?: string | undefined;
      readonly nextCursor?: null | undefined;
      readonly resource: string;
    }>();
  });

  it.effect("reads local text resources with stable fingerprints", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-sdk-document-fetcher-",
      });
      const filePath = path.join(directory, "companies.json");
      yield* fs.writeFileString(filePath, '{"companies":[]}');

      const fetcher = DocumentFetchers.fileText({
        path: filePath,
        platform: testPlatformLayer,
      });

      const first = yield* fetcher.read(null);
      const second = yield* fetcher.read(null);

      expect(first.resource).toBe('{"companies":[]}');
      expect(first.fingerprint).toMatch(sha256HexPattern);
      expect(second.fingerprint).toBe(first.fingerprint);
      expect(first.nextCursor).toBeUndefined();
      expect(fetcher.cursorSchema.ast).toBeDefined();
    }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect("does not parse or validate JSON contents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-sdk-document-fetcher-",
      });
      const filePath = path.join(directory, "invalid.json");
      yield* fs.writeFileString(filePath, "{not json");

      const fetcher = DocumentFetchers.fileText({
        path: filePath,
        platform: testPlatformLayer,
      });

      const result = yield* fetcher.read(null);

      expect(result.resource).toBe("{not json");
    }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect(
    "fails missing files as source plugin errors with path context",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-sdk-document-fetcher-",
        });
        const filePath = path.join(directory, "missing.json");
        const fetcher = DocumentFetchers.fileText({
          path: filePath,
          platform: testPlatformLayer,
        });

        const error = yield* fetcher.read(null).pipe(Effect.flip);

        expect(error).toBeInstanceOf(SourcePluginError);
        expect(error.message).toBe("Unable to read document resource file");
        expect(error.cause).toEqual(
          expect.objectContaining({
            path: filePath,
            resolvedPath: path.resolve(filePath),
          })
        );
      }).pipe(Effect.provide(testPlatformLayer))
  );
});

describe("DocumentFetchers.effect", () => {
  it.effect("reads resources from an already-closed Effect", () =>
    Effect.gen(function* () {
      const fetcher = DocumentFetchers.effect({
        cursorSchema: Schema.Null,
        read: () =>
          Effect.succeed({
            resource: { articles: [] as readonly ArticleDocument[] },
          }),
      });

      expectTypeOf(fetcher).toMatchTypeOf<
        DocumentFetcher<{ readonly articles: readonly ArticleDocument[] }, null>
      >();

      const result = yield* fetcher.read(null);

      expect(result).toEqual({
        resource: { articles: [] },
      });
    })
  );

  it.effect(
    "assembles resources with caller-provided Effect dependencies",
    () =>
      Effect.gen(function* () {
        const state: ArticleDocumentApiState = {
          detailCalls: [],
          listCalls: 0,
        };
        const fetcher = DocumentFetchers.effect({
          cursorSchema: ArticlePageCursor,
          read: (cursor) =>
            Effect.gen(function* () {
              const api = yield* ArticleDocumentApi;
              const page = yield* api.listArticleIds(cursor);
              const articles = yield* Effect.forEach(
                page.ids,
                (id) => api.getArticle(id),
                { concurrency: 2 }
              );

              return {
                fingerprint: `articles:${page.ids.join(",")}`,
                nextCursor: page.nextCursor,
                resource: { articles },
              };
            }),
          layer: makeArticleDocumentApiLayer(state),
        });

        expectTypeOf(fetcher).toMatchTypeOf<
          DocumentFetcher<
            { readonly articles: readonly ArticleDocument[] },
            ArticlePageCursor
          >
        >();

        const first = yield* fetcher.read(null);
        const second = yield* fetcher.read(first.nextCursor ?? null);

        expect(first).toEqual({
          fingerprint: "articles:article-1,article-2",
          nextCursor: { offset: 2 },
          resource: {
            articles: [
              { body: "First body", id: "article-1", title: "First" },
              { body: "Second body", id: "article-2", title: "Second" },
            ],
          },
        });
        expect(second).toEqual({
          fingerprint: "articles:article-3",
          resource: {
            articles: [{ body: "Third body", id: "article-3", title: "Third" }],
          },
        });
        expect(state.listCalls).toBe(2);
        expect(state.detailCalls).toEqual([
          "article-1",
          "article-2",
          "article-3",
        ]);
      })
  );
});
