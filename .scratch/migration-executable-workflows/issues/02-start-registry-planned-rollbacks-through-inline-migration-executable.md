# Start Registry-Planned Rollbacks Through Inline MigrationExecutable

Status: ready-for-agent

## Parent

[Migration Executable Workflows PRD](../PRD.md)

## What to build

Extend the executable service boundary to rollback execution. A registry-backed
executable rollback plan can be started through `MigrationExecutable`, and the
inline executable returns the current completed rollback summary behavior.

This slice should also keep function-style run and rollback entrypoints on the
inline compatibility path so existing SDK users do not need to adopt
`MigrationExecutable` immediately.

## Acceptance criteria

- [x] A registry can expose an executable rollback-planning view that returns a
      distinct executable rollback plan.
- [x] `MigrationExecutable` exposes `startRollback` through the service and
      static helper.
- [x] `MigrationExecutable.inline` starts executable rollback plans through the
      existing inline runtime and returns a completed execution start result.
- [x] Inline rollback execution preserves existing rollback summary, preflight,
      run state, item state, and lock behavior.
- [x] Ordinary non-executable registry rollback plans cannot be passed to
      `MigrationExecutable.startRollback` at the public type boundary.
- [x] Existing function-style run and rollback entrypoints continue to return
      completed summaries on the inline path.
- [x] Public exports and author-facing docs expose the rollback start path.

## Blocked by

- [01 - Start Registry-Planned Runs Through Inline MigrationExecutable](01-start-registry-planned-runs-through-inline-migration-executable.md)
