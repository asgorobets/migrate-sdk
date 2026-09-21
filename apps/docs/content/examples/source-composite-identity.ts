import { Schema } from "effect";
import { SourceIdentity } from "migrate-sdk";

export const authorIdentity = SourceIdentity.make({
  id: "author-by-system@v1",
  schema: SourceIdentity.tuple([
    SourceIdentity.part("system", Schema.NonEmptyString),
    SourceIdentity.part("id", Schema.NonEmptyString),
  ]),
});

export const authorKey = SourceIdentity.fromKey(authorIdentity, [
  "editorial-api",
  "author-1040",
]);
