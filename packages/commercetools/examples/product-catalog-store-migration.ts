import { fileURLToPath } from "node:url";
import { CommercetoolsSdk } from "@migrate-sdk/commercetools";
import type { ProductDraftInput } from "@migrate-sdk/commercetools/destination";
import { CommercetoolsDestination } from "@migrate-sdk/commercetools/destination";
import { CommercetoolsMigrationStore } from "@migrate-sdk/commercetools/migration-store";
import { Console, Effect, Schema } from "effect";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationExecution,
  type MigrationItemState,
  type MigrationRunSummary,
  MigrationStore,
  SourceIdentity,
  type SourceItemInput,
  Tracking,
  toMigrationDefinitionId,
} from "migrate-sdk";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import {
  loadLiveCommercetoolsConfig,
  makeLiveApiRoot,
} from "./live-commercetools.ts";

const catalogDefinitionId = "products";
export const catalogStoreOptions = {
  container: "migrate-sdk-examples",
  namespace: "product-catalog",
};

export const CatalogProductSource = Schema.Struct({
  displayFamily: Schema.optional(Schema.String),
  format: Schema.Literals(["hardcover", "paperback"]),
  isbn: Schema.NonEmptyString,
  key: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  pages: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  productTypeKey: Schema.NonEmptyString,
  searchable: Schema.Boolean,
  sku: Schema.NonEmptyString,
  slug: Schema.NonEmptyString,
});
type CatalogProductSource = typeof CatalogProductSource.Type;

export const CatalogProductSourceIdentity = SourceIdentity.make({
  id: "commercetools-catalog-product@v1",
  schema: SourceIdentity.key("key", Schema.NonEmptyString),
});

export const CatalogProductTrackingRecord = Tracking.record({
  id: "commercetools-catalog-product-tracking@v1",
  schema: Schema.Struct({
    productId: Schema.String,
    productKey: Schema.String,
  }),
});

export const CatalogProductAttributes = Schema.Struct({
  displayFamily: Schema.optional(Schema.String),
  searchable: Schema.Boolean,
});

export const CatalogVariantAttributes = Schema.Struct({
  format: Schema.Literals(["hardcover", "paperback"]),
  isbn: Schema.NonEmptyString,
  pages: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
});

const catalogProducts: readonly SourceItemInput<CatalogProductSource>[] = [
  {
    identityKey: "effectful-architecture",
    version: "source-version-1",
    item: {
      displayFamily: "software-architecture",
      format: "paperback",
      isbn: "9780135957059",
      key: "effectful-architecture",
      name: "Effectful Architecture",
      pages: 320,
      productTypeKey: "book",
      searchable: true,
      sku: "effectful-architecture-paperback",
      slug: "effectful-architecture",
    },
  },
];

export interface ProductCatalogStoreMigrationExampleResult {
  readonly itemStates: readonly MigrationItemState[];
  readonly summary: MigrationRunSummary;
}

export const runProductCatalogStoreMigration = Effect.fn(
  "runProductCatalogStoreMigration"
)(function* () {
  const config = yield* loadLiveCommercetoolsConfig();
  const apiRoot = makeLiveApiRoot(config);
  const sdkLayer = CommercetoolsSdk.layerFromApiRoot({
    apiRoot,
    projectKey: config.projectKey,
  });
  const storeLayer = CommercetoolsMigrationStore.layerFromApiRoot({
    apiRoot,
    ...catalogStoreOptions,
    projectKey: config.projectKey,
  });
  const ct = CommercetoolsDestination.make({
    productTypes: {
      book: {
        attributes: CatalogVariantAttributes,
        productAttributes: CatalogProductAttributes,
      },
    },
  }).provide(sdkLayer);

  const products = MigrationDefinition.make({
    id: catalogDefinitionId,
    source: InMemorySource.make({
      identity: CatalogProductSourceIdentity,
      items: catalogProducts,
      sourceSchema: CatalogProductSource,
    }),
    store: storeLayer,
    tracking: CatalogProductTrackingRecord,
    process: Effect.fn("products.process")(function* (source) {
      const productAttributes = yield* ct.products
        .productAttributes("book")
        .withAttributes({
          displayFamily: source.item.displayFamily,
          searchable: source.item.searchable,
        })
        .toDraft();
      const variantAttributes = yield* ct.products
        .attributes("book")
        .withAttributes({
          format: source.item.format,
          isbn: source.item.isbn,
          pages: source.item.pages,
        })
        .toDraft();
      const draft = {
        attributes: productAttributes,
        key: source.item.key,
        masterVariant: {
          attributes: variantAttributes,
          sku: source.item.sku,
        },
        name: {
          "en-US": source.item.name,
        },
        productType: {
          key: source.item.productTypeKey,
          typeId: "product-type",
        },
        slug: {
          "en-US": source.item.slug,
        },
      } satisfies ProductDraftInput;
      const product = yield* ct.products.create(draft);

      yield* Tracking.setRecord({
        productId: product.id,
        productKey: product.key ?? source.item.key,
      });
    }),
  });

  const registry = MigrationDefinitionRegistry.make({
    definitions: [products] as const,
  });
  const execution = MigrationExecution.make({ registry });
  const start = yield* execution.run({ all: true });
  let summary: MigrationRunSummary;

  if (start.kind === "completed") {
    summary = start.summary;
  } else if (start.handle === undefined) {
    return yield* Effect.die("Inline example execution detached unexpectedly");
  } else {
    summary = yield* Effect.flatMap(start.handle.wait, (result) =>
      result.kind === "finished"
        ? Effect.succeed(result.summary)
        : Effect.die(`Inline example execution ended as ${result.kind}`)
    );
  }

  const itemStates = yield* Effect.flatMap(MigrationStore, (store) =>
    store.listItemStates(toMigrationDefinitionId(catalogDefinitionId))
  ).pipe(Effect.provide(storeLayer));

  return {
    itemStates,
    summary,
  } satisfies ProductCatalogStoreMigrationExampleResult;
});

export const formatProductCatalogStoreMigrationExampleResult = (
  result: ProductCatalogStoreMigrationExampleResult
): string =>
  [
    "Commercetools Product Catalog Store Migration Example",
    `status: ${result.summary.status}`,
    `definitions: ${result.summary.definitions.length}`,
    `products migrated: ${result.summary.definitions[0]?.counts.migrated ?? 0}`,
    `persisted item states: ${result.itemStates.length}`,
  ].join("\n");

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  Effect.runPromise(
    runProductCatalogStoreMigration().pipe(
      Effect.map(formatProductCatalogStoreMigrationExampleResult),
      Effect.flatMap(Console.log)
    )
  ).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
