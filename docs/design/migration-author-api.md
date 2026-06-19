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

## Execution Concurrency

Process and rollback pipelines run serially by default. Authors can set
definition defaults, and operators can override them from the CLI:

```ts
const articles = defineMigration({
  id: "articles",
  source,
  store,
  execution: {
    process: { concurrency: 4 },
    rollback: { concurrency: 2 },
  },
  process: Effect.fn("articles.process")(function* (source) {
    // destination writes
  }),
  rollback: Effect.fn("articles.rollback")(function* (state) {
    // destination deletes
  }),
})
```

`concurrency` accepts a positive integer or `"unbounded"`. The CLI exposes the
same command-local override as `migrate run --concurrency 4 ...` /
`migrate run -c 4 ...` and `migrate rollback --concurrency unbounded ...`.
Status source scans use the same command-local flag name for their own
source-scan concurrency. Plan output includes the effective policy for each
selected Migration Definition.

Concurrency controls how many source items have active pipeline Effects at the
same time. It does not replace per-item retry policy. Each concurrent pipeline
run can still retry, back off, and jitter through ordinary `.pipe()` semantics:

```ts
import { Effect, Schedule } from "effect"

const RetryDestinationWrite = Schedule.exponential("250 millis").pipe(
  Schedule.both(Schedule.recurs(3)),
  Schedule.jittered
)

const articles = defineMigration({
  id: "articles",
  source,
  store,
  execution: {
    process: { concurrency: 4 },
  },
  process: (source) => {
    const process = Effect.gen(function* () {
      const entry = yield* entries.entries.upsert({
        title: source.item.title,
      })

      yield* Tracking.setRecord({
        entryId: entry.entryId,
      })
    })

    return process.pipe(
      Effect.retry(RetryDestinationWrite),
      Effect.timeout("30 seconds")
    )
  },
})
```

With `process.concurrency = 4`, up to four source items can be in flight. Each
item owns its own retry schedule, so jitter prevents their retries from lining
up against the same destination dependency.
