# Static Migration Definition Registry

The first registry for executable migrations will be a static **Migration Definition Registry**, not a global mutable plugin-discovery container. It catalogs executable **Migration Definitions** for SDK and CLI hosts, while the existing **Plugin Registry** term remains reserved for future compilation of serializable **Migration Specs** into executable definitions.

## Status

Accepted

## Considered Options

- Use a static immutable catalog of executable migration definitions.
- Use an ambient global registry that modules or plugins mutate during import.
- Make registry-backed execution silently expand dependency scope.
- Require CLI users to select dependencies explicitly unless they opt into expansion.
- Make the registry the only execution path and remove raw definition requests.
- Keep raw `runMigrations` and `rollbackMigrations` requests as lower-level SDK primitives.
- Model migration definition dependencies as required and optional ordering edges.

## External Reference

The required/optional dependency split is lightly inspired by Drupal Migrate's
dependency categories. This ADR treats that as inspiration only; the public
glossary and API design keep the SDK's own terminology.

## Decision

`MigrationDefinitionRegistry` is the canonical public term for the executable-definition catalog. A registry is static from the runner's point of view, even when its definitions were produced earlier by a validated runtime, low-code, storage-backed, or plugin/spec workflow.

Registry construction is lazy and synchronous. It may perform pure catalog validation, including duplicate definition ids, missing required dependency definitions in the full registry graph, and required dependency cycles. Hard catalog validation failures are collected and thrown synchronously as one schema-backed construction error, while lookup and planning failures remain typed Effect errors. CLI config loading catches construction errors thrown during module evaluation and renders all registry issues. Optional dependencies are ordering preferences when the referenced definition participates in the selected run; they do not make a registry invalid when the referenced definition is omitted, optional dependency cycles do not fail construction or planning, and they do not model lookup or stub relationships. Missing optional dependency ids are retained for inspection commands. When optional edges cycle, planning preserves deterministic registry order for the affected definitions and returns a structured notice. The registry must not acquire locks, read migration stores, initialize source or destination systems, inspect rollbackable item state, or otherwise perform runtime preflight during construction.

Registry-backed SDK and CLI operations require explicit selection. Running or rolling back every registered definition uses an explicit all selection rather than omitting definition ids. CLI commands must not silently expand required dependency scope; callers include required definitions explicitly or pass `--with-dependencies`. `--with-dependencies` expands only required dependencies; optional dependencies affect ordering only when already included by explicit selection or by all-registry execution.

The registry exposes catalog lookup, CLI-oriented listing, command-specific planning, and thin run/rollback helpers. Planning methods return structured plans and typed planning errors so CLI renderers can explain dependency policy failures without embedding CLI copy in the SDK. The CLI exposes planning through `run --plan` and `rollback --plan`, not through separate top-level plan or validation commands. `--plan` uses the same planning path as execution and only skips runtime execution after a valid plan is produced.

Raw `runMigrations` and `rollbackMigrations` requests remain public lower-level SDK primitives. They keep request-scoped validation because callers can still bypass the registry by supplying definitions directly.

## Consequences

- CLI behavior stays deterministic because command scope comes from one explicit registry value instead of import-time global mutation.
- Future discovery or low-code flows can still compile and validate definitions before initializing a static registry.
- Duplicate ids, missing required dependency edges, and required dependency cycles are rejected at the registry boundary for registry-backed calls.
- Optional dependency cycles and Migration Reference Lookup relationships do not invalidate a registry because they do not promise strict execution ordering.
- CLI renderers can warn about unresolved optional dependencies and ignored optional dependency cycles without failing the command.
- CLI `--plan` prints selection and ordering only; durable state inspection belongs to future status commands.
- Existing raw SDK calls continue to defend their own request boundary and can keep their current dependency expansion semantics until public ergonomics are revisited.
- Rollback CLI commands can make destructive scope visible by default and use `--with-dependencies` as an explicit operator choice.
