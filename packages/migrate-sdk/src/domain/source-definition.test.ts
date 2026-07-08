import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { Service } from "effect/Context";
import {
  type ConfiguredSource,
  MigrationDefinition,
  Source,
  type Source as SourceContract,
  SourceError,
  SourceIdentity,
  type SourceIdentityTarget,
  type SourceItem,
  SourceItemTotal,
  type SourceReadResult,
  type SourceReadResultInput,
  toSourceVersion,
} from "migrate-sdk";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import { expectTypeOf } from "vitest";
import { MigrationDefinitionSource } from "../services/migration-definition-source.ts";
import { useConfiguredSource } from "../testing/configured-source-runtime.ts";

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

const RemoteArticleIdentity = SourceIdentity.make({
  id: "remote-article@v1",
  schema: SourceIdentity.key("articleId", Schema.NonEmptyString),
});

const tuple2 = <A, B>(first: A, second: B): readonly [A, B] => [first, second];

expectTypeOf<
  ReturnType<SourceContract<RemoteArticle, RemoteArticleCursor>["read"]>
>().toEqualTypeOf<
  Effect.Effect<
    SourceReadResult<RemoteArticle, RemoteArticleCursor>,
    SourceError
  >
>();

expectTypeOf<
  ReturnType<
    SourceContract<RemoteArticle, RemoteArticleCursor>["readByIdentity"]
  >
>().toEqualTypeOf<
  Effect.Effect<SourceItem<RemoteArticle> | null, SourceError>
>();

expectTypeOf<
  ReturnType<
    NonNullable<
      SourceContract<RemoteArticle, RemoteArticleCursor>["countTotal"]
    >
  >
>().toEqualTypeOf<Effect.Effect<SourceItemTotal, SourceError>>();

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
    ) => Effect.Effect<RemoteArticle, SourceError>;
    readonly list: (cursor: RemoteArticleCursor | null) => Effect.Effect<
      {
        readonly entries: readonly ArticleListEntry[];
        readonly nextCursor?: RemoteArticleCursor;
      },
      SourceError
    >;
  }
>()("@migrate-sdk/test/ArticleApi") {}

interface ScopedSourceDependencyState {
  closed: boolean;
  reads: number;
  releases: number;
}

class ScopedSourceDependency extends Service<
  ScopedSourceDependency,
  {
    readonly read: () => Effect.Effect<
      SourceReadResultInput<RemoteArticle, RemoteArticleCursor, string>,
      SourceError
    >;
  }
>()("@migrate-sdk/test/ScopedSourceDependency") {}

