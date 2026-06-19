# Superseded Destination Operation Grouping

## Status

Superseded by [ADR 0006](./0006-scoped-pipeline-tracking-with-composite-identities.md).

## Context

The SDK now treats destination integrations as Effect helper modules that are
called inside `process`. Grouping provider operations is still useful inside a
destination package, but the runtime no longer reads a grouped destination
operation catalog from migration definitions.

## Consequence

Destination packages should expose domain helpers and typed change descriptors.
Runtime tracking comes from scoped process journal entries and optional tracking
records, not a runtime-owned destination operation catalog.
