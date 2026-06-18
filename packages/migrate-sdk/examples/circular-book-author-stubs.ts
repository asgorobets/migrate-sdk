import { Effect, Schema } from "effect";
import {
  type DestinationPluginError,
  defineMigration,
  type MigrationDefinition,
  type MigrationItemState,
  MigrationReferenceLookup,
  type MigrationReferenceLookupError,
  type MigrationRunSummary,
  type MigrationStoreError,
  runMigrations,
  SourceIdentity,
  type SourceIdentityDefinition,
  Tracking,
} from "migrate-sdk";
import {
  InMemoryDestination,
  type InMemoryEntryUpsertedChange,
} from "migrate-sdk/destinations/in-memory";
import {
  type InMemorySourceCursor,
  InMemorySourcePlugin,
} from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import { formatMigrationRunSummary } from "./in-memory-runtime.ts";

const Money = Schema.Struct({
  amount: Schema.Number,
  currency: Schema.Literal("USD"),
});

const BookSource = Schema.Struct({
  authorIds: Schema.Array(Schema.String),
  categories: Schema.Array(Schema.String),
  format: Schema.Literals(["hardcover", "paperback", "ebook"]),
  isbn: Schema.String,
  listPrice: Money,
  publicationYear: Schema.Number,
  subtitle: Schema.optional(Schema.String),
  title: Schema.Trim,
});

const AuthorSource = Schema.Struct({
  biography: Schema.String,
  displayName: Schema.String,
  links: Schema.Struct({
    website: Schema.optional(Schema.String),
  }),
  popularBookIds: Schema.Array(Schema.String),
  specialties: Schema.Array(Schema.String),
});

const BookSourceIdentity = SourceIdentity.make({
  id: "book@v1",
  schema: SourceIdentity.key("bookId", Schema.NonEmptyString),
});

const AuthorSourceIdentity = SourceIdentity.make({
  id: "author@v1",
  schema: SourceIdentity.key("authorId", Schema.NonEmptyString),
});

const BookEntryFields = Schema.Struct({
  authorEntries: Schema.Array(Schema.String),
  authorReferenceStatuses: Schema.Array(Schema.String),
  categorySlugs: Schema.Array(Schema.String),
  format: Schema.String,
  isStub: Schema.optionalKey(Schema.Boolean),
  isbn: Schema.String,
  listPriceAmount: Schema.Number,
  listPriceCurrency: Schema.String,
  publicationYear: Schema.Number,
  subtitle: Schema.optionalKey(Schema.String),
  title: Schema.String,
});

const AuthorEntryFields = Schema.Struct({
  biography: Schema.String,
  displayName: Schema.String,
  isStub: Schema.optionalKey(Schema.Boolean),
  popularBookEntries: Schema.Array(Schema.String),
  popularBookReferenceStatuses: Schema.Array(Schema.String),
  specialties: Schema.Array(Schema.String),
  website: Schema.optionalKey(Schema.String),
});

const BookTrackingRecord = Schema.Struct({
  entryId: Schema.String,
});

const AuthorTrackingRecord = Schema.Struct({
  entryId: Schema.String,
});

const bookTracking = Tracking.record({
  id: "book-entry@v1",
  schema: BookTrackingRecord,
});

const authorTracking = Tracking.record({
  id: "author-entry@v1",
  schema: AuthorTrackingRecord,
});

const makeBookstoreDestinationFixture = () => {
  const authorDestination = InMemoryDestination.makeEntries({
    contentType: "author",
    fields: AuthorEntryFields,
  });
  const bookDestination = InMemoryDestination.makeEntries({
    contentType: "book",
    fields: BookEntryFields,
  });

  return {
    authorDestination,
    bookDestination,
  };
};

type BookstoreDestinationFixture = ReturnType<
  typeof makeBookstoreDestinationFixture
>;
type BookEntryFieldsValue = typeof BookEntryFields.Type;
type AuthorEntryFieldsValue = typeof AuthorEntryFields.Type;
type BookUpsertChange = InMemoryEntryUpsertedChange<
  "book",
  BookEntryFieldsValue
>;
type AuthorUpsertChange = InMemoryEntryUpsertedChange<
  "author",
  AuthorEntryFieldsValue
>;
type BookstoreUpsertChange = BookUpsertChange | AuthorUpsertChange;
type SourceIdentityKey<Definition> =
  Definition extends SourceIdentityDefinition<infer Key> ? Key : never;

type ReferenceLookupPipelineError =
  | DestinationPluginError
  | MigrationReferenceLookupError
  | MigrationStoreError
  | Schema.SchemaError;
type BookMigration = MigrationDefinition<
  typeof BookSource.Type,
  never,
  ReferenceLookupPipelineError,
  InMemorySourceCursor,
  SourceIdentityKey<typeof BookSourceIdentity>,
  ReferenceLookupPipelineError,
  unknown,
  never,
  never,
  typeof bookTracking
>;
type AuthorMigration = MigrationDefinition<
  typeof AuthorSource.Type,
  never,
  ReferenceLookupPipelineError,
  InMemorySourceCursor,
  SourceIdentityKey<typeof AuthorSourceIdentity>,
  ReferenceLookupPipelineError,
  unknown,
  never,
  never,
  typeof authorTracking
