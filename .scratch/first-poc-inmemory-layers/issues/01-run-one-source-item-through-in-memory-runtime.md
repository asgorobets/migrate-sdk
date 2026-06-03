# Run one Source Item through in-memory runtime

Status: done

## Parent

[First POC: In-Memory Migration Runtime](../PRD.md)

## What to build

Build the first end-to-end tracer bullet for the SDK runtime: a typed Migration Definition runs one Source Item through in-memory SourcePlugin, Transformation Pipeline, in-memory DestinationPlugin, and in-memory MigrationStore, then returns a completed Migration Run Summary.

This slice should establish the core Effect service boundaries, the in-memory layer pattern, migrated Migration Item State persistence, and public exports needed by later slices.

## Acceptance criteria

- [x] A developer can define a typed Migration Definition that connects source, pipeline, destination, and store behavior.
- [x] SourcePlugin, DestinationPlugin, and MigrationStore are exposed as Effect service tags.
- [x] In-memory source, destination, and store layers can be provided to the runner.
- [x] Running one Source Item executes one Destination Command and persists migrated Migration Item State.
- [x] The run returns a completed Migration Run Summary with migrated counts.
- [x] Public runtime types and helpers needed for this slice are exported from the package entrypoint.
- [x] Tests verify the end-to-end behavior through the public SDK surface.

## Blocked by

None - can start immediately
