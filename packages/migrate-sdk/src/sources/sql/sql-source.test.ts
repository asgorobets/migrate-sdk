import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { SqlClient, type Statement } from "effect/unstable/sql";
import {
  type ConfiguredSourcePlugin,
  defineMigration,
  type EncodedSourceIdentityInput,
  InMemoryMigrationStore,
  MigrationProgress,
  type MigrationProgressEvent,
  type MigrationRunSummary,
  type RunMigrationError,
  runMigration,
  SourceIdentity,
  SourceItemTotal,
  type SourcePayloadSchema,
  SourcePlugin,
  SourcePluginError,
  type SourceVersionInput,
  toEncodedSourceIdentity,
} from "migrate-sdk";
import {
  SqlIdentity,
  type SqlSourceCount,
  SqlSourcePlugin,
} from "migrate-sdk/sources/sql";
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

const SqlArticleColumnIdentity = SqlIdentity.columns({
  id: "sql-article@v1",
  columns: [SqlIdentity.column("id", Schema.NonEmptyString)],
});

const SqliteArticleRow = Schema.Struct({
  content_hash: Schema.String,
  id: Schema.String,
  title: Schema.String,
  updated_at: Schema.String,
  views: Schema.NumberFromString,
});

type SqliteArticleRow = Schema.Codec.Encoded<typeof SqliteArticleRow>;

const NumericSqlArticleRow = Schema.Struct({
  content_hash: Schema.String,
  id: Schema.Number,
  title: Schema.String,
  updated_at: Schema.String,
});

type NumericSqlArticleRow = typeof NumericSqlArticleRow.Type;

const StringEncodedNumericArticleRow = Schema.Struct({
  id: Schema.NumberFromString,
  title: Schema.String,
  updated_at: Schema.String,
});

type StringEncodedNumericArticleRow = Schema.Codec.Encoded<
  typeof StringEncodedNumericArticleRow
>;

const TenantUserRow = Schema.Struct({
  email_key: Schema.NonEmptyString,
  name: Schema.String,
  tenant_id: Schema.NonEmptyString,
  updated_at: Schema.String,
});

type TenantUserRow = typeof TenantUserRow.Type;

const TenantUserCursor = Schema.Struct({
  email_key: Schema.String,
  tenant_id: Schema.String,
});

type TenantUserCursor = typeof TenantUserCursor.Type;

