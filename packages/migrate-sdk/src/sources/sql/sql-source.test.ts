import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { SqlClient, type Statement } from "effect/unstable/sql";
import {
  type ConfiguredSourcePlugin,
  defineMigration,
  InMemoryDestinationPlugin,
  InMemoryMigrationStore,
  type MigrationRunSummary,
  type RunMigrationError,
  runMigration,
  type SourceIdentityInput,
  type SourcePayloadSchema,
  SourcePlugin,
  SourcePluginError,
  type SourceVersionInput,
  toSourceIdentity,
} from "migrate-sdk";
import { SqlSourcePlugin } from "migrate-sdk/sources/sql";
import { expectTypeOf } from "vitest";

const SqlArticleRow = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  updated_at: Schema.String,
  views: Schema.NumberFromString,
});

type SqlArticle = typeof SqlArticleRow.Type;
type SqlArticleRow = Schema.Codec.Encoded<typeof SqlArticleRow>;

const SqlArticleCursor = Schema.Struct({
  id: Schema.String,
  updated_at: Schema.String,
});

type SqlArticleCursor = typeof SqlArticleCursor.Type;

const ArticleEntryFields = Schema.Struct({
  title: Schema.String,
  views: Schema.Number,
});

const metadataFailure = {
  kind: "failure" as const,
  message: "missing SQL source metadata",
};

interface SqlStatementCall {
  readonly strings: readonly string[];
  readonly values: readonly unknown[];
}

interface ScriptedSqlFailure {
  readonly cause: unknown;
  readonly kind: "failure";
}

type ScriptedSqlResult = readonly unknown[] | ScriptedSqlFailure;

const sqlFailure = (cause: unknown): ScriptedSqlFailure => ({
  cause,
  kind: "failure",
});

const isScriptedSqlFailure = (
  result: ScriptedSqlResult
): result is ScriptedSqlFailure =>
  typeof result === "object" &&
  result !== null &&
  !Array.isArray(result) &&
  "kind" in result &&
  result.kind === "failure";

const makeStatement = <A>(result: ScriptedSqlResult): Statement.Statement<A> =>
  (isScriptedSqlFailure(result)
    ? Effect.fail(result.cause)
    : Effect.succeed(
        result as readonly A[]
      )) as unknown as Statement.Statement<A>;

const makeFakeSqlClient = (results: readonly ScriptedSqlResult[]) => {
  const calls: SqlStatementCall[] = [];
  let index = 0;
  let transactionCount = 0;

  const client = (<A>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ) => {
    calls.push({
      strings: Array.from(strings),
      values,
    });

    const result = results[index] ?? [];
    index += 1;

    return makeStatement<A>(result);
  }) as SqlClient.SqlClient;

  Object.assign(client, {
    reactive: (() => {
      throw new Error("Fake SQL client does not implement reactive queries");
    }) as SqlClient.SqlClient["reactive"],
    reactiveMailbox: (() =>
      Effect.die(
        "Fake SQL client does not implement reactive mailboxes"
      )) as SqlClient.SqlClient["reactiveMailbox"],
    reserve: Effect.die("Fake SQL client does not implement reserve"),
    safe: client,
    transactionService: undefined as never,
    withTransaction: (<R, E, A>(effect: Effect.Effect<A, E, R>) =>
      Effect.sync(() => {
        transactionCount += 1;
      }).pipe(
        Effect.andThen(effect)
      )) as SqlClient.SqlClient["withTransaction"],
    withoutTransforms: () => client,
  });

  return {
    calls,
    layer: Layer.succeed(SqlClient.SqlClient, client),
    transactionCount: () => transactionCount,
  };
};

const articleRows = [
  {
    id: "article-1",
    title: "First article",
    updated_at: "2026-01-01T00:00:00.000Z",
    views: "7",
  },
  {
    id: "article-2",
    title: "Second article",
    updated_at: "2026-01-02T00:00:00.000Z",
    views: "11",
  },
] as const satisfies readonly [SqlArticleRow, SqlArticleRow];

const makeSqlArticleSource = () =>
  SqlSourcePlugin.make({
    batchSize: 2,
    cursorSchema: SqlArticleCursor,
    getSourceMetadata: (row, context) => {
      expectTypeOf(row).toEqualTypeOf<Readonly<SqlArticleRow>>();
      expectTypeOf(context).toEqualTypeOf<{ readonly rowIndex: number }>();

      return row.id.length === 0
        ? metadataFailure
        : {
            kind: "success",
            cursor: {
              id: row.id,
              updated_at: row.updated_at,
            },
            identity: row.id satisfies SourceIdentityInput,
            version: row.updated_at satisfies SourceVersionInput,
          };
    },
    lookup: (sql, identity) => {
      expectTypeOf(identity).toEqualTypeOf<SourceIdentityInput>();
      return sql<SqlArticleRow>`select id, title, updated_at, views from articles where id = ${identity}`;
    },
    read: (sql, cursor, limit) => {
      expectTypeOf(cursor).toEqualTypeOf<SqlArticleCursor | null>();
      expectTypeOf(limit).toEqualTypeOf<number>();

      return cursor === null
        ? sql<SqlArticleRow>`select id, title, updated_at, views from articles order by updated_at, id limit ${limit}`
        : sql<SqlArticleRow>`select id, title, updated_at, views from articles where (updated_at, id) > (${cursor.updated_at}, ${cursor.id}) order by updated_at, id limit ${limit}`;
    },
    sourceSchema: SqlArticleRow,
  });

