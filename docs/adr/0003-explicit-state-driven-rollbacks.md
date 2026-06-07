# Explicit State-Driven Rollbacks

Rollback is modeled as an explicit rollback pipeline that turns durable migration item state into normal destination commands, rather than as an inferred inverse of the forward command plan. A migration item is rollbackable when its durable state contains a destination identity; after the rollback command plan succeeds completely, the migration store deletes the item state so the source identity is treated as unmigrated by durable migration memory.

## Status

Accepted

## Considered Options

- Infer rollback commands by reversing forward destination commands.
- Require destination plugins to model reversible commands such as publish/unpublish through one command shape.
- Add a terminal rolled-back migration item state.
- Use an explicit rollback pipeline driven by durable migration item state.

## Consequences

- Destination plugins can expose destination-native commands such as create, publish, unpublish, and delete without teaching the core runtime command inverses.
- Migration definitions may remain forward-only, but a rollback run fails in preflight when any selected definition with rollbackable item state lacks a rollback pipeline.
- Rollback uses the same migration definition lock primitive as forward migration execution.
- Rollback does not read source items or mutate source cursors.
- Rollback does not silently expand to dependent migration definitions; a rollback run fails preflight when unselected dependents still have rollbackable item state.
- Rollback executes the selected migration definition set in reverse dependency order.
- Rollback pipelines receive a narrowed rollbackable item state type that guarantees a destination identity.
- Needs-update states, including states created for destination stubs, are rollbackable when they contain a destination identity.
- Rollback command plans may contain only side-effect-only destination commands; identity-bearing commands are rejected because rollback compensates an existing durable destination identity.
- Destination identities or versions returned by rollback command execution are ignored for durable item state purposes.
- Successful rollback removes the item state, while failed rollback preserves the original item state for retry.
- The migration store exposes a dedicated item-state deletion operation for successful rollback.
- Rollback returns a separate rollback run summary for the current execution session; the first version does not persist rollback summary counts as durable run state.
- Rollback is exposed as a separate public operation from forward migration execution.
- A future migration executable API may group run and rollback operations under one public object, but the first rollback slice should add the separate rollback operation before broader API consolidation.
- Rollback dry-run or planning mode is deferred until command planning and effect boundaries can provide useful guarantees.
- The first rollback slice reuses the current migration store item-state listing and direct item-state lookup capabilities; large-catalog pagination is a future storage consideration, not part of the initial rollback contract.
- Re-migration after rollback is handled by migration run modes such as normal discovery, identity-targeted runs, or a future rescan mode.
