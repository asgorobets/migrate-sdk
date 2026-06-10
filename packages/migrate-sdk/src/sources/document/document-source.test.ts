import { layer as nodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { layer as nodePathLayer } from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { Service } from "effect/Context";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { SourcePluginError } from "migrate-sdk";
import {
  type DocumentFetcher,
  DocumentFetchers,
  type DocumentFetchResult,
  type DocumentParser,
  DocumentParsers,
  type DocumentSourceDirectLookupResult,
  DocumentSourcePlugin,
} from "migrate-sdk/sources/document";
import { expectTypeOf } from "vitest";
import { toSourceIdentity } from "../../domain/ids.ts";
import { SourcePlugin } from "../../services/source-plugin.ts";

const CompanyContact = Schema.Struct({
  email: Schema.String,
  key: Schema.String,
});

const CompanyAddress = Schema.Struct({
  city: Schema.String,
  key: Schema.String,
});

const BusinessUnit = Schema.Struct({
  addresses: Schema.Array(CompanyAddress),
  contacts: Schema.Array(CompanyContact),
  key: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["active", "inactive"]),
});

const CompaniesDocument = Schema.Struct({
  businessUnits: Schema.Array(BusinessUnit),
  exportedAt: Schema.String,
});

const InventoryDocument = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      inventory: Schema.BigIntFromString,
      key: Schema.String,
    })
  ),
});

const ResourceEnvelopeDocument = Schema.Struct({
  resource: Schema.Struct({
    items: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        version: Schema.String,
      })
    ),
  }),
});

const ApiPost = Schema.Struct({
  body: Schema.String,
  id: Schema.NumberFromString,
  title: Schema.String,
});

type ApiPost = typeof ApiPost.Type;

const ApiPostsDocument = Schema.Struct({
  posts: Schema.Array(ApiPost),
});

interface ApiPostsState {
  readonly detailCalls: number[];
  listCalls: number;
}

class ApiPosts extends Service<
  ApiPosts,
  {
    readonly getPost: (id: number) => Effect.Effect<ApiPost, SourcePluginError>;
    readonly listPostIds: () => Effect.Effect<
      readonly number[],
      SourcePluginError
    >;
  }
>()("@migrate-sdk/test/ApiPosts") {}

const makeApiPostsLayer = (state: ApiPostsState): Layer.Layer<ApiPosts> =>
  Layer.sync(ApiPosts, () => {
    const posts = new Map<number, ApiPost>([
      [1, { body: "First body", id: 1, title: "First" }],
      [2, { body: "Second body", id: 2, title: "Second" }],
    ]);

    const getPost = (id: number) =>
      Effect.gen(function* () {
        state.detailCalls.push(id);
        const post = posts.get(id);

        if (post === undefined) {
          return yield* new SourcePluginError({
            message: "Post was not found",
            cause: { id },
          });
        }

        return post;
      });

    const listPostIds = () =>
      Effect.sync(() => {
        state.listCalls += 1;
        return Array.from(posts.keys());
      });

    return {
      getPost,
      listPostIds,
    };
  });

const testPlatformLayer = Layer.mergeAll(nodeFileSystemLayer, nodePathLayer);
const sha256HexPattern = /^[a-f0-9]{64}$/;

const writeCompaniesFile = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.writeFileString(
      filePath,
      JSON.stringify({
        businessUnits: [
          {
            addresses: [
              { city: "Austin", key: "ADDR-100-BILL" },
              { city: "Round Rock", key: "ADDR-100-SHIP" },
            ],
            contacts: [
              { email: "avery@example.com", key: "CONTACT-100-1" },
              { email: "morgan@example.com", key: "CONTACT-100-2" },
            ],
            key: "BU-100",
            name: "Orbit Labs",
            status: "active",
          },
          {
            addresses: [{ city: "Denver", key: "ADDR-200-SHIP" }],
            contacts: [{ email: "riley@example.com", key: "CONTACT-200-1" }],
            key: "BU-200",
            name: "River Market",
            status: "inactive",
          },
        ],
        exportedAt: "2026-05-14",
      })
    );
  });

