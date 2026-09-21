import { PgClient } from "@effect/sql-pg";
import { Config, Schema } from "effect";
import {
  SqlIdentity,
  SqlSource,
  type SqlSourceRead,
} from "migrate-sdk/sources/sql";

const sourceDatabase = PgClient.layerConfig({
  url: Config.Redacted("SOURCE_DATABASE_URL"),
});

const AuthorRow = Schema.Struct({
  id: Schema.NonEmptyString,
  first_name: Schema.NonEmptyString,
  last_name: Schema.NonEmptyString,
  revision: Schema.NonEmptyString,
});
const AuthorCursor = Schema.Struct({ id: Schema.NonEmptyString });

const readAuthors: SqlSourceRead<
  typeof AuthorRow.Encoded,
  typeof AuthorCursor.Type
> = (sql, cursor, limit) =>
  cursor === null
    ? sql`
        SELECT id, first_name, last_name, revision
        FROM source_authors
        ORDER BY id
        LIMIT ${limit}
      `
    : sql`
        SELECT id, first_name, last_name, revision
        FROM source_authors
        WHERE id > ${cursor.id}
        ORDER BY id
        LIMIT ${limit}
      `;

export const authorSource = SqlSource.make({
  sourceSchema: AuthorRow,
  identity: SqlIdentity.columns({
    id: "author-id@v1",
    columns: [SqlIdentity.column("id", Schema.NonEmptyString)],
  }),
  cursorSchema: AuthorCursor,
  batchSize: 100,
  read: readAuthors,
  lookup: (sql, identity) => sql`
    SELECT id, first_name, last_name, revision
    FROM source_authors
    WHERE id = ${identity.key}
  `,
  getSourceMetadata: (row) => ({
    kind: "success",
    cursor: { id: row.id },
    version: row.revision,
  }),
}).provide(sourceDatabase);
