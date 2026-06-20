# Add Migration Execution Envelope And Registry Catalog

Status: ready-for-agent

## Parent

[Migration Executable Workflows PRD](../PRD.md)

## What to build

Add the adapter-neutral durable payload and registry lookup service. Executable
plans remain in-process objects, while durable adapters derive a serializable
`Migration Execution Envelope` that can be re-planned inside a workflow
execution context.

This slice should make envelope execution possible without adding a real
workflow provider.

## Acceptance criteria

- [ ] A migration execution envelope can be derived from executable run and
      rollback plans.
- [ ] The envelope includes the migration run id, registry id, kind, definition
      ids, request, and diagnostic planned order.
- [ ] The envelope does not serialize migration definitions, layers, effects, or
      executable plan objects.
- [ ] `MigrationDefinitionRegistryCatalog` resolves registries by registry id.
- [ ] The catalog rejects duplicate registry ids when its layer is constructed.
- [ ] Missing registry lookup fails through a typed Effect error.
- [ ] Envelope execution re-plans from the resolved executable registry before
      running.
- [ ] Envelope execution uses the envelope migration run id and does not call
      the public `MigrationExecutable.startRun` or `startRollback` again.
- [ ] Planned order differences are diagnostic metadata only and do not fail
      code-defined envelope execution by default.

## Blocked by

- [01 - Start Registry-Planned Runs Through Inline MigrationExecutable](01-start-registry-planned-runs-through-inline-migration-executable.md)
- [02 - Start Registry-Planned Rollbacks Through Inline MigrationExecutable](02-start-registry-planned-rollbacks-through-inline-migration-executable.md)