describe("DocumentSourcePlugin", () => {
  it.effect(
    "composes an effect-native fetcher with a materialized schema parser",
    () =>
      Effect.gen(function* () {
        const state: ApiPostsState = {
          detailCalls: [],
          listCalls: 0,
        };
        const source = DocumentSourcePlugin.make({
          fetcher: DocumentFetchers.effect({
            cursorSchema: Schema.Null,
            read: () =>
              Effect.gen(function* () {
                const api = yield* ApiPosts;
                const postIds = yield* api.listPostIds();
                const posts = yield* Effect.forEach(
                  postIds,
                  (id) => api.getPost(id),
                  { concurrency: 2 }
                );

                return {
                  fingerprint: `posts:${postIds.join(",")}`,
                  resource: { posts },
                };
              }),
            layer: makeApiPostsLayer(state),
          }),
          parser: DocumentParsers.schema("api-posts", ApiPostsDocument),
          selector: {
            item: (document) => document.posts,
          },
          identity: ({ item }) => {
            expectTypeOf(item.body).toEqualTypeOf<string>();

            return item.id;
          },
          lookup: { kind: "scan" },
          version: {
            kind: "value",
            value: ({ item }) => item.title,
          },
        });
        const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
        const read = yield* plugin.read(null);

        expect(read.items).toEqual([
          {
            identity: "1",
            item: { item: { body: "First body", id: 1, title: "First" } },
            version: "First",
          },
          {
            identity: "2",
            item: { item: { body: "Second body", id: 2, title: "Second" } },
            version: "Second",
          },
        ]);
        expect(state.listCalls).toBe(1);
        expect(state.detailCalls).toEqual([1, 2]);
      })
  );

  it.effect("reads top-level selected document items", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-sdk-document-source-",
      });
      const filePath = path.join(directory, "companies.json");
      yield* writeCompaniesFile(filePath);

      const source = DocumentSourcePlugin.make({
        fetcher: DocumentFetchers.fileText({
          path: filePath,
          platform: testPlatformLayer,
        }),
        parser: DocumentParsers.json(CompaniesDocument),
        selector: {
          item: (document) => document.businessUnits,
        },
        identity: ({ item }) => item.key,
        lookup: { kind: "scan" },
        version: {
          kind: "value",
          value: ({ item }) => item.status,
        },
      });
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
      const read = yield* plugin.read(null);

      expect(read.items.map((sourceItem) => sourceItem.identity)).toEqual([
        "BU-100",
        "BU-200",
      ]);
      expect(read.items[0]?.version).toBe("active");
      expect(read.items[0]?.item).toEqual({
        item: {
          addresses: [
            { city: "Austin", key: "ADDR-100-BILL" },
            { city: "Round Rock", key: "ADDR-100-SHIP" },
          ],
          contacts: [
            { email: "avery@example.com", key: "CONTACT-100-1" },
            { email: "morgan@example.com", key: "CONTACT-100-2" },
          ],
          key: "BU-100",
          name: "Orbit Labs",
          status: "active",
        },
      });
    }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect("reads nested selected document items with parent context", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-sdk-document-source-",
      });
      const filePath = path.join(directory, "companies.json");
      yield* writeCompaniesFile(filePath);

      const source = DocumentSourcePlugin.make({
        fetcher: DocumentFetchers.fileText({
          path: filePath,
          platform: testPlatformLayer,
        }),
        parser: DocumentParsers.json(CompaniesDocument),
        selector: {
          parent: (document) => document.businessUnits,
          item: (businessUnit) => businessUnit.contacts,
        },
        identity: ({ item, parent }) => {
          expectTypeOf(parent.name).toEqualTypeOf<string>();
          expectTypeOf(item.email).toEqualTypeOf<string>();

          return [parent.key, item.key];
        },
        lookup: { kind: "scan" },
        version: { kind: "content-hash" },
      });
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
      const read = yield* plugin.read(null);
      const found = yield* plugin.readByIdentity(
        toSourceIdentity(JSON.stringify(["BU-200", "CONTACT-200-1"]))
      );

      expect(read.items.map((sourceItem) => sourceItem.identity)).toEqual([
        JSON.stringify(["BU-100", "CONTACT-100-1"]),
        JSON.stringify(["BU-100", "CONTACT-100-2"]),
        JSON.stringify(["BU-200", "CONTACT-200-1"]),
      ]);
      expect(read.items[0]?.version).toMatch(sha256HexPattern);
      expect(read.items[0]?.item.parent.name).toBe("Orbit Labs");
      expect(read.items[0]?.item.item.email).toBe("avery@example.com");
      expect(found?.item.parent.name).toBe("River Market");
      expect(found?.item.item.email).toBe("riley@example.com");
    }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect(
    "uses parser-decoded selected values without decoding them again",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-sdk-document-source-",
        });
        const filePath = path.join(directory, "inventory.json");
        yield* fs.writeFileString(
          filePath,
          JSON.stringify({
            items: [{ inventory: "42", key: "sku-1" }],
          })
        );

        const source = DocumentSourcePlugin.make({
          fetcher: DocumentFetchers.fileText({
            path: filePath,
            platform: testPlatformLayer,
          }),
          parser: DocumentParsers.json(InventoryDocument),
          selector: {
            item: (document) => document.items,
          },
          identity: ({ item }) => item.key,
          lookup: { kind: "scan" },
          version: { kind: "content-hash" },
        });
        const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
        const read = yield* plugin.read(null);

        expect(read.items[0]?.identity).toBe("sku-1");
        expect(read.items[0]?.item.item.inventory).toBe(42n);
        expect(read.items[0]?.version).toMatch(sha256HexPattern);
      }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect(
    "keeps direct lookup resources explicit when the resource also has a resource field",
    () =>
      Effect.gen(function* () {
        type ObjectResource = typeof ResourceEnvelopeDocument.Type;
        const fetcher: DocumentFetcher<ObjectResource, null> = {
          cursorSchema: Schema.Null,
          read: () =>
            Effect.fail(
              new SourcePluginError({
                message: "Direct lookup should not use scan fetcher read",
              })
            ),
        };
        const parser: DocumentParser<ObjectResource, ObjectResource> = {
          documentSchema: ResourceEnvelopeDocument,
          name: "object-resource",
          parse: (resource) =>
            Schema.decodeUnknownEffect(ResourceEnvelopeDocument)(resource).pipe(
              Effect.map((document) => [document]),
              Effect.mapError(
                (cause) =>
                  new SourcePluginError({
                    cause,
                    message: "Object resource did not match document schema",
                  })
              )
            ),
        };
        const lookupResult: DocumentSourceDirectLookupResult<
          ObjectResource,
          null
        > = {
          resource: {
            resource: {
              items: [{ key: "item-1", version: "v1" }],
            },
          },
        };

        expectTypeOf<typeof lookupResult>().toEqualTypeOf<
          DocumentFetchResult<ObjectResource, null>
        >();

        const source = DocumentSourcePlugin.make({
          fetcher,
          parser,
          selector: {
            item: (document) => document.resource.items,
          },
          identity: ({ item }) => item.key,
          lookup: {
            kind: "direct",
            read: () => Effect.succeed(lookupResult),
          },
          version: {
            kind: "value",
            value: ({ item }) => item.version,
          },
        });
        const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
        const found = yield* plugin.readByIdentity(toSourceIdentity("item-1"));

        expect(found?.item.item.key).toBe("item-1");
        expect(found?.version).toBe("v1");
      })
  );

  it.effect(
    "reads direct lookup resources and verifies requested identity",
    () =>
      Effect.gen(function* () {
        const fetcher: DocumentFetcher<string, null> = {
          cursorSchema: Schema.Null,
          read: () =>
            Effect.fail(
              new SourcePluginError({
                message: "Direct lookup should not use scan fetcher read",
              })
            ),
        };
        const source = DocumentSourcePlugin.make({
          fetcher,
          parser: DocumentParsers.json(CompaniesDocument),
          selector: {
            parent: (document) => document.businessUnits,
            item: (businessUnit) => businessUnit.contacts,
          },
          identity: ({ item, parent }) => [parent.key, item.key],
          lookup: {
            kind: "direct",
            read: () =>
              Effect.succeed({
                resource: JSON.stringify({
                  businessUnits: [
                    {
                      addresses: [],
                      contacts: [
                        { email: "riley@example.com", key: "CONTACT-200-1" },
                      ],
                      key: "BU-200",
                      name: "River Market",
                      status: "inactive",
                    },
                  ],
                  exportedAt: "2026-05-14",
                }),
              }),
          },
          version: {
            kind: "value",
            value: ({ item }) => item.email,
          },
        });
        const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
        const found = yield* plugin.readByIdentity(
          toSourceIdentity(JSON.stringify(["BU-200", "CONTACT-200-1"]))
        );
        const missing = yield* plugin.readByIdentity(
          toSourceIdentity(JSON.stringify(["BU-200", "missing"]))
        );

        expect(found?.item.parent.name).toBe("River Market");
        expect(found?.item.item.email).toBe("riley@example.com");
        expect(found?.version).toBe("riley@example.com");
        expect(missing).toBeNull();
      })
  );

  it.effect(
    "paginates selected items with a document source cursor envelope",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-sdk-document-source-",
        });
        const filePath = path.join(directory, "companies.json");
        yield* writeCompaniesFile(filePath);

        const source = DocumentSourcePlugin.make({
          batchSize: 2,
          fetcher: DocumentFetchers.fileText({
            path: filePath,
            platform: testPlatformLayer,
          }),
          parser: DocumentParsers.json(CompaniesDocument),
          selector: {
            parent: (document) => document.businessUnits,
            item: (businessUnit) => businessUnit.contacts,
          },
          identity: ({ item, parent }) => [parent.key, item.key],
          lookup: { kind: "scan" },
          version: {
            kind: "value",
            value: ({ item }) => item.email,
          },
        });
        const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
        const first = yield* plugin.read(null);
        const second = yield* plugin.read(first.nextCursor ?? null);

        expect(first.items.map((sourceItem) => sourceItem.identity)).toEqual([
          JSON.stringify(["BU-100", "CONTACT-100-1"]),
          JSON.stringify(["BU-100", "CONTACT-100-2"]),
        ]);
        expect(first.nextCursor).toEqual(
          expect.objectContaining({
            fetcherCursor: null,
            nextDocumentIndex: 0,
            nextItemIndex: 2,
          })
        );
        expect(first.nextCursor?.resourceFingerprint).toMatch(sha256HexPattern);
        expect(second.items.map((sourceItem) => sourceItem.identity)).toEqual([
          JSON.stringify(["BU-200", "CONTACT-200-1"]),
        ]);
        expect(second.nextCursor).toBeUndefined();
      }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect("advances fetcher cursor when parser returns zero documents", () =>
    Effect.gen(function* () {
      const PageDocument = Schema.Struct({
        items: Schema.Array(
          Schema.Struct({
            key: Schema.String,
            version: Schema.String,
          })
        ),
      });
      const fetcher: DocumentFetcher<string, number> = {
        cursorSchema: Schema.Number,
        read: (cursor) =>
          Effect.succeed(
            cursor === null
              ? { nextCursor: 1, resource: "empty" }
              : {
                  resource: JSON.stringify({
                    items: [{ key: "page-2-item", version: "v2" }],
                  }),
                }
          ),
      };
      const source = DocumentSourcePlugin.make({
        fetcher,
        parser: {
          documentSchema: PageDocument,
          name: "test-pages",
          parse: (resource) =>
            resource === "empty"
              ? Effect.succeed([])
              : DocumentParsers.json(PageDocument).parse(resource),
        },
        selector: {
          item: (document) => document.items,
        },
        identity: ({ item }) => item.key,
        lookup: { kind: "scan" },
        version: {
          kind: "value",
          value: ({ item }) => item.version,
        },
      });
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
      const emptyPage = yield* plugin.read(null);
      const nextPage = yield* plugin.read(emptyPage.nextCursor ?? null);

      expect(emptyPage.items).toEqual([]);
      expect(emptyPage.nextCursor).toEqual({
        fetcherCursor: 1,
        nextDocumentIndex: 0,
        nextItemIndex: 0,
      });
      expect(nextPage.items.map((item) => item.identity)).toEqual([
        "page-2-item",
      ]);
      expect(nextPage.nextCursor).toBeUndefined();
    })
  );

  it.effect("fails duplicate selected identities for reads and lookups", () =>
    Effect.gen(function* () {
      const duplicatedResource = JSON.stringify({
        businessUnits: [
          {
            addresses: [],
            contacts: [],
            key: "BU-DUP",
            name: "Duplicate One",
            status: "active",
          },
          {
            addresses: [],
            contacts: [],
            key: "BU-DUP",
            name: "Duplicate Two",
            status: "inactive",
          },
        ],
        exportedAt: "2026-05-14",
      });
      const fetcher: DocumentFetcher<string, null> = {
        cursorSchema: Schema.Null,
        read: () => Effect.succeed({ resource: duplicatedResource }),
      };
      const source = DocumentSourcePlugin.make({
        fetcher,
        parser: DocumentParsers.json(CompaniesDocument),
        selector: {
          item: (document) => document.businessUnits,
        },
        identity: ({ item }) => item.key,
        lookup: {
          kind: "direct",
          read: () => Effect.succeed({ resource: duplicatedResource }),
        },
        version: {
          kind: "value",
          value: ({ item }) => item.status,
        },
      });
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
      const readExit = yield* Effect.exit(plugin.read(null));
      const lookupExit = yield* Effect.exit(
        plugin.readByIdentity(toSourceIdentity("BU-DUP"))
      );

      expect(readExit._tag).toBe("Failure");
      expect(lookupExit._tag).toBe("Failure");
      if (readExit._tag === "Failure") {
        expect(String(readExit.cause)).toContain(
          "Duplicate document source identity"
        );
      }
      if (lookupExit._tag === "Failure") {
        expect(String(lookupExit.cause)).toContain(
          "Duplicate document source identity"
        );
      }
    })
  );

  it.effect("wraps parser failures with document source resource context", () =>
    Effect.gen(function* () {
      const fetcher: DocumentFetcher<string, null> = {
        cursorSchema: Schema.Null,
        read: () => Effect.succeed({ resource: "{not-json" }),
      };
      const source = DocumentSourcePlugin.make({
        fetcher,
        parser: DocumentParsers.json(CompaniesDocument),
        selector: {
          item: (document) => document.businessUnits,
        },
        identity: ({ item }) => item.key,
        lookup: {
          kind: "direct",
          read: () =>
            Effect.succeed({
              fingerprint: "resource-fingerprint",
              resource: "{not-json",
            }),
        },
        version: {
          kind: "value",
          value: ({ item }) => item.status,
        },
      });
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
      const error = yield* plugin
        .readByIdentity(toSourceIdentity("BU-100"))
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(SourcePluginError);
      expect(error.message).toBe("Unable to parse document source resource");
      expect(error.cause).toEqual(
        expect.objectContaining({
          diagnostic: expect.stringContaining("Unable to parse JSON document"),
          parser: "json",
          resourceFingerprint: "resource-fingerprint",
          sourceIdentity: "BU-100",
        })
      );
    })
  );

  it.effect("preserves direct lookup source plugin failures", () =>
    Effect.gen(function* () {
      const fetcher: DocumentFetcher<string, null> = {
        cursorSchema: Schema.Null,
        read: () => Effect.succeed({ resource: "{}" }),
      };
      const source = DocumentSourcePlugin.make({
        fetcher,
        parser: DocumentParsers.json(CompaniesDocument),
        selector: {
          item: (document) => document.businessUnits,
        },
        identity: ({ item }) => item.key,
        lookup: {
          kind: "direct",
          read: () =>
            Effect.fail(
              new SourcePluginError({
                message: "Direct lookup failed",
              })
            ),
        },
        version: {
          kind: "value",
          value: ({ item }) => item.status,
        },
      });
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
      const error = yield* plugin
        .readByIdentity(toSourceIdentity("BU-100"))
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(SourcePluginError);
      expect(error.message).toBe("Direct lookup failed");
    })
  );
});
