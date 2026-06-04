# Expose SDK entrypoint and runnable in-memory example

Status: done

## Parent

[First POC: In-Memory Migration Runtime](../PRD.md)

## What to build

Finalize the first POC as a usable SDK surface. Export the runtime API from the package entrypoint and provide a small runnable in-memory example that demonstrates a complete Migration Run with Source Items, Destination Commands, Migration Item State, and Migration Run Summary output.

## Acceptance criteria

- [x] The package entrypoint exports the public runtime API for the POC.
- [x] The starter Effect example is replaced or updated to demonstrate the in-memory migration runtime.
- [x] A developer can run the package dev script and see a completed in-memory Migration Run.
- [x] The example uses public helpers and domain terminology from the docs.
- [x] The example does not rely on external systems.
- [x] Type checking passes for the package.

## Blocked by

- [04 - Implement Run Modes over Migration Item State](04-implement-run-modes-over-migration-item-state.md)
- [05 - Run multiple Migration Definitions with locks](05-run-multiple-migration-definitions-with-locks.md)
- [06 - Apply source and destination retry wrappers](06-apply-source-and-destination-retry-wrappers.md)
