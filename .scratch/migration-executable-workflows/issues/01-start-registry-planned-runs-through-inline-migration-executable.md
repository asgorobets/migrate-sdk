# Start Registry-Planned Runs Through Inline MigrationExecutable

Status: ready-for-agent

## Parent

[Migration Executable Workflows PRD](../PRD.md)

## What to build

Add the first executable run path: a registry-backed executable run plan can be
started through `MigrationExecutable`, and the inline executable returns the
same completed migration run behavior SDK users already get from direct run
calls.

This slice should prove that the public execution start API is registry-first,
service-backed, and layer-swappable without introducing a durable provider yet.

## Acceptance criteria

- [x] A registry can expose an executable run-planning view that returns a
      distinct executable run plan.
- [x] `MigrationExecutable` exposes `startRun` through an Effect service and a
      static helper.
- [x] `MigrationExecutable.inline` starts executable run plans through the
      existing inline runtime and returns a completed execution start result.
- [x] Inline run execution preserves existing migration summary, run state, item
      state, and lock behavior.
- [x] Ordinary non-executable registry run plans cannot be passed to
      `MigrationExecutable.startRun` at the public type boundary.
- [x] Dynamic executable-planning failures report missing runtime requirements
      with a `missingRequirements` diagnostic.
- [x] Public exports and author-facing docs expose the new run start path.

## Blocked by

None - can start immediately.
