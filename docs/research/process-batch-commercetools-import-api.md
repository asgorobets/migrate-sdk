# Research behind `processBatch`: commercetools Import API

Date: 2026-09-01

Status: implemented on 2026-09-01. This document preserves the research that
led to the decision; it is not current API documentation. See
[ADR 0009](../adr/0009-process-batch-pipelines-with-per-item-settlements.md)
for the framework decision and
[`packages/commercetools/docs/import-api.md`](../../packages/commercetools/docs/import-api.md)
for the supported API and examples. Code descriptions and line references
below describe the repository before implementation.

## Question

Could the commercetools Import API prove that a migration can use bulk
destination work without losing per-item tracking, retries, rollback, and
cursor safety?

## Executive conclusion

Yes. The Import API gave us a concrete version of the problem:

> Several products may share one Import Request, but each source product still
> needs its own durable migration outcome.

One resource-specific Import Request accepts up to 20 resources, creates one ImportOperation per resource, and exposes state and errors on each operation. A request can therefore contain independently successful and unsuccessful resources; Migrate SDK must not collapse that request to one all-or-nothing item outcome. The provider also has a `partiallyImported` state for partial effects *within one resource*, which is a second reason to preserve item-level failure and journaling rather than treating provider acceptance as success. [Import Requests](https://docs.commercetools.com/api/import-export/import-requests), [Import Operations](https://docs.commercetools.com/api/import-export/import-operation)

The Import API does **not** prove exactly-once execution. It is asynchronous and eventually consistent, uses key-based upserts for most resource types, does not document a request idempotency key, and explicitly warns against concurrent duplicate requests because processing order is not guaranteed and concurrency conflicts can result. A workflow retry after provider acceptance but before item-state/cursor persistence can therefore resubmit the same keys. Stable keys make many replays recoverable, but they do not make concurrent duplicate submissions safe. [Import API overview](https://docs.commercetools.com/api/import-export/overview), [Import API best practices](https://docs.commercetools.com/api/import-export/best-practices)

At the time of this research, the adapter had no first-party Import API client
or import destination surface. It depended on `@commercetools/platform-sdk`,
bound its service to that SDK's `ApiRoot`, and exposed synchronous create/update
helpers. Its generic `execute` function could run a separately configured
request, but that was an escape hatch rather than a supported import
capability. `packages/commercetools/package.json:87-90`;
`packages/commercetools/src/sdk.ts:1-26,45-77`;
`packages/commercetools/docs/destination.md:3-8,30-44`

The smallest credible first-party slice is:

1. a separate `CommercetoolsImportSdk` service/layer backed by `@commercetools/importapi-sdk`;
2. explicit container setup separate from per-window execution;
3. one resource-specific `submitAndAwait` helper, starting with Product or Product Draft imports;
4. a returned, exact per-resource outcome table keyed by the submitted resource key; and
5. a `commercetools.product.imported` journal descriptor that records the container key, operation ID, resource key, and resulting resource version without pretending the upsert was definitely a create or an update.

This should be implemented only after the core `processBatch` contract can validate exact item settlement coverage. The adapter should demonstrate the core primitive, not invent a separate batching abstraction that bypasses it.

## Repository capability at the time of research

### Package and SDK boundary

- `@migrate-sdk/commercetools` exports its existing root, destination, migration-store, source, and testing entry points. There is no import-specific entry point. `packages/commercetools/package.json:23-56`
- Its production dependencies are `@commercetools/platform-sdk` and `@commercetools/sdk-client-v2`; `@commercetools/importapi-sdk` is absent. `packages/commercetools/package.json:87-90`
- `CommercetoolsSdkLayerOptions.apiRoot` is the Platform SDK `ApiRoot`, and `CommercetoolsProject` is derived from `ApiRoot["withProjectKey"]`. The service's bound `project` and `request` methods can therefore build only Platform SDK project requests. `packages/commercetools/src/sdk.ts:1-26,51-77`
- `CommercetoolsSdk.execute` was intentionally structural: it accepted any object whose `execute()` returned a body. A consumer that separately installed and configured the Import SDK could use this function, but the adapter supplied no Import API root, types, container helper, polling, correlation, outcome classification, or journal descriptors. `packages/commercetools/src/sdk.ts:6-20,45-49,56-62`
- commercetools documents `@commercetools/importapi-sdk` as a separate generated package and shows a separately configured Import API host/root. This supports a separate adapter service rather than widening the meaning of the existing platform-root `CommercetoolsSdk`. [TypeScript SDK setup](https://docs.commercetools.com/dev-tooling/ts-sdk-getting-started), [Import API hosts and authorization](https://docs.commercetools.com/api/import-export/hosts-and-authorization)

### Existing destination surface

At the time of research, the destination supported six platform resource
areas: Business Units, Customers, Inventory Entries, Products, Product
Selections, and Stores. Each generic resource helper had one `create` and one
`update` Effect. `packages/commercetools/src/destination/capabilities.ts:96-141`

The Import API overlaps with five of those six areas: Business Units, Customers, Inventory Entries, Products, and Product Selections. Stores are not in the documented Import API supported-resource list. The resource-specific import endpoints remain public beta even though containers, operations, processing states, and summaries are generally available. [Supported resources and lifecycle status](https://docs.commercetools.com/api/import-export/overview)

The existing helpers wait for a synchronous Platform SDK response, then record a created/updated descriptor containing the resource ID, key, and version. Product create/update illustrates this shape. `packages/commercetools/src/destination/capabilities.ts:490-529,531-612`

The existing journal vocabulary distinguishes `created` from `updated` for every supported resource. An Import API helper cannot honestly reuse that distinction: for most resources the provider performs an upsert by key, and the ImportOperation reports the resulting resource version but does not say whether the operation created or updated the resource. A distinct `imported` descriptor is therefore required. `packages/commercetools/src/destination/capabilities.ts:371-425`; [Import API upsert behavior](https://docs.commercetools.com/api/import-export/overview), [ImportOperation representation](https://docs.commercetools.com/api/import-export/import-operation)

### Core runtime boundary today

`MigrationDefinition` then required one per-item `process(source, context)`
pipeline; there was no `processBatch` authoring contract.
`packages/migrate-sdk/src/domain/definition.ts:526-538,565-600,776-781`

For cursor discovery, the runtime reads one source window, calls `processSourceItem` independently for each item with `processConcurrency`, waits for every scheduled item, and only then writes the next source cursor. Failed/skipped/migrated outcomes are persisted per item inside that processing path. `packages/migrate-sdk/src/services/migration-run-executor.ts:2368-2427,2430-2460`; `packages/migrate-sdk/src/runtime/process-source-item.ts:632-688`

That order is the behavior a batch path must preserve: admit/filter items first, run one or more provider batches, persist exact item outcomes, and checkpoint the source cursor only after the whole source window is durably classified.

## Import API behavior that shaped the design

### Submission is asynchronous

An Import Request is resource-specific and contains at most 20 resources. The POST response is an `ImportResponse` containing initial `ImportOperationStatus` values; receiving it means processing has started, not that resources were created or updated. The API creates one ImportOperation per submitted resource. [Import Requests](https://docs.commercetools.com/api/import-export/import-requests), [Import API overview](https://docs.commercetools.com/api/import-export/overview)

Consequences for `processBatch`:

- Provider submission success is not an item success.
- The callback must poll/classify operations or deliberately return a pending/failure policy.
- One source cursor window is not necessarily one Import Request. A window
  containing more than 20 admitted items must be partitioned inside the
  commercetools callback/helper while remaining one settlement population.
- A single Import Request cannot mix resource kinds, so a source window
  containing several destination resource kinds must be grouped before
  submission.

The last two bullets are interface inferences from the documented resource-specific request types and 20-resource cap, not extra provider guarantees. [Import Requests](https://docs.commercetools.com/api/import-export/import-requests)

### Per-resource operations support partial item settlement

Every submitted resource has its own ImportOperation. Each operation exposes its own `resourceKey`, processing `state`, errors, unresolved references, and—after a successful import—the resulting `resourceVersion`. [Import Operations](https://docs.commercetools.com/api/import-export/import-operation)

The provider states map to a batch integration as follows:

| Provider state | Meaning for a `processBatch` adapter |
| --- | --- |
| `imported` | Successful per-item settlement; record the import journal descriptor and tracking record. |
| `validationFailed` | Terminal per-item typed failure with provider errors. |
| `rejected` | Terminal per-item typed failure; commercetools says this is the state that requires a caller retry after internal retries are exhausted. |
| `canceled` | Per-item typed failure. |
| `partiallyImported` | Per-item typed partial failure, not success. Record only external changes that can be established safely, then fail the item so it remains eligible for correction/retry. |
| `processing` | Pending; keep polling until the adapter's deadline. |
| `unresolved` | Pending on missing key references, potentially for the operation lifetime. |
| `waitForMasterVariant` | Pending Product condition, potentially until a later request supplies required Master Variant data. |

The state meanings are provider facts; the settlement policy in the right column is the recommended adapter interpretation. commercetools documents `partiallyImported` as “some actions succeeded but others failed” and includes error details for failed parts. It does not document a complete list of successful sub-actions in the operation, so exact rollback journaling for a partial operation may require import-type-specific knowledge or a platform read-back. commercetools's retry guidance says caller retry is needed for `rejected`; other provider retries are internal. [Processing states](https://docs.commercetools.com/api/import-export/import-operation), [partial import state release note](https://docs.commercetools.com/api/releases/2026-03-10-introduced-partial-import-state-for-import-operations), [retry guidance](https://docs.commercetools.com/api/import-export/best-practices)

This directly supported the Migrate SDK semantics we later implemented. If A,
B, C, and D share one request and only C's operation fails, A/B/D can return
successful settlements and C can return a failed settlement. If C is
`partiallyImported`, C still remains one failed source item with a partial
destination journal; the entire request must not be marked failed or successful
as a unit.

### Correlation must be explicit

The initial `ImportResponse.operationStatus` representation contains operation IDs and initial states but no resource keys. The full ImportOperation contains both `id` and `resourceKey`, and the API provides a Get ImportOperation endpoint by ID. [ImportResponse](https://docs.commercetools.com/api/import-export/import-requests), [Get ImportOperation](https://docs.commercetools.com/api/import-export/import-operation)

The official response contract does not state that `operationStatus` order is a durable positional correlation contract. A first-party adapter should therefore:

1. require 1–20 locally unique resource keys for the first Product slice;
2. retain all returned operation IDs;
3. GET/poll those exact IDs;
4. correlate the resulting operations by `resourceKey`; and
5. validate exact set equality between submitted resource keys and returned operation resource keys before producing Migrate SDK settlements.

The “do not use response position” rule is a conservative inference from the documented shapes, not a claim that commercetools reorders the response array. It avoids making an adapter guarantee the provider does not document.

Querying operations by `resourceKey` is available, but it is weaker for exact request correlation when a stable container is reused: multiple ImportOperations for the same resource key can coexist over their 48-hour lifetime. The exact operation IDs returned from the request are the unambiguous handles. This is an inference from container reuse, operation lifetime, and the query filter. [Query ImportOperations](https://docs.commercetools.com/api/import-export/import-operation), [container reuse guidance](https://docs.commercetools.com/api/import-export/best-practices)

An ImportSummary is suitable for aggregate diagnostics, not item settlement: it only contains counts by state and its endpoint is eventually consistent. Polling the exact operation IDs is the appropriate proof-point path. [ImportSummary](https://docs.commercetools.com/api/import-export/import-container), [monitoring guidance](https://docs.commercetools.com/api/import-export/overview)

### Limits and concurrency

- One Import Request contains at most 20 resources and its body must not exceed 14 MB. Multiple requests may be sent concurrently to the same container. [Import Requests](https://docs.commercetools.com/api/import-export/import-requests)
- commercetools recommends fewer than 200,000 live ImportOperations per container so container-level monitoring remains performant. [Import API best practices](https://docs.commercetools.com/api/import-export/best-practices)
- The Import API documents no hard rate limit, but recommends no more than 300 API calls per second per Project for best performance. This is a provider recommendation, not an SDK default that `processBatch` should encode globally. [Import API best practices](https://docs.commercetools.com/api/import-export/best-practices)
- Concurrent *distinct* requests are supported, but concurrent duplicate import requests are explicitly discouraged because asynchronous processing order is not guaranteed and concurrent modification errors may result. [Import Requests](https://docs.commercetools.com/api/import-export/import-requests), [Import API best practices](https://docs.commercetools.com/api/import-export/best-practices)

This separates three knobs that should not be conflated:

1. source-window size and admission/settlement concurrency owned by Migrate SDK;
2. the runtime population passed to `processBatch`; and
3. Import API request concurrency/chunking owned by the Commercetools batch callback or helper.

For the proof point, call `processBatch` once for one admitted population and
let the commercetools helper partition that population into disjoint requests
of at most 20 resources. This keeps internal grouping in the migration and
proves that an Import Request is not a cursor or settlement boundary.

### Container lifecycle

Import Containers are durable provider workspaces, not batch identities. A container can be restricted to one resource type or accept all supported types. New containers without a retention policy expire after 72 hours; an explicit TTL can be between 1 hour and 30 days; and a Project can have up to 1,000 containers. ImportOperations expire after 48 hours. [Import Containers](https://docs.commercetools.com/api/import-export/import-container), [Import Operations](https://docs.commercetools.com/api/import-export/import-operation)

commercetools recommends stable containers for routine imports, separate containers by resource type or source when useful, and warns against arbitrary one-off containers for small batches. [Import API best practices](https://docs.commercetools.com/api/import-export/best-practices)

Therefore:

- do not create one container per `processBatch` call;
- make container provisioning/validation an explicit adapter capability or run setup step;
- give the first Product import helper a configured stable container key and resource type;
- surface expiry so a long-running or scheduled integration can re-ensure the container; and
- never use the container key as a Migrate SDK batch ID.

### Replay, idempotency, and version semantics

For most supported resources, the Import API identifies a resource by user-defined `key` and performs an upsert. Orders use `orderNumber`, and Orders/Product Variants have distinct create-versus-patch request types. Stable keys make a sequential replay target the same logical resource instead of intentionally creating another keyed resource. [Import API overview](https://docs.commercetools.com/api/import-export/overview)

That is not an exactly-once or unconditional-idempotency guarantee:

- the documented Import Request has no request-level idempotency/deduplication token;
- duplicate requests may execute out of order;
- concurrent duplicate requests can produce `ConcurrentModification` errors; and
- an upsert can overwrite the current representation or increment the target resource version even though the logical key is unchanged.

The first three bullets follow directly from the documented request and concurrency contracts. The last is an inference from upsert/update behavior and normal commercetools resource versioning; the adapter must not promise whether an identical payload increments a version without a provider test for the chosen import type. [Import API overview](https://docs.commercetools.com/api/import-export/overview), [Import API best practices](https://docs.commercetools.com/api/import-export/best-practices), [resource versioning](https://docs.commercetools.com/api/general-concepts)

Two versions must not be confused:

- `ImportOperation.version` is the version of the status resource itself.
- `ImportOperation.resourceVersion` is the resulting version of the imported commerce resource when the import succeeds.

The ImportOperation exposes the latter after success; the generic import request does not expose a request-level expected target-resource version precondition. The Import API can still report `ConcurrentModification` while its internal asynchronous work races another update. [ImportOperation representation](https://docs.commercetools.com/api/import-export/import-operation), [Import API errors](https://docs.commercetools.com/api/errors)

The cursor collision is consequently real:

1. a Workflow cursor-window step submits an Import Request;
2. the provider accepts it and returns operation IDs;
3. the step crashes before those IDs, item outcomes, and the source cursor are durably committed; and
4. replay submits the same keys while the first operations may still be running.

Step 4 is a Migrate SDK/Workflow inference, but the commercetools consequence is documented: concurrent duplicates are unsafe. Per-item journal extensions can retain operation receipts once settlement begins, but they cannot close the earlier gap between remote acceptance and local settlement execution. The integration must therefore document at-least-once submission, require stable keys, and never market `processBatch` as exactly once.

A lost or timed-out POST response is an even smaller ambiguity window: the adapter has neither returned operation IDs nor proof that the provider rejected the request. This is a distributed-systems inference, but the documented Import Request contract offers no client-supplied idempotency token or lookup by such a token. Preserve that distinction in each affected item's indeterminate outcome (for example, `acceptance: "unknown"`) instead of reporting every transport failure as “not submitted.” [Import Request and response contract](https://docs.commercetools.com/api/import-export/import-requests)

If an operation ID has already reached an item settlement Effect, the
commercetools integration can record it in that item's Destination Journal even
when settlement later fails. That enables a later attempt to inspect the failed
state and resume polling instead of blindly resubmitting. It does not close the
smaller crash window between Import API acceptance and execution of the
returned item settlements; closing that window would require a durable receipt
protocol outside the initial boundary.

## Workflow SDK and cursor-window collision analysis

The Workflow SDK runs one `executeMigrationRunCursorWindow` call inside one `"use step"` invocation, and loops sequentially over the returned continuation state. However, the first cursor-window call is not one homogeneous source page: on a normal run it processes the complete failed/needs-update backlog first and then reads one source cursor page. `packages/workflow-sdk/src/migration-execution-workflow.ts:151-245`; `packages/migrate-sdk/src/services/migration-run-executor.ts:3144-3208`

Therefore `processBatch` must be attached to an **admitted runtime population**, not to a Workflow step:

- targeted backlog identities and a cursor page are separate admission populations even when one Workflow step happens to execute both;
- each cursor page may become one `processBatch` call whose callback creates several physical Import Requests;
- an empty terminal Commercetools page creates no `processBatch` call; and
- `processBatch` must not carry leftover Import Request members across source cursor windows because there is no durable batch buffer to reconstruct that temporary grouping.

At the time of research, the cursor-page commit order was destination/item work,
every per-item state write, source cursor write, progress event, and finally
Workflow step-result persistence. Cursor and item states were separate
Migration Store writes; the commercetools store represented them as separate
Custom Objects rather than one transaction.
`packages/migrate-sdk/src/services/migration-run-executor.ts:2368-2460`;
`packages/migrate-sdk/src/services/migration-store.ts:228-269`;
`packages/commercetools/src/migration-store/index.ts:1821-1847,1943-1959`

This produces two important replay collisions:

1. If some item states persist but the cursor does not, replay rereads the same page. Already-migrated unchanged items are filtered, while failed or uncommitted items are admitted again. A provider success whose item-state write was lost can therefore be resubmitted.
2. If the source cursor persists but the Workflow step result does not, retry reads the *next* page using the previous Workflow counts/exclusions. The durable item/cursor data moves forward, but Workflow progress can undercount or regress. After terminal full-discovery cursor deletion, the same response-loss window can restart discovery from the beginning.

Workflow 4.5 retried failed steps three times by default and required external
side effects to be idempotent. At the time, the repository's in-memory fixture
set `maxRetries = 0`, while the shipped example did not set retry metadata.
[Workflow errors and retries](https://workflow-sdk.dev/docs/foundations/errors-and-retries),
[Workflow idempotency](https://workflow-sdk.dev/docs/foundations/idempotency);
`packages/workflow-sdk/src/test-fixtures/in-memory-migration.steps.ts:202-208,312-327`;
`examples/workflow-sdk/src/migrations/workflow-steps.ts:46-143`

For v1, explicitly disabling configured cursor-step retries is a useful risk reduction because commercetools-specific retry and polling logic can preserve partial results more precisely. It is not an exactly-once guarantee: a step can still execute again after an ambiguous crash or lost result, and a later migration run can replay an item whose remote effect escaped persistence. A stronger future fix is an atomic cursor-window checkpoint containing the expected input cursor and returned Workflow counts, so a repeated step returns the already-committed result instead of consuming the next page. That is cursor and Workflow durability, not persisted batch state, and remains outside `processBatch`.

Definition locks do not remove this hazard. They exclude a different migration
run for the same definition, but a repeated attempt in the same run has the
same lease identity. They also do not coordinate Import API concurrency across
different definitions targeting the same commercetools Project; that remains
an application concern.

## Core runtime gaps exposed by batching

The existing `processSourceItem` already contains the right phases but combines them in one function. A batch implementation should extract shared admission and settlement seams rather than fork the decode/state/tracking rules: decode the source, load/decode prior state and tracking, observe inventory membership, exclude unchanged migrated items, then give each admitted item an isolated Tracking-backed settlement. `packages/migrate-sdk/src/runtime/process-source-item.ts:573-688`

Three details need an explicit decision during that refactor:

1. Current code excludes an unchanged migrated item before decoding its stored tracking record, while the handoff describes prior tracking-contract validation before unchanged exclusion. The shared admission path must choose and test one order. `packages/migrate-sdk/src/runtime/process-source-item.ts:632-669`
2. On a later failed or skipped attempt, process entries still preserve the previous compensation journal. A generic, typed journal extension now gives helpers independent merge semantics: the commercetools helper can replace its own latest Import Operation value without replacing those process entries. This is an item-level extension point, not batch or attempt history. `packages/migrate-sdk/src/domain/tracking.ts`; `packages/migrate-sdk/src/runtime/process-source-item.ts`
3. Structurally tagged `MigrationStoreError`, defects, and interruption escape item-error normalization. That behavior should remain fatal for the window: some sibling item writes may already have persisted, but the cursor must not advance. Ordinary typed per-item failures and a typed outer `BatchError` can be durably broadcast to admitted items and allow the window to advance; a malformed settlement table must fail before executing any settlement Effects. `packages/migrate-sdk/src/runtime/process-source-item.ts:505-568`

These are durability constraints, not reasons to persist generic batch identity. On retry, the durable per-item states still determine the next admitted population.

## Smallest plausible first-party adapter surface

### 1. Mirror the existing SDK service for the Import API

Add `@commercetools/importapi-sdk` and a separate service rather than changing the type of `CommercetoolsSdk.project`:

```ts
type CommercetoolsImportProject = ReturnType<
  ImportApiRoot["withProjectKeyValue"]
>;

class CommercetoolsImportSdk extends Context.Service<
  CommercetoolsImportSdk,
  {
    readonly execute: CommercetoolsImportSdkExecute;
    readonly project: CommercetoolsImportProject;
    readonly request: CommercetoolsImportSdkRequest;
  }
>()("@migrate-sdk/commercetools/CommercetoolsImportSdk") {
  static readonly layerFromApiRoot: (
    options: CommercetoolsImportSdkLayerOptions
  ) => CommercetoolsImportSdkLayer;
}
```

The official TypeScript guide constructs an Import API root with `@commercetools/importapi-sdk` and a distinct Import API HTTP host. The existing platform service uses the same basic Effect wrapper shape, so this is a narrow extension with a familiar testing seam. [TypeScript SDK setup](https://docs.commercetools.com/dev-tooling/ts-sdk-getting-started); `packages/commercetools/src/sdk.ts:4-27,45-77`; `packages/commercetools/src/testing/sdk.ts:183-244`

Do not make the adapter own credentials or infer a region. Match the existing `layerFromApiRoot` ownership model: the application supplies a fully configured root/client.

Before implementation, the selected `@commercetools/importapi-sdk` release
needed to be verified against the adapter's then-current
`@commercetools/sdk-client-v2` dependency. The official setup guide used
`@commercetools/ts-client`; compatibility or a client-package migration needed
to come from the chosen package's actual types rather than assumption.
[TypeScript SDK setup](https://docs.commercetools.com/dev-tooling/ts-sdk-getting-started);
`packages/commercetools/package.json:87-90`

### 2. Expose container setup separately

The minimum container surface is `get`, `create`, and `ensure` for a configured key/resource type/retention policy. `ensure` must validate an existing container's resource type rather than silently repurposing it. Container creation/update needs separate error classification because it is shared infrastructure, not one source item's outcome. [Import Container representations and endpoints](https://docs.commercetools.com/api/import-export/import-container)

Do not create/delete containers inside `submitAndAwait`, and do not delete a container as rollback: deleting a container removes its operations but does not undo commerce resources already imported. [Import API best practices](https://docs.commercetools.com/api/import-export/best-practices)

### 3. Start with one resource-specific batch helper

Start with Product Draft or Product imports because Products already have a first-party destination capability and are the catalog use case. Keep the Import API request type visible:

```ts
type CommercetoolsImportBatchOutcome =
  | {
      readonly kind: "imported";
      readonly containerKey: string;
      readonly operationId: string;
      readonly resourceKey: string;
      readonly resourceVersion: number;
    }
  | {
      readonly kind: "failed";
      readonly containerKey: string;
      readonly errors: readonly ErrorObject[];
      readonly operationId: string;
      readonly resourceKey: string;
      readonly state:
        | "canceled"
        | "partiallyImported"
        | "rejected"
        | "validationFailed";
    }
  | {
      readonly kind: "pending";
      readonly containerKey: string;
      readonly operationId: string;
      readonly resourceKey: string;
      readonly state: "processing" | "unresolved" | "waitForMasterVariant";
      readonly unresolvedReferences?: readonly UnresolvedReferences[];
    };

interface CommercetoolsProductImports {
  readonly submitAndAwait: (input: {
    readonly containerKey: string;
    readonly poll: CommercetoolsImportPollPolicy;
    readonly request: ProductImportRequest | ProductDraftImportRequest;
  }) => Effect.Effect<
    readonly CommercetoolsImportBatchOutcome[],
    CommercetoolsImportRequestError | CommercetoolsImportContractError,
    never
  >;
}
```

This is an interface sketch, not implementation-ready naming. Important properties are:

- 1–20 unique keys and the 14 MB encoded-body limit are validated before POST;
- the helper returns exactly one outcome per submitted key, in no meaningful order;
- submission failures settle affected resources with explicit `not-accepted` or `unknown` acceptance, while shared container and response-contract failures remain outer errors;
- provider states remain per-resource data rather than one batch error;
- polling timeout yields known terminal outcomes plus explicit per-resource pending outcomes, so the `processBatch` callback can still settle every admitted item; and
- the caller decides how a pending-at-deadline outcome maps to its typed process error.

Do not initially generalize across every ImportRequest union. One Product implementation is enough to force the core SDK to solve admission, exact settlement coverage, partial success, polling, interruption, replay, and cursor checkpointing. Inventory, Customers, Business Units, and Product Selections can reuse the internal operation machinery later; Stores must retain the Platform API path because the Import API does not support them. [Supported Import API resources](https://docs.commercetools.com/api/import-export/overview)

### 4. Separate compensation changes from the helper's operation extension

On `imported`, record a descriptor such as `commercetools.product.imported` with:

```ts
{
  containerKey,
  operationId,
  resourceKey,
  resourceType,
  resourceVersion
}
```

Do not call it `created` or `updated`, and do not put the full commercetools
response or raw credentials/headers in the journal. This follows the helper's
compact, descriptor-backed journal practice while representing the Import
API's actual upsert result. `packages/commercetools/docs/destination.md:55-72,90-96`;
`packages/commercetools/src/destination/capabilities.ts:371-425,508-529`

For `partiallyImported`, a settlement may record an import-partial
descriptor/diagnostic and then fail with a typed commercetools error. The
planned `processBatch` runtime needed to preserve journal entries made before
that typed failure, just as the handoff required. Exact rollback remained
migration-specific because the operation does not say whether the original
upsert created a resource or updated a pre-existing one.

Separately, keep the latest Import Operation outcome in a typed, helper-owned
journal extension. Pending or ambiguously accepted operations can then be read
and polled on the next run without turning their receipts into compensation
changes. Replacing this extension updates current helper state; it does not
create SDK-owned attempt history.

## What this proof point requires from core `processBatch`

1. **Admission before provider work.** Decode source/state/tracking, apply unchanged filtering, and persist immediate item failures before Product imports are assembled.
2. **Batch size independent of source cursor windows.** Pass one admitted
   population to the callback; let the commercetools helper split it into
   disjoint Import Requests of at most 20. Never advance the cursor between
   request chunks from the same source window.
3. **Exact item settlement.** One settlement per admitted source item; duplicate, missing, or foreign settlements are a contract error and execute no settlement table.
4. **Per-item Tracking scopes.** Successful operations record their own import descriptor/tracking record. A failed or partially imported operation records only its own diagnostics/known changes.
5. **Partial outcomes before outer failure.** Once operation-level results exist, return item settlements instead of throwing one outer error that broadcasts failure to successful imports.
6. **Explicit Import API concurrency.** Keep admission/settlement concurrency
   and Import API request/poll concurrency separate; the callback owns the
   latter.
7. **Cursor safety under partial persistence.** Advance the source cursor only after every admitted item in the window has a durable outcome. Replay must re-admit only unresolved/failed/changed items; already migrated unchanged items must be filtered.
8. **No exactly-once claim.** A crash after Import API acceptance but before durable per-item receipt/state can resubmit; stable keys are required and concurrent replay remains a documented provider hazard.

## Proof-point test matrix

The first-party adapter is useful only if it exercises these cases against scripted generated-SDK requests and core batch tests:

1. 20 Product resources submit as one Import Request and settle independently.
2. A/B/D `imported`, C `validationFailed`: A/B/D migrate, C fails, and the cursor window completes only after all four states persist.
3. C `partiallyImported`: its known provider details are journaled and only C fails.
4. A definitive local validation or shared-container failure before POST is an outer batch error and the cursor does not advance.
5. A POST response is lost after possible acceptance: every affected item records an indeterminate outcome with unknown acceptance, the cursor advances only after those item failures persist, and blind replay is blocked.
6. Operation IDs resolve to a missing, duplicate, or foreign resource key: correlation contract error; no settlement table executes and the cursor does not advance.
7. `processing`, `unresolved`, or `waitForMasterVariant` passes the poll deadline: successful peers still settle; the pending item gets an explicit typed outcome according to definition policy.
8. A source cursor window contains 41 items: the runtime/helper creates 20/20/1 provider requests while committing the source cursor only after all 41 item outcomes persist.
9. Two disjoint requests run concurrently in one container; no item key appears in both.
10. Step interruption after submit is replayed with stable keys and documents the possible duplicate-operation/concurrent-modification path.
11. An imported upsert journal uses `imported`, not guessed `created`/`updated`, and carries the provider's `resourceVersion`.
12. A Store migration cannot select the Import API helper.
13. Container expiry is detected and `ensure` recreates/validates infrastructure before item submission.
14. A Workflow retry after the source cursor commits but before the step result does not consume a new page with stale counts (or the accepted v1 limitation is captured by an explicit retry policy test).
15. Reprocessing a previously migrated item preserves its compensation journal when the new import fails; recovery of the new Import Operation does not overwrite that compensation evidence.

## Research recommendation implemented by ADR 0009

Use the commercetools Import API as the first-party batch proof point, with these boundaries:

- Product-only first slice;
- one core callback per admitted population, with migration-owned Import
  Request chunks of at most 20 items;
- separate Import API SDK service and explicit stable-container setup;
- exact operation-ID polling and resource-key correlation;
- per-resource outcomes mapped to ordinary Migrate SDK settlements;
- import-specific change descriptors plus a typed helper-owned operation extension;
- no Stores, generic multi-resource abstraction, automatic container-per-batch lifecycle, durable batch receipt, or exactly-once claim in v1.

The proof point is valuable precisely because it stresses the hard parts of
`processBatch`: Import API acceptance is asynchronous, source windows and
Import Requests have different sizes, items settle independently, one product
can be partially applied, and replay can collide with an in-flight prior
submission.
