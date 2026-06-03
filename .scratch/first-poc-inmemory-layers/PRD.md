# First POC: In-Memory Migration Runtime

Status: ready-for-agent

## Problem Statement

The migration framework has a clear initial API design, but the `migrate-sdk` package does not yet implement the runtime primitives. We need a small first proof of concept that proves the core semantics with in-memory layers before building SQL, file, SaaS, CLI, or durable execution integrations.

This PRD uses `docs/design/initial-api-design.md` as the detailed design source. The goal here is to define the first implementation slice, not repeat every example from that document.

## Solution

Implement an executable SDK runtime for Migration Definitions using Effect services and layers:

- SourcePlugin
- DestinationPlugin
- MigrationStore
- inline runner / Execution Adapter
- in-memory source, destination, and store layers

The POC should let a developer define one or more Migration Definitions, run them through the SDK API, and receive a completed Migration Run Summary. It should prove cursor windows, item state transitions, run modes, Skip Item handling, destination command execution, retry wrappers, dependency ordering, and definition-level locks.

## User Stories

1. As a migration framework developer, I want to define a typed Migration Definition, so that I can connect source, pipeline, destination, and store behavior.

2. As a migration framework developer, I want SourcePlugin, DestinationPlugin, and MigrationStore to be Effect services, so that implementations can be provided as layers.

3. As a migration framework developer, I want in-memory layers, so that I can validate runtime behavior without external systems.

4. As a migration framework developer, I want to run one or many Migration Definitions, so that dependency ordering and sequential execution can be tested.

5. As a migration framework developer, I want normal, failed, skipped, and item Run Modes, so that retry and targeted execution semantics are explicit.

6. As a migration framework developer, I want Skip Item to persist skipped item state without calling the destination, so that pipeline-level skip decisions are durable.

7. As a migration framework developer, I want item failures to be recorded while the run continues, so that one bad Source Item does not stop unrelated work.

8. As a migration framework developer, I want Source Cursors to advance after processed cursor windows, so that failed items do not pin incremental discovery forever.

9. As a migration framework developer, I want Destination Command results to persist Destination Identity and optional Destination Version, so that future updates have state to build on.

10. As a migration framework developer, I want a Migration Run Summary, so that SDK callers and tests can inspect status, counts, and cursor position.

## Implementation Decisions

- Keep implementation inside `migrate-sdk` as SDK runtime code.

- Treat `docs/design/initial-api-design.md` and `CONTEXT.md` as the source of truth for domain language and detailed behavior.

- Export core runtime types and helpers from the package entrypoint.

- Use `kind` for public command/request/result variants and `status` for persisted Migration Item State variants. Keep `_tag` limited to Effect-native errors such as Skip Item.

- Provide a public Skip Item helper so users can write pipeline skips without constructing `_tag` manually.

- Implement SourcePlugin, DestinationPlugin, and MigrationStore as Effect service tags with in-memory layer implementations.

- Implement a typed Migration Definition shape, plus a `defineMigration` helper if it improves inference.

- Implement an inline runner that expands selected definitions with dependencies, rejects missing dependencies and cycles, orders definitions, acquires definition locks, executes definitions sequentially, and returns a completed summary.

- Implement item processing for previous state lookup, unchanged detection, pipeline execution, skip handling, destination execution, error normalization, item state persistence, and summary outcome reporting.

- Implement normal mode as: process failed and needs-update backlog first, then process cursor discovery.

- Implement failed, skipped, and item modes as explicit targeted modes.

- Implement optional retry wrappers for source cursor reads, source identity lookups, and destination execution.

- Keep the in-memory implementations real reference layers, not test-only mocks.

## Testing Decisions

- Add tests around externally visible behavior: run summaries, item state, cursor commits, destination command executions, locks, dependency ordering, and retry behavior.

- Keep focused tests for deep modules: dependency ordering, Run Mode item selection, item processing, and summary aggregation.

- Use in-memory integration tests for normal, failed, skipped, and item modes.

- Test that Skip Item persists skipped state and does not execute a Destination Command.

- Test that item failures continue the run but mark the run summary as failed.

- Test that Migration Store failures stop the run instead of allowing destination side effects without durable progress.

- Choose a minimal TypeScript-friendly test runner if the package does not already have one.

## Out of Scope

Anything outside the in-memory runtime POC is out of scope. That includes external source/destination/store integrations, CLI and serializable specs, durable or parallel execution adapters, stubbing, and npm release work.

## Further Notes

- The first implementation should optimize for clear semantics, strong inference, and testability.

- The main deep modules should be dependency ordering, Run Mode item selection, item processing, and summary aggregation.

- The POC should leave room for future adapters and real plugins, but it only needs the inline completed-summary execution path.
