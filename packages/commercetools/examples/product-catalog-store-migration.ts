import { fileURLToPath } from "node:url";
import type { Product, ProductData } from "@commercetools/platform-sdk";
import type { CommercetoolsSdkLayer } from "@migrate-sdk/commercetools";
import type { ProductDraftInput } from "@migrate-sdk/commercetools/destination";
import { CommercetoolsDestination } from "@migrate-sdk/commercetools/destination";
import { CommercetoolsMigrationStore } from "@migrate-sdk/commercetools/migration-store";
import {
  makeScriptedCommercetoolsSdk,
  makeScriptedCustomObjectRoutes,
  type ScriptedCommercetoolsSdkRequest,
  scriptedCommercetoolsSdkRoute,
} from "@migrate-sdk/commercetools/testing";
import {
  Console,
  Effect,
  type Layer as EffectLayer,
  Layer,
  Schema,
} from "effect";
import {
  InMemorySourcePlugin,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationExecution,
  type MigrationExecutionRunError,
  type MigrationItemState,
  type MigrationRunSummary,
  MigrationStore,
  type MigrationStoreError,
  SourceIdentity,
  type SourceItemInput,
  Tracking,
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

const isProductDraftRequest = (
  request: ProductCatalogStoreMigrationSdkRequest
): request is ProductCatalogStoreMigrationSdkRequest & {
  readonly body: ProductDraftInput;
} =>
  request.body !== undefined &&
  "productType" in request.body &&
  "name" in request.body &&
  "slug" in request.body;

const isCustomObjectRequest = (
  request: ProductCatalogStoreMigrationSdkRequest
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
  readonly sdkRequests: readonly ProductCatalogStoreMigrationSdkRequest[];
  readonly summary: MigrationRunSummary;
}

export type ProductCatalogStoreMigrationSdkRequest =
  ScriptedCommercetoolsSdkRequest;

export interface ProductCatalogStoreMigrationExampleOptions {
  readonly sdkLayer: CommercetoolsSdkLayer;
  readonly storeLayer: EffectLayer.Layer<MigrationStore, MigrationStoreError>;
}

const productResponse = (draft: ProductDraftInput): Product => {
  const data: ProductData = {
    attributes: draft.attributes ?? [],
    categories: [],
    masterVariant: {
      ...(draft.masterVariant?.attributes === undefined
        ? {}
        : { attributes: draft.masterVariant.attributes }),
      id: 1,
      ...(draft.masterVariant?.sku === undefined
        ? {}
        : { sku: draft.masterVariant.sku }),
    },
    name: draft.name,
    searchKeywords: {},
    slug: draft.slug,
    variants: [],
  };

  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "recording-product-id",
    ...(draft.key === undefined ? {} : { key: draft.key }),
    lastModifiedAt: "2026-01-01T00:00:00.000Z",
    masterData: {
      current: data,
      hasStagedChanges: true,
      published: false,
      staged: data,
    },
    productType: {
      id: draft.productType.id ?? draft.productType.key ?? "book",
      typeId: "product-type",
    },
    version: 1,
  };
};

export const runProductCatalogStoreMigration: (
  options: ProductCatalogStoreMigrationExampleOptions
) => Effect.Effect<
  ProductCatalogStoreMigrationExampleResult,
  MigrationStoreError | MigrationExecutionRunError
> = Effect.fn("runProductCatalogStoreMigration")(function* (options) {
  const ct = CommercetoolsDestination.make({
    productTypes: {
      book: {
        attributes: CatalogVariantAttributes,
        productAttributes: CatalogProductAttributes,
      },
    },
  }).provide(options.sdkLayer);

  const products = MigrationDefinition.make({
    id: catalogDefinitionId,
    source: InMemorySourcePlugin.make({
      identity: CatalogProductSourceIdentity,
      items: catalogProducts,
      sourceSchema: CatalogProductSource,
    }),
    store: options.storeLayer,
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
  const result = yield* execution.run({ all: true });
  const summary =
    result.kind === "completed"
      ? result.summary
      : yield* Effect.die("Inline example execution unexpectedly started");
  const itemStates = yield* listProductItemStates(options.storeLayer);

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
  MigrationStoreError | MigrationExecutionRunError
> = Effect.fn("runProductCatalogStoreMigrationExample")(function* () {
  const customObjects = makeScriptedCustomObjectRoutes();
  const sdk = makeScriptedCommercetoolsSdk({
    projectKey: "example-catalog-project",
    routes: [
      ...customObjects.routes,
      scriptedCommercetoolsSdkRoute("products.create").replyWith((request) =>
        productResponse(request.body as ProductDraftInput)
      ),
    ],
  });
  const result = yield* runProductCatalogStoreMigration({
    sdkLayer: sdk.layer,
    storeLayer: CommercetoolsMigrationStore.layer({
      ...catalogStoreOptions,
    }).pipe(Layer.provide(sdk.layer)),
  });
  const sdkRequests = sdk.requests;
  const productRequests = sdkRequests.filter(isProductDraftRequest);
  const customObjectRequests = sdkRequests.filter(isCustomObjectRequest);

  return {
    ...result,
    customObjectRequestCount: customObjectRequests.length,
    productDraft: productRequests[0]?.body ?? null,
    productRequestCount: productRequests.length,
    sdkRequests,
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
