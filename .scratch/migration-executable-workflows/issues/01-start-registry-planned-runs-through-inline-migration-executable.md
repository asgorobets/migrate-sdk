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

- [ ] A registry can expose an executable run-planning view that returns a
      distinct executable run plan.
- [ ] `MigrationExecutable` exposes `startRun` through an Effect service and a
      static helper.
- [ ] `MigrationExecutable.inline` starts executable run plans through the
      existing inline runtime and returns a completed execution start result.
- [ ] Inline run execution preserves existing migration summary, run state, item
      state, and lock behavior.
- [ ] Ordinary non-executable registry run plans cannot be passed to
      `MigrationExecutable.startRun` at the public type boundary.
- [ ] Dynamic executable-planning failures report missing runtime requirements
      with a `missingRequirements` diagnostic.
- [ ] Public exports and author-facing docs expose the new run start path.

## Blocked by

None - can start immediately.

