import { Effect, Schema } from "effect";
import { Source, SourceIdentity } from "migrate-sdk";

export const AuthorRow = Schema.Struct({
  id: Schema.NonEmptyString,
  firstName: Schema.NonEmptyString,
  lastName: Schema.NonEmptyString,
});

const rows = [
  { id: "author-1", firstName: "Ada", lastName: "Morgan" },
  { id: "author-2", firstName: "Alex", lastName: "Chen" },
];

const items = rows.map((row) => ({
  identityKey: row.id,
  version: JSON.stringify(row),
  item: row,
}));

export const authorSource = Source.make({
  sourceSchema: AuthorRow,
  identity: SourceIdentity.make({
    id: "author-id@v1",
    schema: SourceIdentity.key("id", Schema.NonEmptyString),
  }),
  cursorSchema: Schema.Null,
  lookupStrategy: "direct",
  read: () => Effect.succeed({ items }),
  readByIdentity: (identity) =>
    Effect.succeed(
      items.find((entry) => entry.identityKey === identity.key) ?? null
    ),
});
