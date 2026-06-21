# Commercetools Destination Capabilities

Status: implemented for process-based migrations.

`@migrate-sdk/commercetools/destination` exposes a Destination Capability
Module. Helpers are normal Effect functions that run inside `process`, call the
Commercetools SDK service, return SDK resources, and record Destination Journal
changes through `Tracking`.

## Provision

The primary style is plugin-local provision:

```ts
import { CommercetoolsDestination } from "@migrate-sdk/commercetools/destination";

const ct = CommercetoolsDestination.make({
  productTypes,
  customTypes,
}).provide(commercetoolsSdkLayer);
```

After `.provide(commercetoolsSdkLayer)`, helpers require only the framework
`Tracking` service that the runner supplies inside `process`.

Advanced Effect users can skip plugin-local provision and provide the SDK layer
around a larger process or run-level Effect. The unprovided module keeps
`CommercetoolsSdk | Tracking` in each helper requirement.

## Process Helpers

Helpers are grouped by Commercetools resource area:

- `ct.products.create(...)` and `ct.products.update(...)`
- `ct.inventory.create(...)` and `ct.inventory.update(...)`
- `ct.customers.create(...)` and `ct.customers.update(...)`
- `ct.businessUnits.create(...)` and `ct.businessUnits.update(...)`
- `ct.stores.create(...)`, `ct.stores.update(...)`,
  `ct.stores.assignProductSelection(...)`, and
  `ct.stores.removeProductSelection(...)`
- `ct.productSelections.create(...)` and `ct.productSelections.update(...)`

Pure builders remain available beside the effectful helpers: product attribute
builders, Business Unit custom field builders, selectors, and update-action
builders.

```ts
const product = yield* ct.products.create(draft);

yield* Tracking.setRecord({
  productId: product.id,
  productKey: product.key ?? source.item.key,
});
```

## Destination Journal

Each successful helper records a descriptor-backed change after the SDK request
succeeds. Descriptor ids are stable and module-prefixed, for example:

- `commercetools.product.created`
- `commercetools.product.updated`
- `commercetools.inventory-entry.created`
- `commercetools.customer.updated`
- `commercetools.business-unit.created`
- `commercetools.store.product-selection.assigned`
- `commercetools.product-selection.updated`

Descriptor values carry stable resource facts: resource type, id, key when
available, version, source identity, selector context for updates, and small
resource facts such as SKU or product selection key. They do not include full
provider response objects.

Rollback code can narrow journal entries with the descriptor catalog:

```ts
const productEntry = itemState.journal?.process.entries.find(
  ct.products.changes.created.is
);

if (productEntry !== undefined) {
  const decoded = yield* ct.products.changes.created.decode(productEntry);
  yield* rollbackProduct(decoded.value.resourceId);
}
```

If rollback fails, the runtime stores a rollback-attempt segment with whatever
diagnostics or changes the rollback process recorded before failing.

## Diagnostics

Failed SDK requests are mapped to `DestinationPluginError` and record a safe
Destination Journal diagnostic. Diagnostics include stable operation names,
resource type, source identity, selector context, and safe status code when
available. They must not include raw SDK responses, headers, tokens, or
credentials.

## Tracking Records

Tracking Records are migration-specific. Destination helpers record journal
changes, while migration authors choose the current record shape:

```ts
const ProductTracking = Tracking.record({
  id: "catalog-product-tracking@v1",
  schema: Schema.Struct({
    productId: Schema.String,
    productKey: Schema.String,
  }),
});

const definition = MigrationDefinition.make({
  id: "products",
  source,
  store,
  tracking: ProductTracking,
  process: Effect.fn("products.process")(function* (source) {
    const product = yield* ct.products.create(draftFrom(source));

    yield* Tracking.setRecord({
      productId: product.id,
      productKey: product.key ?? source.item.key,
    });
  }),
});
```

## Examples

`examples/product-catalog-store-migration.ts` is the scripted end-to-end proof:
it uses `MigrationDefinition`, `process`, Commercetools product helpers,
`Tracking.setRecord`, Destination Journal changes, and the Commercetools Custom
Object Migration Store.

`examples/product-catalog-store-migration.live.ts` is optional and requires live
Commercetools credentials. Unit tests use scripted SDK routes and do not require
live credentials.
