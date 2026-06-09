# Commercetools Custom Fields API

Audience: migration authors and maintainers shaping the
`@migrate-sdk/commercetools` package.

This document captures the intended shape for schema-backed Commercetools
custom field helpers. It builds on the destination plugin authoring rule that
destination schemas validate pipeline-facing values without transforming them.

Related future-state design: [Product Attribute Builders](./product-attributes.md).

## Problem

Commercetools custom fields are configured by a custom type and then attached to
many entity kinds, such as business units, customers, orders, products, and
product selections. The SDK exposes low-level update actions such as
`setCustomField`, but migration authors should not have to hand-author one
action per field for common mapping code.

The plugin should provide a typed helper that lets a pipeline work with a field
bag, then project that bag into either:

- a `CustomFieldsDraft` value suitable for create drafts
- update actions suitable for existing entities

The helper is not a destination command. It prepares typed SDK values that
commands can consume.

## Configuration

The configured destination owns the custom type schema for each entity kind.
For the first slice, assume one configured custom type per entity kind in a
single Commercetools project.

```ts
const BusinessUnitCustomFields = Schema.Struct({
  approvalStatus: Schema.Literal("pending", "approved", "rejected"),
  hasStoreCredit: Schema.Boolean,
  taxId: Schema.optional(Schema.String),
  taxIdValidationReason: Schema.optional(Schema.String),
});

const destination = CommercetoolsDestinationPlugin.make({
  sdkLayer: CommercetoolsSdk.layerFromApiRoot({
    apiRoot,
    projectKey,
  }),
  customTypes: {
    businessUnits: {
      typeKey: "repoBusinessUnit",
      fields: BusinessUnitCustomFields,
    },
  },
});
```

Custom field schemas must be same-shape schemas. They validate the values the
pipeline already produced; they must not decode source-native representations
such as string numbers into destination values. Source plugins own that
decoding.

## Helper Namespace

Custom field helpers should live under the entity helper namespace:

```ts
destination.helpers.businessUnits.customFields
```

The entity-specific helper is already provisioned with the configured custom
type and schema. Migration authors should not pass the custom type key every
time they set fields.

This matches the existing entity-first helper shape, such as
`destination.helpers.products.attributes(...)`, while preserving enough entity
safety to avoid using a business-unit field schema for a customer command. If a
project later needs multiple custom types for the same entity kind, add an
explicit keyed configuration shape rather than making the first API pay that
complexity now.

## Builder API

The primary API accepts a bag of fields and allows chainable field edits:

```ts
const builder = destination.helpers.businessUnits.customFields
  .withFields({
    approvalStatus: "approved",
  })
  .set("hasStoreCredit", true)
  .unset("taxIdValidationReason");
```

`withFields(...)` validates a partial field bag using the configured schema.
`set(name, value)` is typed by the configured field name and value.
`unset(name)` records field removal for update actions and omits that field
from draft output.

The builder should expose projections instead of being treated as a command:

```ts
const custom = yield* builder.toDraft();
const actions = yield* builder.toActions();
```

## Draft Projection

`toDraft()` creates a Commercetools `CustomFieldsDraft` using the configured
custom type. This is safe for entity creation because there are no existing
custom fields to wipe.

```ts
const custom = yield* destination.helpers.businessUnits.customFields
  .withFields({
    approvalStatus: "pending",
    hasStoreCredit: false,
  })
  .set("taxId", "123456789")
  .toDraft();
```

Expected SDK shape:

```ts
{
  type: { typeId: "type", key: "repoBusinessUnit" },
  fields: {
    approvalStatus: "pending",
    hasStoreCredit: false,
    taxId: "123456789",
  },
}
```

`toDraft()` should omit fields marked with `unset(...)`.

## Update Actions Projection

`toActions()` creates one entity-specific `setCustomField` action per field.
It must not silently emit `setCustomType`.

```ts
const actions = yield* destination.helpers.businessUnits.customFields
  .withFields({
    approvalStatus: "approved",
  })
  .set("hasStoreCredit", true)
  .unset("taxIdValidationReason")
  .toActions();
```

Expected SDK shape:

```ts
[
  { action: "setCustomField", name: "approvalStatus", value: "approved" },
  { action: "setCustomField", name: "hasStoreCredit", value: true },
  { action: "setCustomField", name: "taxIdValidationReason" },
]
```

`setCustomType` is intentionally excluded from this projection because setting
the custom type on an entity that already has custom fields can remove existing
field values. Initializing or replacing a custom type on an existing entity
should be an explicit operation, not a side effect of setting fields.

## Command Usage

Commands consume the helper outputs through existing command factories.

Create draft usage:

```ts
const custom = yield* destination.helpers.businessUnits.customFields
  .withFields({
    approvalStatus: "pending",
    hasStoreCredit: false,
  })
  .toDraft();

const command = destination.commands.businessUnits.createDraft({
  key: "buyer-org",
  name: "Buyer Org",
  unitType: "Company",
  custom,
});
```

Update usage:

```ts
const actions = yield* destination.helpers.businessUnits.customFields
  .withFields({
    approvalStatus: "approved",
    hasStoreCredit: true,
  })
  .toActions();

const command = destination.commands.businessUnits.update.withActions({
  selector: { kind: "key", key: "buyer-org" },
  version,
  actions,
}).command();
```

The chainable update builder remains useful for mixed SDK-shaped updates:

```ts
const customFieldActions = yield* destination.helpers.businessUnits.customFields
  .withFields({
    approvalStatus: "approved",
  })
  .toActions();

const command = destination.commands.businessUnits.update
  .withActions({
    selector: { kind: "key", key: "buyer-org" },
    version,
    actions: customFieldActions,
  })
  .action({ action: "setContactEmail", contactEmail: "buyer@example.com" })
  .command();
```

## Runtime Safety

The helper validates field bags at the helper boundary. Destination command
handlers should receive SDK-shaped values and execute them; they should not
perform hidden decoding or representation-changing schema work.

Validation failures should be `Schema.SchemaError` values returned from the
helper effect. Missing configuration, such as using
`helpers.businessUnits.customFields` without a configured business-unit custom
type, is a plugin configuration error and should fail loudly.

## Future Extensions

Potential later additions:

- generated custom field schemas from Commercetools custom type definitions
- reader helpers for source plugins and migration-side inspection
- locale-aware reader projections for localized strings and localized enums
- explicit custom type initialization or replacement commands for existing
  entities
- support for multiple custom types per entity kind when a real project needs it
