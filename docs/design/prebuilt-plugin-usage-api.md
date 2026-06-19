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

const articles = defineMigration({
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
their module-owned descriptors. Process code may also stage a tracking record
with `Tracking.setRecord(...)` when the migration definition declares a
tracking contract.
