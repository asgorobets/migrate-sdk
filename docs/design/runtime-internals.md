# Runtime Internals

Audience: SDK maintainers.

Status: current scoped process runtime notes.

The runtime owns source reading, item-state lookup, scoped tracking, migration
contract checks, definition locks, and durable state writes. User code owns the
process body and any destination helper calls it performs.

For each source item the runtime:

1. Decodes source payload and source identity.
2. Checks previous item state and source-version comparability.
3. Creates a scoped tracking service for the item.
4. Runs `process` inside that scope.
5. Persists skipped, failed, migrated, unchanged, or needs-update item state.
6. Stores any process journal segment or tracking record produced by the scope.

Rollback uses the same scoped tracking service shape with a separate attempt
scope. A successful rollback deletes item state. A failed rollback appends the
attempt journal to the existing item state.
