# commercetools Import API batches

`@migrate-sdk/commercetools/import-api` connects the commercetools Import API
to a migration's `processBatch` callback. Use it when sending Product Drafts
one by one would create unnecessary requests or put avoidable pressure on API
limits. The helper submits several drafts at once, while commercetools still
reports one Import Operation per product.

Bulk submission does not turn the request into the migration unit. Every source
product still receives its own outcome, tracking data, retry eligibility, and
rollback boundary. Existing migrations that use `process` do not need to
change; `processBatch` is an opt-in alternative for migrations that benefit
from coordinated work.

## Configure the Import SDK

Install the generated Import API client and its current TypeScript client in
the application that owns the commercetools credentials:

```sh
pnpm add @commercetools/importapi-sdk @commercetools/ts-client
```

Build the client with the region-specific Import API host, then provide its API
root as an Effect Layer:

```ts
import { createApiBuilderFromCtpClient } from "@commercetools/importapi-sdk";
import { ClientBuilder } from "@commercetools/ts-client";
import { CommercetoolsImportSdk } from "@migrate-sdk/commercetools/import-api";

const projectKey = process.env.CTP_PROJECT_KEY!;
const client = new ClientBuilder()
  .withProjectKey(projectKey)
  .withClientCredentialsFlow({
    credentials: {
      clientId: process.env.CTP_CLIENT_ID!,
      clientSecret: process.env.CTP_CLIENT_SECRET!,
    },
    fetch,
    host: process.env.CTP_AUTH_URL!,
    projectKey,
    scopes: process.env.CTP_SCOPES?.split(",") ?? [],
  })
  .withHttpMiddleware({
    fetch,
    host: process.env.CTP_IMPORT_API_URL!,
  })
  .withUserAgentMiddleware()
  .build();
const apiRoot = createApiBuilderFromCtpClient(client);

const importSdkLayer = CommercetoolsImportSdk.layerFromApiRoot({
  apiRoot,
  projectKey,
});
```

`CTP_IMPORT_API_URL` is `https://import.{region}.commercetools.com`, not the
Composable Commerce HTTP API host. Give the API Client the Product scopes
required to submit Product Draft imports and inspect their operations. Add the
Import Container management scope when the migration also owns setup.

Ensure the container once before starting execution, not inside each cursor
window. `ensure` creates the key when commercetools reports it missing. For an
existing container, it validates the resource type and rejects an expired or
near-expiry container so the application can rotate to a new key:

```ts
yield* CommercetoolsImportContainers.ensure({
  key: "migrate-sdk-catalog-products",
  resourceType: "product-draft",
  retentionPolicy: {
    strategy: "ttl",
    config: { timeToLive: "30d" },
  },
}).pipe(Effect.provide(importSdkLayer));
```

## Run the live Process Batch test

The package includes opt-in end-to-end tests against a real commercetools
Project. The catalog-scale case reads the shared checked-in Wikidata book
catalog used by the Workflow SDK example. Its 100 source rows represent 79
unique works, which the test imports as uniquely keyed Products. It runs the
inline `processBatch` migration across two source cursor windows and five Import
API requests, verifies every Product through the regular platform API, and
checks each item's durable tracking record and helper-owned journal extension.

The mixed-outcome case first creates a Product that reserves a slug. It then
sends three Product Drafts in one accepted Import Request, with one draft
deliberately reusing that slug. commercetools reports `validationFailed` for
that product while importing its two siblings. A second migration run corrects
the slug and proves that only the failed source item is retried while the same
Import Container is reused.

Both cases intentionally retain every Product, Product Type, and Import
Container they create so the result can be inspected in the test Project. A
non-destructive finalizer prints the exact Project key, container key, Product
Type key, Product key prefix/count, Import Operations endpoint, retention
windows, and manual cleanup order even when the test fails. Import Operations
expire after 48 hours and the test's Import Container has a 30-day TTL; Products
and Product Types must be removed manually.

Set these values in `packages/commercetools/examples/.env` or in the process
environment:

```dotenv
CTP_PROJECT_KEY=your-test-project
CTP_CLIENT_ID=your-client-id
CTP_CLIENT_SECRET=your-client-secret
CTP_AUTH_URL=https://auth.{region}.commercetools.com
CTP_API_URL=https://api.{region}.commercetools.com
CTP_IMPORT_API_URL=https://import.{region}.commercetools.com
CTP_SCOPES=manage_import_containers:your-test-project,manage_products:your-test-project
```

Run only the live test:

