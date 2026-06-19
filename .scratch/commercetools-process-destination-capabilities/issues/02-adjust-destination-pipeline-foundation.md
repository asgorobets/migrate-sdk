# Adjust Destination Pipeline Foundation

Status: done

Type: AFK

## Parent

[Commercetools Process Destination Capabilities](../PRD.md)

## User stories covered

1, 2, 3, 4, 10, 11, 12, 13, 16, 17, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 39, 40, 41, 43, 44, 45

## What to build

Add the destination-side foundation needed for Commercetools helpers to run as
normal Effect values inside `process`, without porting the full helper surface
yet. This is the destination tracer bullet that proves the current destination
capability model against one minimal Commercetools operation and fake SDK
service.

The slice should establish the Commercetools Destination Capability Module
shape, descriptor catalog conventions, plugin-local `.provide(layer)` behavior,
safe diagnostic normalization, and `Tracking.recordChange` integration. The
primary public path must remain plugin-local provision: construct the
Commercetools destination module, provide the Commercetools SDK layer to that
module, then call the provided helpers from `process`.

This slice must not reintroduce destination registries, `MigrationDefinition`
destination properties, `MigrationDefinition.provide`, command groups, command
plans, `destination`, or `pipeline`.

## Acceptance criteria

- [x] A minimal Commercetools destination module exposes at least one effectful helper callable from `process`.
- [x] The destination module supports plugin-local `.provide(commercetoolsSdkLayer)` and erases the SDK requirement from the provided module.
- [x] Provided Commercetools helpers still require the framework `Tracking` service during process execution.
- [x] Descriptor ids use stable Commercetools-prefixed public ids.
- [x] The descriptor catalog is exported beside the helper that records it.
- [x] Successful helper execution records exactly one descriptor-backed Destination Change after the fake SDK operation succeeds.
- [x] Failed helper execution records no success change when the fake SDK operation fails before completion.
- [x] Failed helper execution can record a safe Destination Journal Diagnostic with normalized Commercetools context.
- [x] Diagnostics do not persist raw thrown objects, raw SDK responses, credentials, tokens, request headers, or unstable provider internals.
- [x] Repeated helper calls preserve journal order through the core Tracking service.
- [x] Descriptor predicates or decoders can narrow journal entries for rollback code.
- [x] A focused process integration test runs `defineMigration`, `process`, the Commercetools helper, `Tracking.record`, and `Tracking.setRecord`.
- [x] A failure-path process test proves ordered journal evidence survives when a later process step fails.
- [x] No Commercetools-specific runtime hook is added to the core `migrate-sdk` package.
- [x] No destination registry or `MigrationDefinition.provide` API is added.
- [x] `pnpm --filter migrate-sdk check-types` passes.
- [x] `pnpm --filter @migrate-sdk/commercetools check-types` no longer fails for the destination foundation added in this slice.

## Blocked by

- .scratch/commercetools-process-destination-capabilities/issues/01-align-source-and-store-with-current-runtime-contracts.md

## Comments

- Implemented the tracer-bullet destination capability module with `CommercetoolsDestination.make().provide(sdkLayer).productSelections.create(...)`, descriptor-backed `Tracking.recordChange`, and safe diagnostic logging.
- Added focused TDD coverage in `packages/commercetools/src/destination/capabilities.test.ts` for process integration, plugin-local SDK provisioning, Tracking-only provided helper requirements, success journaling, failure diagnostics, descriptor decoding, and ordered repeated changes when a later process step fails.
- `pnpm --filter migrate-sdk check-types`, the focused Commercetools destination test, touched-file Ultracite, and `git diff --check` pass. `pnpm --filter @migrate-sdk/commercetools check-types` still fails on legacy destination command APIs and examples scheduled for follow-up issue 3, but the reported failures no longer include the new destination capability foundation files.
