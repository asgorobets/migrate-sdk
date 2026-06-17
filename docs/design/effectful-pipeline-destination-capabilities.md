# Effectful Process Destination Capabilities

Audience: SDK users authoring migrations and plugin authors implementing
destination helper modules.

Status: draft design direction.

This document captures the revised destination API direction where the process
pipeline is the destination execution unit. It intentionally does not rewrite
the older command-plan design documents yet.

Change descriptors, journal tracking, optional materialized tracking records,
and journal persistence are specified in
[Scoped Process Tracking API](./scoped-pipeline-tracking-api.md). This document
only describes how destination helpers participate in effectful process
pipelines.

The domain term is **Process Pipeline**; examples may still show the current
`pipeline` property until implementation renames that authoring slot to
`process`.

## Summary

Destination command plans should collapse into normal Effect process pipelines.
Destination plugins should become Effect capability modules: they expose
effectful destination helpers, typed change descriptors, dependency layers, and
optional rollback helpers. The migration definition does not need a
`destination`, `destinations`, or `provide` key unless the runtime has a concrete
reason to read it.

The runtime owns migration item execution. For each source item it provides the
scoped tracking service, runs the user process, preserves the process journal
segment when failed-state evidence is needed, and delegates tracking record
evaluation to the tracking model.

## Target Authoring Shape

```ts
const ct = CommercetoolsDestination.make({
  projectKey: "catalog",
}).provide(CommercetoolsLive.layer)

const ProductTracking = Tracking.record({
  id: "products@v1",
  schema: ProductTrackingRecord,
})

const products = defineMigration({
  id: "products",
  source,
  store,
  tracking: ProductTracking,
  pipeline: Effect.fn("products.pipeline")(function* (source) {
    const product = yield* ct.products
      .upsert({
        key: source.item.key,
        name: source.item.name,
      })
      .pipe(RetryOnNetwork)

    yield* Tracking.setRecord({
      productId: product.id,
      productKey: product.key,
    })
  }),
})
```

The migration definition describes the source, store, optional tracking record
contract, and process pipeline. Destination capability modules are regular
values used by the process. Their non-framework requirements are satisfied with normal
Effect composition.

## Destination Capability Module

A destination module is not a command-plan executor. It is a typed Effect helper
package for one destination system or destination area.

```ts
interface DestinationCapabilityModule<Requirements> {
  readonly changes: ChangeCatalog
  readonly provide: <Provided, Error, Remaining>(
    layer: Layer.Layer<Provided, Error, Remaining>
  ) => DestinationCapabilityModule<Remaining | Exclude<Requirements, Provided>>
}
```

The change catalog is part of the module because journal reads, rollback
helpers, and optional tracking records need typed descriptors for
destination-native outcomes. The descriptor semantics belong to the tracking
spec; this document only requires destination modules to expose them beside the
helpers that record them.

Concrete modules expose domain helpers:

```ts
interface CommercetoolsDestination<Requirements> {
  readonly changes: {
    readonly productUpserted: DestinationChangeDescriptor<ProductUpserted>
    readonly inventoryEntryUpserted: DestinationChangeDescriptor<InventoryEntryUpserted>
  }
  readonly products: {
    readonly upsert: (
      draft: ProductDraft
    ) => Effect.Effect<
      Product,
      CommercetoolsError,
      Requirements | Tracking
    >
  }
  readonly inventory: {
    readonly upsert: (
      draft: InventoryDraft
    ) => Effect.Effect<
      InventoryEntry,
      CommercetoolsError,
      Requirements | Tracking
    >
  }
  readonly provide: DestinationProvide<Requirements>
}
```

Destination helpers may require destination services such as clients,
credentials, rate limiters, and telemetry services. Helpers that produce
trackable changes also require the framework-provided `Tracking` service so
they can record changes when destination operations succeed.

## Providing Requirements

The migration definition should not grow a `provide` option unless the runtime
needs to inspect it. Normal Effect provision is enough.

Plugin-local provision is the recommended authoring style:

```ts
const ct = CommercetoolsDestination.make({
  projectKey: "catalog",
}).provide(CommercetoolsLive.layer)
```

Process-local provision remains valid for advanced cases:

```ts
const productsPipeline = Effect.fn("products.pipeline")(function* (source) {
  yield* ct.products.upsert(source.item).pipe(RetryOnNetwork)
}).pipe(Effect.provide(CommercetoolsLive.layer))
```