>;

export interface CircularBookAuthorStubsExampleResult {
  readonly authorEntryFields: AuthorEntryFieldsValue | null;
  readonly authorState: MigrationItemState | null;
  readonly bookEntryFields: BookEntryFieldsValue | null;
  readonly bookStubState: MigrationItemState | null;
  readonly itemStates: readonly MigrationItemState[];
  readonly summary: MigrationRunSummary;
  readonly upsertChanges: readonly BookstoreUpsertChange[];
}

const bookSourceItems = [
  {
    identityKey: "book:effectful-architecture",
    version: "book-version-1",
    item: {
      authorIds: ["author:maya-chen"],
      categories: ["software-architecture", "typescript"],
      format: "hardcover",
      isbn: "978-1-55555-010-2",
      listPrice: {
        amount: 48,
        currency: "USD",
      },
      publicationYear: 2026,
      subtitle: "Designing migration systems with Effect",
      title: "  Effectful Architecture  ",
    },
  },
] as const;

const authorSourceItems = [
  {
    identityKey: "author:maya-chen",
    version: "author-version-1",
    item: {
      biography:
        "Maya Chen writes about TypeScript, content platforms, and operational architecture.",
      displayName: "Maya Chen",
      links: {
        website: "https://example.com/maya-chen",
      },
      popularBookIds: ["book:effectful-architecture", "book:future-catalog"],
      specialties: ["TypeScript", "Effect", "Content migrations"],
    },
  },
] as const;

const isUpsertExecution = (
  change: BookstoreUpsertChange
): change is BookstoreUpsertChange => change.contentType !== undefined;

const isBookUpsertChange = (
  change: BookstoreUpsertChange
): change is BookUpsertChange => change.contentType === "book";

const isAuthorUpsertChange = (
  change: BookstoreUpsertChange
): change is AuthorUpsertChange => change.contentType === "author";

const processJournalEntries = (itemState: MigrationItemState) =>
  itemState.status === "migrated" ||
  itemState.status === "failed" ||
  itemState.status === "needs-update" ||
  itemState.status === "skipped"
    ? (itemState.journal?.process.entries ?? [])
    : [];

const collectUpsertChanges = (
  destinationFixture: BookstoreDestinationFixture,
  itemStates: readonly MigrationItemState[]
): Effect.Effect<readonly BookstoreUpsertChange[], Schema.SchemaError> =>
  Effect.gen(function* () {
    const changes: BookstoreUpsertChange[] = [];

    for (const entry of itemStates.flatMap(processJournalEntries)) {
      if (destinationFixture.bookDestination.changes.entryUpserted.is(entry)) {
        const decoded =
          yield* destinationFixture.bookDestination.changes.entryUpserted.decode(
            entry
          );
        changes.push(decoded.value);
        continue;
      }

      if (
        destinationFixture.authorDestination.changes.entryUpserted.is(entry)
      ) {
        const decoded =
          yield* destinationFixture.authorDestination.changes.entryUpserted.decode(
            entry
          );
        changes.push(decoded.value);
      }
    }

    return changes;
  });

