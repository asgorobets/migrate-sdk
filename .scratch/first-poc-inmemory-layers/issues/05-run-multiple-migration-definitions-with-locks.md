# Run multiple Migration Definitions with locks

Status: ready-for-agent

## Parent

[First POC: In-Memory Migration Runtime](../PRD.md)

## What to build

Support Run Requests that include multiple Migration Definitions. The runner should expand selected definitions with dependencies, reject missing dependencies and cycles before execution, order definitions topologically, execute them sequentially, and use MigrationStore definition-level locks for each Migration Definition.

## Acceptance criteria

- [ ] The runner can execute multiple Migration Definitions in dependency order.
- [ ] Selecting specific Migration Definitions includes required dependencies automatically.
- [ ] Missing dependencies fail before any Migration Definition executes.
- [ ] Dependency cycles fail before any Migration Definition executes.
- [ ] The MigrationStore acquires and releases a Migration Definition Lock around each definition run.
- [ ] Concurrent lock ownership for the same Migration Definition is rejected.
- [ ] Tests verify dependency expansion, topological ordering, missing dependency rejection, cycle rejection, and lock behavior.

## Blocked by

- [01 - Run one Source Item through in-memory runtime](01-run-one-source-item-through-in-memory-runtime.md)
