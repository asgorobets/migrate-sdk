# Add CLI Run and Rollback Execution

Status: ready-for-agent

## Parent

[Migration Definition Registry and CLI](../PRD.md)

## What to build

Add actual CLI execution for `migrate run` and `migrate rollback` using the same registry-backed command parsing and planning behavior as plan mode. Successful commands should delegate to the existing migration and rollback runtimes through registry helpers, while invalid selections should fail before runtime execution.

This slice should turn the CLI from an inspection/planning tool into an operator command surface for executing selected migration definitions and rollback definitions.

## Acceptance criteria

- [ ] `migrate run <definition>` executes the selected migration definition through the registry-backed run helper.
- [ ] `migrate run <definition...>` executes selected migration definitions in normalized dependency order.
- [ ] `migrate run --all` executes all registered migration definitions in normalized dependency order.
- [ ] `migrate rollback <definition>` executes rollback for the selected migration definition through the registry-backed rollback helper.
- [ ] `migrate rollback <definition...>` executes selected rollback definitions in normalized reverse dependency order.
- [ ] `migrate rollback --all` executes all registered rollback definitions in normalized reverse dependency order.
- [ ] Execution commands require explicit scope through `--all` or definition ids.
- [ ] Execution commands reject invalid selection before runtime execution.
- [ ] Execution commands share parsing, required dependency policy, run-mode flags, `--ids` behavior, and planning errors with plan mode.
- [ ] `--with-dependencies` expands required dependencies before execution.
- [ ] `--with-dependencies` does not expand optional dependencies before execution.
- [ ] `migrate run <definition> --failed` executes failed mode.
- [ ] `migrate run <definition> --skipped` executes skipped mode.
- [ ] `migrate run <definition> --ids <id>` executes item mode.
- [ ] `migrate rollback <definition> --ids <id[,id...]>` executes targeted rollback.
- [ ] Duplicate requested definitions do not execute more than once.
- [ ] Duplicate parsed source identities do not target the same source identity more than once.
- [ ] Runtime summaries are rendered with concise command output.
- [ ] Runtime failures are rendered through existing structured errors where possible.
- [ ] Execution tests verify delegation to existing runtime operations rather than re-testing runtime internals.
- [ ] Execution tests verify that invalid selection does not acquire locks, create run state, or execute runtime work.

## Blocked by

- [Add CLI Run and Rollback Plan Mode](./05-add-cli-run-and-rollback-plan-mode.md)
