# Commercetools Process Destination Capabilities

Status: ready-for-agent

## Problem Statement

The `@migrate-sdk/commercetools` package was merged back onto the current SDK
runtime after the SDK moved from destination command plans to Process Pipelines,
Destination Journals, Destination Change Descriptors, and optional Tracking
Records. The core package now expects migration definitions to run destination
effects inline inside `process`, while the Commercetools package still exposes
and tests the removed destination command model.

That leaves Commercetools migration authors with the right package boundary but
the wrong execution model. Existing Commercetools destination APIs still use
`defineDestinationPlugin`, command groups, `destination`, and `pipeline`, which
no longer exist in the core public runtime path. The package also has adjacent
merge fallout from the source identity contract and migration item state
changes: Commercetools source and migration-store code still references older
source identity, destination identity, and item-state shapes.

The SDK needs the Commercetools integration to become the first real
provider-backed proof of the effectful destination helper model described in
the destination capability design, while keeping the core ownership boundary
clear: migration definitions own orchestration and Tracking Records,
Commercetools owns destination-native helpers and descriptors, and the runtime
owns item execution, scoped tracking, and durable state.

## Solution

Refactor `@migrate-sdk/commercetools` onto the current Process Pipeline model.
The Commercetools destination package will expose Destination Capability
Modules: regular Effect helper values with typed destination helpers, typed
Destination Change Descriptors, destination-local dependency provision, safe
diagnostics, and optional rollback helper utilities.

Commercetools destination helpers will execute SDK operations inline inside
`process`. When a helper completes a destination-side effect, it records a
descriptor-backed Destination Change through the framework-provided `Tracking`
service. If a helper fails before it can prove that a destination effect
completed, it must not record a success change. It may record a generic
Destination Journal Diagnostic with stable, serializable Commercetools context.

The public migration authoring path will move from this shape:

```ts
defineMigration({
  source,
  destination,
  store,
  pipeline: () => destination.commands.products.createDraft(...)
})
```

to this shape:

```ts
const ct = CommercetoolsDestination.make({
  productTypes,
}).provide(commercetoolsSdkLayer)

defineMigration({
  source,
  store,
  tracking: ProductTracking,
  process: Effect.fn("products.process")(function* (source) {
    const product = yield* ct.products.create(draft).pipe(RetryOnNetwork)

    yield* Tracking.setRecord({
      productId: product.id,
      productKey: product.key,
    })
  }),
})
```

The refactor also updates package compatibility with the current core SDK:
Commercetools sources must use schema-backed source identity contracts and
current `SourceItemInput` fields, while the Commercetools migration store must
persist the current `MigrationItemState` shape, including structured source
identity, optional Tracking Records, and Destination Journal evidence.

## User Stories

1. As a Commercetools migration author, I want to call Commercetools destination helpers inside a Process Pipeline, so that destination work uses normal Effect control flow.

2. As a Commercetools migration author, I want to retry one destination helper call inline, so that retry policy is applied only where that operation is safe to retry.

3. As a Commercetools migration author, I want Commercetools helpers to return real SDK resource results, so that process code can stage useful Tracking Records.

4. As a Commercetools migration author, I want successful product helpers to record typed Destination Changes, so that rollback and diagnostics can see what happened.

5. As a Commercetools migration author, I want successful inventory helpers to record typed Destination Changes, so that product and inventory side effects can be tracked separately.

6. As a Commercetools migration author, I want successful customer helpers to record typed Destination Changes, so that customer migrations can be inspected and compensated.

7. As a Commercetools migration author, I want successful business-unit helpers to record typed Destination Changes, so that business-unit state is not collapsed into one destination identity.

8. As a Commercetools migration author, I want successful store and product-selection helpers to record typed Destination Changes, so that catalog assignment workflows are journaled.

9. As a Commercetools migration author, I want one source item to record multiple Commercetools changes, so that composite destination work is represented in journal order.

10. As a Commercetools migration author, I want a Tracking Record to be optional, so that simple progress-only Commercetools migrations do not need extra boilerplate.

11. As a Commercetools migration author, I want record-backed migrations to stage one schema-valid Tracking Record, so that downstream migrations can rely on stable references.

12. As a Commercetools migration author, I want helpers to record safe diagnostics when a request fails, so that failed item state preserves useful provider context.

