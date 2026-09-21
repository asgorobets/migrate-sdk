import { Effect, Schema } from "effect";
import {
  DestinationChangeDescriptor,
  type DestinationError,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  type ProcessPipelineFor,
  type RollbackPipelineFor,
  Tracking,
} from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";
import { FileMigrationStore } from "migrate-sdk/stores/file";
import { combinedSource } from "./api-combined-source";
import { writeJson } from "./api-http";
import { destinationEndpoint, destinationId, mapAuthor } from "./api-to-api";

const searchEndpoint = {
  url: process.env.SEARCH_URL ?? "https://search.example.test/documents",
  token: process.env.SEARCH_TOKEN,
};
const SearchDocument = Schema.Struct({
  id: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  body: Schema.String,
});
const tracking = Tracking.record({
  id: "author-two-apis@v1",
  schema: Schema.Struct({
    authorId: Schema.NonEmptyString,
    documentId: Schema.NonEmptyString,
  }),
});
const authorWritten = DestinationChangeDescriptor.make(
  "directory-author-put@v1",
  Schema.Struct({ id: Schema.NonEmptyString })
);
const documentWritten = DestinationChangeDescriptor.make(
  "search-document-put@v1",
  Schema.Struct({ id: Schema.NonEmptyString })
);

type Process = ProcessPipelineFor<
  typeof combinedSource,
  DestinationError | Schema.SchemaError,
  typeof tracking
>;
const processAuthor: Process = Effect.fn("publishAuthor")(
  function* (sourceItem) {
    const { author: row, profile } = sourceItem.item.item;
    const author = yield* mapAuthor(row);
    // Validate both payloads before performing either write.
    const document = yield* Schema.decodeEffect(SearchDocument)({
      id: author.id,
      title: author.name,
      body: profile.bio,
    });
    yield* writeJson(destinationEndpoint, author.id, "PUT", author);
    yield* Tracking.recordChange(authorWritten, { id: author.id });
    yield* writeJson(searchEndpoint, document.id, "PUT", document);
    yield* Tracking.recordChange(documentWritten, { id: document.id });
    yield* Tracking.setRecord({ authorId: author.id, documentId: document.id });
  }
);

const rollbackAuthor: RollbackPipelineFor<
  typeof tracking,
  DestinationError | Schema.SchemaError
> = Effect.fn("unpublishAuthor")(function* (state) {
  const sourceId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(
    state.sourceIdentity.key
  );
  // Known, migration-owned IDs cover a partial write without a success record.
  const fallbackId = destinationId(sourceId);
  yield* writeJson(
    searchEndpoint,
    state.trackingRecord?.documentId ?? fallbackId,
    "DELETE"
  );
  yield* writeJson(
    destinationEndpoint,
    state.trackingRecord?.authorId ?? fallbackId,
    "DELETE"
  );
});

export const publishedAuthors = MigrationDefinition.make({
  id: "published-authors",
  source: combinedSource,
  process: processAuthor,
  tracking,
  rollback: rollbackAuthor,
  store: FileMigrationStore.layer({ directory: "./.migrate-published" }),
});

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({
    definitions: [publishedAuthors],
  }),
});
