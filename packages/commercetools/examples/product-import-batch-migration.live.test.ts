import { randomUUID } from "node:crypto";
import type { ProductDraftImport } from "@commercetools/importapi-sdk";
import type {
  Product,
  ProductDraft,
  ProductTypeDraft,
} from "@commercetools/platform-sdk";
import { describe, expect, it } from "@effect/vitest";
import { CommercetoolsImportSdk } from "@migrate-sdk/commercetools/import-api";
import { Effect } from "effect";
import {
  DestinationJournalExtensionId,
  type MigrationItemState,
} from "migrate-sdk";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import {
  bookCatalogImportProductCount,
  loadBookCatalogImportItems,
} from "./book-catalog-import-fixture.ts";
import {
  loadLiveCommercetoolsImportConfig,
  makeLiveApiRoot,
  makeLiveImportApiRoot,
} from "./live-commercetools.ts";
import {
  type CatalogProductImportSource,
  runCatalogProductImportMigration,
  toProductDraftImport,
} from "./product-import-batch-migration.ts";

interface ExecutableRequest<A> {
  readonly execute: () => Promise<{ readonly body: A }>;
}

const liveSourceBatchSize = 45;
const platformRequestConcurrency = 8;
const productDraftImportOperationExtensionId =
  DestinationJournalExtensionId.make(
    "commercetools.product-draft.import-operation@v1"
  );
const trailingSlashes = /\/+$/u;

const execute = async <A>(request: ExecutableRequest<A>): Promise<A> =>
  (await request.execute()).body;

const statusCodeFrom = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) {
    return;
  }

  const candidate = error as {
    readonly response?: {
      readonly status?: unknown;
      readonly statusCode?: unknown;
    };
    readonly status?: unknown;
    readonly statusCode?: unknown;
  };
  const statusCode =
    candidate.statusCode ??
    candidate.status ??
    candidate.response?.statusCode ??
    candidate.response?.status;

  return typeof statusCode === "number" ? statusCode : undefined;
};

const getIfExists = async <A>(
  request: ExecutableRequest<A>
): Promise<A | null> => {
  try {
    return await execute(request);
  } catch (error) {
    if (statusCodeFrom(error) === 404) {
      return null;
    }

    throw error;
  }
};

const mapWithConcurrency = async <A, B>(
  values: readonly A[],
  concurrency: number,
  use: (value: A) => Promise<B>
): Promise<B[]> => {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, values.length);
  const results: B[] = [];

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];

        if (value !== undefined) {
          results[index] = await use(value);
        }
      }
    })
  );

  return results;
};

const retainedLiveFixtureInstructions = (options: {
  readonly containerKey: string;
  readonly importApiUrl: string;
  readonly notes?: readonly string[];
  readonly productKeyPrefix: string;
  readonly productKeys: readonly string[];
  readonly productTypeKey: string;
  readonly projectKey: string;
}): string =>
  [
    "Live commercetools fixture cleanup is intentionally disabled.",
    "Inspect whatever this run created:",
    `  Project: ${options.projectKey}`,
    `  Import Container: ${options.containerKey}`,
    `  Product Type: ${options.productTypeKey}`,
    `  Product key prefix: ${options.productKeyPrefix}`,
    `  Expected Product keys (${options.productKeys.length}): ${
      options.productKeys.length <= 5
        ? options.productKeys.join(", ")
        : `${options.productKeys[0]} ... ${options.productKeys.at(-1)}`
    }`,
    `  Import Operations: ${options.importApiUrl.replace(trailingSlashes, "")}/${options.projectKey}/import-containers/${options.containerKey}/import-operations`,
    ...(options.notes ?? []).map((note) => `  Note: ${note}`),
    "Import Operations expire after 48 hours; the Import Container has a 30-day TTL.",
    "Products and the Product Type remain until you remove them manually.",
    "Manual cleanup order: Products, Product Type, then Import Container.",
  ].join("\n");

const printRetainedLiveFixtureInstructions = (instructions: string) =>
  Effect.sync(() => {
    process.stdout.write(`${instructions}\n`);
  });

const stateFor = (
  states: Iterable<MigrationItemState>,
  sourceIdentity: string
): MigrationItemState | undefined =>
  Array.from(states).find(
    (state) => state.sourceIdentity.encoded === sourceIdentity
  );

