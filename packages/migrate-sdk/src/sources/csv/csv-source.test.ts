import { layer as nodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { layer as nodePathLayer } from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, PlatformError, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import {
  defineMigration,
  InMemoryMigrationStore,
  MigrationProgress,
  type MigrationProgressEvent,
  runMigration,
} from "migrate-sdk";
import { CsvIdentity, CsvSourcePlugin } from "migrate-sdk/sources/csv";
import { SourceIdentity, toEncodedSourceIdentity } from "../../domain/ids.ts";
import { SourcePlugin } from "../../services/source-plugin.ts";
import { CsvParserCore, type CsvParserOptions } from "./csv-source.ts";

const CsvArticleSource = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  views: Schema.NumberFromString,
});

const CsvBookstoreCatalogRowSource = Schema.Struct({
  attributes_json: Schema.String,
  book_id: Schema.String,
  categories: Schema.String,
  catalog_version: Schema.String,
  co_author_ids: Schema.String,
  co_author_names: Schema.String,
  currency: Schema.String,
  description: Schema.String,
  format: Schema.String,
  inventory_count: Schema.NumberFromString,
  price: Schema.NumberFromString,
  primary_author_id: Schema.String,
  primary_author_name: Schema.String,
  slug: Schema.String,
  subtitle: Schema.String,
  title: Schema.String,
  variant_sku: Schema.String,
});

const sha256HexPattern = /^[a-f0-9]{64}$/;

const CsvArticleIdentity = CsvIdentity.column({
  column: "id",
  id: "csv-article@v1",
});

const CsvBookstoreCatalogIdentity = CsvIdentity.columns({
  columns: ["book_id", "format"],
  id: "csv-bookstore-catalog@v1",
});

const csvOptions: CsvParserOptions<string> = {
  dialect: { kind: "standard" },
  emptyRows: { kind: "skip" },
  headers: { kind: "from-row", rowIndex: 0 },
  identity: CsvArticleIdentity,
  version: { kind: "row-hash" },
};

const bookstoreCatalogOptions: CsvParserOptions<
  readonly [string, string, ...string[]]
> = {
  dialect: { kind: "standard" },
  emptyRows: { kind: "skip" },
  headers: { kind: "from-row", rowIndex: 2 },
  identity: CsvBookstoreCatalogIdentity,
  version: { kind: "column", column: "catalog_version" },
};

const testPlatformLayer = Layer.mergeAll(nodeFileSystemLayer, nodePathLayer);

const makeFirstReadFileFailurePlatformLayer = (state: {
  readFileAttempts: number;
}) => {
  const flakyFileSystemLayer = Layer.effect(
    FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem;

      return {
        ...fs,
        readFile: (filePath: string) =>
          Effect.sync(() => {
            state.readFileAttempts += 1;
            return state.readFileAttempts;
          }).pipe(
            Effect.flatMap((attempt) =>
              attempt === 1
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "Unknown",
                      description: "Transient test read failure",
                      method: "readFile",
                      module: "FileSystem",
                      pathOrDescriptor: filePath,
                    })
                  )
                : fs.readFile(filePath)
            )
          ),
      };
    })
  ).pipe(Layer.provide(nodeFileSystemLayer));

  return Layer.mergeAll(flakyFileSystemLayer, nodePathLayer);
};

