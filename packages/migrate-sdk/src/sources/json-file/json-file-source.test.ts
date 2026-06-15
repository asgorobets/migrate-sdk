import { layer as nodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { layer as nodePathLayer } from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import {
  JsonFileSourceCursor,
  JsonFileSourcePlugin,
} from "migrate-sdk/sources/json-file";
import { expectTypeOf } from "vitest";
import { SourceIdentity, toEncodedSourceIdentity } from "../../domain/ids.ts";
import { SourcePlugin } from "../../services/source-plugin.ts";

const JsonArticleSource = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  version: Schema.String,
  views: Schema.Number,
});

const JsonArticleWithoutIdentitySource = Schema.Struct({
  title: Schema.String,
  version: Schema.String,
  views: Schema.Number,
});

const JsonArticleWithoutVersionSource = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  views: Schema.Number,
});

const JsonLocalizedArticleSource = Schema.Struct({
  id: Schema.String,
  locale: Schema.String,
  title: Schema.String,
  views: Schema.Number,
});

const JsonArticleWithBigIntSource = Schema.Struct({
  id: Schema.String,
  inventory: Schema.BigIntFromString,
  title: Schema.String,
});

const JsonInventoryDocument = Schema.Struct({
  items: Schema.Array(JsonArticleWithBigIntSource),
});

const JsonCompanyContactSource = Schema.Struct({
  email: Schema.String,
  firstName: Schema.String,
  isPrimary: Schema.Boolean,
  key: Schema.String,
  lastName: Schema.String,
});

const JsonCompanyAddressSource = Schema.Struct({
  city: Schema.String,
  country: Schema.String,
  key: Schema.String,
  postalCode: Schema.String,
  region: Schema.String,
  street: Schema.String,
  type: Schema.Literals(["billing", "shipping"]),
});

const JsonCompanyBusinessUnitSource = Schema.Struct({
  addresses: Schema.Array(JsonCompanyAddressSource),
  contacts: Schema.Array(JsonCompanyContactSource),
  key: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["active", "inactive"]),
});

const JsonCompaniesDocument = Schema.Struct({
  businessUnits: Schema.Array(JsonCompanyBusinessUnitSource),
  exportedAt: Schema.String,
});

const sha256HexPattern = /^[a-f0-9]{64}$/;

const testPlatformLayer = Layer.mergeAll(nodeFileSystemLayer, nodePathLayer);

const tuple2 = <A, B>(first: A, second: B): readonly [A, B] => [first, second];

const fieldSelector = <Field extends string>(
  field: Field
): {
  readonly field: Field;
  readonly kind: "field";
} => ({
  field,
  kind: "field",
});

const fieldsSelector = <const Fields extends readonly [string, ...string[]]>(
  fields: Fields
): {
  readonly fields: Fields;
  readonly kind: "fields";
} => ({
  fields,
  kind: "fields",
});

const JsonArticleIdentity = {
  id: "json-article@v1",
  key: fieldSelector("id"),
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
};

const JsonLocalizedArticleIdentity = {
  id: "json-localized-article@v1",
  key: fieldsSelector(["id", "locale"]),
  schema: SourceIdentity.tuple([
    SourceIdentity.part("id", Schema.NonEmptyString),
    SourceIdentity.part("locale", Schema.NonEmptyString),
  ]),
};

const JsonBusinessUnitIdentity = {
  id: "json-business-unit@v1",
  key: ({
    item,
  }: {
    readonly item: typeof JsonCompanyBusinessUnitSource.Type;
  }) => item.key,
  schema: SourceIdentity.key("businessUnitKey", Schema.NonEmptyString),
};

const JsonInventoryItemIdentity = {
  id: "json-inventory-item@v1",
  key: ({ item }: { readonly item: typeof JsonArticleWithBigIntSource.Type }) =>
    item.id,
  schema: SourceIdentity.key("inventoryItemId", Schema.NonEmptyString),
};

const JsonBusinessUnitChildIdentity = {
  id: "json-business-unit-child@v1",
  key: ({
    item,
    parent,
  }: {
    readonly item:
      | typeof JsonCompanyAddressSource.Type
      | typeof JsonCompanyContactSource.Type;
    readonly parent: typeof JsonCompanyBusinessUnitSource.Type;
  }) => tuple2(parent.key, item.key),
  schema: SourceIdentity.tuple([
    SourceIdentity.part("businessUnitKey", Schema.NonEmptyString),
    SourceIdentity.part("childKey", Schema.NonEmptyString),
  ]),
};