```sh
pnpm --filter @migrate-sdk/commercetools test:product-import:live
```

The default `pnpm test` suite excludes `*.live.test.ts`, so missing credentials
cannot accidentally turn a local or CI unit-test run into a remote import.

## Import Product Drafts from `processBatch`

`CommercetoolsProductDraftImports.submitAndAwait`:

- accepts any non-empty number of Product Draft imports;
- rejects duplicate resource keys before submission;
- splits the population by both commercetools limits: at most 20 resources and
  at most 14 MB of encoded request body per request;
- submits those disjoint requests with bounded concurrency
  (`submissionConcurrency`, default `4`);
- polls the exact operation ids returned by each request;
- correlates completed operations by `resourceKey`, without relying on response
  order; and
- returns a `ReadonlyMap` containing exactly one outcome for every submitted
  resource key.

`submissionConcurrency` is an option on the commercetools import helper. It
controls how many disjoint Import Requests may be submitted at the same time;
it does not control polling, source cursor windows, or the SDK's item admission
and settlement concurrency.

The migration callback owns the mapping between a source item and its
commercetools resource key. This matters when the source identity is not the
same value as the Product key.

```ts
import type { ProductDraftImport } from "@commercetools/importapi-sdk";
import {
  CommercetoolsImportContractError,
  CommercetoolsImportContainers,
  CommercetoolsProductDraftImports,
  type CommercetoolsProductDraftImportOutcome,
} from "@migrate-sdk/commercetools/import-api";
import { Effect, Schema } from "effect";
import {
  MigrationDefinition,
  type ProcessBatchItem,
  Tracking,
} from "migrate-sdk";

const ProductImportTracking = Tracking.record({
  id: "catalog-product-import@v1",
  schema: Schema.Struct({
    productKey: Schema.NonEmptyString,
    productVersion: Schema.Int,
  }),
});

const settleOutcome = (
  item: ProcessBatchItem<
    CatalogProduct,
    CatalogProductImportError,
    string,
    typeof ProductImportTracking
  >,
  outcome: CommercetoolsProductDraftImportOutcome
) =>
  item.settle(
    Effect.gen(function* () {
      yield* CommercetoolsProductDraftImports.recordOperationOutcome(outcome);

      if (outcome.kind === "imported") {
        yield* Tracking.recordChange(
          CommercetoolsProductDraftImports.changes.imported,
          {
            containerKey: outcome.containerKey,
            operationId: outcome.operationId,
            resourceKey: outcome.resourceKey,
            resourceType: "product-draft",
            resourceVersion: outcome.resourceVersion,
            state: "imported",
          }
        );
        yield* Tracking.setRecord({
          productKey: outcome.resourceKey,
          productVersion: outcome.resourceVersion,
        });
        return;
      }

      if (outcome.state === "partiallyImported") {
        yield* Tracking.recordChange(
          CommercetoolsProductDraftImports.changes.partiallyImported,
          {
            containerKey: outcome.containerKey,
            issues: outcome.errors.map(({ code, message }) => ({ code, message })),
            operationId: outcome.operationId,
            resourceKey: outcome.resourceKey,
            resourceType: "product-draft",
            resourceVersion: outcome.resourceVersion ?? null,
            state: "partiallyImported",
          }
        );
      }

      return yield* CommercetoolsProductDraftImports.toOperationError(outcome);
    })
  );

const imports = CommercetoolsProductDraftImports.provide(importSdkLayer);

const products = MigrationDefinition.make({
  id: "catalog-products",
  source,
  store,
  tracking: ProductImportTracking,
  processBatch: Effect.fn("catalogProducts.processBatch")(function* (items) {
    const prepared = yield* Effect.forEach(items, (item) => {
      const draft = toProductDraftImport(item.source.item);
      return imports
        .resumeFromJournal(item.context.previousState?.journal, draft.key)
        .pipe(
          Effect.match({
            onFailure: (error) => ({
              kind: "failed" as const,
              settlement: item.settle(Effect.fail(error)),
            }),
            onSuccess: (resume) => ({
              draft,
              item,
              kind: "ready" as const,
              resume,
            }),
          })
        );
    });
    const pairs = prepared.flatMap((entry) =>
      entry.kind === "ready" ? [entry] : []
    );
    const outcomes = new Map();
    const candidates = pairs.flatMap(({ resume }) =>
      resume.kind === "await"
        ? [
            {
              candidateOperationIds: resume.candidateOperationIds,
              candidateResourceKeys: resume.candidateResourceKeys,
              resourceKey: resume.resourceKey,
            },
          ]
        : []
    );
    const fresh = pairs.flatMap(({ draft, resume }) =>
      resume.kind === "submit" ? [draft] : []
    );

    for (const { draft, resume } of pairs) {
      if (resume.kind === "blocked") outcomes.set(draft.key, resume.outcome);
    }
    if (candidates.length > 0) {
      const resumed = yield* imports.awaitOperations({
        candidates,
        containerKey: "migrate-sdk-catalog-products",
      }).pipe(Effect.mapError(imports.toProcessBatchContractError));
      for (const entry of resumed) outcomes.set(...entry);
    }
    if (fresh.length > 0) {
      const submitted = yield* imports.submitAndAwait({
        containerKey: "migrate-sdk-catalog-products",
        resources: fresh,
        submissionConcurrency: 4,
      }).pipe(
        Effect.mapError((error) =>
          error instanceof CommercetoolsImportContractError
            ? imports.toProcessBatchContractError(error)
            : error
        )
      );
      for (const entry of submitted) outcomes.set(...entry);
    }

    return prepared.map((entry) => {
      if (entry.kind === "failed") return entry.settlement;

      const { draft, item } = entry;
      const outcome = outcomes.get(draft.key);

      if (outcome === undefined) {
        // submitAndAwait validates exact key equality, so this indicates an
        // implementation defect rather than an item-level commercetools error.
        throw new Error(`Missing validated import outcome for ${draft.key}`);
      }

      return settleOutcome(item, outcome);
    });
  }),
});
```