const TenantUserIdentity = SqlIdentity.columns({
  id: "tenant-user@v1",
  columns: [
    SqlIdentity.column("tenant_id", Schema.NonEmptyString),
    SqlIdentity.column("email_key", Schema.NonEmptyString),
  ],
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

const normalizeSqlText = (strings: readonly string[]) =>
  strings.join("?").replaceAll(/\s+/g, " ").trim().toLowerCase();

const compareSqliteArticleCursor = (
  row: SqliteArticleRow,
  cursor: {
    readonly id: string;
    readonly updated_at: string;
  }
) =>
  row.updated_at.localeCompare(cursor.updated_at) ||
  row.id.localeCompare(cursor.id);

const makeSqliteStyleArticleSqlClient = (rows: readonly SqliteArticleRow[]) => {
  const calls: SqlStatementCall[] = [];
  const sortedRows = [...rows].sort(
    (left, right) =>
      left.updated_at.localeCompare(right.updated_at) ||
      left.id.localeCompare(right.id)
  );

  const client = (<A>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ) => {
    calls.push({
      strings: Array.from(strings),
      values,
    });

    const sqlText = normalizeSqlText(strings);

    if (sqlText.includes("where id =")) {
      const [identity] = values;
      return makeStatement<A>(sortedRows.filter((row) => row.id === identity));
    }

    const limit = values.at(-1);

    if (typeof limit !== "number") {
      return makeStatement<A>(sqlFailure(new Error("missing SQL limit")));
    }

    const windowRows =
      values.length === 1
        ? sortedRows
        : sortedRows.filter(
            (row) =>
              compareSqliteArticleCursor(row, {
                updated_at: String(values[0]),
                id: String(values[1]),
              }) > 0
          );

    return makeStatement<A>(windowRows.slice(0, limit));
  }) as SqlClient.SqlClient;

  Object.assign(client, {
    reactive: (() => {
      throw new Error(
        "SQLite-style SQL client does not implement reactive queries"
      );
    }) as SqlClient.SqlClient["reactive"],
    reactiveMailbox: (() =>
      Effect.die(
        "SQLite-style SQL client does not implement reactive mailboxes"
      )) as SqlClient.SqlClient["reactiveMailbox"],
    reserve: Effect.die("SQLite-style SQL client does not implement reserve"),
    safe: client,
    transactionService: undefined as never,
    withTransaction: (<R, E, A>(effect: Effect.Effect<A, E, R>) =>
      effect) as SqlClient.SqlClient["withTransaction"],
    withoutTransforms: () => client,
  });

  return {
    calls,
    layer: Layer.succeed(SqlClient.SqlClient, client),
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

const getSqlArticleMetadata = (
  row: Readonly<SqlArticleRow>,
  context: { readonly rowIndex: number }
) => {
  expectTypeOf(row).toEqualTypeOf<Readonly<SqlArticleRow>>();
  expectTypeOf(context).toEqualTypeOf<{ readonly rowIndex: number }>();

  return row.id.length === 0
    ? metadataFailure
    : {
        kind: "success" as const,
        cursor: {
          id: row.id,
          updated_at: row.updated_at,
        },
        version: row.updated_at satisfies SourceVersionInput,
      };
};

const makeSqlArticleSource = (
  options: {
    readonly batchSize?: number;
    readonly count?: SqlSourceCount<{ readonly total: number }>;
    readonly getSourceMetadata?: typeof getSqlArticleMetadata;
  } = {}
) =>
  SqlSourcePlugin.make({
    batchSize: options.batchSize ?? 2,
    ...(options.count === undefined ? {} : { count: options.count }),
    cursorSchema: SqlArticleCursor,
    getSourceMetadata: options.getSourceMetadata ?? getSqlArticleMetadata,
    identity: SqlArticleColumnIdentity,
    lookup: (sql, identity) => {
      expectTypeOf(identity.key).toEqualTypeOf<string>();
      return sql<SqlArticleRow>`select id, title, updated_at, views from articles where id = ${identity.key}`;
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
        string,
        SqlArticleRow,
        never,
        SqlClient.SqlClient
      >
    >();
    expectTypeOf(providedSource).toMatchTypeOf<
      ConfiguredSourcePlugin<
        SqlArticle,
        SqlArticleCursor,
        string,
        SqlArticleRow,
        never,
        never
      >
    >();

    const expectMissingIdentityColumnToFailTypeCheck = () => {
      // @ts-expect-error SQL identity columns must exist on the source schema input side.
      SqlSourcePlugin.make({
        batchSize: 2,
        cursorSchema: SqlArticleCursor,
        getSourceMetadata: (row: SqlArticleRow) => ({
          kind: "success",
          cursor: {
            id: row.id,
            updated_at: row.updated_at,
          },
          version: row.updated_at,
        }),
        identity: SqlIdentity.columns({
          id: "bad-sql-article@v1",
          columns: [SqlIdentity.column("articleId", Schema.NonEmptyString)],
        }),
        lookup: (sql: SqlClient.SqlClient, identity: SourceIdentity<string>) =>
          sql<SqlArticleRow>`select id, title, updated_at, views from articles where id = ${identity.key}`,
        read: (
          sql: SqlClient.SqlClient,
          cursor: SqlArticleCursor | null,
          limit: number
        ) =>
          cursor === null
            ? sql<SqlArticleRow>`select id, title, updated_at, views from articles order by updated_at, id limit ${limit}`
            : sql<SqlArticleRow>`select id, title, updated_at, views from articles where (updated_at, id) > (${cursor.updated_at}, ${cursor.id}) order by updated_at, id limit ${limit}`,
        sourceSchema: SqlArticleRow,
      });
    };

    expectTypeOf(expectMissingIdentityColumnToFailTypeCheck).toBeFunction();

    const expectMismatchedIdentityColumnSchemaToFailTypeCheck = () => {
      // @ts-expect-error SQL identity column schemas must match the source schema input side.
      SqlSourcePlugin.make({
        batchSize: 2,
        cursorSchema: SqlArticleCursor,
        getSourceMetadata: (row: NumericSqlArticleRow) => ({
          kind: "success",
          cursor: {
            id: String(row.id),
            updated_at: row.updated_at,
          },
          version: row.content_hash,
        }),
        identity: SqlIdentity.columns({
          id: "bad-numeric-sql-article@v1",
          columns: [SqlIdentity.column("id", Schema.NonEmptyString)],
        }),
        lookup: (sql: SqlClient.SqlClient, identity: SourceIdentity<number>) =>
          sql<NumericSqlArticleRow>`select id, title, updated_at, content_hash from articles where id = ${identity.key}`,
        read: (
          sql: SqlClient.SqlClient,
          cursor: SqlArticleCursor | null,
          limit: number
        ) =>
          cursor === null
            ? sql<NumericSqlArticleRow>`select id, title, updated_at, content_hash from articles order by updated_at, id limit ${limit}`
            : sql<NumericSqlArticleRow>`select id, title, updated_at, content_hash from articles where (updated_at, id) > (${cursor.updated_at}, ${cursor.id}) order by updated_at, id limit ${limit}`,
        sourceSchema: NumericSqlArticleRow,
      });
    };

    expectTypeOf(
      expectMismatchedIdentityColumnSchemaToFailTypeCheck
    ).toBeFunction();
  });

  it.effect(
    "reads source items and looks up identities through a provided SQL client",
    () =>
      Effect.gen(function* () {
        const source = makeSqlArticleSource();
        const fakeSql = makeFakeSqlClient([articleRows, [articleRows[1]]]);
        const plugin = yield* SourcePlugin.pipe(
          Effect.provide(source.layer.pipe(Layer.provide(fakeSql.layer)))
        );

        const page = yield* plugin.read(null);

        expect(
          page.items.map((sourceItem) => ({
            ...sourceItem,
            identity: sourceItem.identity.encoded,
          }))
        ).toEqual([
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
          SourceIdentity.fromEncoded(
            plugin.identity,
            toEncodedSourceIdentity("article-2")
          )
        );

        expect(item).toEqual({
          identity: SourceIdentity.fromKey(plugin.identity, "article-2"),
          item: articleRows[1],
          version: "2026-01-02T00:00:00.000Z",
        });
        expect(fakeSql.calls[1]?.values).toEqual(["article-2"]);
        expect(fakeSql.transactionCount()).toBe(0);
      })
  );

  it.effect(
    "counts known Source Item totals from an explicit count statement",
    () =>
      Effect.gen(function* () {
        let readCalls = 0;
        let lookupCalls = 0;
        const source = SqlSourcePlugin.make({
          batchSize: 2,
          count: {
            getCount: (row: Readonly<{ readonly total: number }>) => row.total,
            kind: "statement",
            statement: (sql) =>
              sql<{
                readonly total: number;
              }>`select count(*) as total from articles where status = ${"published"}`,
          },
          cursorSchema: SqlArticleCursor,
          getSourceMetadata: getSqlArticleMetadata,
          identity: SqlArticleColumnIdentity,
          lookup: (sql, identity) => {
            lookupCalls += 1;

            return sql<SqlArticleRow>`select id, title, updated_at, views from articles where id = ${identity.key}`;
          },
          read: (sql, cursor, limit) => {
            readCalls += 1;

            return cursor === null
              ? sql<SqlArticleRow>`select id, title, updated_at, views from articles order by updated_at, id limit ${limit}`
              : sql<SqlArticleRow>`select id, title, updated_at, views from articles where (updated_at, id) > (${cursor.updated_at}, ${cursor.id}) order by updated_at, id limit ${limit}`;
          },
          sourceSchema: SqlArticleRow,
        });
        const fakeSql = makeFakeSqlClient([[{ total: 2 }]]);
        const plugin = yield* SourcePlugin.pipe(
          Effect.provide(source.layer.pipe(Layer.provide(fakeSql.layer)))
        );

        if (plugin.countTotal === undefined) {
          throw new Error("Expected SQL source total count");
        }

        const total = yield* plugin.countTotal();

        expect(total).toEqual(SourceItemTotal.known(2));
        expect(readCalls).toBe(0);
        expect(lookupCalls).toBe(0);
        expect(fakeSql.calls).toHaveLength(1);
        expect(normalizeSqlText(fakeSql.calls[0]?.strings ?? [])).toBe(
          "select count(*) as total from articles where status = ?"
        );
        expect(fakeSql.calls[0]?.values).toEqual(["published"]);
      })
  );

  it.effect("counts zero totals from an explicit count effect", () =>
    Effect.gen(function* () {
      const source = makeSqlArticleSource({
        count: {
          effect: (_sql) => Effect.succeed(0),
          kind: "effect",
        },
      });
      const fakeSql = makeFakeSqlClient([]);
      const plugin = yield* SourcePlugin.pipe(
        Effect.provide(source.layer.pipe(Layer.provide(fakeSql.layer)))
      );

      if (plugin.countTotal === undefined) {
        throw new Error("Expected SQL source total count");
      }

      const total = yield* plugin.countTotal();

      expect(total).toEqual(SourceItemTotal.known(0));
      expect(fakeSql.calls).toHaveLength(0);
    })
  );

  it.effect("counts totals through a locally provided SQL client", () =>
    Effect.gen(function* () {
      const fakeSql = makeFakeSqlClient([[{ total: 2 }]]);
      const source = makeSqlArticleSource({
        count: {
          getCount: (row) => row.total,
          kind: "statement",
          statement: (sql) =>
            sql<{
              readonly total: number;
            }>`select count(*) as total from articles`,
        },
      }).provide(fakeSql.layer);
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));

      if (plugin.countTotal === undefined) {
        throw new Error("Expected SQL source total count");
      }

      const total = yield* plugin.countTotal();

      expect(total).toEqual(SourceItemTotal.known(2));
      expect(fakeSql.calls).toHaveLength(1);
    })
  );

  it.effect("omits total count when no SQL count operation is configured", () =>
    Effect.gen(function* () {
      const source = makeSqlArticleSource();
      const fakeSql = makeFakeSqlClient([]);
      const plugin = yield* SourcePlugin.pipe(
        Effect.provide(source.layer.pipe(Layer.provide(fakeSql.layer)))
      );

      expect(plugin.countTotal).toBeUndefined();
      expect(fakeSql.calls).toHaveLength(0);
    })
  );

  it.effect("continues migration execution when SQL count fails", () =>
    Effect.gen(function* () {
      const countFailure = new Error("count timed out");
      const fakeSql = makeFakeSqlClient([
        sqlFailure(countFailure),
        [articleRows[0]],
        [],
      ]);
      const source = makeSqlArticleSource({
        count: {
          getCount: (row) => row.total,
          kind: "statement",
          statement: (sql) =>
            sql<{
              readonly total: number;
            }>`select count(*) as total from articles`,
        },
      });
      const storeState = InMemoryMigrationStore.makeState();
      const progressEvents: MigrationProgressEvent[] = [];
      const definition = defineMigration({
        id: "sql-articles",
        process: () => Effect.void,
        source,
        store: InMemoryMigrationStore.layer(storeState),
      });
      const progressLayer = Layer.succeed(MigrationProgress, {
        countSourceItemTotals: true,
        emit: (event) =>
          Effect.sync(() => {
            progressEvents.push(event);
          }),
      });

      const summary = yield* runMigration(definition).pipe(
        Effect.provide(Layer.mergeAll(fakeSql.layer, progressLayer))
      );

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 1,
        skipped: 0,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(storeState.itemStates.size).toBe(1);
      expect(Array.from(storeState.itemStates.values())[0]?.status).toBe(
        "migrated"
      );
      expect(progressEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            definitionId: definition.id,
            kind: "source-item-total-counted",
            sourceItemTotal: expect.objectContaining({
              kind: "unknown",
              message: "Source Item total count failed",
              reason: "failed",
            }),
          }),
        ])
      );
      expect(normalizeSqlText(fakeSql.calls[0]?.strings ?? [])).toBe(
        "select count(*) as total from articles"
      );
      expect(normalizeSqlText(fakeSql.calls[1]?.strings ?? [])).toContain(
        "order by updated_at"
      );
    })
  );

  it.effect("supports explicit non-string source identity contracts", () =>
    Effect.gen(function* () {
      const NumericArticleIdentity = SqlIdentity.columns({
        id: "numeric-sql-article@v1",
        columns: [SqlIdentity.column("id", Schema.Number)],
      });
      const rows = [
        {
          content_hash: "hash-101",
          id: 101,
          title: "First numeric article",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
        {
          content_hash: "hash-102",
          id: 102,
          title: "Second numeric article",
          updated_at: "2026-01-02T00:00:00.000Z",
        },
      ] satisfies readonly NumericSqlArticleRow[];
      const source = SqlSourcePlugin.make({
        batchSize: 2,
        cursorSchema: SqlArticleCursor,
        getSourceMetadata: (row) => ({
          kind: "success",
          cursor: {
            id: String(row.id),
            updated_at: row.updated_at,
          },
          version: row.content_hash,
        }),
        identity: NumericArticleIdentity,
        lookup: (sql, identity) => {
          expectTypeOf(identity.key).toEqualTypeOf<number>();
          return sql<NumericSqlArticleRow>`select id, title, updated_at, content_hash from articles where id = ${identity.key}`;
        },
        read: (sql, cursor, limit) =>
          cursor === null
            ? sql<NumericSqlArticleRow>`select id, title, updated_at, content_hash from articles order by updated_at, id limit ${limit}`
            : sql<NumericSqlArticleRow>`select id, title, updated_at, content_hash from articles where (updated_at, id) > (${cursor.updated_at}, ${cursor.id}) order by updated_at, id limit ${limit}`,
        sourceSchema: NumericSqlArticleRow,
      });
      expectTypeOf(source).toMatchTypeOf<
        ConfiguredSourcePlugin<
          NumericSqlArticleRow,
          SqlArticleCursor,
          number,
          NumericSqlArticleRow,
          never,
          SqlClient.SqlClient
        >
      >();
      const fakeSql = makeFakeSqlClient([rows, [rows[1]]]);
      const plugin = yield* SourcePlugin.pipe(
        Effect.provide(source.layer.pipe(Layer.provide(fakeSql.layer)))
      );

      const page = yield* plugin.read(null);
      const lookupItem = yield* plugin.readByIdentity(
        SourceIdentity.fromKey(plugin.identity, 102)
      );

      expect(page.items.map((item) => item.identity.encoded)).toEqual([
        "101",
        "102",
      ]);
      expect(lookupItem?.identity.key).toBe(102);
      expect(fakeSql.calls[0]?.values).toEqual([2]);
      expect(fakeSql.calls[1]?.values).toEqual([102]);
    })
  );

  it.effect("derives codec source identities from encoded SQL row values", () =>
    Effect.gen(function* () {
      const CodecArticleIdentity = SqlIdentity.columns({
        id: "codec-sql-article@v1",
        columns: [SqlIdentity.column("id", Schema.NumberFromString)],
      });
      const rows = [
        {
          id: "101",
          title: "First codec article",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ] satisfies readonly StringEncodedNumericArticleRow[];
      const source = SqlSourcePlugin.make({
        batchSize: 2,
        cursorSchema: SqlArticleCursor,
        getSourceMetadata: (row) => ({
          kind: "success",
          cursor: {
            id: row.id,
            updated_at: row.updated_at,
          },
          version: row.updated_at,
        }),
        identity: CodecArticleIdentity,
        lookup: (sql, identity) => {
          expectTypeOf(identity.key).toEqualTypeOf<number>();

          return sql<StringEncodedNumericArticleRow>`select id, title, updated_at from articles where id = ${String(identity.key)}`;
        },
        read: (sql, cursor, limit) =>
          cursor === null
            ? sql<StringEncodedNumericArticleRow>`select id, title, updated_at from articles order by updated_at, id limit ${limit}`
            : sql<StringEncodedNumericArticleRow>`select id, title, updated_at from articles where (updated_at, id) > (${cursor.updated_at}, ${cursor.id}) order by updated_at, id limit ${limit}`,
        sourceSchema: StringEncodedNumericArticleRow,
      });
      const fakeSql = makeFakeSqlClient([rows, rows]);
      const plugin = yield* SourcePlugin.pipe(
        Effect.provide(source.layer.pipe(Layer.provide(fakeSql.layer)))
      );

      const page = yield* plugin.read(null);
      const lookupItem = yield* plugin.readByIdentity(
        SourceIdentity.fromKey(plugin.identity, 101)
      );

      expect(page.items[0]?.identity.key).toBe(101);
      expect(page.items[0]?.identity.encoded).toBe("101");
      expect(lookupItem?.identity.key).toBe(101);
      expect(fakeSql.calls[1]?.values).toEqual(["101"]);
    })
  );

  it.effect("derives composite source identities from SQL row aliases", () =>
    Effect.gen(function* () {
      const rows = [
        {
          email_key: "ada@example.com",
          name: "Ada",
          tenant_id: "tenant-1",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ] satisfies readonly TenantUserRow[];
      const source = SqlSourcePlugin.make({
        batchSize: 2,
        cursorSchema: TenantUserCursor,
        getSourceMetadata: (row) => ({
          kind: "success",
          cursor: {
            email_key: row.email_key,
            tenant_id: row.tenant_id,
          },
          version: row.updated_at,
        }),
        identity: TenantUserIdentity,
        lookup: (sql, identity) => {
          expectTypeOf(identity.key).toMatchTypeOf<readonly [string, string]>();
          const [tenantId, emailKey] = identity.key;

          return sql<TenantUserRow>`select tenant_id, email_key, name, updated_at from users where tenant_id = ${tenantId} and email_key = ${emailKey}`;
        },
        read: (sql, cursor, limit) =>
          cursor === null
            ? sql<TenantUserRow>`select tenant_id, email_key, name, updated_at from users order by tenant_id, email_key limit ${limit}`
            : sql<TenantUserRow>`select tenant_id, email_key, name, updated_at from users where (tenant_id, email_key) > (${cursor.tenant_id}, ${cursor.email_key}) order by tenant_id, email_key limit ${limit}`,
        sourceSchema: TenantUserRow,
      });
      expectTypeOf(source).toMatchTypeOf<
        ConfiguredSourcePlugin<
          TenantUserRow,
          TenantUserCursor,
          readonly [string, string],
          TenantUserRow,
          never,
          SqlClient.SqlClient
        >
      >();
      const fakeSql = makeFakeSqlClient([rows, rows]);
      const plugin = yield* SourcePlugin.pipe(
        Effect.provide(source.layer.pipe(Layer.provide(fakeSql.layer)))
      );

      const page = yield* plugin.read(null);
      const lookupItem = yield* plugin.readByIdentity(
        SourceIdentity.fromKey(plugin.identity, ["tenant-1", "ada@example.com"])
      );

      expect(page.items.map((item) => item.identity.encoded)).toEqual([
        '["tenant-1","ada@example.com"]',
      ]);
      expect(page.items[0]?.identity.key).toEqual([
        "tenant-1",
        "ada@example.com",
      ]);
      expect(lookupItem?.identity.encoded).toBe(
        '["tenant-1","ada@example.com"]'
      );
      expect(fakeSql.calls[1]?.values).toEqual(["tenant-1", "ada@example.com"]);
    })
  );

  it.effect("can close SQL client requirements on the source plugin", () =>
    Effect.gen(function* () {
      const fakeSql = makeFakeSqlClient([[articleRows[0]], []]);
      const source = makeSqlArticleSource().provide(fakeSql.layer);
      const storeState = InMemoryMigrationStore.makeState();

      const definition = defineMigration({
        id: "sql-articles",
        process: () => Effect.void,
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

  it.effect("fails reads when batchSize is not a positive integer", () =>
    Effect.gen(function* () {
      const source = makeSqlArticleSource({ batchSize: 0 });
      const fakeSql = makeFakeSqlClient([articleRows]);
      const plugin = yield* SourcePlugin.pipe(
        Effect.provide(source.layer.pipe(Layer.provide(fakeSql.layer)))
      );

      const error = yield* Effect.flip(plugin.read(null));

      expect(error).toBeInstanceOf(SourcePluginError);
      expect(error.message).toBe(
        "SQL source plugin batchSize must be a positive integer"
      );
      expect(error.cause).toEqual({ batchSize: 0 });
      expect(fakeSql.calls).toHaveLength(0);
    })
  );

  it.effect(
    "fails read windows when a returned row has no cursor metadata",
    () =>
      Effect.gen(function* () {
        const source = makeSqlArticleSource({
          getSourceMetadata: (row, context) => ({
            ...getSqlArticleMetadata(row, context),
            cursor: undefined as unknown as SqlArticleCursor,
          }),
        });
        const fakeSql = makeFakeSqlClient([[articleRows[0]]]);
        const plugin = yield* SourcePlugin.pipe(
          Effect.provide(source.layer.pipe(Layer.provide(fakeSql.layer)))
        );

        const error = yield* Effect.flip(plugin.read(null));

        expect(error).toBeInstanceOf(SourcePluginError);
        expect(error.message).toBe(
          "SQL source plugin read metadata failed for row 0: source cursor is required"
        );
        expect(error.cause).toEqual({
          rowIndex: 0,
          sourceCursor: undefined,
        });
      })
  );

  it.effect(
    "fails read windows when metadata extraction returns a failure",
    () =>
      Effect.gen(function* () {
        const source = makeSqlArticleSource();
        const fakeSql = makeFakeSqlClient([
          [
            {
              ...articleRows[0],
              id: "",
            },
          ],
        ]);
        const plugin = yield* SourcePlugin.pipe(
          Effect.provide(source.layer.pipe(Layer.provide(fakeSql.layer)))
        );

        const error = yield* Effect.flip(plugin.read(null));

        expect(error).toBeInstanceOf(SourcePluginError);
        expect(error.message).toBe(
          "SQL source plugin read metadata failed for row 0: missing SQL source metadata"
        );
      })
  );

  it.effect("fails lookups when metadata extraction returns a failure", () =>
    Effect.gen(function* () {
      const source = makeSqlArticleSource();
      const fakeSql = makeFakeSqlClient([
        [
          {
            ...articleRows[0],
            id: "",
          },
        ],
      ]);
      const plugin = yield* SourcePlugin.pipe(
        Effect.provide(source.layer.pipe(Layer.provide(fakeSql.layer)))
      );

      const error = yield* Effect.flip(
        plugin.readByIdentity(
          SourceIdentity.fromEncoded(
            plugin.identity,
            toEncodedSourceIdentity("article-1")
          )
        )
      );

      expect(error).toBeInstanceOf(SourcePluginError);
      expect(error.message).toBe(
        "SQL source plugin readByIdentity metadata failed for row 0: missing SQL source metadata"
      );
    })
  );

  it.effect("fails read windows with duplicate Source Identities", () =>
    Effect.gen(function* () {
      const duplicateRows = [
        articleRows[0],
        {
          ...articleRows[1],
          id: articleRows[0].id,
        },
      ] satisfies readonly SqlArticleRow[];
      const source = makeSqlArticleSource();
      const fakeSql = makeFakeSqlClient([duplicateRows]);
      const plugin = yield* SourcePlugin.pipe(
        Effect.provide(source.layer.pipe(Layer.provide(fakeSql.layer)))
      );

      const error = yield* Effect.flip(plugin.read(null));

      expect(error).toBeInstanceOf(SourcePluginError);
      expect(error.message).toBe(
        "SQL source plugin read metadata failed for row 1: duplicate Source Identity in read window"
      );
      expect(error.cause).toEqual({
        duplicateRowIndex: 1,
        firstRowIndex: 0,
        sourceIdentity: "article-1",
      });
    })
  );

  it.effect("fails lookups when the SQL statement returns multiple rows", () =>
    Effect.gen(function* () {
      const source = makeSqlArticleSource();
      const fakeSql = makeFakeSqlClient([articleRows]);
      const plugin = yield* SourcePlugin.pipe(
        Effect.provide(source.layer.pipe(Layer.provide(fakeSql.layer)))
      );

      const error = yield* Effect.flip(
        plugin.readByIdentity(
          SourceIdentity.fromEncoded(
            plugin.identity,
            toEncodedSourceIdentity("article-1")
          )
        )
      );

      expect(error).toBeInstanceOf(SourcePluginError);
      expect(error.message).toBe(
        "SQL source plugin readByIdentity returned multiple rows"
      );
      expect(error.cause).toEqual({
        rowCount: 2,
        sourceIdentity: "article-1",
      });
    })
  );

  it.effect(
    "fails lookups when returned metadata does not match the requested identity",
    () =>
      Effect.gen(function* () {
        const source = makeSqlArticleSource();
        const fakeSql = makeFakeSqlClient([[articleRows[1]]]);
        const plugin = yield* SourcePlugin.pipe(
          Effect.provide(source.layer.pipe(Layer.provide(fakeSql.layer)))
        );

        const error = yield* Effect.flip(
          plugin.readByIdentity(
            SourceIdentity.fromEncoded(
              plugin.identity,
              toEncodedSourceIdentity("article-1")
            )
          )
        );

        expect(error).toBeInstanceOf(SourcePluginError);
        expect(error.message).toBe(
          "SQL source plugin readByIdentity returned a different Source Identity"
        );
        expect(error.cause).toEqual({
          requestedSourceIdentity: "article-1",
          returnedSourceIdentity: "article-2",
        });
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

      expect(legacyPage.items[0]?.identity.encoded).toBe("legacy-article");
      expect(crmPage.items[0]?.identity.encoded).toBe("crm-article");
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
          Effect.provide(source.layer.pipe(Layer.provide(fakeSql.layer)))
        );

        const page = yield* plugin.read(null);
        const item = yield* plugin.readByIdentity(
          SourceIdentity.fromEncoded(
            plugin.identity,
            toEncodedSourceIdentity("missing")
          )
        );

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
        Effect.provide(source.layer.pipe(Layer.provide(fakeSql.layer)))
      );

      const error = yield* Effect.flip(plugin.read(null));

      expect(error).toBeInstanceOf(SourcePluginError);
      expect(error.message).toBe("SQL source plugin read failed");
      expect(error.cause).toBe(cause);
    })
  );

  it.effect("passes decoded SQL rows into the process through the runner", () =>
    Effect.gen(function* () {
      const source = makeSqlArticleSource();
      const fakeSql = makeFakeSqlClient([[articleRows[0]], []]);
      const storeState = InMemoryMigrationStore.makeState();
      let decodedViews: number | undefined;

      const definition = defineMigration({
        id: "sql-articles",
        process: (sourceItem) =>
          Effect.sync(() => {
            decodedViews = sourceItem.item.views;
          }),
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
    "reads a SQLite-style table with keyset pagination and direct lookup",
    () =>
      Effect.gen(function* () {
        const rows = [
          {
            content_hash: "hash-1",
            id: "article-a",
            title: "A",
            updated_at: "2026-01-01T00:00:00.000Z",
            views: "1",
          },
          {
            content_hash: "hash-2",
            id: "article-b",
            title: "B",
            updated_at: "2026-01-01T00:00:00.000Z",
            views: "2",
          },
          {
            content_hash: "hash-3",
            id: "article-c",
            title: "C",
            updated_at: "2026-01-02T00:00:00.000Z",
            views: "3",
          },
        ] satisfies readonly SqliteArticleRow[];
        const sqlite = makeSqliteStyleArticleSqlClient(rows);
        const source = SqlSourcePlugin.make({
          batchSize: 2,
          cursorSchema: SqlArticleCursor,
          getSourceMetadata: (row) => ({
            kind: "success",
            cursor: {
              id: row.id,
              updated_at: row.updated_at,
            },
            version: row.content_hash,
          }),
          identity: SqlArticleColumnIdentity,
          lookup: (sql, identity) =>
            sql<SqliteArticleRow>`
              select id, updated_at, content_hash, title, views
              from articles
              where id = ${identity.key}
            `,
          read: (sql, cursor, limit) =>
            cursor === null
              ? sql<SqliteArticleRow>`
                  select id, updated_at, content_hash, title, views
                  from articles
                  order by updated_at asc, id asc
                  limit ${limit}
                `
              : sql<SqliteArticleRow>`
                  select id, updated_at, content_hash, title, views
                  from articles
                  where (updated_at, id) > (${cursor.updated_at}, ${cursor.id})
                  order by updated_at asc, id asc
                  limit ${limit}
                `,
          sourceSchema: SqliteArticleRow,
        }).provide(sqlite.layer);
        const storeState = InMemoryMigrationStore.makeState();
        const processItems: string[] = [];

        const definition = defineMigration({
          id: "sqlite-articles",
          process: (sourceItem) =>
            Effect.sync(() => {
              processItems.push(
                `${sourceItem.identity.encoded}:${sourceItem.version}:${sourceItem.item.views}`
              );
            }),
          source,
          store: InMemoryMigrationStore.layer(storeState),
        });

        const summary = yield* runMigration(definition);
        const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
        const lookupItem = yield* plugin.readByIdentity(
          SourceIdentity.fromEncoded(
            plugin.identity,
            toEncodedSourceIdentity("article-b")
          )
        );
        const sqlTexts = sqlite.calls.map((call) =>
          normalizeSqlText(call.strings)
        );

        expect(summary.status).toBe("succeeded");
        expect(summary.definitions[0]?.counts.migrated).toBe(3);
        expect(processItems).toEqual([
          "article-a:hash-1:1",
          "article-b:hash-2:2",
          "article-c:hash-3:3",
        ]);
        expect(
          sqlite.calls
            .filter((call) =>
              normalizeSqlText(call.strings).includes("order by")
            )
            .map((call) => call.values.at(-1))
        ).toEqual([2, 2, 2]);
        expect(sqlTexts.every((text) => !text.includes("offset"))).toBe(true);
        expect(sqlTexts.every((text) => !text.includes("limit 1"))).toBe(true);
        expect(sqlTexts.some((text) => text.includes("where id ="))).toBe(true);
        expect(lookupItem).toEqual({
          identity: SourceIdentity.fromKey(plugin.identity, "article-b"),
          item: rows[1],
          version: "hash-2",
        });
      })
  );

  it.effect("reads a real SQLite database through the Effect SQL client", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
          create table articles (
            id text primary key,
            updated_at text not null,
            content_hash text not null,
            title text not null,
            views text not null
          )
        `;
      yield* sql`
          insert into articles (id, updated_at, content_hash, title, views)
          values
            ('article-a', '2026-01-01T00:00:00.000Z', 'hash-1', 'A', '1'),
            ('article-b', '2026-01-01T00:00:00.000Z', 'hash-2', 'B', '2'),
            ('article-c', '2026-01-02T00:00:00.000Z', 'hash-3', 'C', '3')
        `;

      const source = SqlSourcePlugin.make({
        batchSize: 2,
        cursorSchema: SqlArticleCursor,
        getSourceMetadata: (row) => ({
          kind: "success",
          cursor: {
            id: row.id,
            updated_at: row.updated_at,
          },
          version: row.content_hash,
        }),
        identity: SqlArticleColumnIdentity,
        lookup: (sql, identity) =>
          sql<SqliteArticleRow>`
              select id, updated_at, content_hash, title, views
              from articles
              where id = ${identity.key}
            `,
        read: (sql, cursor, limit) =>
          cursor === null
            ? sql<SqliteArticleRow>`
                  select id, updated_at, content_hash, title, views
                  from articles
                  order by updated_at asc, id asc
                  limit ${limit}
                `
            : sql<SqliteArticleRow>`
                  select id, updated_at, content_hash, title, views
                  from articles
                  where (updated_at, id) > (${cursor.updated_at}, ${cursor.id})
                  order by updated_at asc, id asc
                  limit ${limit}
                `,
        sourceSchema: SqliteArticleRow,
      });
      const storeState = InMemoryMigrationStore.makeState();
      const processItems: Array<{
        readonly sourceIdentity: EncodedSourceIdentityInput;
        readonly valueType: string;
        readonly views: number;
      }> = [];

      const definition = defineMigration({
        id: "sqlite-real-articles",
        process: (sourceItem) =>
          Effect.sync(() => {
            processItems.push({
              sourceIdentity: sourceItem.identity.encoded,
              valueType: typeof sourceItem.item.views,
              views: sourceItem.item.views,
            });
          }),
        source,
        store: InMemoryMigrationStore.layer(storeState),
      });

      const summary = yield* runMigration(definition);
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
      const lookupItem = yield* plugin.readByIdentity(
        SourceIdentity.fromEncoded(
          plugin.identity,
          toEncodedSourceIdentity("article-b")
        )
      );

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions[0]?.counts.migrated).toBe(3);
      expect(processItems).toEqual([
        { sourceIdentity: "article-a", valueType: "number", views: 1 },
        { sourceIdentity: "article-b", valueType: "number", views: 2 },
        { sourceIdentity: "article-c", valueType: "number", views: 3 },
      ]);
      expect(lookupItem).toEqual({
        identity: SourceIdentity.fromKey(plugin.identity, "article-b"),
        item: {
          content_hash: "hash-2",
          id: "article-b",
          title: "B",
          updated_at: "2026-01-01T00:00:00.000Z",
          views: "2",
        },
        version: "hash-2",
      });
    }).pipe(
      Effect.provide(
        SqliteClient.layer({
          disableWAL: true,
          filename: ":memory:",
        })
      )
    )
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
        let processCalls = 0;

        const definition = defineMigration({
          id: "sql-articles",
          process: () =>
            Effect.sync(() => {
              processCalls += 1;
            }),
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
        expect(processCalls).toBe(0);
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
