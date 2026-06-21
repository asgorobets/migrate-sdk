# Commercetools Product Attribute Builders

Status: implemented.

Product attribute builders are pure helpers on the Commercetools destination
Destination. They validate schema-backed attribute bags and project them to SDK
`Attribute[]` drafts or Product update actions. They do not call Commercetools
and they do not record Destination Journal entries by themselves.

## Configure

Use destination-local provision for the effectful destination helpers, and pass
Product Type schemas when constructing the module:

```ts
import { CommercetoolsDestination } from "@migrate-sdk/commercetools/destination";
import { Schema } from "effect";

const BookProductAttributes = Schema.Struct({
  displayFamily: Schema.optional(Schema.String),
  searchable: Schema.Boolean,
});

const BookVariantAttributes = Schema.Struct({
  format: Schema.Literal("hardcover", "paperback", "ebook"),
  isbn: Schema.String,
  pages: Schema.Number,
});

const ct = CommercetoolsDestination.make({
  productTypes: {
    book: {
      attributes: BookVariantAttributes,
      productAttributes: BookProductAttributes,
    },
  },
}).provide(commercetoolsSdkLayer);
```

Schemas must be same-shape destination schemas. Sources own conversion
from source-native values; these helpers validate the destination-facing values
that the process already produced.

## Draft Attributes

`productAttributes(productTypeKey)` builds Product-level attributes.
`attributes(productTypeKey)` builds Variant-level attributes.

```ts
const productAttributes = yield* ct.products
  .productAttributes("book")
  .withAttributes({
    displayFamily: "software-architecture",
    searchable: true,
  })
  .toDraft();

const variantAttributes = yield* ct.products
  .attributes("book")
  .withAttributes({
    format: "paperback",
    isbn: "9780135957059",
    pages: 320,
  })
  .toDraft();

const product = yield* ct.products.create({
  attributes: productAttributes,
  key: source.item.key,
  masterVariant: {
    attributes: variantAttributes,
    sku: source.item.sku,
  },
  name: { "en-US": source.item.name },
  productType: { typeId: "product-type", key: "book" },
  slug: { "en-US": source.item.slug },
});
```

`ct.products.create(...)` records `commercetools.product.created` after the SDK
request succeeds. The descriptor stores stable facts such as id, key, version,
source identity, and small resource facts; it does not store the full Product
response.

## Update Actions

The builders can also create typed update actions that are passed directly to
the process helper:

```ts
const productAttributeActions = yield* ct.products
  .productAttributes("book")
  .withAttributes({ searchable: false })
  .toActions({ staged: false });

const variantAttributeActions = yield* ct.products
  .attributes("book")
  .withAttributes({ format: "hardcover" })
  .toActions({ sku: source.item.sku, staged: true });

yield* ct.products.update({
  actions: [...productAttributeActions, ...variantAttributeActions],
  selector: { kind: "key", key: source.item.key },
  version: source.item.version,
});
```

The update helper validates selectors and non-empty update actions before
building the SDK request. On SDK failure it records a safe diagnostic with the
operation, selector context, source identity, and safe status code when
available.