export const makeCircularBookAuthorStubMigrations = () => {
  const storeState = InMemoryMigrationStore.makeState();
  const store = InMemoryMigrationStore.layer(storeState);
  const destinationFixture = makeBookstoreDestinationFixture();
  const { authorDestination, bookDestination } = destinationFixture;

  const books: BookMigration = defineMigration({
    id: "books",
    source: InMemorySourcePlugin.make({
      identity: BookSourceIdentity,
      items: bookSourceItems,
      sourceSchema: BookSource,
    }),
    store,
    tracking: bookTracking,
    stub: ({ sourceIdentity }) =>
      Effect.gen(function* () {
        const entry = yield* bookDestination.entries.upsert({
          authorEntries: [],
          authorReferenceStatuses: [],
          categorySlugs: [],
          format: "unknown",
          isStub: true,
          isbn: "pending",
          listPriceAmount: 0,
          listPriceCurrency: "USD",
          publicationYear: 0,
          title: `Stub book for ${sourceIdentity}`,
        });

        yield* Tracking.setRecord({
          entryId: entry.destinationIdentity,
        });
      }),
    process: Effect.fn("books.process")(function* (source) {
      const references = yield* MigrationReferenceLookup;
      const authorReferences = yield* Effect.all(
        source.item.authorIds.map((authorId) =>
          references.lookup({
            definition: authors,
            sourceIdentityKey: authorId,
            stub: true,
          })
        )
      );

      const entry = yield* bookDestination.entries.upsert({
        authorEntries: authorReferences.flatMap((reference) =>
          reference === null ? [] : [reference.trackingRecord.entryId]
        ),
        authorReferenceStatuses: authorReferences.flatMap((reference) =>
          reference === null ? [] : [reference.status]
        ),
        categorySlugs: source.item.categories,
        format: source.item.format,
        isbn: source.item.isbn,
        listPriceAmount: source.item.listPrice.amount,
        listPriceCurrency: source.item.listPrice.currency,
        publicationYear: source.item.publicationYear,
        ...(source.item.subtitle === undefined
          ? {}
          : { subtitle: source.item.subtitle }),
        title: source.item.title,
      });

      yield* Tracking.setRecord({
        entryId: entry.destinationIdentity,
      });
    }),
  });

  const authors: AuthorMigration = defineMigration({
    id: "authors",
    source: InMemorySourcePlugin.make({
      identity: AuthorSourceIdentity,
      items: authorSourceItems,
      sourceSchema: AuthorSource,
    }),
    store,
    tracking: authorTracking,
    stub: ({ sourceIdentity }) =>
      Effect.gen(function* () {
        const entry = yield* authorDestination.entries.upsert({
          biography: "Pending author profile",
          displayName: `Stub author for ${sourceIdentity}`,
          isStub: true,
          popularBookEntries: [],
          popularBookReferenceStatuses: [],
          specialties: [],
        });

        yield* Tracking.setRecord({
          entryId: entry.destinationIdentity,
        });
      }),
    process: Effect.fn("authors.process")(function* (source) {
      const references = yield* MigrationReferenceLookup;
      const popularBookReferences = yield* Effect.all(
        source.item.popularBookIds.map((bookId) =>
          references.lookup({
            definition: books,
            sourceIdentityKey: bookId,
            stub: true,
          })
        )
      );

      const entry = yield* authorDestination.entries.upsert({
        biography: source.item.biography,
        displayName: source.item.displayName,
        popularBookEntries: popularBookReferences.flatMap((reference) =>
          reference === null ? [] : [reference.trackingRecord.entryId]
        ),
        popularBookReferenceStatuses: popularBookReferences.flatMap(
          (reference) => (reference === null ? [] : [reference.status])
        ),
        specialties: source.item.specialties,
        ...(source.item.links.website === undefined
          ? {}
          : { website: source.item.links.website }),
      });

      yield* Tracking.setRecord({
        entryId: entry.destinationIdentity,
      });
    }),
  });

  // Do not write `dependsOn` here. Books and Authors form a source-level cycle:
  // Books need Authors, and Authors need popular Books. Running both
  // definitions together lets pipelines resolve the cycle with lookup-created
  // stubs instead of impossible dependency ordering.
  return {
    definitions: [books, authors] as const,
    destinationFixture,
    storeState,
  };
};

export const runCircularBookAuthorStubsExample = Effect.fn(
  "runCircularBookAuthorStubsExample"
)(function* () {
  const { definitions, destinationFixture, storeState } =
    makeCircularBookAuthorStubMigrations();
  const summary = yield* runMigrations({
    definitions,
    definitionIds: ["books", "authors"],
  });
  const itemStates = Array.from(storeState.itemStates.values());
  const upsertChanges = (yield* collectUpsertChanges(
    destinationFixture,
    itemStates
  )).filter(isUpsertExecution);

  return {
    authorEntryFields:
      upsertChanges.find(
        (change): change is AuthorUpsertChange =>
          isAuthorUpsertChange(change) &&
          change.sourceIdentity === "author:maya-chen" &&
          change.fields.isStub !== true
      )?.fields ?? null,
    authorState:
      storeState.itemStates.get(
        InMemoryMigrationStore.itemStateKey("authors", "author:maya-chen")
      ) ?? null,
    bookEntryFields:
      upsertChanges.find(
        (change): change is BookUpsertChange =>
          isBookUpsertChange(change) &&
          change.sourceIdentity === "book:effectful-architecture" &&
          change.fields.isStub !== true
      )?.fields ?? null,
    bookStubState:
      storeState.itemStates.get(
        InMemoryMigrationStore.itemStateKey("books", "book:future-catalog")
      ) ?? null,
    itemStates,
    summary,
    upsertChanges,
  } satisfies CircularBookAuthorStubsExampleResult;
});

export const formatCircularBookAuthorStubsExampleResult = (
  result: CircularBookAuthorStubsExampleResult
): string => {
  return [
    "Circular Book and Author Stub Example",
    formatMigrationRunSummary(result.summary),
    "",
    "Destination Upserts",
    ...result.upsertChanges.map((change) =>
      [
        `${change.contentType}:${change.sourceIdentity}`,
        `  contentType: ${change.contentType}`,
        `  destinationIdentity: ${change.destinationIdentity}`,
        `  fields: ${JSON.stringify(change.fields)}`,
      ].join("\n")
    ),
    "",
    "Persisted Item States",
    ...result.itemStates.map((itemState) =>
      [
        `${itemState.definitionId}:${itemState.sourceIdentity.encoded}`,
        `  status: ${itemState.status}`,
        ...(itemState.status === "failed"
          ? [
              `  error: ${itemState.error.message}`,
              ...(itemState.error.details?.map(
                (detail) =>
                  `  detail: ${detail.path ?? "<root>"} ${detail.message}`
              ) ?? []),
            ]
          : []),
      ].join("\n")
    ),
    "",
    `future book stub status: ${result.bookStubState?.status ?? "missing"}`,
    `author final status: ${result.authorState?.status ?? "missing"}`,
  ].join("\n");
};
