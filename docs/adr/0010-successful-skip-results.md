# Intentional skips are successful pipeline results

## Status

Accepted. Revises the Skip Item error-channel decision in ADR-0001.

## Decision

Process Pipelines and deferred Process Batch item settlements return
`ProcessResult` through Effect's success channel: `void` means processing
completed, and `SkipItem` is `{ kind: "skipped", reason: string }`.
`skipItem(reason)` constructs that value. Actual failures remain in the error
channel. The runner persists skipped state and its reason without requiring a
tracking record, preserving any destination journal already recorded.

The runner decodes callback and settlement results with Effect Schema before
saving them. Completion must be exactly `undefined`; a skip must include a string
reason. Malformed values fail processing. Reference stub results use the same
decoder. Typed discriminant checks happen after this validation.

Returning a skip explicitly exits the current pipeline. A nested helper must
have its returned skip checked and propagated by its caller. This replaces the
automatic unwinding provided by yielding the old typed error. Returning a skip
does not undo destination work that has already happened.

Each batch item may return a skip from its settlement. The outer batch callback
must still return exactly one settlement per item. An outer callback failure is
a failure for its items, even if its error value resembles a skip.

A reference stub may return a skip, but the requested reference was not created.
The runner therefore records a reference-lookup failure, preserving the existing
semantics and journal evidence.

## Consequences

Normal skips produce successful spans with any Effect tracer. The settlement
span carries the outcome and skip reason. Exporters do not inspect causes or
rewrite span statuses.

This is a breaking authoring change: replace `return yield* skipItem(reason)`
with `return skipItem(reason)` and `Effect.fail(skipItem(reason))` with
`Effect.succeed(skipItem(reason))`. `SkipItem` is now a schema and value type,
not a yieldable error class. Use `skipItem` instead of `new SkipItem`.
