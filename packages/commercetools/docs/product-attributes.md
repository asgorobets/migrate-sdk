# Commercetools Product Attribute Builders

Status: future state.

Audience: migration authors and maintainers shaping the
`@migrate-sdk/commercetools` package.

This document captures the intended future shape for schema-backed Product
Attribute helpers. It follows the same builder and projection model as
[Custom Fields API](./custom-fields.md), but Product Attributes need two helper
levels because Commercetools distinguishes Product-level Attributes from
Variant-level Attributes.

## Problem

Commercetools Product Types define Attributes at either the `Product` level or
the `Variant` level. Those two levels serialize to the same SDK `Attribute[]`
shape in drafts, but they do not share a schema and cannot be safely converted
from one to the other.

The current helper shape accepts one Product Type schema and returns draft
attributes directly:

```ts
const attributes = yield* destination.helpers.products.attributes("book", {
  format: "hardcover",
  isbn: "9780000000000",
});
```

That is useful as a narrow draft helper, but it does not model Product-level
Attributes, update actions, or unset semantics. The durable API should be a
builder that projects the same typed field bag into either draft attributes or
Product update actions.

## Configuration

The configured destination owns both Product-level and Variant-level Attribute
schemas for each Product Type.

```ts
const BookProductAttributes = Schema.Struct({
  searchable: Schema.Boolean,
  displayFamily: Schema.optional(Schema.String),
});

const BookVariantAttributes = Schema.Struct({
  format: Schema.Literal("hardcover", "paperback", "ebook"),
  isbn: Schema.String,
  pages: Schema.Number,
});

const destination = CommercetoolsDestinationPlugin.make({
  sdkLayer: CommercetoolsSdk.layerFromApiRoot({
    apiRoot,
    projectKey,
  }),
  productTypes: {
    book: {
      productAttributes: BookProductAttributes,
      attributes: BookVariantAttributes,
    },
  },
});
```

Both schemas must be same-shape destination schemas. They validate values the
pipeline already produced; they must not decode source-native representations.

## Helper Namespace

Product-level and Variant-level helpers should be separate siblings under the
products helper namespace:

```ts
destination.helpers.products.productAttributes("book");
destination.helpers.products.attributes("book");
```

`productAttributes(...)` is for Product-level Attributes and uses the configured
`productAttributes` schema. `attributes(...)` is for Variant-level Attributes
and uses the configured `attributes` schema. The shorter `attributes` name
matches the existing public helper and the common Commercetools language for
Variant Attributes.

If the name becomes ambiguous in practice, the package can add a
`variantAttributes(...)` alias without removing `attributes(...)`.

## Builder API

Both helpers expose the same builder shape:

```ts
const productAttributeBuilder = destination.helpers.products
  .productAttributes("book")
  .withFields({
    searchable: true,
  })
  .unset("displayFamily");

const variantAttributeBuilder = destination.helpers.products
  .attributes("book")
  .withFields({
    format: "hardcover",
    isbn: "9780000000000",
  })
  .set("pages", 320)
  .unset("isbn");
```

`withFields(...)` validates a partial field bag using the configured schema.
`set(name, value)` is typed by field name and field value. `unset(name)` records
removal for update actions and omits that field from draft output.

The builder exposes two projection names:

```ts
const draftAttributes = yield* builder.toDraft();
const actions = yield* builder.toActions(...);
```

The projection names stay the same for Product-level and Variant-level
Attributes. The action projection input differs by helper level.

## Draft Projection

`toDraft()` returns SDK `Attribute[]` for both helper levels.

Product-level draft usage:

```ts
const productAttributes = yield* destination.helpers.products
  .productAttributes("book")
  .withFields({
    searchable: true,
  })
  .toDraft();
```

Expected SDK shape:

```ts
[
  { name: "searchable", value: true },
]
```

Variant-level draft usage:

