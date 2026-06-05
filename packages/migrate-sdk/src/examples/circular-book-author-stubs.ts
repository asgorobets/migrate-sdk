import { Effect, Schema } from "effect";
import {
  defineMigration,
  type InMemoryDestinationExecution,
  InMemoryDestinationPlugin,
  InMemoryMigrationStore,
  InMemorySourcePlugin,
  type MigrationItemState,
  MigrationReferenceLookup,
  type MigrationRunSummary,
  runMigrations,
  type SourceItemInput,
} from "../index.ts";
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

type BookSource = typeof BookSource.Type;

const AuthorSource = Schema.Struct({
  biography: Schema.String,
  displayName: Schema.String,
  links: Schema.Struct({
    website: Schema.optional(Schema.String),
  }),
  popularBookIds: Schema.Array(Schema.String),
  specialties: Schema.Array(Schema.String),
});

type AuthorSource = typeof AuthorSource.Type;

const BookEntryFields = Schema.Struct({
  authorEntries: Schema.Array(Schema.String),
  authorReferenceStatuses: Schema.Array(Schema.String),
  categorySlugs: Schema.Array(Schema.String),
  format: Schema.String,
  isStub: Schema.optional(Schema.Boolean),
  isbn: Schema.String,
  listPriceAmount: Schema.Number,
  listPriceCurrency: Schema.String,
  publicationYear: Schema.Number,
  subtitle: Schema.optional(Schema.String),
  title: Schema.String,
});

const AuthorEntryFields = Schema.Struct({
  biography: Schema.String,
  displayName: Schema.String,
  isStub: Schema.optional(Schema.Boolean),
  popularBookEntries: Schema.Array(Schema.String),
  popularBookReferenceStatuses: Schema.Array(Schema.String),
  specialties: Schema.Array(Schema.String),
  website: Schema.optional(Schema.String),
});

const UpsertBookEntryCommand = Schema.Struct({
  contentType: Schema.Literal("book"),
  fields: BookEntryFields,
  kind: Schema.Literal("UpsertEntry"),
});

const UpsertAuthorEntryCommand = Schema.Struct({
  contentType: Schema.Literal("author"),
  fields: AuthorEntryFields,
  kind: Schema.Literal("UpsertEntry"),
});

const PublishBookEntryCommand = Schema.Struct({
  contentType: Schema.Literal("book"),
  kind: Schema.Literal("PublishEntry"),
});

const PublishAuthorEntryCommand = Schema.Struct({
  contentType: Schema.Literal("author"),
  kind: Schema.Literal("PublishEntry"),
});

const BookstoreCommand = Schema.Union([
  UpsertBookEntryCommand,
  UpsertAuthorEntryCommand,
  PublishBookEntryCommand,
  PublishAuthorEntryCommand,
]);

type BookstoreCommand = typeof BookstoreCommand.Type;
type UpsertBookEntryCommand = typeof UpsertBookEntryCommand.Type;
type UpsertAuthorEntryCommand = typeof UpsertAuthorEntryCommand.Type;
type UpsertBookstoreCommand = UpsertBookEntryCommand | UpsertAuthorEntryCommand;
type UpsertBookstoreExecution =
  InMemoryDestinationExecution<UpsertBookstoreCommand>;
type BookUpsertExecution = InMemoryDestinationExecution<UpsertBookEntryCommand>;
type AuthorUpsertExecution =
  InMemoryDestinationExecution<UpsertAuthorEntryCommand>;

export interface CircularBookAuthorStubsExampleResult {
  readonly authorEntryFields: UpsertAuthorEntryCommand["fields"] | null;
  readonly authorState: MigrationItemState | null;
  readonly bookEntryFields: UpsertBookEntryCommand["fields"] | null;
  readonly bookStubState: MigrationItemState | null;
  readonly executions: readonly InMemoryDestinationExecution<BookstoreCommand>[];
  readonly itemStates: readonly MigrationItemState[];
  readonly summary: MigrationRunSummary;
  readonly upsertExecutions: readonly UpsertBookstoreExecution[];
}

