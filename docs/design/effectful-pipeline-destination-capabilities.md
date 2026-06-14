# Effectful Pipeline Destination Capabilities

Audience: SDK users authoring migrations and plugin authors implementing
destination helper modules.

Status: draft design direction.

This document captures the revised destination API direction where the
transformation pipeline is the destination execution unit. It intentionally does
not rewrite the older command-plan design documents yet.

Change descriptors, journal tracking, optional materialized tracking records,
and journal persistence are specified in
[Scoped Pipeline Tracking API](./scoped-pipeline-tracking-api.md). This document
only describes how destination helpers participate in effectful pipelines.

## Summary

Destination command plans should collapse into normal Effect pipelines.
Destination plugins should become Effect capability modules: they expose
effectful destination helpers, typed change descriptors, dependency layers, and
optional rollback helpers. The migration definition does not need a
`destination`, `destinations`, or `provide` key unless the runtime has a concrete
reason to read it.

The runtime owns migration item execution. For each source item it provides a
scoped destination journal, runs the user pipeline, snapshots the journal on
success or failure, and delegates tracking evaluation to the tracking model.

## Target Authoring Shape

```ts
const ct = CommercetoolsDestination.make({
  projectKey: "catalog",
}).provide(CommercetoolsLive.layer)

const ProductTracking = Tracking.journal({ id: "products@v1" })

const products = defineMigration({
  id: "products",
  source,
  store,
  tracking: ProductTracking,
  pipeline: Effect.fn("products.pipeline")(function* (source) {
    yield* ct.products
      .upsert({
        key: source.item.key,
        name: source.item.name,
      })
      .pipe(RetryOnNetwork)
  }),
})
```

The migration definition describes the source, store, tracking mode, and
pipeline. Destination capability modules are regular values used by the
pipeline. Their non-framework requirements are satisfied with normal Effect
composition.

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
      Requirements | DestinationJournal
    >
  }
  readonly inventory: {
    readonly upsert: (
      draft: InventoryDraft
    ) => Effect.Effect<
      InventoryEntry,
      CommercetoolsError,
      Requirements | DestinationJournal
    >
  }
  readonly provide: DestinationProvide<Requirements>
}
```

Destination helpers may require destination services such as clients,
credentials, rate limiters, and telemetry services. Helpers that produce
trackable changes also require the framework-provided `DestinationJournal` so
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

Pipeline-local provision remains valid for advanced cases:

```ts
const productsPipeline = Effect.fn("products.pipeline")(function* (source) {
  yield* ct.products.upsert(source.item).pipe(RetryOnNetwork)
}).pipe(Effect.provide(CommercetoolsLive.layer))
```

Run-level provision can also work if the returned migration definition preserves
pipeline requirements in its type:

```ts
runMigration(products).pipe(Effect.provide(CommercetoolsLive.layer))
```

The framework still provides framework-owned services around each item
execution:

- source runtime services
- migration store services
- migration item context
- destination journal
- tracking evaluation

Destination client layers are user/plugin requirements, not migration definition
properties.

## Tracking Boundary

Destination helpers participate in tracking by recording destination-native
changes into the framework-provided journal.

```ts
yield* ct.products.upsert(productDraft).pipe(RetryOnNetwork)
```

This document does not define tracking modes, materialized tracking records,
aliases, custom changes, or failed item state persistence. Those rules belong to
the scoped pipeline tracking spec.

## Hand-Rolled Effects

Users can always write ordinary Effects:

```ts
yield* Effect.tryPromise(() =>
  rawCtClient.products().post({ body: productDraft }).execute()
)
```

That is valid pipeline code, but it is not a destination helper from a
capability module and records no destination-native change by default. The
tracking consequences and explicit custom-change escape hatches are specified
by the tracking spec.

## Why Not `destination` On The Definition

The previous runtime needed `definition.destination` because the pipeline
returned command plans:

```ts
pipeline -> DestinationCommandPlan
runtime -> validate command definitions
runtime -> execute through DestinationPlugin service
runtime -> infer destination identity
```

In the effectful pipeline model, the pipeline runs destination effects itself:

```ts
pipeline -> Effect<void, error, requirements | DestinationJournal>
runtime -> provide item scope and journal
runtime -> snapshot journal and evaluate tracking
```

If the runtime does not execute destination command plans, a top-level
`destination` key becomes misleading. It suggests the framework owns destination
execution policy, retries, and identity inference. The new model intentionally
moves those decisions into normal Effect composition and the tracking model.

The migration definition may still need to carry source and store because the
runner reads source items and persists item state. It does not need to carry
destination modules just so the pipeline can call them.

## Why Not `destinations` As A Registry

A `destinations: { ct }` registry could support validation that change
descriptors come from registered modules, but it would mostly duplicate values
already referenced by the pipeline and tracking model.

```ts
const products = defineMigration({
  id: "products",
  source,
  store,
  destinations: { ct },
  tracking: Tracking.journal({ id: "products@v1" }),
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
- plugin lifecycle hooks outside the pipeline
- policy enforcement that all tracking descriptors originate from declared
  capability modules

Until one of those exists, the registry is ceremony.

## Runtime Sketch

For each source item, the runner does this:

```ts
const itemProgram = Effect.gen(function* () {
  const journal = yield* DestinationJournal

  const exit = yield* pipeline(sourceItem).pipe(Effect.exit)
  const journalSnapshot = yield* journal.snapshot

  if (Exit.isFailure(exit)) {
    return yield* storeFailedItemState({
      sourceItem,
      journal: journalSnapshot,
      failure: exit.cause,
    })
  }

  if (tracking._tag === "Untracked") {
    return yield* storeMigratedItemState({
      sourceItem,
    })
  }

  const trackingState = yield* Tracking.evaluate({
    sourceItem,
    journalSnapshot,
    tracking,
  })

  return yield* storeMigratedItemState({
    sourceItem,
    trackingState,
    journal: journalSnapshot,
  })
}).pipe(
  Effect.provide(DestinationJournal.layerScoped()),
  Effect.provide(MigrationItemContext.layer(sourceItem))
)
```

The exact implementation can differ, but the ownership boundary should hold:
the user pipeline executes effects; the runtime owns item state persistence and
journal capture. Detailed tracking evaluation is delegated to the sibling
tracking spec.

## Open Questions

- Should change descriptors carry a module id for diagnostics and
  fingerprinting, even without a destination registry?
- Should plugin-local `.provide(...)` be the only documented dependency style,
  while pipeline-level and run-level provision remain advanced Effect usage?
