# Add CLI Run and Rollback Execution

Status: ready-for-agent

## Parent

[Migration Definition Registry and CLI](../PRD.md)

## What to build

Add actual CLI execution for `migrate run` and `migrate rollback` using the same registry-backed command parsing and planning behavior as plan mode. Successful commands should delegate to the existing migration and rollback runtimes through registry helpers, while invalid selections should fail before runtime execution.

This slice should turn the CLI from an inspection/planning tool into an operator command surface for executing selected migration definitions and rollback definitions.

## Acceptance criteria

- [x] `migrate run <definition>` executes the selected migration definition through the registry-backed run helper.
- [x] `migrate run <definition...>` executes selected migration definitions in normalized dependency order.
- [x] `migrate run --all` executes all registered migration definitions in normalized dependency order.
- [x] `migrate rollback <definition>` executes rollback for the selected migration definition through the registry-backed rollback helper.
- [x] `migrate rollback <definition...>` executes selected rollback definitions in normalized reverse dependency order.
- [x] `migrate rollback --all` executes all registered rollback definitions in normalized reverse dependency order.
- [x] Execution commands require explicit scope through `--all` or definition ids.
- [x] Execution commands reject invalid selection before runtime execution.
- [x] Execution commands share parsing, required dependency policy, run-mode flags, `--ids` behavior, and planning errors with plan mode.
- [x] `--with-dependencies` expands required dependencies before execution.
- [x] `--with-dependencies` does not expand optional dependencies before execution.
- [x] `migrate run <definition> --failed` executes failed mode.
- [x] `migrate run <definition> --skipped` executes skipped mode.
- [x] `migrate run <definition> --ids <id>` executes item mode.
- [x] `migrate rollback <definition> --ids <id[,id...]>` executes targeted rollback.
- [x] Duplicate requested definitions do not execute more than once.
- [x] Duplicate parsed source identities do not target the same source identity more than once.
- [x] Runtime summaries are rendered with concise command output.
- [x] Runtime failures are rendered through existing structured errors where possible.
- [x] Execution tests verify delegation to existing runtime operations rather than re-testing runtime internals.
- [x] Execution tests verify that invalid selection does not acquire locks, create run state, or execute runtime work.

## Blocked by

- [Add CLI Run and Rollback Plan Mode](./05-add-cli-run-and-rollback-plan-mode.md)