const bookSourceItems = [
  {
    identity: "book:effectful-architecture",
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
] satisfies readonly SourceItemInput<BookSource>[];

const authorSourceItems = [
  {
    identity: "author:maya-chen",
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
] satisfies readonly SourceItemInput<AuthorSource>[];

const destinationIdentityFor = (definitionId: string, sourceIdentity: string) =>
  `entry:${definitionId}:${sourceIdentity}`;

const isUpsertExecution = (
  execution: InMemoryDestinationExecution<BookstoreCommand>
): execution is UpsertBookstoreExecution =>
  execution.command.kind === "UpsertEntry";

const isBookUpsertExecution = (
  execution: UpsertBookstoreExecution
): execution is BookUpsertExecution => execution.command.contentType === "book";

const isAuthorUpsertExecution = (
  execution: UpsertBookstoreExecution
): execution is AuthorUpsertExecution =>
  execution.command.contentType === "author";

const makeBookStubCommand = (
  sourceIdentity: string
): UpsertBookEntryCommand => ({
  contentType: "book",
  fields: {
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
  },
  kind: "UpsertEntry",
});

const makeAuthorStubCommand = (
  sourceIdentity: string
): UpsertAuthorEntryCommand => ({
  contentType: "author",
  fields: {
    biography: "Pending author profile",
    displayName: `Stub author for ${sourceIdentity}`,
    isStub: true,
    popularBookEntries: [],
    popularBookReferenceStatuses: [],
    specialties: [],
  },
  kind: "UpsertEntry",
});

export const runCircularBookAuthorStubsExample = Effect.fn(
  "runCircularBookAuthorStubsExample"
)(function* () {
  const storeState = InMemoryMigrationStore.makeState();
  const store = InMemoryMigrationStore.layer(storeState);
  const destinationState =
    InMemoryDestinationPlugin.makeState<BookstoreCommand>();
  const destination = InMemoryDestinationPlugin.make({
    commandSchema: BookstoreCommand,
    identityCommandKinds: ["UpsertEntry"],
    execute: (command, context) =>
      command.kind === "PublishEntry"
        ? {}
        : {
            destinationIdentity: destinationIdentityFor(
              context.definitionId,
              context.sourceIdentity
            ),
            destinationVersion: `version:${context.runId}:${context.sourceIdentity}`,
          },
    state: destinationState,
  });

  const books = defineMigration({
    id: "books",
    source: InMemorySourcePlugin.make({
      items: bookSourceItems,
      sourceSchema: BookSource,
    }),
    destination,
    store,
    // This hook is used when another migration looks up a Book with `stub: true`.
    // The Author pipeline below uses it for `book:future-catalog`, creating a
    // minimal Book entry until that source item appears in a later run.
    stub: ({ sourceIdentity }) =>
      Effect.succeed(makeBookStubCommand(sourceIdentity)),
    pipeline: Effect.fn("books.pipeline")(function* (source) {
      const references = yield* MigrationReferenceLookup;
      const authorReferences = yield* Effect.all(
        source.item.authorIds.map((authorId) =>
          references.lookup({
            definitionId: "authors",
            sourceIdentity: authorId,
            stub: true,
          })
        )
      );

      return [
        {
          contentType: "book" as const,
          fields: {
            authorEntries: authorReferences.flatMap((reference) =>
              reference === null ? [] : [reference.destinationIdentity]
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
            subtitle: source.item.subtitle,
            title: source.item.title,
          },
          kind: "UpsertEntry" as const,
        },
        {
          contentType: "book" as const,
          kind: "PublishEntry" as const,
        },
      ];
    }),
  });

  const authors = defineMigration({
    id: "authors",
    source: InMemorySourcePlugin.make({
      items: authorSourceItems,
      sourceSchema: AuthorSource,
    }),
    destination,
    store,
    // This hook is used when another migration looks up an Author with
    // `stub: true`. The Book pipeline above uses it before Authors have run,
    // then this Author migration updates the same destination entry.
    stub: ({ sourceIdentity }) =>
      Effect.succeed(makeAuthorStubCommand(sourceIdentity)),
    pipeline: Effect.fn("authors.pipeline")(function* (source) {
      const references = yield* MigrationReferenceLookup;
      const popularBookReferences = yield* Effect.all(
        source.item.popularBookIds.map((bookId) =>
          references.lookup({
            definitionId: "books",
            sourceIdentity: bookId,
            stub: true,
          })
        )
      );

      return [
        {
          contentType: "author" as const,
          fields: {
            biography: source.item.biography,
            displayName: source.item.displayName,
            popularBookEntries: popularBookReferences.flatMap((reference) =>
              reference === null ? [] : [reference.destinationIdentity]
            ),
            popularBookReferenceStatuses: popularBookReferences.flatMap(
              (reference) => (reference === null ? [] : [reference.status])
            ),
            specialties: source.item.specialties,
            website: source.item.links.website,
          },
          kind: "UpsertEntry" as const,
        },
        {
          contentType: "author" as const,
          kind: "PublishEntry" as const,
        },
      ];
    }),
  });

  // Do not write `dependsOn` here. Books and Authors form a source-level cycle:
  // Books need Authors, and Authors need popular Books. Running both
  // definitions together lets pipelines resolve the cycle with lookup-created
  // stubs instead of impossible dependency ordering.
  const summary = yield* runMigrations({
    definitions: [books, authors],
    definitionIds: ["books", "authors"],
  });
  const upsertExecutions =
    destinationState.executions.filter(isUpsertExecution);

  return {
    authorEntryFields:
      upsertExecutions.find(
        (execution): execution is AuthorUpsertExecution =>
          isAuthorUpsertExecution(execution) &&
          execution.context.sourceIdentity === "author:maya-chen" &&
          execution.command.fields.isStub !== true
      )?.command.fields ?? null,
    authorState:
      storeState.itemStates.get(
        InMemoryMigrationStore.itemStateKey("authors", "author:maya-chen")
      ) ?? null,
    bookEntryFields:
      upsertExecutions.find(
        (execution): execution is BookUpsertExecution =>
          isBookUpsertExecution(execution) &&
          execution.context.sourceIdentity === "book:effectful-architecture" &&
          execution.command.fields.isStub !== true
      )?.command.fields ?? null,
    bookStubState:
      storeState.itemStates.get(
        InMemoryMigrationStore.itemStateKey("books", "book:future-catalog")
      ) ?? null,
    executions: destinationState.executions,
    itemStates: Array.from(storeState.itemStates.values()),
    summary,
    upsertExecutions,
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
    ...result.upsertExecutions.map((execution) =>
      [
        `${execution.context.definitionId}:${execution.context.sourceIdentity}`,
        `  contentType: ${execution.command.contentType}`,
        `  destinationIdentity: ${execution.result.destinationIdentity}`,
        `  fields: ${JSON.stringify(execution.command.fields)}`,
      ].join("\n")
    ),
    "",
    "Persisted Item States",
    ...result.itemStates.map((itemState) =>
      [
        `${itemState.definitionId}:${itemState.sourceIdentity}`,
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
