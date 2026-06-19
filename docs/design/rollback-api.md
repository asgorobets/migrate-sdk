# Rollback API

Audience: migration authors and runtime maintainers.

Status: current rollback process model.

Rollback is explicit. A migration definition that may roll back stored item
state declares `rollback`. The runtime passes the durable item state and a
rollback context, provides a scoped tracking service for the attempt, and
deletes item state only when the rollback process succeeds.

```ts
const articles = defineMigration({
  id: "articles",
  source,
  store,
  process,
  rollback: Effect.fn("articles.rollback")(function* (state, context) {
    for (const entry of state.journal?.process.entries ?? []) {
      if (entries.changes.entryUpserted.is(entry)) {
        const change = yield* entries.changes.entryUpserted.decode(entry)
        yield* rawApi.deleteEntry(change.value.entryId)
      }
    }

    yield* Tracking.logDiagnostic({
      severity: "info",
      message: "Rollback completed",
      details: {
        definitionId: context.definitionId,
      },
    })
  }),
})
```

If a rollback process fails, the runtime leaves the item state in place and
appends a failed rollback attempt segment. The segment contains rollback-scope
journal entries and normalized failure metadata. If the rollback process
succeeds, the item state is removed and no rollback attempt state remains for
that item.