const makeScopedSourceDependencyLayer = (
  state: ScopedSourceDependencyState
): Layer.Layer<ScopedSourceDependency> =>
  Layer.effect(
    ScopedSourceDependency,
    Effect.acquireRelease(
      Effect.sync(() => ({
        read: () =>
          Effect.gen(function* () {
            state.reads += 1;

            if (state.closed) {
              return yield* new SourceError({
                message: "Scoped source dependency was closed before read",
              });
            }

            return {
              items: [
                {
                  identityKey: "article-1",
                  item: {
                    id: "article-1",
                    title: "One",
                    updatedAt: "2026-06-05T10:00:00.000Z",
                  },
                  version: "2026-06-05T10:00:00.000Z",
                },
              ],
            };
          }),
      })),
      () =>
        Effect.sync(() => {
          state.closed = true;
          state.releases += 1;
        })
    )
  );

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
          return yield* new SourceError({
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

describe("Source", () => {
  it.effect("normalizes source item inputs into a configured source", () =>
    Effect.gen(function* () {
      const source = Source.make({
        cursorSchema: RemoteArticleCursor,
        identity: RemoteArticleIdentity,
        sourceSchema: RemoteArticle,
        lookupStrategy: "direct",
        read: () =>
          Effect.succeed({
            items: [
              {
                identityKey: "article-1",
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
            identityKey: identity.key,
            version: "2026-06-05T10:00:00.000Z",
            item: {
              id: "article-1",
              title: "One",
              updatedAt: "2026-06-05T10:00:00.000Z",
            },
          }),
      });

      yield* useConfiguredSource(source, (sourceRuntime) =>
        Effect.gen(function* () {
          const page = yield* sourceRuntime.read(null);
          const firstItem = page.items[0];

          if (firstItem === undefined) {
            throw new Error("Expected source page to include one item");
          }

          const item = yield* sourceRuntime.readByIdentity(firstItem.identity);

          expect(sourceRuntime.cursorSchema).toBe(RemoteArticleCursor);
          expect(sourceRuntime.identity).toBe(RemoteArticleIdentity);
          expect(sourceRuntime.sourceSchema).toBe(RemoteArticle);
          expect(sourceRuntime.lookupStrategy).toBe("direct");
          expect(sourceRuntime.countTotal).toBeUndefined();
          expect(page.items[0]?.identity).toEqual(
            SourceIdentity.fromKey(RemoteArticleIdentity, "article-1")
          );
          expect(page.items[0]?.version).toBe("2026-06-05T10:00:00.000Z");
          expect(item?.identity).toEqual(
            SourceIdentity.fromKey(RemoteArticleIdentity, "article-1")
          );
        })
      );
    })
  );

  it.effect("exposes optional Source Item total count", () =>
    Effect.gen(function* () {
      const source = Source.make({
        cursorSchema: RemoteArticleCursor,
        identity: RemoteArticleIdentity,
        sourceSchema: RemoteArticle,
        lookupStrategy: "direct",
        read: () =>
          Effect.succeed({
            items: [],
          }),
        readByIdentity: () => Effect.succeed(null),
        countTotal: () => Effect.succeed(0),
      });
      yield* useConfiguredSource(source, (sourceRuntime) =>
        Effect.gen(function* () {
          if (sourceRuntime.countTotal === undefined) {
            throw new Error("Expected source to expose total count");
          }

          const total = yield* sourceRuntime.countTotal();

          expect(total).toEqual(SourceItemTotal.known(0));
        })
      );
    })
  );

  it.effect("adapts a source runtime layer", () =>
    Effect.gen(function* () {
      const source = Source.fromLayer({
        layer: (SourceRuntimeService) =>
          Layer.effect(
            SourceRuntimeService,
            Effect.succeed(
              SourceRuntimeService.of({
                lookupStrategy: "direct",
                read: () =>
                  Effect.succeed({
                    items: [
                      {
                        identityKey: "article-1",
                        version: toSourceVersion("2026-06-05T10:00:00.000Z"),
                        item: {
                          id: "article-1",
                          title: "One",
                          updatedAt: "2026-06-05T10:00:00.000Z",
                        },
                      },
                    ],
                  }),
                readByIdentity: () => Effect.succeed(null),
              })
            )
          ),
        cursorSchema: RemoteArticleCursor,
        identity: RemoteArticleIdentity,
        sourceSchema: RemoteArticle,
      });

      expectTypeOf(source).toMatchTypeOf<
        ConfiguredSource<RemoteArticle, RemoteArticleCursor, string>
      >();

      const page = yield* useConfiguredSource(source, (sourceRuntime) =>
        sourceRuntime.read(null)
      );

      expect(source.identity).toBe(RemoteArticleIdentity);
      expect(page.items[0]?.identity).toEqual(
        SourceIdentity.fromKey(RemoteArticleIdentity, "article-1")
      );
    })
  );

  it.effect("keeps provided source dependencies alive for source use", () =>
    Effect.gen(function* () {
      const state: ScopedSourceDependencyState = {
        closed: false,
        reads: 0,
        releases: 0,
      };
      const source = Source.fromLayer({
        layer: (SourceRuntimeService) =>
          Layer.effect(
            SourceRuntimeService,
            Effect.gen(function* () {
              const dependency = yield* ScopedSourceDependency;

              return SourceRuntimeService.of({
                lookupStrategy: "scan" as const,
                read: () => dependency.read(),
                readByIdentity: () => Effect.succeed(null),
              });
            })
          ),
        cursorSchema: RemoteArticleCursor,
        identity: RemoteArticleIdentity,
        sourceSchema: RemoteArticle,
      }).provide(makeScopedSourceDependencyLayer(state));

      const page = yield* useConfiguredSource(source, (sourceRuntime) =>
        sourceRuntime.read(null)
      );

      expect(page.items[0]?.identity).toEqual(
        SourceIdentity.fromKey(RemoteArticleIdentity, "article-1")
      );
      expect(state.reads).toBe(1);
      expect(state.closed).toBe(true);
      expect(state.releases).toBe(1);
    })
  );

  it.effect(
    "keeps provided source dependencies alive through the definition source service",
    () =>
      Effect.gen(function* () {
        const state: ScopedSourceDependencyState = {
          closed: false,
          reads: 0,
          releases: 0,
        };
        const source = Source.fromLayer({
          layer: (SourceRuntimeService) =>
            Layer.effect(
              SourceRuntimeService,
              Effect.gen(function* () {
                const dependency = yield* ScopedSourceDependency;

                return SourceRuntimeService.of({
                  lookupStrategy: "scan" as const,
                  read: () => dependency.read(),
                  readByIdentity: () => Effect.succeed(null),
                });
              })
            ),
          cursorSchema: RemoteArticleCursor,
          identity: RemoteArticleIdentity,
          sourceSchema: RemoteArticle,
        }).provide(makeScopedSourceDependencyLayer(state));
        const definition = MigrationDefinition.make({
          id: "scoped-source-service",
          source,
          store: InMemoryMigrationStore.layer(),
          process: () => Effect.void,
        });

        const page = yield* Effect.gen(function* () {
          const sourceRuntime =
            yield* MigrationDefinitionSource.get(definition);
          return yield* sourceRuntime.read(null);
        }).pipe(Effect.provide(MigrationDefinitionSource.layer(definition)));

        expect(page.items[0]?.identity).toEqual(
          SourceIdentity.fromKey(RemoteArticleIdentity, "article-1")
        );
        expect(state.reads).toBe(1);
        expect(state.closed).toBe(true);
        expect(state.releases).toBe(1);
      })
  );

  it.effect("exposes lower-bound Source Item totals", () =>
    Effect.gen(function* () {
      const source = Source.make({
        cursorSchema: RemoteArticleCursor,
        identity: RemoteArticleIdentity,
        sourceSchema: RemoteArticle,
        lookupStrategy: "direct",
        read: () =>
          Effect.succeed({
            items: [],
          }),
        readByIdentity: () => Effect.succeed(null),
        countTotal: () =>
          Effect.succeed(
            SourceItemTotal.lowerBound(10_000, {
              message: "Remote total is capped",
              reason: "capped",
            })
          ),
      });
      yield* useConfiguredSource(source, (sourceRuntime) =>
        Effect.gen(function* () {
          if (sourceRuntime.countTotal === undefined) {
            throw new Error("Expected source to expose total count");
          }

          const total = yield* sourceRuntime.countTotal();

          expect(total).toEqual(
            SourceItemTotal.lowerBound(10_000, {
              message: "Remote total is capped",
              reason: "capped",
            })
          );
        })
      );
    })
  );

  it.effect(
    "fails source reads with SourceError when identity keys do not match the Source Identity Schema",
    () =>
      Effect.gen(function* () {
        const source = Source.make({
          cursorSchema: RemoteArticleCursor,
          identity: RemoteArticleIdentity,
          sourceSchema: RemoteArticle,
          lookupStrategy: "direct",
          read: () =>
            Effect.succeed({
              items: [
                {
                  identityKey: "",
                  version: "2026-06-05T10:00:00.000Z",
                  item: {
                    id: "article-1",
                    title: "One",
                    updatedAt: "2026-06-05T10:00:00.000Z",
                  },
                },
              ],
            }),
          readByIdentity: (identity) =>
            Effect.succeed({
              identityKey: identity.key,
              version: "2026-06-05T10:00:00.000Z",
              item: {
                id: "article-1",
                title: "One",
                updatedAt: "2026-06-05T10:00:00.000Z",
              },
            }),
        });
        const error = yield* useConfiguredSource(source, (sourceRuntime) =>
          Effect.flip(sourceRuntime.read(null))
        );

        expect(error).toBeInstanceOf(SourceError);
        expect(error.message).toContain("Source item metadata");
      })
  );

  it.effect(
    "fails source identity lookups with SourceError when returned identity keys do not match the Source Identity Schema",
    () =>
      Effect.gen(function* () {
        const source = Source.make({
          cursorSchema: RemoteArticleCursor,
          identity: RemoteArticleIdentity,
          sourceSchema: RemoteArticle,
          lookupStrategy: "direct",
          read: () =>
            Effect.succeed({
              items: [],
            }),
          readByIdentity: () =>
            Effect.succeed({
              identityKey: "",
              version: "2026-06-05T10:00:00.000Z",
              item: {
                id: "article-1",
                title: "One",
                updatedAt: "2026-06-05T10:00:00.000Z",
              },
            }),
        });
        const identity = SourceIdentity.fromKey(
          RemoteArticleIdentity,
          "article-1"
        );
        const error = yield* useConfiguredSource(source, (sourceRuntime) =>
          Effect.flip(sourceRuntime.readByIdentity(identity))
        );

        expect(error).toBeInstanceOf(SourceError);
        expect(error.message).toContain("Source item metadata");
      })
  );

  it.effect(
    "fails source identity lookups when the returned item identity does not match the requested target",
    () =>
      Effect.gen(function* () {
        const source = Source.make({
          cursorSchema: RemoteArticleCursor,
          identity: RemoteArticleIdentity,
          sourceSchema: RemoteArticle,
          lookupStrategy: "direct",
          read: () =>
            Effect.succeed({
              items: [],
            }),
          readByIdentity: () =>
            Effect.succeed({
              identityKey: "article-2",
              version: "2026-06-05T10:05:00.000Z",
              item: {
                id: "article-2",
                title: "Two",
                updatedAt: "2026-06-05T10:05:00.000Z",
              },
            }),
        });
        const identity = SourceIdentity.fromKey(
          RemoteArticleIdentity,
          "article-1"
        );
        const error = yield* useConfiguredSource(source, (sourceRuntime) =>
          Effect.flip(sourceRuntime.readByIdentity(identity))
        );

        expect(error).toBeInstanceOf(SourceError);
        expect(error.message).toBe(
          "Source identity lookup returned a different Source Identity"
        );
        expect(error.cause).toEqual({
          requestedSourceIdentity: "article-1",
          returnedSourceIdentity: "article-2",
        });
      })
  );

  it.effect(
    "supports service-backed Effect pipelines inside source methods",
    () =>
      Effect.gen(function* () {
        const state: ArticleApiState = { detailCalls: [] };
        const apiLayer = makeArticleApiLayer(state);
        const withArticleApi = <A>(
          effect: Effect.Effect<A, SourceError, ArticleApi>
        ): Effect.Effect<A, SourceError> =>
          effect.pipe(Effect.provide(apiLayer));

        const source = Source.make({
          cursorSchema: RemoteArticleCursor,
          identity: RemoteArticleIdentity,
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
                            identityKey: article.id,
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
              (identity: SourceIdentityTarget<string>) =>
                withArticleApi(
                  Effect.gen(function* () {
                    const api = yield* ArticleApi;
                    const article = yield* api.getDetails(identity.key);

                    return {
                      identityKey: article.id,
                      version: article.updatedAt,
                      item: article,
                    };
                  })
                )
            ),
          }),
        });

        yield* useConfiguredSource(source, (sourceRuntime) =>
          Effect.gen(function* () {
            const page = yield* sourceRuntime.read(null);
            const item = yield* sourceRuntime.readByIdentity(
              SourceIdentity.fromKey(RemoteArticleIdentity, "article-2")
            );

            expect(page.items.map((sourceItem) => sourceItem.identity)).toEqual(
              [
                SourceIdentity.fromKey(RemoteArticleIdentity, "article-1"),
                SourceIdentity.fromKey(RemoteArticleIdentity, "article-2"),
              ]
            );
            expect(page.nextCursor).toEqual({ page: 2 });
            expect(item?.item.title).toBe("Two");
            expect(state.detailCalls).toEqual([
              "article-1",
              "article-2",
              "article-2",
            ]);
          })
        );
      })
  );

  it.effect("normalizes tuple source identity keys", () =>
    Effect.gen(function* () {
      const BusinessAddressIdentity = SourceIdentity.make({
        id: "business-address@v1",
        schema: SourceIdentity.tuple([
          SourceIdentity.part("businessUnitKey", Schema.NonEmptyString),
          SourceIdentity.part("addressIndex", Schema.Int),
        ]),
      });
      const BusinessAddress = Schema.Struct({
        addressIndex: Schema.Int,
        businessUnitKey: Schema.String,
        city: Schema.String,
      });

      const source = Source.make({
        cursorSchema: Schema.Null,
        identity: BusinessAddressIdentity,
        sourceSchema: BusinessAddress,
        lookupStrategy: "direct",
        read: () =>
          Effect.succeed({
            items: [
              {
                identityKey: tuple2("bu-1", 0),
                version: "2026-06-05T10:00:00.000Z",
                item: {
                  addressIndex: 0,
                  businessUnitKey: "bu-1",
                  city: "Kyiv",
                },
              },
            ],
          }),
        readByIdentity: (identity) =>
          Effect.succeed({
            identityKey: identity.key,
            version: "2026-06-05T10:00:00.000Z",
            item: {
              addressIndex: identity.key[1],
              businessUnitKey: identity.key[0],
              city: "Kyiv",
            },
          }),
      });

      yield* useConfiguredSource(source, (sourceRuntime) =>
        Effect.gen(function* () {
          const page = yield* sourceRuntime.read(null);
          const firstItem = page.items[0];

          if (firstItem === undefined) {
            throw new Error("Expected tuple source read to return one item");
          }

          const item = yield* sourceRuntime.readByIdentity(firstItem.identity);

          expect(firstItem.identity).toEqual(
            SourceIdentity.fromKey(BusinessAddressIdentity, ["bu-1", 0])
          );
          expect(item?.identity).toEqual(
            SourceIdentity.fromKey(BusinessAddressIdentity, ["bu-1", 0])
          );
        })
      );
    })
  );
});
