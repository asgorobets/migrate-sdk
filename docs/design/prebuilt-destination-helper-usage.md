# Prebuilt Destination Helper Usage

Audience: migration authors using packaged destination helpers.

Status: current process-tracking design.

Prebuilt destination packages expose Effect helpers, typed change descriptors,
and any required dependency layers. Migration definitions call those helpers
inside their selected processing pipeline, `process` or `processBatch`; the
runtime provides the per-item tracking scope and stores journal evidence when
helpers record changes or diagnostics.

```ts
const entries = InMemoryDestination.makeEntries({
  contentType: "article",
  fields: ArticleEntryFields,
})

const articles = MigrationDefinition.make({
  id: "articles",
  source,
  store,
  process: Effect.fn("articles.process")(function* (source) {
    yield* entries.entries.upsert({
      title: source.item.title,
    })
  }),
})
```

Helpers that write destination-side state should record typed changes through
their module-owned descriptors. Journal entries inherit source identity from
their owning Migration Item State instead of duplicating it in every entry or
descriptor value. SDK-owned helpers, such as the in-memory destination, may use
private runtime item-scope metadata when identity is required for destination
behavior. Separately packaged or customer-authored helpers receive identity
explicitly from `source.identity`, the stub input, or rollback state rather than
through `Tracking`. Process code may also stage a tracking record with
`Tracking.setRecord(...)` when the migration definition declares a tracking
contract.

## Helper-owned journal extensions

A helper may need durable information that is not a destination change,
diagnostic, or migration tracking record. It can declare a typed journal
extension and keep the read/write details inside its own module:

```ts
const ImportOperationJournal = DestinationJournalExtension.make(
  "example.product-import.operation@v1",
  Schema.Struct({
    operationId: Schema.String,
    state: Schema.String,
  })
)

const resume = (journal: DestinationJournal | undefined) =>
  ImportOperationJournal.read(journal)

const recordOperation = (operationId: string, state: string) =>
  Tracking.setExtension(ImportOperationJournal, { operationId, state })

const forgetOperation = Tracking.removeExtension(ImportOperationJournal)
```

The SDK validates and persists the encoded value but does not interpret it.
Setting the extension replaces only that extension; removing it does not alter
standard process entries or extensions owned by other helpers. Untouched
extensions survive reprocessing, and updates are saved with migrated, failed,
or skipped item outcomes. This is an escape hatch for helpers, not an SDK-owned
attempt history or a replacement for a migration's stable Tracking Record.