describe("CsvParserCore", () => {
  it.effect(
    "parses source-native row records with stable identities and row hashes",
    () =>
      Effect.gen(function* () {
        const document = yield* CsvParserCore.parse(
          "\uFEFFid,title,views\n 42 ,  Hello ,7\n",
          csvOptions
        );

        expect(document.rows).toHaveLength(1);
        expect(document.rows[0]?.sourceItem.identityKey).toBe("42");
        expect(document.rows[0]?.sourceItem.version).toMatch(sha256HexPattern);
        expect(document.rows[0]?.sourceItem.item).toEqual({
          id: " 42 ",
          title: "  Hello ",
          views: "7",
        });
        expect(document.rows[0]?.rowIndex).toBe(1);
        expect(document.rows[0]?.lineNumber).toBe(2);
      })
  );

  it.effect("supports provided headers and custom separators", () =>
    Effect.gen(function* () {
      const document = yield* CsvParserCore.parse("42;Hello;7\n", {
        ...csvOptions,
        dialect: { kind: "custom", separator: ";" },
        headers: {
          kind: "provided",
          columns: ["id", "title", "views"],
          dataStartRowIndex: 0,
        },
      });

      expect(document.rows[0]?.sourceItem.item).toEqual({
        id: "42",
        title: "Hello",
        views: "7",
      });
    })
  );

  it.effect("parses UTF-8 bytes", () =>
    Effect.gen(function* () {
      const document = yield* CsvParserCore.parse(
        new TextEncoder().encode("id,title,views\n42,Hello,7\n"),
        csvOptions
      );

      expect(document.rows[0]?.sourceItem.identityKey).toBe("42");
    })
  );

  it.effect("fails blank header rows before column-dependent checks", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        CsvParserCore.parse("\n42,Hello,7\n", csvOptions)
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain(
          "CSV header must include at least one column"
        );
      }
    })
  );

  it.effect("fails Papa Parse parser errors as source read errors", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        CsvParserCore.parse('id,title,views\n42,"Unclosed,7\n', csvOptions)
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain("Unable to parse CSV source");
        expect(String(exit.cause)).toContain("MissingQuotes");
      }
    })
  );

  it.effect("fails invalid custom separators before Papa can fall back", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        CsvParserCore.parse("id,title\n42,Hello\n", {
          ...csvOptions,
          dialect: { kind: "custom", separator: "\n" },
        })
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain("CSV separator is not supported");
      }
    })
  );

  it.effect("fails records that Papa parses into multiple rows", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        CsvParserCore.parse('id,title\n42,a"bad\n43,ok\n', {
          ...csvOptions,
          identity: CsvArticleIdentity,
          version: { kind: "row-hash" },
        })
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain(
          "CSV logical record parsed into multiple rows"
        );
      }
    })
  );

  it.effect("fails duplicate source identities before item processing", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        CsvParserCore.parse(
          "id,title,views\n42,Hello,7\n42,Again,8\n",
          csvOptions
        )
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain("Duplicate CSV source identity");
        expect(String(exit.cause)).toContain("firstRowIndex");
        expect(String(exit.cause)).toContain("duplicateRowIndex");
      }
    })
  );

  it.effect(
    "treats explicit blank rows as source read errors when configured",
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          CsvParserCore.parse("id,title,views\n,,\n", {
            ...csvOptions,
            emptyRows: { kind: "error" },
          })
        );

        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(String(exit.cause)).toContain("CSV row is blank");
          expect(String(exit.cause)).toContain("rowIndex");
        }
      })
  );
});