```ts
const variantAttributes = yield* destination.helpers.products
  .attributes("book")
  .withFields({
    format: "hardcover",
    isbn: "9780000000000",
    pages: 320,
  })
  .toDraft();
```

Expected SDK shape:

```ts
[
  { name: "format", value: "hardcover" },
  { name: "isbn", value: "9780000000000" },
  { name: "pages", value: 320 },
]
```

Fields marked with `unset(...)` are omitted from draft output.

## Update Actions Projection

`toActions(...)` is polymorphic by helper level.

Product-level Attribute actions do not need a variant selector:

```ts
const actions = yield* destination.helpers.products
  .productAttributes("book")
  .withFields({
    searchable: true,
  })
  .unset("displayFamily")
  .toActions({ staged: false });
```

Expected SDK shape:

```ts
[
  {
    action: "setProductAttribute",
    name: "searchable",
    value: true,
    staged: false,
  },
  {
    action: "setProductAttribute",
    name: "displayFamily",
    staged: false,
  },
]
```

Variant-level Attribute actions need either a variant selector or an explicit
all-variants target:

```ts
const actions = yield* destination.helpers.products
  .attributes("book")
  .withFields({
    format: "paperback",
  })
  .unset("isbn")
  .toActions({ sku: "book-sku" });
```

Expected SDK shape:

```ts
[
  {
    action: "setAttribute",
    sku: "book-sku",
    name: "format",
    value: "paperback",
  },
  {
    action: "setAttribute",
    sku: "book-sku",
    name: "isbn",
  },
]
```

For attributes with a `SameForAll` constraint, target all variants explicitly:

```ts
const actions = yield* destination.helpers.products
  .attributes("book")
  .withFields({
    format: "ebook",
  })
  .toActions({ allVariants: true, staged: false });
```

Expected SDK shape:

```ts
[
  {
    action: "setAttributeInAllVariants",
    name: "format",
    value: "ebook",
    staged: false,
  },
]
```

The helper should emit update actions without a `value` property for unset
Attributes. Commercetools treats an empty update-action value as removal.

## Command Usage

Draft usage:

```ts
const productAttributes = yield* destination.helpers.products
  .productAttributes("book")
  .withFields({
    searchable: true,
  })
  .toDraft();

const masterVariantAttributes = yield* destination.helpers.products
  .attributes("book")
  .withFields({
    format: "hardcover",
    isbn: "9780000000000",
    pages: 320,
  })
  .toDraft();

const command = destination.commands.products.createDraft({
  ...bookDraft,
  attributes: productAttributes,
  masterVariant: {
    sku: "book-sku",
    attributes: masterVariantAttributes,
  },
});
```

Update usage:

```ts
const productAttributeActions = yield* destination.helpers.products
  .productAttributes("book")
  .withFields({
    searchable: true,
  })
  .toActions();

const variantAttributeActions = yield* destination.helpers.products
  .attributes("book")
  .withFields({
    format: "paperback",
  })
  .toActions({ sku: "book-sku" });

const command = destination.commands.products.update.withActions({
  selector: { key: "book" },
  version,
  actions: [...productAttributeActions, ...variantAttributeActions],
}).command();
```

## Relationship To Current Helper

The current `destination.helpers.products.attributes(productTypeKey, input)`
shape can remain temporarily as a shorthand for Variant-level draft projection:

```ts
destination.helpers.products.attributes("book", input);
```

is equivalent to:

```ts
destination.helpers.products
  .attributes("book")
  .withFields(input)
  .toDraft();
```

The builder-first API should become the primary documented path because it
supports draft projection, update actions, and unset semantics with the same
typed field bag.

## Future Extensions

Potential later additions:

- generated Product Attribute schemas from Commercetools Product Type
  definitions
- compile-time checks that generated schemas match AttributeDefinition `level`
- reader helpers for source plugins and migration-side inspection
- optional `variantAttributes(...)` alias if `attributes(...)` is too ambiguous