describe("product Import API Process Batch live", () => {
  it.live(
    "imports real products and durably settles every source item",
    () =>
      Effect.gen(function* () {
        const config = yield* loadLiveCommercetoolsImportConfig();
        const platformApiRoot = makeLiveApiRoot(config);
        const importApiRoot = makeLiveImportApiRoot(config);
        const platformProject = platformApiRoot.withProjectKey({
          projectKey: config.projectKey,
        });
        const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
        const prefix = `migrate-sdk-live-${suffix}`;
        const containerKey = `${prefix}-container`;
        const productTypeKey = `${prefix}-product-type`;
        const attributeNames = {
          format: `migrateSdkFormat${suffix}`,
          isbn: `migrateSdkIsbn${suffix}`,
          pages: `migrateSdkPages${suffix}`,
        } as const;
        const items = yield* Effect.promise(() =>
          loadBookCatalogImportItems({ prefix, productTypeKey })
        );
        expect(items).toHaveLength(bookCatalogImportProductCount);
        const productKeys = items.map((item) => item.identityKey);
        const productTypeDraft: ProductTypeDraft = {
          attributes: [
            {
              isRequired: false,
              label: { "en-US": "Format" },
              name: attributeNames.format,
              type: { name: "text" },
            },
            {
              isRequired: false,
              label: { "en-US": "ISBN" },
              name: attributeNames.isbn,
              type: { name: "text" },
            },
            {
              isRequired: false,
              label: { "en-US": "Pages" },
              name: attributeNames.pages,
              type: { name: "number" },
            },
          ],
          description: "Disposable Product Type for migrate-sdk live tests",
          key: productTypeKey,
          name: `Migrate SDK live ${suffix}`,
        };
        const toLiveProductDraftImport = (
          source: CatalogProductImportSource
        ): ProductDraftImport => {
          const draft = toProductDraftImport(source);

          return {
            ...draft,
            masterVariant: {
              attributes: [
                {
                  name: attributeNames.format,
                  type: "text",
                  value: source.format,
                },
                {
                  name: attributeNames.isbn,
                  type: "text",
                  value: source.isbn,
                },
                {
                  name: attributeNames.pages,
                  type: "number",
                  value: source.pages,
                },
              ],
              key: `${source.key}-master`,
              sku: source.sku,
            },
          };
        };
        const storeState = InMemoryMigrationStore.makeState();
        const inspectionInstructions = retainedLiveFixtureInstructions({
          containerKey,
          importApiUrl: config.importApiUrl,
          productKeyPrefix: prefix,
          productKeys,
          productTypeKey,
          projectKey: config.projectKey,
        });

        yield* Effect.promise(() =>
          execute(
            platformProject.productTypes().post({ body: productTypeDraft })
          )
        ).pipe(
          Effect.flatMap(() =>
            runCatalogProductImportMigration({
              containerKey,
              importSdkLayer: CommercetoolsImportSdk.layerFromApiRoot({
                apiRoot: importApiRoot,
                projectKey: config.projectKey,
              }),
              items,
              pollInterval: 1000,
              pollTimeout: "5 minutes",
              sourceBatchSize: liveSourceBatchSize,
              storeLayer: InMemoryMigrationStore.layer(storeState),
              toProductDraftImport: toLiveProductDraftImport,
            })
          ),
          Effect.flatMap((summary) =>
            Effect.gen(function* () {
              expect(summary.status).toBe("succeeded");
              expect(summary.definitions[0]?.counts).toMatchObject({
                failed: 0,
                migrated: items.length,
                skipped: 0,
              });

              const products = yield* Effect.promise(() =>
                mapWithConcurrency(
                  productKeys,
                  platformRequestConcurrency,
                  (key) =>
                    execute(platformProject.products().withKey({ key }).get())
                )
              );
              expect(products.map((product: Product) => product.key)).toEqual(
                productKeys
              );

              const states = [...storeState.itemStates.values()];
              expect(states).toHaveLength(items.length);
              expect(storeState.sourceCursorCommits).toHaveLength(1);
              expect(storeState.sourceCursors.size).toBe(0);

              for (const key of productKeys) {
                const state = stateFor(states, key);

                expect(state).toMatchObject({
                  journal: {
                    extensions: {
                      [productDraftImportOperationExtensionId]: {
                        containerKey,
                        operationId: expect.any(String),
                        resourceKey: key,
                        state: "imported",
                      },
                    },
                  },
                  status: "migrated",
                  trackingRecord: {
                    productKey: key,
                    productVersion: expect.any(Number),
                  },
                });
                expect(state?.journal?.process.entries).toEqual([
                  expect.objectContaining({
                    descriptorId: "commercetools.product-draft.imported",
                    kind: "change",
                    value: expect.objectContaining({
                      containerKey,
                      operationId: expect.any(String),
                      resourceKey: key,
                      state: "imported",
                    }),
                  }),
                ]);
              }
            })
          ),
          Effect.ensuring(
            printRetainedLiveFixtureInstructions(inspectionInstructions)
          )
        );
      }),
    600_000
  );

  it.live(
    "isolates a real validation failure and retries only the corrected source item",
    () =>
      Effect.gen(function* () {
        const config = yield* loadLiveCommercetoolsImportConfig();
        const platformApiRoot = makeLiveApiRoot(config);
        const importApiRoot = makeLiveImportApiRoot(config);
        const platformProject = platformApiRoot.withProjectKey({
          projectKey: config.projectKey,
        });
        const importProject = importApiRoot.withProjectKeyValue({
          projectKey: config.projectKey,
        });
        const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
        const prefix = `migrate-sdk-live-failure-${suffix}`;
        const containerKey = `${prefix}-container`;
        const productTypeKey = `${prefix}-product-type`;
        const blockerProductKey = `${prefix}-slug-blocker`;
        const blockerProductSlug = `${prefix}-reserved-slug`;
        const items = (yield* Effect.promise(() =>
          loadBookCatalogImportItems({ prefix, productTypeKey })
        )).slice(0, 3);
        expect(items).toHaveLength(3);
        const invalidItem = items[1];

        if (invalidItem === undefined) {
          return yield* Effect.die(
            "The live failure fixture must contain an invalid-product candidate"
          );
        }

        const invalidSourceKey = invalidItem.identityKey;
        const productKeys = items.map((item) => item.identityKey);
        const productTypeDraft: ProductTypeDraft = {
          attributes: [],
          description:
            "Disposable Product Type for migrate-sdk failure live tests",
          key: productTypeKey,
          name: `Migrate SDK failure live ${suffix}`,
        };
        const blockerProductDraft: ProductDraft = {
          key: blockerProductKey,
          masterVariant: {
            key: `${blockerProductKey}-master`,
            sku: `${blockerProductKey}-sku`,
          },
          name: { "en-US": "Migrate SDK reserved slug blocker" },
          productType: {
            key: productTypeKey,
            typeId: "product-type",
          },
          publish: false,
          slug: { "en-US": blockerProductSlug },
        };
        const toValidProductDraftImport = (
          source: CatalogProductImportSource
        ): ProductDraftImport => {
          const draft = toProductDraftImport(source);

          return {
            ...draft,
            masterVariant: {
              key: `${source.key}-master`,
              sku: source.sku,
            },
          };
        };
        const toInvalidProductDraftImport = (
          source: CatalogProductImportSource
        ): ProductDraftImport => {
          const draft = toValidProductDraftImport(source);

          return source.key === invalidSourceKey
            ? { ...draft, slug: { "en-US": blockerProductSlug } }
            : draft;
        };
        const storeState = InMemoryMigrationStore.makeState();
        const storeLayer = InMemoryMigrationStore.layer(storeState);
        const importSdkLayer = CommercetoolsImportSdk.layerFromApiRoot({
          apiRoot: importApiRoot,
          projectKey: config.projectKey,
        });
        const inspectionInstructions = retainedLiveFixtureInstructions({
          containerKey,
          importApiUrl: config.importApiUrl,
          notes: [
            `Product ${blockerProductKey} reserves slug ${blockerProductSlug}.`,
            `The first run deliberately reused that slug for source item ${invalidSourceKey}.`,
            "The second run corrected that Product Draft and should add one retry operation to the same container.",
          ],
          productKeyPrefix: prefix,
          productKeys: [blockerProductKey, ...productKeys],
          productTypeKey,
          projectKey: config.projectKey,
        });

        yield* Effect.promise(() =>
          execute(
            platformProject.productTypes().post({ body: productTypeDraft })
          )
        ).pipe(
          Effect.flatMap(() =>
            Effect.promise(() =>
              execute(
                platformProject.products().post({
                  body: blockerProductDraft,
                })
              )
            )
          ),
          Effect.flatMap(() =>
            Effect.gen(function* () {
              const first = yield* runCatalogProductImportMigration({
                containerKey,
                importSdkLayer,
                items,
                pollInterval: 500,
                pollTimeout: "2 minutes",
                sourceBatchSize: items.length,
                storeLayer,
                toProductDraftImport: toInvalidProductDraftImport,
              });

              expect(first.status).toBe("failed");
              expect(first.definitions[0]?.counts).toMatchObject({
                failed: 1,
                migrated: 2,
                skipped: 0,
              });

              const failedState = stateFor(
                storeState.itemStates.values(),
                invalidSourceKey
              );
              expect(failedState).toMatchObject({
                error: {
                  errorTag: "CommercetoolsImportOperationError",
                  kind: "process",
                  message:
                    "Commercetools Product Draft import failed in state validationFailed",
                },
                status: "failed",
              });
              const failedOperationJournal =
                failedState?.journal?.extensions?.[
                  productDraftImportOperationExtensionId
                ];
              expect(failedOperationJournal).toMatchObject({
                containerKey,
                issues: expect.arrayContaining([
                  expect.objectContaining({
                    code: expect.any(String),
                    message: expect.any(String),
                  }),
                ]),
                operationId: expect.any(String),
                resourceKey: invalidSourceKey,
                state: "validationFailed",
              });
              const operationId =
                typeof failedOperationJournal === "object" &&
                failedOperationJournal !== null &&
                "operationId" in failedOperationJournal &&
                typeof failedOperationJournal.operationId === "string"
                  ? failedOperationJournal.operationId
                  : undefined;

              if (operationId === undefined) {
                return yield* Effect.die(
                  "The failed Product Draft journal extension must retain its Import Operation id"
                );
              }

              const failedOperation = yield* Effect.promise(() =>
                execute(
                  importProject
                    .importOperations()
                    .withIdValue({ id: operationId })
                    .get()
                )
              );
              expect(failedOperation).toMatchObject({
                errors: expect.arrayContaining([
                  expect.objectContaining({
                    code: expect.any(String),
                    message: expect.any(String),
                  }),
                ]),
                id: operationId,
                importContainerKey: containerKey,
                resourceKey: invalidSourceKey,
                state: "validationFailed",
              });

              const migratedSiblingKeys = productKeys.filter(
                (key) => key !== invalidSourceKey
              );
              const siblings = yield* Effect.promise(() =>
                mapWithConcurrency(
                  migratedSiblingKeys,
                  platformRequestConcurrency,
                  (key) =>
                    execute(platformProject.products().withKey({ key }).get())
                )
              );
              expect(siblings.map((product: Product) => product.key)).toEqual(
                migratedSiblingKeys
              );
              expect(
                yield* Effect.promise(() =>
                  getIfExists(
                    platformProject
                      .products()
                      .withKey({ key: invalidSourceKey })
                      .get()
                  )
                )
              ).toBeNull();

              const second = yield* runCatalogProductImportMigration({
                containerKey,
                importSdkLayer,
                items,
                pollInterval: 500,
                pollTimeout: "2 minutes",
                sourceBatchSize: items.length,
                storeLayer,
                toProductDraftImport: toValidProductDraftImport,
              });

              expect(second.status).toBe("succeeded");
              expect(second.definitions[0]?.counts).toMatchObject({
                failed: 0,
                migrated: 1,
                skipped: 0,
              });
              const finalStates = [...storeState.itemStates.values()];
              expect(finalStates).toHaveLength(items.length);
              expect(
                finalStates.every((state) => state.status === "migrated")
              ).toBe(true);
              const retriedState = stateFor(finalStates, invalidSourceKey);
              expect(retriedState).toMatchObject({
                journal: {
                  extensions: {
                    [productDraftImportOperationExtensionId]: {
                      containerKey,
                      resourceKey: invalidSourceKey,
                      state: "imported",
                    },
                  },
                },
                status: "migrated",
                trackingRecord: {
                  productKey: invalidSourceKey,
                  productVersion: expect.any(Number),
                },
              });
              expect(retriedState?.journal?.process.entries).toEqual([
                expect.objectContaining({
                  descriptorId: "commercetools.product-draft.imported",
                  value: expect.objectContaining({
                    containerKey,
                    resourceKey: invalidSourceKey,
                  }),
                }),
              ]);
            })
          ),
          Effect.ensuring(
            printRetainedLiveFixtureInstructions(inspectionInstructions)
          )
        );
      }),
    300_000
  );
});
