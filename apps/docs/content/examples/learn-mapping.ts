import { Schema } from "effect";

export const AuthorRow = Schema.Struct({
  id: Schema.NonEmptyString,
  first_name: Schema.NonEmptyString,
  last_name: Schema.NonEmptyString,
});
export const Author = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
});

export const mapAuthor = (row: typeof AuthorRow.Type) =>
  Schema.decodeEffect(Author)({
    id: row.id,
    name: `${row.first_name} ${row.last_name}`,
  });

// At an untrusted boundary, accept unknown and validate before mapping.
export const decodeAuthorRow = Schema.decodeUnknownEffect(AuthorRow);