13. As a Commercetools migration author, I want failed helpers not to record success changes, so that the Destination Journal does not claim a side effect happened when it did not.

14. As a Commercetools migration author, I want product attribute builders to remain available, so that strongly typed product drafts remain ergonomic.

15. As a Commercetools migration author, I want business-unit custom field helpers to remain available, so that typed custom fields can still be authored safely.

16. As a Commercetools migration author, I want destination helpers to be grouped by Commercetools resource area, so that the public API matches Commercetools domain vocabulary.

17. As a Commercetools migration author, I want the Commercetools SDK layer to be provided once to the destination module, so that each helper call does not repeat wiring.

18. As a Commercetools migration author, I want source, destination, and store layers to be independently configurable, so that migrations can read from one project, write to another, and store state in a third.

19. As a Commercetools migration author, I want examples to use `process`, `Tracking.record`, and `Tracking.setRecord`, so that the docs teach the current model.

20. As a Commercetools migration author, I want the product catalog store example to run on the current source identity and tracking model, so that it remains the package's end-to-end proof.

21. As a rollback author, I want Commercetools journal entries to be narrowed with exported descriptors, so that rollback code does not parse raw string kinds.

22. As a rollback author, I want previous failed rollback attempt segments to remain available, so that retry logic can account for earlier compensation attempts.

23. As a rollback author, I want Commercetools helpers to be callable from rollback pipelines too, so that cleanup can use the same SDK service and diagnostics model.

24. As a plugin author, I want Commercetools Destination Change Descriptor ids to be stable public API, so that migrations and rollback code can depend on them.

25. As a plugin author, I want descriptor ids to include a Commercetools module prefix, so that diagnostics and journal inspection can identify the provider without a registry.

26. As a plugin author, I want helper input validation to stay schema-backed, so that malformed drafts and selectors fail before unsafe SDK requests are made.

27. As a plugin author, I want SDK error mapping to be centralized, so that every helper reports Commercetools failures consistently.

28. As a plugin author, I want helper diagnostics to avoid raw provider responses, so that durable item state does not persist unstable or sensitive error objects.

29. As a plugin author, I want package-local `.provide(...)` to erase Commercetools SDK requirements, so that migration definitions do not need a top-level destination provider.

30. As a plugin author, I want process-level and run-level Effect provision to remain possible advanced usage, so that unusual composition is not prevented.

31. As a plugin author, I want process-level and run-level provision kept out of the primary Commercetools API, so that the first implementation stays clear and ergonomic.

32. As a source plugin author, I want Commercetools sources to use current Source Identity contracts, so that state lookup, targeting, and contract drift behave like the core SDK.

33. As a source plugin author, I want Commercetools source `read` and `readByIdentity` to emit current Source Item inputs, so that source results normalize through the core source boundary.

34. As a migration-store author, I want the Commercetools Custom Object store to persist current Migration Item State, so that it can store progress-only, tracked, failed, skipped, and needs-update items.

35. As a migration-store author, I want the store to persist Destination Journal evidence, so that Commercetools-backed state supports failed-item inspection and rollback.

36. As a migration-store author, I want the store to persist optional Tracking Records, so that Commercetools-backed reference lookup works for record-backed definitions.

37. As a migration-store author, I want the store to stop using singular destination identity fields, so that it matches the composite tracking model.

38. As a migration-store author, I want store record schemas to reject malformed tracking and journal data, so that corrupt Custom Objects are not silently accepted.

39. As an SDK maintainer, I want the core `migrate-sdk` package to stay free of Commercetools-specific runtime hooks, so that provider behavior remains plugin-local.

40. As an SDK maintainer, I want no destination registry added for this refactor, so that runtime behavior stays grounded in process effects and tracking contracts.

41. As an SDK maintainer, I want the design's open questions settled in this PRD, so that implementation does not reopen destination registry or provider wiring debates.

42. As an SDK maintainer, I want removed command-plan exports deleted from Commercetools imports and examples, so that the package cannot accidentally revive the legacy runtime model.

43. As an SDK maintainer, I want typecheck failures grouped by source, destination, store, and examples, so that implementation can proceed in reviewable slices.

44. As an SDK maintainer, I want tests to assert durable state and journal behavior, so that the implementation is verified through public behavior rather than private helper internals.

