import { Effect, Schema } from "effect";
import {
  type DestinationError,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  type ProcessPipelineFor,
  type RollbackPipelineFor,
  SourceIdentity,
  Tracking,
} from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";
import {
  DocumentFetchers,
  DocumentParsers,
  DocumentSource,
} from "migrate-sdk/sources/document";
import { FileMigrationStore } from "migrate-sdk/stores/file";
import { readJson, writeJson } from "./api-http";

export const AuthorRow = Schema.Struct({
  id: Schema.NonEmptyString,
  first_name: Schema.NonEmptyString,
  last_name: Schema.NonEmptyString,
});
export const AuthorDocument = Schema.Struct({
  authors: Schema.Array(AuthorRow),
});
export const Author = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
});

// Point these at APIs implementing the contract described in the recipe.
export const sourceEndpoint = {
  url: process.env.SOURCE_URL ?? "https://legacy.example.test/authors",
  token: process.env.SOURCE_TOKEN,
};
export const destinationEndpoint = {
  url: process.env.DESTINATION_URL ?? "https://directory.example.test/authors",
  token: process.env.DESTINATION_TOKEN,
};

export const authorSource = DocumentSource.make({
  fetcher: DocumentFetchers.effect({
    cursorSchema: Schema.Null,
    read: () =>
      readJson(sourceEndpoint).pipe(Effect.map((resource) => ({ resource }))),
  }),
  parser: DocumentParsers.schema("authors-api", AuthorDocument),
  selector: { item: (document) => document.authors },
  identity: {
    id: "author-id@v1",
    schema: SourceIdentity.key("authorId", Schema.NonEmptyString),
    key: ({ item }) => item.id,
  },
  version: { kind: "content-hash" },
  lookup: { kind: "scan" },
});

// This namespace must belong exclusively to this migration.
export const destinationId = (sourceId: string) => `imported-${sourceId}`;
export const mapAuthor = (row: typeof AuthorRow.Type) =>
  Schema.decodeEffect(Author)({
    id: destinationId(row.id),
    name: `${row.first_name} ${row.last_name}`,
  });

const authorTracking = Tracking.record({
  id: "author-api@v1",
  schema: Schema.Struct({ authorId: Schema.NonEmptyString }),
});

type AuthorProcess = ProcessPipelineFor<
  typeof authorSource,
  DestinationError | Schema.SchemaError,
  typeof authorTracking
>;
const processAuthor: AuthorProcess = Effect.fn("processApiAuthor")(
  function* (sourceItem) {
    const author = yield* mapAuthor(sourceItem.item.item);
    yield* writeJson(destinationEndpoint, author.id, "PUT", author);
    yield* Tracking.setRecord({ authorId: author.id });
  }
);

const rollbackAuthor: RollbackPipelineFor<
  typeof authorTracking,
  DestinationError | Schema.SchemaError
> = Effect.fn("rollbackApiAuthor")(function* (state) {
  // A timed-out PUT may have succeeded before tracking was saved.
  const sourceId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(
    state.sourceIdentity.key
  );
  const id = state.trackingRecord?.authorId ?? destinationId(sourceId);
  yield* writeJson(destinationEndpoint, id, "DELETE");
});

export const apiAuthors = MigrationDefinition.make({
  id: "api-authors",
  source: authorSource,
  process: processAuthor,
  tracking: authorTracking,
  rollback: rollbackAuthor,
  store: FileMigrationStore.layer({ directory: "./.migrate-api" }),
});

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({ definitions: [apiAuthors] }),
});
