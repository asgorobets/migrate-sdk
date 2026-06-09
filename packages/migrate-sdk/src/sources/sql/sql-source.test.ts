import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import type { SqlClient, Statement } from "effect/unstable/sql";
import {
  type ConfiguredSourcePlugin,
  type SourceIdentityInput,
  type SourcePayloadSchema,
  SourcePlugin,
  type SourceVersionInput,
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

const clientLayer = Layer.empty as Layer.Layer<SqlClient.SqlClient>;

const metadataFailure = {
  kind: "failure" as const,
  message: "missing SQL source metadata",
};

describe("SqlSourcePlugin", () => {
  it("defines the raw SQL source contract from the source schema input side", () => {
    const source = SqlSourcePlugin.make({
      batchSize: 100,
      clientLayer,
      cursorSchema: SqlArticleCursor,
      getSourceMetadata: (row, context) => {
        expectTypeOf(row).toEqualTypeOf<Readonly<SqlArticleRow>>();
        expectTypeOf(row.updated_at).toEqualTypeOf<string>();
        expectTypeOf(row.views).toEqualTypeOf<string>();
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

    expectTypeOf(source.sourceSchema).toMatchTypeOf<
      SourcePayloadSchema<SqlArticle, SqlArticleRow>
    >();
    expectTypeOf(source).toMatchTypeOf<
      ConfiguredSourcePlugin<SqlArticle, SqlArticleCursor, SqlArticleRow>
    >();
  });

  it.effect(
    "keeps the SQL source scaffold wired as a source plugin service",
    () =>
      Effect.gen(function* () {
        const source = SqlSourcePlugin.make({
          batchSize: 100,
          clientLayer,
          cursorSchema: SqlArticleCursor,
          getSourceMetadata: (row) => ({
            kind: "success",
            cursor: { id: row.id, updated_at: row.updated_at },
            identity: row.id,
            version: row.updated_at,
          }),
          lookup: (sql, identity): Statement.Statement<SqlArticleRow> =>
            sql`select id, title, updated_at, views from articles where id = ${identity}`,
          read: (sql, _cursor, limit): Statement.Statement<SqlArticleRow> =>
            sql`select id, title, updated_at, views from articles order by updated_at, id limit ${limit}`,
          sourceSchema: SqlArticleRow,
        });

        const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));

        expect(plugin.cursorSchema).toBe(SqlArticleCursor);
        expect(plugin.lookupStrategy).toBe("direct");
        expect(plugin.sourceSchema).toBe(SqlArticleRow);
      })
  );
});