describe("JsonFileSourcePlugin source entrypoint", () => {
  it("exports the configured source factory and cursor schema", () => {
    expect(JsonFileSourcePlugin).toHaveProperty("make");
    expect(JsonFileSourcePlugin).toHaveProperty("makeFromDocument");
    expect(JsonFileSourceCursor.ast).toBeDefined();
  });
});

describe("JsonFileSourcePlugin", () => {
  it.effect("reads decoded records from a configured JSON path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-sdk-json-file-",
      });
      const filePath = path.join(directory, "articles.json");
      yield* fs.writeFileString(
        filePath,
        JSON.stringify({
          data: {
            articles: [
              { id: "article-1", title: "Hello", version: "v1", views: 7 },
              { id: "article-2", title: "Again", version: "v2", views: 9 },
            ],
          },
        })
      );

      const source = JsonFileSourcePlugin.make({
        identity: JsonArticleIdentity,
        items: { path: "$.data.articles" },
        path: filePath,
        platform: testPlatformLayer,
        sourceSchema: JsonArticleSource,
        version: { field: "version", kind: "field" },
      });
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
      const read = yield* plugin.read(null);

      expect(read.items).toHaveLength(2);
      expect(read.items[0]?.identity.encoded).toBe("article-1");
      expect(read.items[0]?.version).toBe("v1");
      expect(read.items[0]?.item).toEqual({
        id: "article-1",
        title: "Hello",
        version: "v1",
        views: 7,
      });
    }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect("paginates reads with batchSize and stops at EOF", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-sdk-json-file-",
      });
      const filePath = path.join(directory, "articles.json");
      yield* fs.writeFileString(
        filePath,
        JSON.stringify({
          articles: [
            { id: "article-1", title: "One", version: "v1", views: 1 },
            { id: "article-2", title: "Two", version: "v2", views: 2 },
            { id: "article-3", title: "Three", version: "v3", views: 3 },
          ],
        })
      );

      const source = JsonFileSourcePlugin.make({
        batchSize: 2,
        identity: JsonArticleIdentity,
        items: { path: "$.articles" },
        path: filePath,
        platform: testPlatformLayer,
        sourceSchema: JsonArticleSource,
        version: { field: "version", kind: "field" },
      });
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
      const firstRead = yield* plugin.read(null);

      expect(firstRead.items.map((item) => item.identity.encoded)).toEqual([
        "article-1",
        "article-2",
      ]);
      expect(firstRead.nextCursor?.nextItemIndex).toBe(2);

      const secondRead = yield* plugin.read(firstRead.nextCursor ?? null);
      expect(secondRead.items.map((item) => item.identity.encoded)).toEqual([
        "article-3",
      ]);
      expect(secondRead.nextCursor).toBeUndefined();

      const eofRead = yield* plugin.read({
        fileFingerprint: firstRead.nextCursor?.fileFingerprint ?? "",
        nextItemIndex: 3,
      });
      expect(eofRead.items).toHaveLength(0);
      expect(eofRead.nextCursor).toBeUndefined();
    }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect("reads by identity from the current file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-sdk-json-file-",
      });
      const filePath = path.join(directory, "articles.json");
      yield* fs.writeFileString(
        filePath,
        JSON.stringify([
          { id: "article-1", title: "One", version: "v1", views: 1 },
          { id: "article-2", title: "Two", version: "v2", views: 2 },
        ])
      );

      const source = JsonFileSourcePlugin.make({
        identity: JsonArticleIdentity,
        items: { path: "$" },
        path: filePath,
        platform: testPlatformLayer,
        sourceSchema: JsonArticleSource,
        version: { field: "version", kind: "field" },
      });
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
      const found = yield* plugin.readByIdentity(
        SourceIdentity.fromEncoded(
          plugin.identity,
          toEncodedSourceIdentity("article-2")
        )
      );

      expect(found?.item.title).toBe("Two");
      expect(found?.version).toBe("v2");
      expect(
        yield* plugin.readByIdentity(
          SourceIdentity.fromEncoded(
            plugin.identity,
            toEncodedSourceIdentity("missing")
          )
        )
      ).toBeNull();
    }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect("supports multi-field identities and content-hash versions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-sdk-json-file-",
      });
      const filePath = path.join(directory, "articles.json");
      yield* fs.writeFileString(
        filePath,
        JSON.stringify([
          { id: "article-1", locale: "en-US", title: "One", views: 1 },
        ])
      );

      const source = JsonFileSourcePlugin.make({
        identity: JsonLocalizedArticleIdentity,
        items: { path: "$" },
        path: filePath,
        platform: testPlatformLayer,
        sourceSchema: JsonLocalizedArticleSource,
        version: { kind: "content-hash" },
      });
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
      const read = yield* plugin.read(null);

      expect(read.items[0]?.identity.encoded).toBe(
        JSON.stringify(["article-1", "en-US"])
      );
      expect(read.items[0]?.version).toMatch(sha256HexPattern);
    }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect("builds content-hash versions from schema-encoded items", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-sdk-json-file-",
      });
      const filePath = path.join(directory, "articles.json");
      yield* fs.writeFileString(
        filePath,
        JSON.stringify([{ id: "article-1", inventory: "42", title: "One" }])
      );

      const source = JsonFileSourcePlugin.make({
        identity: JsonArticleIdentity,
        items: { path: "$" },
        path: filePath,
        platform: testPlatformLayer,
        sourceSchema: JsonArticleWithBigIntSource,
        version: { kind: "content-hash" },
      });
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
      const read = yield* plugin.read(null);

      expect(read.items[0]?.item.inventory).toBe(42n);
      expect(read.items[0]?.version).toMatch(sha256HexPattern);
    }).pipe(Effect.provide(testPlatformLayer))
  );

  it("infers source item and parent types from document selectors", () => {
    const source = JsonFileSourcePlugin.make({
      documentSchema: JsonCompaniesDocument,
      items: {
        parentSelector: (document) => document.businessUnits,
        selector: (businessUnit) => businessUnit.contacts,
      },
      identity: {
        id: "json-company-contact@v1",
        key: ({ item, parent }) => {
          expectTypeOf(parent.key).toEqualTypeOf<string>();
          expectTypeOf(item.key).toEqualTypeOf<string>();

          return tuple2(parent.key, item.key);
        },
        schema: JsonBusinessUnitChildIdentity.schema,
      },
      path: "not-read-in-type-test.json",
      platform: testPlatformLayer,
      version: {
        kind: "value",
        value: ({ item, parent }) => `${parent.key}:${item.key}`,
      },
    });
    type ContactSource = typeof source.sourceSchema.Type;

    expectTypeOf<ContactSource["parent"]>().toEqualTypeOf<{
      readonly addresses: readonly (typeof JsonCompanyAddressSource.Type)[];
      readonly contacts: readonly (typeof JsonCompanyContactSource.Type)[];
      readonly key: string;
      readonly name: string;
      readonly status: "active" | "inactive";
    }>();
    expectTypeOf<ContactSource["item"]["email"]>().toEqualTypeOf<string>();
  });

  it("infers top-level source item types from document selectors", () => {
    const source = JsonFileSourcePlugin.make({
      documentSchema: JsonCompaniesDocument,
      items: {
        selector: (document) => document.businessUnits,
      },
      identity: {
        id: "json-business-unit@v1",
        key: ({ item }) => {
          expectTypeOf(item.key).toEqualTypeOf<string>();

          return item.key;
        },
        schema: JsonBusinessUnitIdentity.schema,
      },
      path: "not-read-in-type-test.json",
      platform: testPlatformLayer,
      version: {
        kind: "value",
        value: ({ item }) => item.status,
      },
    });
    type BusinessUnitSource = typeof source.sourceSchema.Type;

    expectTypeOf<BusinessUnitSource["item"]["key"]>().toEqualTypeOf<string>();
  });

  it.effect(
    "decodes projected document items with schema transforms once",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-sdk-json-file-",
        });
        const filePath = path.join(directory, "inventory.json");
        yield* fs.writeFileString(
          filePath,
          JSON.stringify({
            items: [{ id: "article-1", inventory: "42", title: "One" }],
          })
        );

        const source = JsonFileSourcePlugin.make({
          documentSchema: JsonInventoryDocument,
          items: {
            selector: (document) => document.items,
          },
          identity: JsonInventoryItemIdentity,
          path: filePath,
          platform: testPlatformLayer,
          version: { kind: "content-hash" },
        });
        const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
        const read = yield* plugin.read(null);

        expect(read.items[0]?.identity.encoded).toBe("article-1");
        expect(read.items[0]?.item.item.inventory).toBe(42n);
        expect(read.items[0]?.version).toMatch(sha256HexPattern);
      }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect(
    "projects multiple source slices from the same schema-backed document",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-sdk-json-file-",
        });
        const filePath = path.join(directory, "companies.json");
        yield* fs.writeFileString(
          filePath,
          JSON.stringify({
            businessUnits: [
              {
                addresses: [
                  {
                    city: "Austin",
                    country: "US",
                    key: "ADDR-100-BILL",
                    postalCode: "78701",
                    region: "TX",
                    street: "100 Market Street",
                    type: "billing",
                  },
                  {
                    city: "Austin",
                    country: "US",
                    key: "ADDR-100-SHIP",
                    postalCode: "78744",
                    region: "TX",
                    street: "250 Warehouse Road",
                    type: "shipping",
                  },
                ],
                contacts: [
                  {
                    email: "avery@example.com",
                    firstName: "Avery",
                    isPrimary: true,
                    key: "CONTACT-100-1",
                    lastName: "Stone",
                  },
                  {
                    email: "morgan@example.com",
                    firstName: "Morgan",
                    isPrimary: false,
                    key: "CONTACT-100-2",
                    lastName: "Lee",
                  },
                ],
                key: "BU-100",
                name: "Orbit Labs",
                status: "active",
              },
              {
                addresses: [
                  {
                    city: "Denver",
                    country: "US",
                    key: "ADDR-200-SHIP",
                    postalCode: "80216",
                    region: "CO",
                    street: "18 Loading Dock Lane",
                    type: "shipping",
                  },
                ],
                contacts: [
                  {
                    email: "riley@example.com",
                    firstName: "Riley",
                    isPrimary: true,
                    key: "CONTACT-200-1",
                    lastName: "Chen",
                  },
                ],
                key: "BU-200",
                name: "River Market",
                status: "inactive",
              },
            ],
            exportedAt: "2026-05-14",
          })
        );
        const businessUnitSource = JsonFileSourcePlugin.make({
          batchSize: 1,
          documentSchema: JsonCompaniesDocument,
          items: {
            selector: (document) => document.businessUnits,
          },
          identity: JsonBusinessUnitIdentity,
          path: filePath,
          platform: testPlatformLayer,
          version: {
            kind: "value",
            value: ({ item }) => item.status,
          },
        });
        const contactSource = JsonFileSourcePlugin.make({
          documentSchema: JsonCompaniesDocument,
          items: {
            parentSelector: (document) => document.businessUnits,
            selector: (businessUnit) => businessUnit.contacts,
          },
          identity: JsonBusinessUnitChildIdentity,
          path: filePath,
          platform: testPlatformLayer,
          version: { kind: "content-hash" },
        });
        const addressSource = JsonFileSourcePlugin.make({
          documentSchema: JsonCompaniesDocument,
          items: {
            parentSelector: (document) => document.businessUnits,
            selector: (businessUnit) => businessUnit.addresses,
          },
          identity: JsonBusinessUnitChildIdentity,
          path: filePath,
          platform: testPlatformLayer,
          version: { kind: "content-hash" },
        });
        const businessUnitPlugin = yield* SourcePlugin.pipe(
          Effect.provide(businessUnitSource.layer)
        );
        const firstBusinessUnitRead = yield* businessUnitPlugin.read(null);
        const secondBusinessUnitRead = yield* businessUnitPlugin.read(
          firstBusinessUnitRead.nextCursor ?? null
        );

        expect(
          firstBusinessUnitRead.items.map((item) => item.identity.encoded)
        ).toEqual(["BU-100"]);
        expect(
          secondBusinessUnitRead.items.map((item) => item.identity.encoded)
        ).toEqual(["BU-200"]);
        expect(firstBusinessUnitRead.items[0]?.item.item.name).toBe(
          "Orbit Labs"
        );

        const contactPlugin = yield* SourcePlugin.pipe(
          Effect.provide(contactSource.layer)
        );
        const contactRead = yield* contactPlugin.read(null);
        const foundContact = yield* contactPlugin.readByIdentity(
          SourceIdentity.fromEncoded(
            contactPlugin.identity,
            toEncodedSourceIdentity(JSON.stringify(["BU-200", "CONTACT-200-1"]))
          )
        );

        expect(contactRead.items.map((item) => item.identity.encoded)).toEqual([
          JSON.stringify(["BU-100", "CONTACT-100-1"]),
          JSON.stringify(["BU-100", "CONTACT-100-2"]),
          JSON.stringify(["BU-200", "CONTACT-200-1"]),
        ]);
        expect(contactRead.items[0]?.version).toMatch(sha256HexPattern);
        expect(contactRead.items[0]?.item).toEqual({
          item: {
            email: "avery@example.com",
            firstName: "Avery",
            isPrimary: true,
            key: "CONTACT-100-1",
            lastName: "Stone",
          },
          parent: {
            addresses: [
              {
                city: "Austin",
                country: "US",
                key: "ADDR-100-BILL",
                postalCode: "78701",
                region: "TX",
                street: "100 Market Street",
                type: "billing",
              },
              {
                city: "Austin",
                country: "US",
                key: "ADDR-100-SHIP",
                postalCode: "78744",
                region: "TX",
                street: "250 Warehouse Road",
                type: "shipping",
              },
            ],
            contacts: [
              {
                email: "avery@example.com",
                firstName: "Avery",
                isPrimary: true,
                key: "CONTACT-100-1",
                lastName: "Stone",
              },
              {
                email: "morgan@example.com",
                firstName: "Morgan",
                isPrimary: false,
                key: "CONTACT-100-2",
                lastName: "Lee",
              },
            ],
            key: "BU-100",
            name: "Orbit Labs",
            status: "active",
          },
        });
        expect(foundContact?.item.parent.name).toBe("River Market");
        expect(foundContact?.item.item.email).toBe("riley@example.com");

        const addressPlugin = yield* SourcePlugin.pipe(
          Effect.provide(addressSource.layer)
        );
        const addressRead = yield* addressPlugin.read(null);
        const foundAddress = yield* addressPlugin.readByIdentity(
          SourceIdentity.fromEncoded(
            addressPlugin.identity,
            toEncodedSourceIdentity(JSON.stringify(["BU-100", "ADDR-100-SHIP"]))
          )
        );

        expect(addressRead.items.map((item) => item.identity.encoded)).toEqual([
          JSON.stringify(["BU-100", "ADDR-100-BILL"]),
          JSON.stringify(["BU-100", "ADDR-100-SHIP"]),
          JSON.stringify(["BU-200", "ADDR-200-SHIP"]),
        ]);
        expect(addressRead.items[1]?.item.parent.name).toBe("Orbit Labs");
        expect(addressRead.items[1]?.item.parent.status).toBe("active");
        expect(addressRead.items[1]?.item.item.type).toBe("shipping");
        expect(foundAddress?.item.item.street).toBe("250 Warehouse Road");
      }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect("fails when a projected JSON document violates its schema", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-sdk-json-file-",
      });
      const filePath = path.join(directory, "invalid-companies.json");
      yield* fs.writeFileString(
        filePath,
        JSON.stringify({
          businessUnits: [],
          exportedAt: 20_260_514,
        })
      );
      const source = JsonFileSourcePlugin.make({
        documentSchema: JsonCompaniesDocument,
        items: {
          selector: (document) => document.businessUnits,
        },
        identity: JsonBusinessUnitIdentity,
        path: filePath,
        platform: testPlatformLayer,
        version: { kind: "content-hash" },
      });
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
      const exit = yield* Effect.exit(plugin.read(null));

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain(
          "JSON file document did not match Document Schema"
        );
      }
    }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect("restarts from the first item when file content changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-sdk-json-file-",
      });
      const filePath = path.join(directory, "articles.json");
      yield* fs.writeFileString(
        filePath,
        JSON.stringify([
          { id: "article-1", title: "One", version: "v1", views: 1 },
          { id: "article-2", title: "Two", version: "v2", views: 2 },
        ])
      );

      const source = JsonFileSourcePlugin.make({
        batchSize: 1,
        identity: JsonArticleIdentity,
        items: { path: "$" },
        path: filePath,
        platform: testPlatformLayer,
        sourceSchema: JsonArticleSource,
        version: { field: "version", kind: "field" },
      });
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
      const firstRead = yield* plugin.read(null);

      yield* fs.writeFileString(
        filePath,
        JSON.stringify([
          { id: "article-new", title: "Changed", version: "v3", views: 3 },
        ])
      );

      const changedRead = yield* plugin.read(firstRead.nextCursor ?? null);
      expect(changedRead.items.map((item) => item.identity.encoded)).toEqual([
        "article-new",
      ]);
      expect(changedRead.nextCursor).toBeUndefined();
    }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect("fails duplicate source identities before returning items", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-sdk-json-file-",
      });
      const filePath = path.join(directory, "articles.json");
      yield* fs.writeFileString(
        filePath,
        JSON.stringify([
          { id: "article-1", title: "One", version: "v1", views: 1 },
          { id: "article-1", title: "Two", version: "v2", views: 2 },
        ])
      );

      const source = JsonFileSourcePlugin.make({
        identity: JsonArticleIdentity,
        items: { path: "$" },
        path: filePath,
        platform: testPlatformLayer,
        sourceSchema: JsonArticleSource,
        version: { field: "version", kind: "field" },
      });
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
      const exit = yield* Effect.exit(plugin.read(null));

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain(
          "Duplicate JSON file source identity"
        );
        expect(String(exit.cause)).toContain("firstItemIndex");
        expect(String(exit.cause)).toContain("duplicateItemIndex");
      }
    }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect("fails source-read edge cases as SourcePluginError", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-sdk-json-file-",
      });

      const cases = [
        {
          content: "{not-json",
          expected: "Unable to parse JSON source file",
          name: "invalid-json",
        },
        {
          content: JSON.stringify({ article: { id: "article-1" } }),
          expected: "JSON file items path must resolve to array",
          name: "non-array-items-path",
        },
        {
          content: JSON.stringify([
            { id: "article-1", title: "One", version: "v1", views: "1" },
          ]),
          expected: "JSON file item did not match Source Payload Schema",
          name: "schema-decode",
        },
      ] as const;

      for (const testCase of cases) {
        const filePath = path.join(directory, `${testCase.name}.json`);
        yield* fs.writeFileString(filePath, testCase.content);
        const source = JsonFileSourcePlugin.make({
          identity: JsonArticleIdentity,
          items: { path: "$" },
          path: filePath,
          platform: testPlatformLayer,
          sourceSchema: JsonArticleSource,
          version: { field: "version", kind: "field" },
        });
        const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
        const exit = yield* Effect.exit(plugin.read(null));

        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(String(exit.cause)).toContain(testCase.expected);
        }
      }
    }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect("fails missing configured identity and version fields", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-sdk-json-file-",
      });
      const missingIdentityPath = path.join(directory, "missing-id.json");
      yield* fs.writeFileString(
        missingIdentityPath,
        JSON.stringify([{ title: "One", version: "v1", views: 1 }])
      );
      const identitySource = JsonFileSourcePlugin.make({
        identity: JsonArticleIdentity,
        items: { path: "$" },
        path: missingIdentityPath,
        platform: testPlatformLayer,
        sourceSchema: JsonArticleWithoutIdentitySource,
        version: { field: "version", kind: "field" },
      });
      const identityPlugin = yield* SourcePlugin.pipe(
        Effect.provide(identitySource.layer)
      );
      const identityExit = yield* Effect.exit(identityPlugin.read(null));

      expect(identityExit._tag).toBe("Failure");
      if (identityExit._tag === "Failure") {
        expect(String(identityExit.cause)).toContain(
          "JSON file identity field was not found"
        );
      }

      const missingVersionPath = path.join(directory, "missing-version.json");
      yield* fs.writeFileString(
        missingVersionPath,
        JSON.stringify([{ id: "article-1", title: "One", views: 1 }])
      );
      const versionSource = JsonFileSourcePlugin.make({
        identity: JsonArticleIdentity,
        items: { path: "$" },
        path: missingVersionPath,
        platform: testPlatformLayer,
        sourceSchema: JsonArticleWithoutVersionSource,
        version: { field: "version", kind: "field" },
      });
      const versionPlugin = yield* SourcePlugin.pipe(
        Effect.provide(versionSource.layer)
      );
      const versionExit = yield* Effect.exit(versionPlugin.read(null));

      expect(versionExit._tag).toBe("Failure");
      if (versionExit._tag === "Failure") {
        expect(String(versionExit.cause)).toContain(
          "JSON file version field was not found"
        );
      }
    }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect("fails non-positive batchSize early", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-sdk-json-file-",
      });
      const filePath = path.join(directory, "articles.json");
      yield* fs.writeFileString(filePath, "{not-json");

      const source = JsonFileSourcePlugin.make({
        batchSize: 0,
        identity: JsonArticleIdentity,
        items: { path: "$" },
        path: filePath,
        platform: testPlatformLayer,
        sourceSchema: JsonArticleSource,
        version: { field: "version", kind: "field" },
      });
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
      const exit = yield* Effect.exit(plugin.read(null));

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain(
          "JSON file source batchSize must be a positive integer"
        );
      }
    }).pipe(Effect.provide(testPlatformLayer))
  );
});
