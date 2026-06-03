# Run multiple Migration Definitions with locks

Status: done

## Parent

[First POC: In-Memory Migration Runtime](../PRD.md)

## What to build

Support Run Requests that include multiple Migration Definitions. The runner should expand selected definitions with dependencies, reject missing dependencies and cycles before execution, order definitions topologically, execute them sequentially, and use MigrationStore definition-level locks for each Migration Definition.

## Acceptance criteria

- [x] The runner can execute multiple Migration Definitions in dependency order.
- [x] Selecting specific Migration Definitions includes required dependencies automatically.
- [x] Missing dependencies fail before any Migration Definition executes.
- [x] Dependency cycles fail before any Migration Definition executes.
- [x] The MigrationStore acquires and releases a Migration Definition Lock around each definition run.
- [x] Concurrent lock ownership for the same Migration Definition is rejected.
- [x] Tests verify dependency expansion, topological ordering, missing dependency rejection, cycle rejection, and lock behavior.

## Blocked by

- [01 - Run one Source Item through in-memory runtime](01-run-one-source-item-through-in-memory-runtime.md)
