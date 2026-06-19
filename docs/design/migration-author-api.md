# Migration Author API

Audience: SDK users writing migrations.

Status: current process authoring model.

Migration definitions describe source access, durable store access, optional
dependencies, optional tracking contracts, and a required `process` function.
Destination work happens inline through normal Effect code.

```ts
const ArticleTracking = Tracking.record({
  id: "article-entry@v1",
  schema: Schema.Struct({
    entryId: Schema.String,
  }),
})

const entries = InMemoryDestination.makeEntries({
  contentType: "article",
  fields: Schema.Struct({
    title: Schema.String,
  }),
})

const articles = defineMigration({
  id: "articles",
  source,
  store,
  tracking: ArticleTracking,
  process: Effect.fn("articles.process")(function* (source) {
    const entry = yield* entries.entries.upsert({
      title: source.item.title,
    })

    yield* Tracking.setRecord({
      entryId: entry.entryId,
    })
  }),
})
```

The runtime provides scoped tracking services around each source item. A
successful item persists source identity, source version, status, and any
journal segment or tracking record produced by the process. A failed item keeps
the available process journal and normalized failure metadata.
