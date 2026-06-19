# Port Destination Helpers Examples And Docs

Status: done

Type: AFK

## Parent

[Commercetools Process Destination Capabilities](../PRD.md)

## User stories covered

1, 2, 3, 4, 5, 6, 7, 8, 9, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48

## What to build

Port the remaining Commercetools destination helper surface onto the
destination capability model established by the tracer bullet, then update
examples and docs to teach only the current Process Pipeline and Tracking
model.

This slice should tackle all real Commercetools destination helper groups
together so the package has one coherent public API: products, inventory
entries, customers, business units and custom fields, stores, product
selections, and store/product-selection assignment workflows. Keep pure draft
builders, attribute helpers, custom field helpers, selectors, and update-action
builders where they remain useful, but effectful SDK helpers must return SDK
resources or stable resource summaries instead of command descriptions.

The product catalog store example should become the package's end-to-end proof
for Commercetools source, destination helper, Tracking Record, Destination
Journal, and Custom Object Migration Store integration. Live Commercetools
examples should remain optional and separate from scripted or fake SDK tests.

## Acceptance criteria

- [x] Product helpers run inside `process`, call the SDK service, return resource results or stable summaries, and record descriptor-backed changes.
- [x] Inventory helpers run inside `process`, call the SDK service, return resource results or stable summaries, and record descriptor-backed changes.
- [x] Customer helpers run inside `process`, call the SDK service, return resource results or stable summaries, and record descriptor-backed changes.
- [x] Business-unit and custom-field helpers run inside `process`, call the SDK service, return resource results or stable summaries, and record descriptor-backed changes.
- [x] Store helpers run inside `process`, call the SDK service, return resource results or stable summaries, and record descriptor-backed changes.
- [x] Product-selection and store/product-selection assignment helpers run inside `process`, call the SDK service, return resource results or stable summaries, and record descriptor-backed changes.
- [x] Helper descriptors carry stable Commercetools resource facts such as id, key when available, version when useful, and selector context when needed.
- [x] Helper descriptors do not carry full provider response objects by default.
- [x] Helper input validation remains schema-backed where malformed drafts or selectors would make unsafe SDK requests.
- [x] SDK error mapping and diagnostic normalization are shared across helper groups.
- [x] Tests cover request shape and journal effects for each helper group using fake or scripted SDK layers.
- [x] At least one test proves one source item can record multiple ordered Commercetools changes.
- [x] At least one rollback-oriented test reads descriptor-narrowed journal entries and records rollback-attempt evidence on failure.
- [x] The product catalog store example uses `defineMigration`, `process`, Commercetools helpers, `Tracking.record`, `Tracking.setRecord`, and the Commercetools Custom Object Migration Store.
- [x] Examples no longer use `DestinationPlugin`, destination command groups, `.layer` assertions, `destination`, or `pipeline`.
- [x] Public docs show plugin-local `.provide(...)` as the primary Commercetools dependency style.
- [x] Public docs mention process-local and run-level provision only as advanced Effect usage where useful.
- [x] Public docs explain descriptor ids, safe diagnostics, Tracking Records, Destination Journal behavior, and optional live examples.
- [x] Removed command-plan exports and imports are deleted from the Commercetools package.
- [x] Status and inspection paths remain read-only and do not initialize destination helpers or call live destination APIs.
- [x] No CLI item-level journal inspection, provider preflight, destination registry, or live credential requirement is added.
- [x] `pnpm --filter @migrate-sdk/commercetools check-types` passes.
- [x] Focused Commercetools tests pass without live credentials.

## Blocked by

- .scratch/commercetools-process-destination-capabilities/issues/02-adjust-destination-pipeline-foundation.md

## Comments
