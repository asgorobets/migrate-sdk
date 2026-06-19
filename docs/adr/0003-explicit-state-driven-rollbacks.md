# Explicit State-Driven Rollbacks

## Status

Superseded in part by
[ADR 0006](./0006-scoped-pipeline-tracking-with-composite-identities.md).

## Context

Rollback remains explicit and state driven. The current runtime invokes a
migration definition's `rollback` process for selected item state, provides a
rollback tracking scope, and deletes item state only after the rollback process
succeeds.

## Decision

Rollback processes receive durable item state and rollback context. They inspect
stored process journal entries or tracking records as needed, call destination
helpers or provider clients directly, and may record rollback diagnostics in the
scoped tracking journal.

## Consequence

Failed rollback attempts preserve the original item state and append rollback
attempt evidence. Successful rollback removes the item state so the source
identity can be processed again by a future run.
