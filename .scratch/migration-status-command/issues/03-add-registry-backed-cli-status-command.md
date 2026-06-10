# Add Registry-Backed CLI Status Command

Status: ready-for-agent

## Parent

[Migration Status Command](../PRD.md)

## What to build

Add the public integration slice for status by connecting registry-backed selection to the CLI. The registry should expose a status helper that reuses registry selection, required dependency expansion, registry-order output, split-store status reads, and registry notices. The CLI should expose `migrate status` as an Effect CLI command that renders durable-only status by default and source inventory columns when source scanning is requested.

This slice proves the operator workflow end to end: load config, select Migration Definitions, optionally include required dependencies, optionally scan sources, and render concise status output plus actionable warnings.

## Acceptance criteria

- [ ] The registry exposes a status method for CLI and application callers.
- [ ] Registry-backed status accepts selected definition ids.
- [ ] Registry-backed status accepts `--all` equivalent selection.
- [ ] Registry-backed status requires explicit scope and does not silently inspect every definition.
- [ ] Registry-backed status expands required dependencies only when dependency expansion is requested.
- [ ] Registry-backed status rejects missing explicit required dependencies when dependency expansion is not requested.
- [ ] Registry-backed status returns requested definition ids.
- [ ] Registry-backed status returns included definition ids.
- [ ] Registry-backed status returns registry notices.
- [ ] Registry-backed status includes duplicate requested definition notices.
- [ ] Registry-backed status includes optional dependency cycle notices without failing.
- [ ] Registry-backed status preserves registry order rather than execution order.
- [ ] Registry-backed status does not expose execution order.
- [ ] Registry-backed status supports selected definitions with different store layers.
- [ ] Registry-backed status does not require the shared-store execution rule used by run and rollback.
- [ ] Run and rollback shared-store execution rules remain unchanged.
- [ ] Registry-backed durable-only status avoids source and destination plugin initialization.
- [ ] Registry-backed source-scan status delegates source inventory scanning to the standalone status behavior.
- [ ] CLI exposes `migrate status <definition-id...>` for explicit definitions.
- [ ] CLI exposes `migrate status --all` for every registered definition.
- [ ] CLI rejects `migrate status` without definition ids or `--all`.
- [ ] CLI exposes `--with-dependencies` for required dependency expansion.
- [ ] CLI does not silently expand dependencies without `--with-dependencies`.
- [ ] CLI exposes `--scan-source` for source inventory scanning.
- [ ] CLI exposes `--concurrency` for source scan concurrency.
- [ ] CLI rejects `--concurrency` without `--scan-source`.
- [ ] CLI rejects non-positive or non-integer concurrency with a clear known-error message.
- [ ] CLI does not accept `--ids` for status in the first version.
- [ ] CLI durable-only status renders latest run lifecycle and durable item-state counts.
- [ ] CLI durable-only status does not render source inventory columns.
- [ ] CLI source-scan status renders total, unprocessed, invalid, duplicate, and orphaned source columns.
- [ ] CLI status rows are rendered in registry/list order.
- [ ] CLI status warnings render below the table.
- [ ] CLI duplicate Source Identity warnings include actionable suggestions.
- [ ] CLI invalid source item warnings include actionable suggestions.
- [ ] CLI known status errors render concise actionable messages.
- [ ] CLI unknown config/runtime failures preserve stack traces according to existing CLI behavior.
- [ ] CLI status uses Effect CLI primitives rather than manual argv parsing.
- [ ] CLI status rendering is separated enough that tests can assert structured status data independently from human output.
- [ ] Tests cover registry status selection, dependency expansion, notices, order, and split-store status reads.
- [ ] Tests cover CLI exit codes and key output fragments for durable-only status.
- [ ] Tests cover CLI exit codes and key output fragments for source-scan status.
- [ ] Tests cover CLI status warning rendering without brittle full-table snapshots.
- [ ] Documentation remains aligned with the implemented registry API and CLI behavior.

## Blocked by

- [Add Durable-Only Standalone Status](./01-add-durable-only-standalone-status.md)
- [Add Source Inventory Scan Status](./02-add-source-inventory-scan-status.md)
