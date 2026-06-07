import { Effect, Schema } from "effect";
import {
  defineMigration,
  type MigrationItemState,
  MigrationReferenceLookup,
  type MigrationRunSummary,
  runMigrations,
} from "migrate-sdk";
import { InMemoryDestinationTesting } from "migrate-sdk/destinations/in-memory/testing";
import { InMemorySourcePlugin } from "migrate-sdk/sources/in-memory";
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

const makeBookstoreDestinationFixture = () => {
  const author = InMemoryDestinationTesting.fixtureEntries({
    contentType: "author",
    commands: {
      publishEntry: true,
      upsertEntry: { fields: AuthorEntryFields },
    },
  });
  const book = InMemoryDestinationTesting.fixtureEntries({
    contentType: "book",
    commands: {
      publishEntry: true,
      upsertEntry: { fields: BookEntryFields },
    },
  });

  return {
    authorDestination: author.destination,
    bookDestination: book.destination,
    executions: () => [...book.executions(), ...author.executions()],
  };
};

type BookstoreDestinationFixture = ReturnType<
  typeof makeBookstoreDestinationFixture
>;
type BookstoreExecution = ReturnType<
  BookstoreDestinationFixture["executions"]
>[number];
type BookstoreCommand = BookstoreExecution["command"];
type UpsertBookstoreCommand = Extract<
  BookstoreCommand,
  { readonly kind: "UpsertEntry" }
>;
type UpsertBookEntryCommand = Extract<
  BookstoreCommand,
  { readonly contentType: "book"; readonly kind: "UpsertEntry" }
>;
type UpsertAuthorEntryCommand = Extract<
  BookstoreCommand,
  { readonly contentType: "author"; readonly kind: "UpsertEntry" }
>;
type UpsertBookstoreExecution = BookstoreExecution & {
  readonly command: UpsertBookstoreCommand;
};
type BookUpsertExecution = BookstoreExecution & {
  readonly command: UpsertBookEntryCommand;
};
type AuthorUpsertExecution = BookstoreExecution & {
  readonly command: UpsertAuthorEntryCommand;
};

export interface CircularBookAuthorStubsExampleResult {
  readonly authorEntryFields: UpsertAuthorEntryCommand["fields"] | null;
  readonly authorState: MigrationItemState | null;
  readonly bookEntryFields: UpsertBookEntryCommand["fields"] | null;
  readonly bookStubState: MigrationItemState | null;
  readonly executions: readonly BookstoreExecution[];
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
] as const;

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
] as const;

const isUpsertExecution = (
  execution: BookstoreExecution
): execution is UpsertBookstoreExecution =>
  execution.command.kind === "UpsertEntry";

const isBookUpsertExecution = (
  execution: UpsertBookstoreExecution
): execution is BookUpsertExecution => execution.command.contentType === "book";

const isAuthorUpsertExecution = (
  execution: UpsertBookstoreExecution
): execution is AuthorUpsertExecution =>
  execution.command.contentType === "author";

export const runCircularBookAuthorStubsExample = Effect.fn(
  "runCircularBookAuthorStubsExample"
)(function* () {
  const storeState = InMemoryMigrationStore.makeState();
  const store = InMemoryMigrationStore.layer(storeState);
  const destinationFixture = makeBookstoreDestinationFixture();
  const { authorDestination, bookDestination } = destinationFixture;

  const books = defineMigration({
    id: "books",
    source: InMemorySourcePlugin.make({
      items: bookSourceItems,
      sourceSchema: BookSource,
    }),
    destination: bookDestination,
    store,
    // This hook is used when another migration looks up a Book with `stub: true`.
    // The Author pipeline below uses it for `book:future-catalog`, creating a
    // minimal Book entry until that source item appears in a later run.
    stub: ({ sourceIdentity }) =>
      bookDestination.commands.upsertEntry({
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
      }),
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
        bookDestination.commands.upsertEntry({
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
        }),
        bookDestination.commands.publishEntry(),
      ];
    }),
  });

  const authors = defineMigration({
    id: "authors",
    source: InMemorySourcePlugin.make({
      items: authorSourceItems,
      sourceSchema: AuthorSource,
    }),
    destination: authorDestination,
    store,
    // This hook is used when another migration looks up an Author with
    // `stub: true`. The Book pipeline above uses it before Authors have run,
    // then this Author migration updates the same destination entry.
    stub: ({ sourceIdentity }) =>
      authorDestination.commands.upsertEntry({
        biography: "Pending author profile",
        displayName: `Stub author for ${sourceIdentity}`,
        isStub: true,
        popularBookEntries: [],
        popularBookReferenceStatuses: [],
        specialties: [],
      }),
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
        authorDestination.commands.upsertEntry({
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
        }),
        authorDestination.commands.publishEntry(),
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
  const upsertExecutions = destinationFixture
    .executions()
    .filter(isUpsertExecution);

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
    executions: destinationFixture.executions(),
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