Run-level provision can also work if the returned migration definition preserves
process requirements in its type:

```ts
runMigration(products).pipe(Effect.provide(CommercetoolsLive.layer))
```

The framework still provides framework-owned services around each item
execution:

- source runtime services
- migration store services
- migration item context
- scoped tracking service
- tracking evaluation

Destination client layers are user/plugin requirements, not migration definition
properties.

## Tracking Boundary

Destination helpers participate in tracking by recording destination-native
changes into the framework-provided journal.

```ts
yield* ct.products.upsert(productDraft).pipe(RetryOnNetwork)
```

This document does not define tracking record contracts, journal diagnostics, or
failed item state persistence. Those rules belong to the scoped process
tracking spec.

## Hand-Rolled Effects

Users can always write ordinary Effects:

```ts
yield* Effect.tryPromise(() =>
  rawCtClient.products().post({ body: productDraft }).execute()
)
```

That is valid process code, but it is not a destination helper from a
capability module and records no destination-native change by default. The
tracking consequences, diagnostic logging, and optional tracking record contract
are specified by the tracking spec.

## Why Not `destination` On The Definition

The previous runtime needed `definition.destination` because the pipeline
returned command plans:

```ts
pipeline -> DestinationCommandPlan
runtime -> validate command definitions
runtime -> execute through DestinationPlugin service
runtime -> infer destination identity
```

In the effectful process model, the process pipeline runs destination effects
itself:

```ts
process -> Effect<void, error, requirements | Tracking>
runtime -> provide item scope and tracking service
runtime -> preserve failed-state journal evidence and evaluate tracking records
```

If the runtime does not execute destination command plans, a top-level
`destination` key becomes misleading. It suggests the framework owns destination
execution policy, retries, and identity inference. The new model intentionally
moves those decisions into normal Effect composition and the tracking model.

The migration definition may still need to carry source and store because the
runner reads source items and persists item state. It does not need to carry
destination modules just so the process pipeline can call them.

## Why Not `destinations` As A Registry

A `destinations: { ct }` registry could support validation that change
descriptors come from registered modules, but it would mostly duplicate values
already referenced by the process pipeline and tracking model.

```ts
const products = defineMigration({
  id: "products",
  source,
  store,
  destinations: { ct },
  tracking: Tracking.record({
    id: "products@v1",
    schema: ProductTrackingRecord,
  }),
  pipeline,
})
```

This is not needed for the current model. Change descriptors can carry enough
metadata for contract fingerprinting and validation without registering the
whole module. Destination services can be provided through Effect. The registry
should be deferred until the runtime has a concrete behavior that requires it.

Possible future reasons to add a registry:

- runtime inspection of destination capabilities
- automatic operator reports grouped by destination system
- preflight checks against destination systems
- plugin lifecycle hooks outside the process
- policy enforcement that all tracking descriptors originate from declared
  capability modules

Until one of those exists, the registry is ceremony.

## Runtime Sketch

For each source item, the runner does this:

```ts
const itemProgram = Effect.gen(function* () {
  const trackingService = yield* Tracking

  const exit = yield* pipeline(sourceItem).pipe(Effect.exit)
  const journal = yield* trackingService.snapshot

  if (Exit.isFailure(exit)) {
    return yield* storeFailedItemState({
      sourceItem,
      processJournal: journal,
      failure: exit.cause,
    })
  }

  if (definition.tracking === undefined) {
    return yield* storeMigratedItemState({
      sourceItem,
    })
  }

  const trackingState = yield* trackingService.evaluateRecordContract({
    sourceItem,
    tracking: definition.tracking,
  })

  return yield* storeMigratedItemState({
    sourceItem,
    trackingState,
  })
}).pipe(
  Effect.provide(Tracking.layerProcessScope()),
  Effect.provide(MigrationItemContext.layer(sourceItem))
)
```

The exact implementation can differ, but the ownership boundary should hold:
the user process executes effects; the runtime owns item state persistence and
journal capture. Detailed tracking evaluation is delegated to the sibling
tracking spec.

## Open Questions

- Should change descriptors carry a module id for diagnostics and
  fingerprinting, even without a destination registry?
- Should plugin-local `.provide(...)` be the only documented dependency style,
  while process-level and run-level provision remain advanced Effect usage?
