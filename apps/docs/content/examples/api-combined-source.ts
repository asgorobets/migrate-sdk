import { Effect, Schema } from "effect";
import { SourceError, SourceIdentity } from "migrate-sdk";
import {
  DocumentFetchers,
  DocumentParsers,
  DocumentSource,
} from "migrate-sdk/sources/document";
import { readJson } from "./api-http";
import { AuthorDocument, AuthorRow, sourceEndpoint } from "./api-to-api";

const Profile = Schema.Struct({
  author_id: Schema.NonEmptyString,
  bio: Schema.String,
});
const ProfileDocument = Schema.Struct({ profiles: Schema.Array(Profile) });
export const EnrichedAuthor = Schema.Struct({
  author: AuthorRow,
  profile: Profile,
});
const JoinedDocument = Schema.Struct({ authors: Schema.Array(EnrichedAuthor) });

const profilesEndpoint = {
  url: process.env.PROFILES_URL ?? "https://profiles.example.test/profiles",
  token: process.env.PROFILES_TOKEN,
};

const readJoinedAuthors = Effect.gen(function* () {
  const [authorJson, profileJson] = yield* Effect.all(
    [readJson(sourceEndpoint), readJson(profilesEndpoint)],
    { concurrency: 2 }
  );
  const authors = yield* Schema.decodeUnknownEffect(AuthorDocument)(authorJson);
  const profiles =
    yield* Schema.decodeUnknownEffect(ProfileDocument)(profileJson);
  const profilesById = new Map(
    profiles.profiles.map((profile) => [profile.author_id, profile])
  );
  if (profilesById.size !== profiles.profiles.length) {
    return yield* new SourceError({
      message: "Profile API returned duplicate author IDs",
    });
  }
  const authorIds = new Set(authors.authors.map((author) => author.id));
  if (authorIds.size !== authors.authors.length) {
    return yield* new SourceError({
      message: "Author API returned duplicate author IDs",
    });
  }
  const joined = yield* Effect.forEach(authors.authors, (author) => {
    const profile = profilesById.get(author.id);
    return profile === undefined
      ? Effect.fail(
          new SourceError({ message: `Missing profile for ${author.id}` })
        )
      : Effect.succeed({ author, profile });
  });
  return { resource: { authors: joined } };
}).pipe(
  Effect.mapError((cause) =>
    Schema.is(SourceError)(cause)
      ? cause
      : new SourceError({
          message: "API response did not match its schema",
          cause,
        })
  )
);

export const combinedSource = DocumentSource.make({
  fetcher: DocumentFetchers.effect({
    cursorSchema: Schema.Null,
    read: () => readJoinedAuthors,
  }),
  parser: DocumentParsers.schema("joined-authors-api", JoinedDocument),
  selector: { item: (document) => document.authors },
  identity: {
    id: "author-id@v1",
    schema: SourceIdentity.key("authorId", Schema.NonEmptyString),
    key: ({ item }) => item.author.id,
  },
  version: { kind: "content-hash" },
  lookup: { kind: "scan" },
});
