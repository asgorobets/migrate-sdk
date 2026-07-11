# Prebuilt Destination Helper Usage

Audience: migration authors using packaged destination helpers.

Status: current process-tracking design.

Prebuilt destination packages expose Effect helpers, typed change descriptors,
and any required dependency layers. Migration definitions call those helpers
inside `process`; the runtime provides the per-item tracking scope and stores
journal evidence when helpers record changes or diagnostics.

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
