# Commercetools Custom Field Builders

Status: implemented for Business Units.

Custom field builders are pure helpers on the Commercetools destination
capability module. They validate a schema-backed field bag and project it to a
`CustomFieldsDraft` or Business Unit update actions. They do not call the SDK
until their output is passed to an effectful destination helper.

## Configure

Use plugin-local provision for the SDK dependency and configure the Business
Unit custom type once:

```ts
import { CommercetoolsDestination } from "@migrate-sdk/commercetools/destination";
import { Schema } from "effect";

const BusinessUnitCustomFields = Schema.Struct({
  approvalStatus: Schema.Literal("pending", "approved", "rejected"),
  hasStoreCredit: Schema.Boolean,
  taxId: Schema.optional(Schema.String),
});

const ct = CommercetoolsDestination.make({
  customTypes: {
    businessUnits: {
      fields: BusinessUnitCustomFields,
      typeKey: "repoBusinessUnit",
    },
  },
}).provide(commercetoolsSdkLayer);
```

Custom field schemas must be same-shape destination schemas. Source plugins own
source-native decoding; these helpers validate values already mapped for
Commercetools.

## Draft Fields

Use `toDraft()` when creating a Business Unit with custom fields:

```ts
const custom = yield* ct.businessUnits.customFields
  .withFields({
    approvalStatus: "pending",
    hasStoreCredit: false,
  })
  .set("taxId", "123456789")
  .toDraft();

const businessUnit = yield* ct.businessUnits.create({
  custom,
  key: "buyer-org",
  name: "Buyer Org",
  unitType: "Company",
});
```

The create helper records `commercetools.business-unit.created` after the SDK
request succeeds.

## Update Actions

Use `toActions()` when updating existing custom fields:

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

The update helper records `commercetools.business-unit.updated` with selector
context and stable resource facts. SDK failures record safe diagnostics instead
of success changes.
