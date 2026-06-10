# Add Registry-Backed CLI Status Command

Status: done

## Parent

[Migration Status Command](../PRD.md)

## What to build

Add the public integration slice for status by connecting registry-backed selection to the CLI. The registry should expose a status helper that reuses registry selection, required dependency expansion, registry-order output, split-store status reads, and registry notices. The CLI should expose `migrate status` as an Effect CLI command that renders durable-only status by default and source inventory columns when source scanning is requested.

This slice proves the operator workflow end to end: load config, select Migration Definitions, optionally include required dependencies, optionally scan sources, and render concise status output plus actionable warnings.

## Acceptance criteria

- [x] The registry exposes a status method for CLI and application callers.
- [x] Registry-backed status accepts selected definition ids.
- [x] Registry-backed status accepts `--all` equivalent selection.
- [x] Registry-backed status requires explicit scope and does not silently inspect every definition.
- [x] Registry-backed status expands required dependencies only when dependency expansion is requested.
- [x] Registry-backed status rejects missing explicit required dependencies when dependency expansion is not requested.
- [x] Registry-backed status returns requested definition ids.
- [x] Registry-backed status returns included definition ids.
- [x] Registry-backed status returns registry notices.
- [x] Registry-backed status includes duplicate requested definition notices.
- [x] Registry-backed status includes optional dependency cycle notices without failing.
- [x] Registry-backed status preserves registry order rather than execution order.
- [x] Registry-backed status does not expose execution order.
- [x] Registry-backed status supports selected definitions with different store layers.
- [x] Registry-backed status does not require the shared-store execution rule used by run and rollback.
- [x] Run and rollback shared-store execution rules remain unchanged.
- [x] Registry-backed durable-only status avoids source and destination plugin initialization.
- [x] Registry-backed source-scan status delegates source inventory scanning to the standalone status behavior.
- [x] CLI exposes `migrate status <definition-id...>` for explicit definitions.
- [x] CLI exposes `migrate status --all` for every registered definition.
- [x] CLI rejects `migrate status` without definition ids or `--all`.
- [x] CLI exposes `--with-dependencies` for required dependency expansion.
- [x] CLI does not silently expand dependencies without `--with-dependencies`.
- [x] CLI exposes `--scan-source` for source inventory scanning.
- [x] CLI exposes `--concurrency` for source scan concurrency.
- [x] CLI rejects `--concurrency` without `--scan-source`.
- [x] CLI rejects non-positive or non-integer concurrency with a clear known-error message.
- [x] CLI does not accept `--ids` for status in the first version.
- [x] CLI durable-only status renders latest run lifecycle and durable item-state counts.
- [x] CLI durable-only status does not render source inventory columns.
- [x] CLI source-scan status renders total, unprocessed, invalid, duplicate, and orphaned source columns.
- [x] CLI status rows are rendered in registry/list order.
- [x] CLI status warnings render below status rows.
- [x] CLI duplicate Source Identity warnings include actionable suggestions.
- [x] CLI invalid source item warnings include actionable suggestions.
- [x] CLI known status errors render concise actionable messages.
- [x] CLI unknown config/runtime failures preserve stack traces according to existing CLI behavior.
- [x] CLI status uses Effect CLI primitives rather than manual argv parsing.
- [x] CLI status rendering is separated enough that tests can assert structured status data independently from human output.
- [x] Tests cover registry status selection, dependency expansion, notices, order, and split-store status reads.
- [x] Tests cover CLI exit codes and key output fragments for durable-only status.
- [x] Tests cover CLI exit codes and key output fragments for source-scan status.
- [x] Tests cover CLI status warning rendering without brittle full-table snapshots.
- [x] Documentation remains aligned with the implemented registry API and CLI behavior.

## Blocked by

- [Add Durable-Only Standalone Status](./01-add-durable-only-standalone-status.md)
- [Add Source Inventory Scan Status](./02-add-source-inventory-scan-status.md)