describe("CsvSourcePlugin", () => {
  it("includes declarative identity columns in the source identity contract fingerprint", () => {
    const schema = SourceIdentity.key("articleId", Schema.NonEmptyString);
    const fromId = CsvSourcePlugin.make({
      ...csvOptions,
      identity: {
        id: "csv-article@v1",
        key: {
          columns: ["id"],
          kind: "columns",
        },
        schema,
      },
      path: "articles.csv",
      platform: testPlatformLayer,
      sourceSchema: CsvArticleSource,
    });
    const fromSlug = CsvSourcePlugin.make({
      ...csvOptions,
      identity: {
        id: "csv-article@v1",
        key: {
          columns: ["slug"],
          kind: "columns",
        },
        schema,
      },
      path: "articles.csv",
      platform: testPlatformLayer,
      sourceSchema: CsvArticleSource,
    });

    expect(fromId.identity.fingerprint).toBe(fromSlug.identity.fingerprint);
    expect(fromId.sourceIdentityContractFingerprint).not.toBe(
      fromSlug.sourceIdentityContractFingerprint
    );
  });

  it("includes source-native headers in the source identity contract fingerprint", () => {
    const fromIdColumn = CsvSourcePlugin.make({
      ...csvOptions,
      headers: {
        columns: ["id", "title", "views"],
        dataStartRowIndex: 0,
        kind: "provided",
      },
      path: "articles.csv",
      platform: testPlatformLayer,
      sourceSchema: CsvArticleSource,
    });
    const fromTitleColumn = CsvSourcePlugin.make({
      ...csvOptions,
      headers: {
        columns: ["title", "id", "views"],
        dataStartRowIndex: 0,
        kind: "provided",
      },
      path: "articles.csv",
      platform: testPlatformLayer,
      sourceSchema: CsvArticleSource,
    });

    expect(fromIdColumn.identity.fingerprint).toBe(
      fromTitleColumn.identity.fingerprint
    );
    expect(fromIdColumn.sourceIdentityContractFingerprint).not.toBe(
      fromTitleColumn.sourceIdentityContractFingerprint
    );
  });

  it("includes source-native dialect in the source identity contract fingerprint", () => {
    const commaSeparated = CsvSourcePlugin.make({
      ...csvOptions,
      headers: {
        columns: ["id", "title", "views"],
        dataStartRowIndex: 0,
        kind: "provided",
      },
      path: "articles.csv",
      platform: testPlatformLayer,
      sourceSchema: CsvArticleSource,
    });
    const semicolonSeparated = CsvSourcePlugin.make({
      ...csvOptions,
      dialect: { kind: "custom", separator: ";" },
      headers: {
        columns: ["id", "title", "views"],
        dataStartRowIndex: 0,
        kind: "provided",
      },
      path: "articles.csv",
      platform: testPlatformLayer,
      sourceSchema: CsvArticleSource,
    });

    expect(commaSeparated.identity.fingerprint).toBe(
      semicolonSeparated.identity.fingerprint
    );
    expect(commaSeparated.sourceIdentityContractFingerprint).not.toBe(
      semicolonSeparated.sourceIdentityContractFingerprint
    );
  });

  it.effect("reads a bookstore book catalog fixture", () =>
    Effect.gen(function* () {
      const path = yield* Path;
      const fixturePath = yield* path.fromFileUrl(
        new URL("./fixtures/bookstore-book-catalog.csv", import.meta.url)
      );
      const source = CsvSourcePlugin.make({
        ...bookstoreCatalogOptions,
        path: fixturePath,
        platform: testPlatformLayer,
        sourceSchema: CsvBookstoreCatalogRowSource,
      });
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
      const read = yield* plugin.read(null);

      expect(read.items).toHaveLength(4);
      expect(read.items.map((item) => item.identity.encoded)).toEqual([
        JSON.stringify(["BOOK-001", "paperback"]),
        JSON.stringify(["BOOK-001", "ebook"]),
        JSON.stringify(["BOOK-002", "hardcover"]),
        JSON.stringify(["BOOK-003", "box-set"]),
      ]);
      expect(read.items[0]?.version).toBe("2026-05-01T10:00:00Z");
      expect(read.items[0]?.item.co_author_ids).toBe("AUTH-002|AUTH-003");
      expect(read.items[1]?.item.attributes_json).toBe(
        '{"language":"en","drm_free":true}'
      );
      expect(read.items[2]?.item.title).toBe('Designing "Durable" Systems');
      expect(read.items[2]?.item.primary_author_name).toBe("Patel, Mina");
      expect(read.items[2]?.item.description).toContain(
        "Includes dependency notes"
      );

      const lookedUp = yield* plugin.readByIdentity(
        SourceIdentity.fromEncoded(
          plugin.identity,
          toEncodedSourceIdentity(JSON.stringify(["BOOK-002", "hardcover"]))
        )
      );

      expect(lookedUp?.item.primary_author_id).toBe("AUTH-002");
    }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect("counts totals from the native file load and parse path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-sdk-csv-",
      });
      const filePath = path.join(directory, "articles.csv");
      yield* fs.writeFileString(
        filePath,
        "id,title,views\n42,Hello,7\n43,Goodbye,8\n"
      );

      const source = CsvSourcePlugin.make({
        ...csvOptions,
        path: filePath,
        platform: testPlatformLayer,
        sourceSchema: CsvArticleSource,
      });
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));

      if (plugin.countTotal === undefined) {
        throw new Error("Expected CSV source total count");
      }

      const total = yield* plugin.countTotal();

      expect(total).toBe(2);
    }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect(
    "counts totals that respect provided headers, custom separators, and skipped blank rows",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-sdk-csv-",
        });
        const filePath = path.join(directory, "articles.csv");
        yield* fs.writeFileString(
          filePath,
          "metadata\n42;Hello;7\n\n43;Goodbye;8\n"
        );

        const source = CsvSourcePlugin.make({
          ...csvOptions,
          dialect: { kind: "custom", separator: ";" },
          headers: {
            columns: ["id", "title", "views"],
            dataStartRowIndex: 1,
            kind: "provided",
          },
          path: filePath,
          platform: testPlatformLayer,
          sourceSchema: CsvArticleSource,
        });
        const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));

        if (plugin.countTotal === undefined) {
          throw new Error("Expected CSV source total count");
        }

        const total = yield* plugin.countTotal();

        expect(total).toBe(2);
      }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect("fails total count when CSV cannot parse", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-sdk-csv-",
      });
      const filePath = path.join(directory, "articles.csv");
      yield* fs.writeFileString(filePath, "id,title,views\n,,\n");

      const source = CsvSourcePlugin.make({
        ...csvOptions,
        emptyRows: { kind: "error" },
        path: filePath,
        platform: testPlatformLayer,
        sourceSchema: CsvArticleSource,
      });
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));

      if (plugin.countTotal === undefined) {
        throw new Error("Expected CSV source total count");
      }

      const error = yield* Effect.flip(plugin.countTotal());

      expect(error).toEqual(
        expect.objectContaining({
          message: "CSV row is blank",
        })
      );
    }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect(
    "continues migration execution when CSV total count has a transient load failure",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-sdk-csv-",
        });
        const filePath = path.join(directory, "articles.csv");
        const platformState = { readFileAttempts: 0 };
        const progressEvents: MigrationProgressEvent[] = [];
        yield* fs.writeFileString(filePath, "id,title,views\n42,Hello,7\n");

        const source = CsvSourcePlugin.make({
          ...csvOptions,
          path: filePath,
          platform: makeFirstReadFileFailurePlatformLayer(platformState),
          sourceSchema: CsvArticleSource,
        });
        const definition = defineMigration({
          id: "articles",
          source,
          store: InMemoryMigrationStore.layer(),
          process: () => Effect.void,
        });
        const progressLayer = Layer.succeed(MigrationProgress, {
          countSourceItemTotals: true,
          emit: (event) =>
            Effect.sync(() => {
              progressEvents.push(event);
            }),
        });

        const summary = yield* runMigration(definition).pipe(
          Effect.provide(progressLayer)
        );

        expect(summary.status).toBe("succeeded");
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 1,
          skipped: 0,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(platformState.readFileAttempts).toBe(3);
        expect(progressEvents).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "source-item-total-counted",
              sourceItemTotal: expect.objectContaining({
                kind: "unknown",
                message: "Source Item total count failed",
                reason: "failed",
              }),
            }),
          ])
        );
      }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect("reads a path source once per file fingerprint", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-sdk-csv-",
      });
      const filePath = path.join(directory, "articles.csv");
      yield* fs.writeFileString(filePath, "id,title,views\n42,Hello,7\n");

      const source = CsvSourcePlugin.make({
        ...csvOptions,
        path: filePath,
        platform: testPlatformLayer,
        sourceSchema: CsvArticleSource,
      });
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
      const firstRead = yield* plugin.read(null);

      expect(firstRead.items).toHaveLength(1);
      expect(firstRead.nextCursor?.nextRowIndex).toBe(2);

      const secondRead = yield* plugin.read(firstRead.nextCursor ?? null);
      expect(secondRead.items).toHaveLength(0);
      expect(secondRead.nextCursor).toBeUndefined();

      yield* fs.writeFileString(filePath, "id,title,views\n42,Changed,8\n");
      const changedRead = yield* plugin.read(firstRead.nextCursor ?? null);

      expect(changedRead.items).toHaveLength(1);
      expect(changedRead.items[0]?.item).toEqual({
        id: "42",
        title: "Changed",
        views: "8",
      });
    }).pipe(Effect.provide(testPlatformLayer))
  );
});