45. As an SDK maintainer, I want fake Commercetools SDK tests to cover request shape and journal effects, so that no live credentials are required for normal validation.

46. As an SDK maintainer, I want live Commercetools examples to remain optional, so that CI and local validation do not depend on external state.

47. As an operator, I want status to remain read-only, so that inspecting Commercetools-backed migration state does not initialize destination helpers or call live destination APIs.

48. As an operator, I want item-level journal inspection to remain outside this PRD, so that the refactor does not widen into CLI inspection work.

## Implementation Decisions

- Keep `@migrate-sdk/commercetools` as a separate workspace package.

- Preserve public subpaths for source, destination, migration-store, and testing.

- Remove usage of the removed destination command model from the Commercetools destination package.

- Do not reintroduce `ConfiguredDestinationPlugin`, `defineDestinationPlugin`, destination command groups, `DestinationCommandPlan`, `destination`, or `pipeline`.

- Model the Commercetools destination as a Destination Capability Module.

- Expose Commercetools destination helpers as normal Effect functions grouped by resource area.

- Resource areas should include products, inventory entries, customers, business units, product selections, and stores.

- Keep pure draft builders, product attribute helpers, custom field helpers, selectors, and update-action builders where they remain useful.

- Separate pure helper modules from effectful SDK operation helpers.

- Effectful helpers return SDK resources or stable resource summaries, not command descriptions.

- Effectful helpers require the Commercetools SDK service and the framework-provided `Tracking` service until their SDK dependency is provided.

- Add or standardize a plugin-local `.provide(layer)` method for Commercetools destination modules.

- The primary documented dependency style is plugin-local provision: construct the destination module, then call `.provide(commercetoolsSdkLayer)`.

- Keep process-local and run-level provision as advanced Effect usage, but do not make them the primary examples in this PRD.

- Do not add a `provide` property to `MigrationDefinition`.

- Do not add a `destination` or `destinations` registry property to `MigrationDefinition`.

- Do not add a destination capability registry in this PRD.

- Treat descriptor ids as enough provider identity for this slice.

- Use stable module-prefixed descriptor ids, such as a Commercetools provider prefix plus resource and outcome.

- Do not add a separate module id field to descriptors unless a later reporting, preflight, or policy feature needs it.

- Export descriptor catalogs from the Commercetools destination module beside the helpers that record those descriptors.

- Define descriptor schemas for each helper outcome that may need rollback, diagnostics, or downstream inspection.

- Descriptor values should carry stable Commercetools resource facts such as id, key when available, version when useful, and selector context when needed.

- Descriptor values should not carry full provider response objects by default.

- A helper records a Destination Change only after the SDK operation has succeeded or after the helper can otherwise prove the destination effect completed.

- A helper that fails before a known destination effect may record a Destination Journal Diagnostic, but not a success change.

- Diagnostic details must be stable JSON objects.

- Diagnostic details may include operation names, resource selectors, Commercetools correlation ids when safely available, and normalized status codes.

- Diagnostic details must not persist raw thrown objects, raw SDK responses, credentials, tokens, request headers, or unstable provider internals.

- Reuse the core `DestinationPluginError` or introduce Commercetools-specific tagged errors only where they add provider-specific clarity.

- Keep SDK request execution behind the Commercetools SDK service.

- Keep SDK service methods dependency-free; dependencies belong in the service layer.

- Update Commercetools source plugins to the current source identity contract model.

- Source plugins must emit `identityKey`, not legacy `identity`, in source item inputs.

- Source plugin identity definitions must include id, schema, and key derivation.

- Source plugins should preserve entity-specific projection options and lookup behavior.

- Update the Commercetools Custom Object migration store to the current core `MigrationStore` contract.

- Store state schemas must use structured source identity snapshots and current item-state variants.

- Store state schemas must persist optional Tracking Records where present.

- Store state schemas must persist Destination Journal process and rollback-attempt segments where present.

- Store state schemas must remove dependence on singular destination identity and destination version fields.

- Existing Custom Object record key strategy may remain, but decoded record metadata must validate against current item-state metadata.

- Existing Custom Object lock, run-state, source-cursor, keyset pagination, and namespace decisions remain unless they conflict with current core contracts.

- Update examples and docs to use Process Pipelines and Tracking Records.

