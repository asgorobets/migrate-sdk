import { Schema } from "effect";
import { SourceIdentity } from "migrate-sdk";
import { InMemorySource } from "migrate-sdk/sources/in-memory";

const AuthorRow = Schema.Struct({
  id: Schema.NonEmptyString,
  first_name: Schema.NonEmptyString,
  last_name: Schema.NonEmptyString,
});

const authorIdentity = SourceIdentity.make({
  id: "author-id@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});

export const authorSource = InMemorySource.make({
  sourceSchema: AuthorRow,
  identity: authorIdentity,
  items: [
    {
      identityKey: "author-1040",
      version: "revision-7",
      item: {
        id: "author-1040",
        first_name: "Ada",
        last_name: "Morgan",
      },
    },
  ],
});
