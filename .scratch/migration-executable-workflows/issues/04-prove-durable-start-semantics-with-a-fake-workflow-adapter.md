# Prove Durable Start Semantics With A Fake Workflow Adapter

Status: ready-for-agent

## Parent

[Migration Executable Workflows PRD](../PRD.md)

## What to build

Add a fake durable executable adapter that proves the start contract without
depending on Workflow SDK, Effect workflow, Vercel, or a production durable
backend. The fake provider should accept envelopes, return started execution
results, and exercise migration run state and provider-handle behavior.

This slice is the durable tracer bullet for the core SDK API.

## Acceptance criteria

- [ ] A fake durable `MigrationExecutable` layer can start executable run plans
      and return a started execution start result.
- [ ] A fake durable `MigrationExecutable` layer can start executable rollback
      plans and return a started execution start result.
- [ ] Durable starts allocate a migration run id and create queued migration run
      state before provider acceptance.
- [ ] Provider start rejection marks the migration run state as `start-failed`
      and fails the start call.
- [ ] Provider execution identity is attached before `started` is returned.
- [ ] Attach failure fails the start call and includes the provider execution
      identity in the error.
- [ ] Started results expose the migration run id separately from the provider
      execution handle.
- [ ] The provider-owned workflow execution owns selected migration definition
      locks for the duration of execution.
- [ ] Overlapping selected definition sets are rejected while locks are held.
- [ ] Tests cover the fake durable path without relying on provider-specific
      Workflow SDK or Effect workflow packages.

## Blocked by

- [03 - Add Migration Execution Envelope And Registry Catalog](03-add-migration-execution-envelope-and-registry-catalog.md)