describe("SqlSourcePlugin", () => {
  it("defines the raw SQL source contract from the source schema input side", () => {
    const source = makeSqlArticleSource();
    const fakeSql = makeFakeSqlClient([]);
    const providedSource = source.provide(fakeSql.layer);

    expectTypeOf(source.sourceSchema).toMatchTypeOf<
      SourcePayloadSchema<SqlArticle, SqlArticleRow>
    >();
    expectTypeOf(source).toMatchTypeOf<
      ConfiguredSourcePlugin<
        SqlArticle,
        SqlArticleCursor,
        SqlArticleRow,
        never,
        SqlClient.SqlClient
      >
    >();
    expectTypeOf(providedSource).toMatchTypeOf<
      ConfiguredSourcePlugin<
        SqlArticle,
        SqlArticleCursor,
        SqlArticleRow,
        never,
        never
      >
    >();
  });

  it.effect(
    "reads source items and looks up identities through a provided SQL client",
    () =>
      Effect.gen(function* () {
        const source = makeSqlArticleSource();
        const fakeSql = makeFakeSqlClient([articleRows, [articleRows[1]]]);
        const plugin = yield* SourcePlugin.pipe(
          Effect.provide(source.layer),
          Effect.provide(fakeSql.layer)
        );

        const page = yield* plugin.read(null);

        expect(page.items).toEqual([
          {
            identity: "article-1",
            item: articleRows[0],
            version: "2026-01-01T00:00:00.000Z",
          },
          {
            identity: "article-2",
            item: articleRows[1],
            version: "2026-01-02T00:00:00.000Z",
          },
        ]);
        expect(page.nextCursor).toEqual({
          id: "article-2",
          updated_at: "2026-01-02T00:00:00.000Z",
        });
        expect(fakeSql.calls[0]?.values).toEqual([2]);

        const item = yield* plugin.readByIdentity(
          toSourceIdentity("article-2")
        );

        expect(item).toEqual({
          identity: "article-2",
          item: articleRows[1],
          version: "2026-01-02T00:00:00.000Z",
        });
        expect(fakeSql.calls[1]?.values).toEqual(["article-2"]);
        expect(fakeSql.transactionCount()).toBe(0);
      })
  );

  it.effect("can close SQL client requirements on the source plugin", () =>
    Effect.gen(function* () {
      const fakeSql = makeFakeSqlClient([[articleRows[0]], []]);
      const source = makeSqlArticleSource().provide(fakeSql.layer);
      const storeState = InMemoryMigrationStore.makeState();
      const destination = InMemoryDestinationPlugin.makeEntries({
        commands: {
          upsertEntry: {
            fields: ArticleEntryFields,
          },
        },
        contentType: "article",
      });

      const definition = defineMigration({
        destination,
        id: "sql-articles",
        pipeline: (sourceItem) =>
          destination.commands.upsertEntry({
            title: sourceItem.item.title,
            views: sourceItem.item.views,
          }),
        source,
        store: InMemoryMigrationStore.layer(storeState),
      });

      expectTypeOf(runMigration(definition)).toMatchTypeOf<
        Effect.Effect<MigrationRunSummary, RunMigrationError, never>
      >();

      const summary = yield* runMigration(definition);

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions[0]?.counts).toEqual({
        failed: 0,
        migrated: 1,
        needsUpdate: 0,
        skipped: 0,
        unchanged: 0,
      });
      expect(fakeSql.calls[0]?.values).toEqual([2]);
    })
  );

  it.effect("keeps separately provided SQL source instances isolated", () =>
    Effect.gen(function* () {
      const legacyRows = [{ ...articleRows[0], id: "legacy-article" }];
      const crmRows = [{ ...articleRows[0], id: "crm-article" }];
      const legacySql = makeFakeSqlClient([legacyRows]);
      const crmSql = makeFakeSqlClient([crmRows]);
      const legacySource = makeSqlArticleSource().provide(legacySql.layer);
      const crmSource = makeSqlArticleSource().provide(crmSql.layer);
      const legacyPlugin = yield* SourcePlugin.pipe(
        Effect.provide(legacySource.layer)
      );
      const crmPlugin = yield* SourcePlugin.pipe(
        Effect.provide(crmSource.layer)
      );

      const legacyPage = yield* legacyPlugin.read(null);
      const crmPage = yield* crmPlugin.read(null);

      expect(legacyPage.items[0]?.identity).toBe("legacy-article");
      expect(crmPage.items[0]?.identity).toBe("crm-article");
      expect(legacySql.calls).toHaveLength(1);
      expect(crmSql.calls).toHaveLength(1);
    })
  );

  it.effect(
    "returns no cursor for empty reads and no item for empty lookups",
    () =>
      Effect.gen(function* () {
        const source = makeSqlArticleSource();
        const fakeSql = makeFakeSqlClient([[], []]);
        const plugin = yield* SourcePlugin.pipe(
          Effect.provide(source.layer),
          Effect.provide(fakeSql.layer)
        );

        const page = yield* plugin.read(null);
        const item = yield* plugin.readByIdentity(toSourceIdentity("missing"));

        expect(page).toEqual({ items: [] });
        expect(page.nextCursor).toBeUndefined();
        expect(item).toBeNull();
        expect(fakeSql.transactionCount()).toBe(0);
      })
  );

  it.effect("normalizes SQL execution failures through SourcePluginError", () =>
    Effect.gen(function* () {
      const source = makeSqlArticleSource();
      const cause = new Error("database unavailable");
      const fakeSql = makeFakeSqlClient([sqlFailure(cause)]);
      const plugin = yield* SourcePlugin.pipe(
        Effect.provide(source.layer),
        Effect.provide(fakeSql.layer)
      );

      const error = yield* Effect.flip(plugin.read(null));

      expect(error).toBeInstanceOf(SourcePluginError);
      expect(error.message).toBe("SQL source plugin read failed");
      expect(error.cause).toBe(cause);
    })
  );

  it.effect(
    "passes decoded SQL rows into the transformation pipeline through the runner",
    () =>
      Effect.gen(function* () {
        const source = makeSqlArticleSource();
        const fakeSql = makeFakeSqlClient([[articleRows[0]], []]);
        const storeState = InMemoryMigrationStore.makeState();
        const destination = InMemoryDestinationPlugin.makeEntries({
          commands: {
            upsertEntry: {
              fields: ArticleEntryFields,
            },
          },
          contentType: "article",
        });
        let decodedViews: number | undefined;

        const definition = defineMigration({
          destination,
          id: "sql-articles",
          pipeline: (sourceItem) => {
            decodedViews = sourceItem.item.views;

            return destination.commands.upsertEntry({
              title: sourceItem.item.title,
              views: sourceItem.item.views,
            });
          },
          source,
          store: InMemoryMigrationStore.layer(storeState),
        });

        expectTypeOf(runMigration(definition)).toMatchTypeOf<
          Effect.Effect<
            MigrationRunSummary,
            RunMigrationError,
            SqlClient.SqlClient
          >
        >();

        const summary = yield* runMigration(definition).pipe(
          Effect.provide(fakeSql.layer)
        );

        expect(summary.status).toBe("succeeded");
        expect(summary.definitions[0]?.counts).toEqual({
          failed: 0,
          migrated: 1,
          needsUpdate: 0,
          skipped: 0,
          unchanged: 0,
        });
        expect(decodedViews).toBe(7);
      })
  );

  it.effect(
    "stores invalid SQL row payloads as failed item state through the runner",
    () =>
      Effect.gen(function* () {
        const source = makeSqlArticleSource();
        const invalidRow = {
          ...articleRows[0],
          views: null as unknown as string,
        } satisfies SqlArticleRow;
        const fakeSql = makeFakeSqlClient([[invalidRow], []]);
        const storeState = InMemoryMigrationStore.makeState();
        const destination = InMemoryDestinationPlugin.makeEntries({
          commands: {
            upsertEntry: {
              fields: ArticleEntryFields,
            },
          },
          contentType: "article",
        });
        let pipelineCalls = 0;

        const definition = defineMigration({
          destination,
          id: "sql-articles",
          pipeline: (sourceItem) => {
            pipelineCalls += 1;

            return destination.commands.upsertEntry({
              title: sourceItem.item.title,
              views: sourceItem.item.views,
            });
          },
          source,
          store: InMemoryMigrationStore.layer(storeState),
        });

        const summary = yield* runMigration(definition).pipe(
          Effect.provide(fakeSql.layer)
        );
        const itemState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("sql-articles", "article-1")
        );

        expect(summary.status).toBe("failed");
        expect(summary.definitions[0]?.counts.failed).toBe(1);
        expect(pipelineCalls).toBe(0);
        expect(itemState).toEqual(
          expect.objectContaining({
            status: "failed",
          })
        );
        if (itemState?.status !== "failed") {
          throw new Error("Expected invalid SQL row to create failed state");
        }
        expect(itemState.error.errorTag).toBe("SourcePayloadSchemaError");
      })
  );
});
