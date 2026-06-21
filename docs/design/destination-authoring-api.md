# Destination Helper Authoring API

Audience: destination authors building destinations.

Status: current process-helper model.

Destination packages expose Effect helpers and typed change descriptors. They
do not register runtime-executed operations. Migration authors call helpers
inside `process`, and helpers record successful destination changes through the
scoped `Tracking` service.

```ts
const productUpserted = DestinationChangeDescriptor.make(
  "ct.product.upserted",
  Schema.Struct({
    productId: Schema.String,
    productKey: Schema.String,
  })
)

const upsert = (draft: ProductDraft) =>
  Effect.gen(function* () {
    const product = yield* client.upsertProduct(draft)

    yield* Tracking.recordChange(productUpserted, {
      productId: product.id,
      productKey: product.key,
    })

    return product
  })
```

Helpers may require provider clients, config, telemetry, or rate-limit services
through normal Effect requirements. Package-level `.provide(...)` helpers are
recommended when a destination module wants ergonomic local dependency wiring.
