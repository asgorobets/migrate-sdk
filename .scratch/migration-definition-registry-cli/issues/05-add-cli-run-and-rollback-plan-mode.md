# Add CLI Run and Rollback Plan Mode

Status: ready-for-agent

## Parent

[Migration Definition Registry and CLI](../PRD.md)

## What to build

Add command parsing and human rendering for `migrate run --plan` and `migrate rollback --plan`. Planning mode should use registry planning exactly as execution will, render compact human-readable plans, and exit before any runtime execution or store/plugin work.

This slice should include CLI parsing for explicit scope, run-mode flags, required dependency expansion, source identity shorthand, and planning error suggestions.

## Acceptance criteria

- [x] `migrate run <definition> --plan` renders a run plan.
- [x] `migrate run <definition...> --plan` renders requested definitions in requested order and normalized execution order separately.
- [x] `migrate run --all --plan` renders `Requested: all` and expands included definitions separately.
- [x] `migrate rollback <definition> --plan` renders a rollback plan.
- [x] `migrate rollback <definition...> --plan` renders requested definitions in requested order and normalized execution order separately.
- [x] `migrate rollback --all --plan` renders `Requested: all` and expands included definitions separately.
- [x] `--plan` uses the same planning path as execution and fails with the same planning errors for invalid selection.
- [x] `--plan` exits before runtime execution.
- [x] `--plan` does not acquire locks, read stores, initialize source or destination systems, scan source items, inspect rollbackable state, or calculate counts.
- [x] Human plan output shows requested definitions, target ids when present, included definitions, execution order, and notices.
- [x] Duplicate requested definition ids render notices.
- [x] Optional dependency cycle notices render when present.
- [x] Missing explicit required dependency errors render safe fixed-command suggestions.
- [x] Rollback missing required dependency suggestions list the `--with-dependencies` command first.
- [x] Running `migrate run --plan` without `--all` or definition ids is invalid.
- [x] Running `migrate rollback --plan` without `--all` or definition ids is invalid.
- [x] `--with-dependencies` is supported and has no short alias.
- [x] `--with-dependencies` expands required dependencies only.
- [x] The CLI exposes no generic `--mode` flag.
- [x] `--failed` maps to failed run mode.
- [x] `--skipped` maps to skipped run mode.
- [x] `--ids` on run maps to item mode.
- [x] `--ids` is the only source identity shorthand in the first slice.
- [x] `--ids` parses comma-separated values, rejects empty segments, percent-decodes values, and fails on invalid percent encoding before planning.
- [x] Source identities containing commas can be represented by encoding the comma.
- [x] Duplicate parsed `--ids` values are deduplicated and rendered as notices.
- [x] Forward run item mode accepts exactly one unique parsed source identity and exactly one explicit definition id.
- [x] Forward run item mode rejects all-registry selection, multiple explicit definitions, required dependency expansion, failed mode, and skipped mode.
- [x] Rollback targeting accepts one or more unique parsed source identities for exactly one explicit definition id.
- [x] Rollback targeting rejects required dependency expansion until cross-definition source identity mapping is designed.
- [x] The first slice does not expose `--json` or another machine-readable plan output flag.
- [x] CLI tests assert exit codes, key text, parsing behavior, and that plan mode does not execute.

## Blocked by

- [Add Registry Run and Rollback Planning](./02-add-registry-run-and-rollback-planning.md)
- [Add CLI Config Discovery and List Command](./03-add-cli-config-discovery-and-list-command.md)
