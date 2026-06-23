# Commercetools Custom Field Builders

Status: implemented for supported non-product destination resources.

Custom field builders are pure helpers on the Commercetools destination
Destination. They validate a schema-backed field bag and project it to a
`CustomFieldsDraft` or resource-specific update actions. They do not call the
SDK until their output is passed to an effectful destination helper.

## Configure

Use destination-local provision for the SDK dependency and configure each custom
type once:

```ts
import { CommercetoolsDestination } from "@migrate-sdk/commercetools/destination";
import { Schema } from "effect";

const BusinessUnitCustomFields = Schema.Struct({
  approvalStatus: Schema.Literal("pending", "approved", "rejected"),
  hasStoreCredit: Schema.Boolean,
  taxId: Schema.optional(Schema.String),
});

const CustomerCustomFields = Schema.Struct({
  acceptsMarketing: Schema.Boolean,
  externalId: Schema.optional(Schema.String),
  loyaltyTier: Schema.Literal("bronze", "silver", "gold"),
});

const InventoryCustomFields = Schema.Struct({
  fragile: Schema.Boolean,
  replenishmentZone: Schema.String,
});

const ProductSelectionCustomFields = Schema.Struct({
  featured: Schema.Boolean,
  season: Schema.String,
});

const StoreCustomFields = Schema.Struct({
  marketCode: Schema.String,
  pickupEnabled: Schema.Boolean,
});

const ct = CommercetoolsDestination.make({
  customTypes: {
    businessUnits: {
      fields: BusinessUnitCustomFields,
      typeKey: "repoBusinessUnit",
    },
    customers: {
      fields: CustomerCustomFields,
      typeKey: "repoCustomer",
    },
    inventory: {
      fields: InventoryCustomFields,
      typeKey: "repoInventoryEntry",
    },
    productSelections: {
      fields: ProductSelectionCustomFields,
      typeKey: "repoProductSelection",
    },
    stores: {
      fields: StoreCustomFields,
      typeKey: "repoStore",
    },
  },
}).provide(commercetoolsSdkLayer);
```

Custom field schemas must be same-shape destination schemas. Sources own
source-native decoding; these helpers validate values already mapped for
Commercetools.

## Draft Fields

Use `toDraft()` when creating a resource with custom fields:

```ts
const custom = yield* ct.customers.customFields
  .withFields({
    acceptsMarketing: true,
    loyaltyTier: "silver",
  })
  .set("externalId", "external-customer-1")
  .toDraft();

const customer = yield* ct.customers.create({
  custom,
  email: "buyer@example.com",
  key: "buyer-1",
});
```

```ts
const custom = yield* ct.productSelections.customFields
  .withFields({
    featured: true,
    season: "spring",
  })
  .toDraft();

const productSelection = yield* ct.productSelections.create({
  custom,
  key: "spring-selection",
  name: { "en-US": "Spring Selection" },
});
```

The create helper records the resource-specific created change after the SDK
request succeeds.

## Update Actions

Use `toActions()` when updating existing custom fields:

```ts
const actions = yield* ct.customers.customFields
  .withFields({
    acceptsMarketing: false,
    loyaltyTier: "gold",
  })
  .unset("externalId")
  .toActions();

yield* ct.customers.update({
  actions,
  selector: { kind: "key", key: "buyer-1" },
  version,
});
```

```ts
const actions = yield* ct.businessUnits.customFields
  .withFields({
    approvalStatus: "approved",
  })
  .set("hasStoreCredit", true)
  .unset("taxId")
  .toActions();

yield* ct.businessUnits.update({
  actions,
  selector: { kind: "key", key: "buyer-org" },
  version,
});
```

The same builder surface is available on `ct.inventory.customFields`,
`ct.productSelections.customFields`, and `ct.stores.customFields`. Products use
their product attribute helpers instead of this top-level custom-field helper.

The update helper records the resource-specific updated change with selector
context and stable resource facts. SDK failures record safe diagnostics instead
of success changes.