The runnable version is
[`../examples/product-import-batch-migration.ts`](../examples/product-import-batch-migration.ts).

## Settlement behavior

- `imported` records `commercetools.product-draft.imported`, writes the current
  Product key/version Tracking Record, and settles the item as migrated.
- `partiallyImported` records
  `commercetools.product-draft.partially-imported` before failing the item. This
  preserves evidence that the destination may have changed together with the
  normalized commercetools error codes and messages.
- `rejected`, `validationFailed`, `canceled`, or a still-pending operation
  becomes a typed `CommercetoolsImportOperationError` for that item. Other
  completed items in the same Import Request keep their own outcomes. Terminal
  failures retain normalized commercetools error codes and messages in the
  helper's typed journal extension.
- If one item's saved Import Operation extension cannot be decoded or belongs
  to a different resource key, only that item fails. Other admitted items can
  still be resumed, submitted, and settled.
- Every outcome replaces the helper's latest Import Operation extension for
  that source item. Pending operation ids and accepted polling failures can be
  read on a later run and resumed with `awaitOperations` instead of submitting
  the same Product Draft again. Candidate sets remain recoverable when several
  operation lookups fail together because completed operations expose their
  `resourceKey`. An ambiguous submission with unknown acceptance is retained
  and not blindly resubmitted; it requires manual inspection before the item
  can continue safely.
- A request/response correlation failure is converted with
  `toProcessBatchContractError`. It aborts the cursor window before any
  settlement table is applied or its source cursor advances.

The callback must return exactly one settlement for every admitted item. The
runtime validates the complete handle set before running any settlement. A
missing, duplicate, or foreign settlement fails the cursor window without
advancing its source cursor.

## Cursor windows and replay

One `processBatch` call handles one eligible group. A source cursor window
normally creates that group. The first execution window can also process an
existing failed or `needs-update` backlog as a separate group before it reads
the next source page. The helper may create several count- or byte-bounded
Import Requests for either group, but it never carries unsettled resources into
another cursor window.

The cursor advances only after all item settlements are persisted. Successful
items with unchanged source versions are excluded on a later run, while failed
items are admitted again.

The example runs inline through `runCatalogProductImportMigration`. The
commercetools and Migration Store writes are still separate commits: a worker
can stop after commercetools accepts a request but before its item settlement
is persisted. Use stable Product keys and tolerate replay. Avoid concurrently
submitting duplicate imports for the same keys because the Import API does not
guarantee their processing order.

Rollback remains a per-product migration decision. Deleting an Import
Container removes its Import Operations; it does not remove or revert Products
that were already imported.

See the commercetools documentation for [Import Requests](https://docs.commercetools.com/api/import-export/import-requests),
[Import Operations](https://docs.commercetools.com/api/import-export/import-operation),
[API limits](https://docs.commercetools.com/api/limits),
[Import API hosts and authorization](https://docs.commercetools.com/api/import-export/hosts-and-authorization),
and [Import API best practices](https://docs.commercetools.com/api/import-export/best-practices).
