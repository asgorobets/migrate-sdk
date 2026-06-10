import { fileURLToPath } from "node:url";
import type { ApiRoot } from "@commercetools/platform-sdk";
import { CommercetoolsSdk } from "@migrate-sdk/commercetools";
import type { ProductDraftInput } from "@migrate-sdk/commercetools/destination";
import { CommercetoolsDestinationPlugin } from "@migrate-sdk/commercetools/destination";
import { CommercetoolsMigrationStore } from "@migrate-sdk/commercetools/migration-store";
import {
  makeRecordingCommercetoolsApiRoot,
  type RecordedCommercetoolsRequest,
} from "@migrate-sdk/commercetools/testing";
import { Console, Effect, Layer, Schema } from "effect";
import {
  defineMigration,
  InMemorySourcePlugin,
  type MigrationItemState,
  type MigrationRunSummary,
  MigrationStore,
  type MigrationStoreError,
  type RunMigrationError,
  runMigrations,
  type SourceItemInput,
  toMigrationDefinitionId,
} from "migrate-sdk";

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
    identity: "book:effectful-architecture",
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

const isProductDraftRequest = (
  request: RecordedCommercetoolsRequest
): request is RecordedCommercetoolsRequest & {
  readonly body: ProductDraftInput;
} =>
  request.body !== undefined &&
  "productType" in request.body &&
  "name" in request.body &&
  "slug" in request.body;

const isCustomObjectRequest = (
  request: RecordedCommercetoolsRequest
): boolean => request.uriTemplate?.includes("custom-objects") === true;

const listProductItemStates = (
  storeLayer: Layer.Layer<MigrationStore, MigrationStoreError>
) =>
  Effect.gen(function* () {
    const store = yield* MigrationStore;

    return yield* store.listItemStates(
      toMigrationDefinitionId(catalogDefinitionId)
    );
  }).pipe(Effect.provide(storeLayer));

export interface ProductCatalogStoreMigrationExampleResult {
  readonly customObjectRequestCount: number;
  readonly itemStates: readonly MigrationItemState[];
  readonly productDraft: ProductDraftInput | null;
  readonly productRequestCount: number;
  readonly sdkRequests: readonly RecordedCommercetoolsRequest[];
  readonly summary: MigrationRunSummary;
}

export interface ProductCatalogStoreMigrationExampleOptions {
  readonly apiRoot: ApiRoot;
  readonly projectKey: string;
}

export const runProductCatalogStoreMigration: (
  options: ProductCatalogStoreMigrationExampleOptions
) => Effect.Effect<
  ProductCatalogStoreMigrationExampleResult,
  MigrationStoreError | RunMigrationError
> = Effect.fn("runProductCatalogStoreMigration")(function* (options) {
  const sdkLayer = CommercetoolsSdk.layerFromApiRoot({
    apiRoot: options.apiRoot,
    projectKey: options.projectKey,
  });
  const catalogStoreLayer = CommercetoolsMigrationStore.layer(
    catalogStoreOptions
  ).pipe(Layer.provide(sdkLayer));
  const destination = CommercetoolsDestinationPlugin.make({
    productTypes: {
      book: {
        attributes: CatalogVariantAttributes,
        productAttributes: CatalogProductAttributes,
      },
    },
    sdkLayer,
  });

  const products = defineMigration({
    id: catalogDefinitionId,
    source: InMemorySourcePlugin.make({
      items: catalogProducts,
      sourceSchema: CatalogProductSource,
    }),
    destination,
    store: catalogStoreLayer,
    pipeline: Effect.fn("products.pipeline")(function* (source) {
      const productAttributes = yield* destination.helpers.products
        .productAttributes("book")
        .withAttributes({
          displayFamily: source.item.displayFamily,
          searchable: source.item.searchable,
        })
        .toDraft();
      const variantAttributes = yield* destination.helpers.products
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

      return [destination.commands.products.createDraft(draft)];
    }),
  });

  const summary = yield* runMigrations({
    definitions: [products],
  });
  const itemStates = yield* listProductItemStates(catalogStoreLayer);

  return {
    customObjectRequestCount: 0,
    itemStates,
    productDraft: null,
    productRequestCount: 0,
    sdkRequests: [],
    summary,
  } satisfies ProductCatalogStoreMigrationExampleResult;
});

export const runProductCatalogStoreMigrationExample: () => Effect.Effect<
  ProductCatalogStoreMigrationExampleResult,
  MigrationStoreError | RunMigrationError
> = Effect.fn("runProductCatalogStoreMigrationExample")(function* () {
  const recording = makeRecordingCommercetoolsApiRoot();
  const result = yield* runProductCatalogStoreMigration({
    apiRoot: recording.apiRoot,
    projectKey: "example-catalog-project",
  });
  const productRequests = recording.requests.filter(isProductDraftRequest);
  const customObjectRequests = recording.requests.filter(isCustomObjectRequest);

  return {
    ...result,
    customObjectRequestCount: customObjectRequests.length,
    productDraft: productRequests[0]?.body ?? null,
    productRequestCount: productRequests.length,
    sdkRequests: recording.requests,
  };
});

export const formatProductCatalogStoreMigrationExampleResult = (
  result: ProductCatalogStoreMigrationExampleResult
): string =>
  [
    "Commercetools Product Catalog Store Migration Example",
    `status: ${result.summary.status}`,
    `definitions: ${result.summary.definitions.length}`,
    `products created: ${result.productRequestCount}`,
    `persisted item states: ${result.itemStates.length}`,
    `custom object requests: ${result.customObjectRequestCount}`,
  ].join("\n");

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  Effect.runPromise(
    runProductCatalogStoreMigrationExample().pipe(
      Effect.map(formatProductCatalogStoreMigrationExampleResult),
      Effect.flatMap(Console.log)
    )
  ).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