- The product catalog example should become the primary end-to-end proof for source, destination helper, Tracking Record, and Commercetools migration store integration.

- Keep live examples optional and clearly separate from scripted SDK tests.

- Keep CLI item-level journal inspection out of scope.

- Keep provider preflight and destination registry out of scope.

- Keep automatic proof that arbitrary hand-rolled Effect code records all destination changes out of scope.

- Keep package validation focused on `@migrate-sdk/commercetools` and `migrate-sdk`; broader repo checks may still surface unrelated style drift.

## Testing Decisions

- Tests should assert public behavior and durable state, not private helper implementation details.

- Add focused tests for Commercetools destination helper modules using a fake Commercetools SDK service.

- Test that successful helpers execute the expected SDK request and record exactly one descriptor-backed Destination Change.

- Test that repeated helper calls preserve journal order through the core tracking service.

- Test that failed helpers record no success change when the SDK operation fails before completion.

- Test that failed helpers can record safe diagnostics with normalized Commercetools context.

- Test that helper-authored diagnostics do not include raw thrown provider objects.

- Test that plugin-local `.provide(...)` erases the Commercetools SDK requirement from a destination module.

- Test that a provided Commercetools destination module still requires the framework `Tracking` service inside process execution.

- Test that descriptor predicates and decoders can narrow journal entries for rollback code.

- Add integration tests using `defineMigration`, `process`, Commercetools helpers, `Tracking.record`, and `Tracking.setRecord`.

- Add an integration test where one source item creates or updates multiple Commercetools resources and the failed item state preserves ordered journal evidence after a later process failure.

- Add an integration test where a record-backed Commercetools migration persists the staged Tracking Record.

- Add an integration test where a record-backed Commercetools migration fails if no Tracking Record is staged.

- Add an integration test where Commercetools rollback code reads descriptor-backed journal entries and records rollback-attempt evidence on failure.

- Update existing destination example tests away from `DestinationPlugin`, command groups, and `.layer` assertions.

- Update source plugin tests to cover current source identity contracts and current Source Item inputs.

- Update migration-store tests to round-trip current item-state variants, Tracking Records, and Destination Journals through Custom Objects.

- Add malformed persisted-state tests for invalid Tracking Record and journal shapes.

- Keep tests for Custom Object locking, pagination, key generation, and collision validation from the existing migration-store PRD where they still apply.

- Use scripted or fake SDK layers for normal tests.

- Do not require live Commercetools credentials for normal `check-types` or `test` validation.

- Expected validation for the completed refactor is `pnpm --filter migrate-sdk check-types`, `pnpm --filter @migrate-sdk/commercetools check-types`, and focused Commercetools tests.

## Out of Scope

- Adding a destination capability registry.

- Adding runtime preflight against live Commercetools projects.

- Adding CLI item-level journal inspection.

- Adding automatic detection that hand-written raw Commercetools SDK Effects recorded all destination changes.

- Migrating old persisted Custom Object state from the removed destination identity model.

- Maintaining backward-compatible support for Commercetools destination command plans.

- Supporting `destination` or `pipeline` in new Commercetools examples.

- Implementing full rollback helpers for every Commercetools resource area before the destination helper model is proven.

- Reworking Commercetools source query semantics beyond what is needed for current source identity contracts.

- Reworking Custom Object storage topology beyond what is needed for current core state schemas.

- Publishing the package externally.

## Further Notes

- This PRD intentionally settles the destination capability design gaps for the
  Commercetools refactor: no destination registry, no migration-definition
  `provide`, plugin-local `.provide(...)` as the primary dependency style, and
  stable module-prefixed descriptor ids instead of a separate module id field.

- The current `@migrate-sdk/commercetools` typecheck failure is useful triage
  evidence. The failures group into removed destination command APIs, examples
  still using `destination` and `pipeline`, source identity contract drift, and
  Custom Object migration-store state drift.

- The strongest deep modules for implementation are the Commercetools SDK
  service, destination descriptor catalogs, resource-specific destination
  helpers, SDK error and diagnostic normalization, source identity adapters, and
  Custom Object state record schemas.

- The first implementation slice should be a tracer bullet rather than a full
  provider sweep: one resource area, one helper, one descriptor, one process
  integration test, and one example updated to `process` and Tracking Records.
