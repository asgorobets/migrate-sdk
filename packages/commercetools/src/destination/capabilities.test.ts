import type {
  BusinessUnit,
  BusinessUnitDraft,
  Customer,
  CustomerDraft,
  CustomerSignInResult,
  InventoryEntry,
  InventoryEntryDraft,
  Product,
  ProductData,
  ProductDraft,
  ProductSelection,
  ProductSelectionDraft,
  Store,
  StoreDraft,
} from "@commercetools/platform-sdk";
import { describe, expect, it } from "@effect/vitest";
import type { CommercetoolsSdk } from "@migrate-sdk/commercetools";
import {
  CommercetoolsDestination,
  type CommercetoolsResourceChange,
} from "@migrate-sdk/commercetools/destination";
import {
  makeScriptedCommercetoolsSdk,
  scriptedCommercetoolsSdkRoute,
} from "@migrate-sdk/commercetools/testing";
import { Effect, Schema } from "effect";
import {
  type DestinationJournalChangeEntry,
  type DestinationPluginError,
  InMemoryMigrationStore,
  InMemorySourcePlugin,
  MigrationDefinition,
  rollbackMigration,
  runMigrations,
  SourceIdentity,
  Tracking,
} from "migrate-sdk";
import { expectTypeOf } from "vitest";

const ResourceSource = Schema.Struct({
  key: Schema.String,
});

const ResourceSourceIdentity = SourceIdentity.make({
  id: "commercetools-destination-source@v1",
  schema: SourceIdentity.key("key", Schema.String),
});

const ResourceTrackingRecord = Tracking.record({
  id: "commercetools-destination-tracking@v1",
  schema: Schema.Struct({
    productId: Schema.String,
    storeId: Schema.String,
  }),
});

const RepoBusinessUnitCustomFields = Schema.Struct({
  approvalStatus: Schema.Literals(["pending", "approved", "rejected"]),
  hasStoreCredit: Schema.Boolean,
  taxId: Schema.optional(Schema.String),
});

const ProductSelectionDraftForTypes = {
  key: "typed-selection",
  name: {
    "en-US": "Typed selection",
  },
} satisfies ProductSelectionDraft;
const CapabilityModuleForTypes = CommercetoolsDestination.make();
const ProvidedCapabilityModuleForTypes = CapabilityModuleForTypes.provide(
  makeScriptedCommercetoolsSdk({
    projectKey: "type-project",
    routes: [],
  }).layer
);

expectTypeOf(
  CapabilityModuleForTypes.productSelections.create(
    ProductSelectionDraftForTypes
  )
).toEqualTypeOf<
  Effect.Effect<
    ProductSelection,
    DestinationPluginError | Schema.SchemaError,
    CommercetoolsSdk | Tracking
  >
>();
expectTypeOf(
  ProvidedCapabilityModuleForTypes.productSelections.create(
    ProductSelectionDraftForTypes
  )
).toEqualTypeOf<
  Effect.Effect<
    ProductSelection,
    DestinationPluginError | Schema.SchemaError,
    Tracking
  >
>();

const dates = {
  createdAt: "2026-01-01T00:00:00.000Z",
  lastModifiedAt: "2026-01-01T00:00:00.000Z",
};

const productResponse = (draft: ProductDraft, version = 1): Product => {
  const data: ProductData = {
    attributes: draft.attributes ?? [],
    categories: [],
    masterVariant: {
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
    ...dates,
    id: `product:${draft.key ?? "unknown"}`,
    ...(draft.key === undefined ? {} : { key: draft.key }),
    masterData: {
      current: data,
      hasStagedChanges: true,
      published: false,
      staged: data,
    },
    productType: {
      id: draft.productType.id ?? draft.productType.key ?? "product-type",
      typeId: "product-type",
    },
    version,
  } as Product;
};

const inventoryEntryResponse = (
  draft: InventoryEntryDraft,
  version = 1
): InventoryEntry =>
  ({
    ...dates,
    id: `inventory:${draft.sku}`,
    ...(draft.key === undefined ? {} : { key: draft.key }),
    quantityOnStock: draft.quantityOnStock,
    sku: draft.sku,
    version,
  }) as InventoryEntry;

const customerResponse = (draft: CustomerDraft, version = 1): Customer =>
  ({
    ...dates,
    email: draft.email,
    id: `customer:${draft.key ?? draft.email}`,
    ...(draft.key === undefined ? {} : { key: draft.key }),
    version,
  }) as Customer;

const customerSignInResult = (
  draft: CustomerDraft,
  version = 1
): CustomerSignInResult =>
  ({
    customer: customerResponse(draft, version),
  }) as CustomerSignInResult;

const businessUnitResponse = (
  draft: BusinessUnitDraft,
  version = 1
): BusinessUnit =>
  ({
    ...dates,
    addresses: [],
    associates: [],
    id: `business-unit:${draft.key}`,
    key: draft.key,
    name: draft.name,
    status: "Active",
    stores: [],
    unitType: draft.unitType,
    version,
  }) as unknown as BusinessUnit;

const storeResponse = (draft: StoreDraft, version = 1): Store =>
  ({
    ...dates,
    id: `store:${draft.key}`,
    key: draft.key,
    productSelections: [],
    version,
  }) as unknown as Store;

const productSelectionResponse = (
  draft: ProductSelectionDraft,
  version = 1
): ProductSelection =>
  ({
    ...dates,
    id: `product-selection:${draft.key}`,
    ...(draft.key === undefined ? {} : { key: draft.key }),
    mode: draft.mode ?? "Individual",
    name: draft.name,
    productCount: 0,
    version,
  }) as ProductSelection;

interface ProcessFailedAfterDestination {
  readonly _tag: "ProcessFailedAfterDestination";
  readonly message: string;
}

const makeOneItemSource = () =>
  InMemorySourcePlugin.make({
    identity: ResourceSourceIdentity,
    items: [
      {
        identityKey: "source-1",
        item: {
          key: "source-1",
        },
        version: "source-version-1",
      },
    ],
    sourceSchema: ResourceSource,
  });

const storeItem = (
  storeState: ReturnType<typeof InMemoryMigrationStore.makeState>
) =>
  storeState.itemStates.get(
    InMemoryMigrationStore.itemStateKey("resource-helpers", "source-1")
  );

const allResourceRoutes = () => [
  scriptedCommercetoolsSdkRoute("products.create").replyWith((request) =>
    productResponse(request.body as ProductDraft)
  ),
  scriptedCommercetoolsSdkRoute("products.update").reply(
    productResponse(
      {
        key: "product-1",
        name: {
          "en-US": "Product",
        },
        productType: {
          key: "book",
          typeId: "product-type",
        },
        slug: {
          "en-US": "product",
        },
      } satisfies ProductDraft,
      2
    )
  ),
  scriptedCommercetoolsSdkRoute("inventory.create").replyWith((request) =>
    inventoryEntryResponse(request.body as InventoryEntryDraft)
  ),
  scriptedCommercetoolsSdkRoute("inventory.update").reply(
    inventoryEntryResponse(
      {
        quantityOnStock: 5,
        sku: "sku-1",
      },
      2
    )
  ),
  scriptedCommercetoolsSdkRoute("customers.create").replyWith((request) =>
    customerSignInResult(request.body as CustomerDraft)
  ),
  scriptedCommercetoolsSdkRoute("customers.update").reply(
    customerResponse(
      {
        email: "customer@example.com",
        key: "customer-1",
      },
      2
    )
  ),
  scriptedCommercetoolsSdkRoute("businessUnits.create").replyWith((request) =>
    businessUnitResponse(request.body as BusinessUnitDraft)
  ),
  scriptedCommercetoolsSdkRoute("businessUnits.update").reply(
    businessUnitResponse(
      {
        key: "business-unit-1",
        name: "Business Unit",
        unitType: "Company",
      },
      2
    )
  ),
  scriptedCommercetoolsSdkRoute("stores.create").replyWith((request) =>
    storeResponse(request.body as StoreDraft)
  ),
  scriptedCommercetoolsSdkRoute("stores.update").reply(
    storeResponse({ key: "store-1" }, 2)
  ),
  scriptedCommercetoolsSdkRoute("stores.assignProductSelection").reply(
    storeResponse({ key: "store-1" }, 3)
  ),
  scriptedCommercetoolsSdkRoute("stores.removeProductSelection").reply(
    storeResponse({ key: "store-1" }, 4)
  ),
  scriptedCommercetoolsSdkRoute("productSelections.create").replyWith(
    (request) => productSelectionResponse(request.body as ProductSelectionDraft)
  ),
  scriptedCommercetoolsSdkRoute("productSelections.update").reply(
    productSelectionResponse(
      {
        key: "product-selection-1",
        name: {
          "en-US": "Product Selection",
        },
      },
      2
    )
  ),
];

describe("CommercetoolsDestination capability module", () => {
  it.effect(
    "runs every resource helper inside process and records ordered destination changes",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const sdk = makeScriptedCommercetoolsSdk({
          projectKey: "test-project",
          routes: allResourceRoutes(),
        });
        const ct = CommercetoolsDestination.make({
          customTypes: {
            businessUnits: {
              fields: RepoBusinessUnitCustomFields,
              typeKey: "repoBusinessUnit",
            },
          },
        }).provide(sdk.layer);

        const definition = MigrationDefinition.make({
          id: "resource-helpers",
          process: (source) =>
            Effect.gen(function* () {
              const product = yield* ct.products.create({
                key: "product-1",
                name: {
                  "en-US": "Product",
                },
                productType: {
                  key: "book",
                  typeId: "product-type",
                },
                slug: {
                  "en-US": "product",
                },
              });
              yield* ct.products.update({
                actions: [{ action: "publish" }],
                selector: {
                  key: product.key ?? "product-1",
                  kind: "key",
                },
                version: product.version,
              });
              yield* ct.inventory.create({
                quantityOnStock: 5,
                sku: "sku-1",
              });
              yield* ct.inventory.update({
                actions: [{ action: "changeQuantity", quantity: 6 }],
                selector: {
                  key: "inventory-key-1",
                  kind: "key",
                },
                version: 1,
              });
              yield* ct.customers.create({
                email: "customer@example.com",
                key: "customer-1",
              });
              yield* ct.customers.update({
                actions: [{ action: "setFirstName", firstName: "Ada" }],
                selector: {
                  key: "customer-1",
                  kind: "key",
                },
                version: 1,
              });
              yield* ct.businessUnits.create({
                key: "business-unit-1",
                name: "Business Unit",
                unitType: "Company",
              });
              const businessUnitCustomFieldActions =
                yield* ct.businessUnits.customFields
                  .withFields({
                    approvalStatus: "pending",
                    hasStoreCredit: false,
                  })
                  .set("taxId", "123456789")
                  .toActions();
              yield* ct.businessUnits.update({
                actions: businessUnitCustomFieldActions,
                selector: {
                  key: "business-unit-1",
                  kind: "key",
                },
                version: 1,
              });
              const store = yield* ct.stores.create({ key: "store-1" });
              yield* ct.stores.update({
                actions: [{ action: "setName", name: { "en-US": "Store" } }],
                selector: {
                  key: store.key,
                  kind: "key",
                },
                version: store.version,
              });
              yield* ct.stores.assignProductSelection({
                productSelection: {
                  key: "product-selection-1",
                  typeId: "product-selection",
                },
                selector: {
                  key: store.key,
                  kind: "key",
                },
                version: 2,
              });
              yield* ct.stores.removeProductSelection({
                productSelection: {
                  key: "product-selection-1",
                  typeId: "product-selection",
                },
                selector: {
                  key: store.key,
                  kind: "key",
                },
                version: 3,
              });
              yield* ct.productSelections.create({
                key: "product-selection-1",
                name: {
                  "en-US": "Product Selection",
                },
              });
              yield* ct.productSelections.update({
                actions: [
                  {
                    action: "changeName",
                    name: {
                      "en-US": "Product Selection",
                    },
                  },
                ],
                selector: {
                  key: "product-selection-1",
                  kind: "key",
                },
                version: 1,
              });
              yield* Tracking.setRecord({
                productId: product.id,
                storeId: store.id,
              });

              expect(source.item.key).toBe("source-1");
            }),
          source: makeOneItemSource(),
          store: InMemoryMigrationStore.layer(storeState),
          tracking: ResourceTrackingRecord,
        });

        const summary = yield* runMigrations({ definitions: [definition] });
        const itemState = storeItem(storeState);
        const journalEntries =
          itemState?.status === "migrated"
            ? (itemState.journal?.process.entries ?? [])
            : [];
        const changeEntries = journalEntries.filter(
          (
            entry
          ): entry is DestinationJournalChangeEntry<CommercetoolsResourceChange> =>
            entry.kind === "change"
        );
        const rawAssignedEntry = journalEntries[10];

        if (rawAssignedEntry === undefined) {
          throw new Error("Expected store product selection assignment entry");
        }

        const assignedEntry = yield* ct.stores.changes.productSelectionAssigned
          .decode(rawAssignedEntry)
          .pipe(Effect.map((entry) => entry.value));

        expect(summary.status).toBe("succeeded");
        expect(sdk.requests.map((request) => request.operation)).toEqual([
          "products.create",
          "products.update",
          "inventory.create",
          "inventory.update",
          "customers.create",
          "customers.update",
          "businessUnits.create",
          "businessUnits.update",
          "stores.create",
          "stores.update",
          "stores.assignProductSelection",
          "stores.removeProductSelection",
          "productSelections.create",
          "productSelections.update",
        ]);
        expect(sdk.requests).toMatchObject([
          {
            body: {
              key: "product-1",
              name: {
                "en-US": "Product",
              },
              productType: {
                key: "book",
                typeId: "product-type",
              },
              publish: false,
              slug: {
                "en-US": "product",
              },
            },
            method: "POST",
            operation: "products.create",
          },
          {
            body: {
              actions: [{ action: "publish" }],
              version: 1,
            },
            method: "POST",
            operation: "products.update",
            pathVariables: {
              key: "product-1",
            },
          },
          {
            body: {
              quantityOnStock: 5,
              sku: "sku-1",
            },
            method: "POST",
            operation: "inventory.create",
          },
          {
            body: {
              actions: [{ action: "changeQuantity", quantity: 6 }],
              version: 1,
            },
            method: "POST",
            operation: "inventory.update",
            pathVariables: {
              key: "inventory-key-1",
            },
          },
          {
            body: {
              email: "customer@example.com",
              key: "customer-1",
            },
            method: "POST",
            operation: "customers.create",
          },
          {
            body: {
              actions: [{ action: "setFirstName", firstName: "Ada" }],
              version: 1,
            },
            method: "POST",
            operation: "customers.update",
            pathVariables: {
              key: "customer-1",
            },
          },
          {
            body: {
              key: "business-unit-1",
              name: "Business Unit",
              unitType: "Company",
            },
            method: "POST",
            operation: "businessUnits.create",
          },
          {
            body: {
              actions: [
                {
                  action: "setCustomField",
                  name: "approvalStatus",
                  value: "pending",
                },
                {
                  action: "setCustomField",
                  name: "hasStoreCredit",
                  value: false,
                },
                {
                  action: "setCustomField",
                  name: "taxId",
                  value: "123456789",
                },
              ],
              version: 1,
            },
            method: "POST",
            operation: "businessUnits.update",
            pathVariables: {
              key: "business-unit-1",
            },
          },
          {
            body: {
              key: "store-1",
            },
            method: "POST",
            operation: "stores.create",
          },
          {
            body: {
              actions: [{ action: "setName", name: { "en-US": "Store" } }],
              version: 1,
            },
            method: "POST",
            operation: "stores.update",
            pathVariables: {
              key: "store-1",
            },
          },
          {
            body: {
              actions: [
                {
                  action: "addProductSelection",
                  productSelection: {
                    key: "product-selection-1",
                    typeId: "product-selection",
                  },
                },
              ],
              version: 2,
            },
            method: "POST",
            operation: "stores.assignProductSelection",
            pathVariables: {
              key: "store-1",
            },
          },
          {
            body: {
              actions: [
                {
                  action: "removeProductSelection",
                  productSelection: {
                    key: "product-selection-1",
                    typeId: "product-selection",
                  },
                },
              ],
              version: 3,
            },
            method: "POST",
            operation: "stores.removeProductSelection",
            pathVariables: {
              key: "store-1",
            },
          },
          {
            body: {
              key: "product-selection-1",
              name: {
                "en-US": "Product Selection",
              },
            },
            method: "POST",
            operation: "productSelections.create",
          },
          {
            body: {
              actions: [
                {
                  action: "changeName",
                  name: {
                    "en-US": "Product Selection",
                  },
                },
              ],
              version: 1,
            },
            method: "POST",
            operation: "productSelections.update",
            pathVariables: {
              key: "product-selection-1",
            },
          },
        ]);
        expect(itemState).toEqual(
          expect.objectContaining({
            status: "migrated",
            trackingRecord: {
              productId: "product:product-1",
              storeId: "store:store-1",
            },
          })
        );
        expect(journalEntries.map((entry) => entry.sequence)).toEqual([
          0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
        ]);
        expect(changeEntries).toHaveLength(journalEntries.length);
        expect(changeEntries.map((entry) => entry.descriptorId)).toEqual([
          ct.products.changes.created.id,
          ct.products.changes.updated.id,
          ct.inventory.changes.created.id,
          ct.inventory.changes.updated.id,
          ct.customers.changes.created.id,
          ct.customers.changes.updated.id,
          ct.businessUnits.changes.created.id,
          ct.businessUnits.changes.updated.id,
          ct.stores.changes.created.id,
          ct.stores.changes.updated.id,
          ct.stores.changes.productSelectionAssigned.id,
          ct.stores.changes.productSelectionRemoved.id,
          ct.productSelections.changes.created.id,
          ct.productSelections.changes.updated.id,
        ]);
        expect(assignedEntry).toMatchObject({
          facts: {
            productSelectionKey: "product-selection-1",
          },
          resourceKey: "store-1",
          resourceType: "store",
          selector: {
            key: "store-1",
            kind: "key",
          },
          sourceIdentity: "source-1",
        });
        expect(JSON.stringify(journalEntries)).not.toContain("masterData");
        expect(JSON.stringify(journalEntries)).not.toContain(
          "customer@example.com"
        );
      })
  );

  it.effect(
    "preserves repeated helper changes in order when a later process step fails",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const sdk = makeScriptedCommercetoolsSdk({
          projectKey: "test-project",
          routes: [
            scriptedCommercetoolsSdkRoute("productSelections.create").replyWith(
              (request) => {
                const draft = request.body as ProductSelectionDraft;

                return productSelectionResponse(
                  draft,
                  draft.key === "source-1" ? 1 : 2
                );
              }
            ),
          ],
        });
        const ct = CommercetoolsDestination.make().provide(sdk.layer);
        const processError: ProcessFailedAfterDestination = {
          _tag: "ProcessFailedAfterDestination",
          message: "Process failed after destination work",
        };

        const definition = MigrationDefinition.make({
          id: "resource-helpers",
          process: (source) =>
            Effect.gen(function* () {
              yield* ct.productSelections.create({
                key: source.item.key,
                name: {
                  "en-US": "Summer catalog",
                },
              });
              yield* ct.productSelections.create({
                key: `${source.item.key}-archive`,
                name: {
                  "en-US": "Summer catalog Archive",
                },
              });

              return yield* Effect.fail(processError);
            }),
          source: makeOneItemSource(),
          store: InMemoryMigrationStore.layer(storeState),
        });

        const summary = yield* runMigrations({ definitions: [definition] });
        const itemState = storeItem(storeState);
        const journalEntries =
          itemState?.status === "failed"
            ? (itemState.journal?.process.entries ?? [])
            : [];
        const productSelectionChanges = yield* Effect.forEach(
          journalEntries.filter(ct.productSelections.changes.created.is),
          ct.productSelections.changes.created.decode
        );

        expect(summary.status).toBe("failed");
        expect(productSelectionChanges.map((entry) => entry.sequence)).toEqual([
          0, 1,
        ]);
        expect(
          productSelectionChanges.map((entry) => entry.value.resourceKey)
        ).toEqual(["source-1", "source-1-archive"]);
        expect(
          productSelectionChanges.map((entry) => entry.value.resourceVersion)
        ).toEqual([1, 2]);
      })
  );

  it.effect(
    "records a safe diagnostic without a success change when the SDK create fails",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const sdk = makeScriptedCommercetoolsSdk({
          projectKey: "test-project",
          routes: [
            scriptedCommercetoolsSdkRoute("productSelections.create").fail({
              body: {
                message: "Temporary unavailable",
                statusCode: 503,
              },
              headers: {
                authorization: "Bearer secret-token",
                "x-correlation-id": "provider-internal-correlation-id",
              },
              statusCode: 503,
            }),
          ],
        });
        const ct = CommercetoolsDestination.make().provide(sdk.layer);

        const definition = MigrationDefinition.make({
          id: "resource-helpers",
          process: (source) =>
            ct.productSelections
              .create({
                key: source.item.key,
                name: {
                  "en-US": "Summer catalog",
                },
              })
              .pipe(Effect.asVoid),
          source: makeOneItemSource(),
          store: InMemoryMigrationStore.layer(storeState),
        });

        const summary = yield* runMigrations({ definitions: [definition] });
        const itemState = storeItem(storeState);
        const journalEntries =
          itemState?.status === "failed"
            ? (itemState.journal?.process.entries ?? [])
            : [];

        expect(summary.status).toBe("failed");
        expect(journalEntries).toEqual([
          {
            details: {
              operation: "productSelections.create",
              productSelectionKey: "source-1",
              resourceType: "product-selection",
              sourceIdentity: "source-1",
              statusCode: 503,
            },
            kind: "diagnostic",
            message: "Commercetools product selection create failed",
            sequence: 0,
            severity: "error",
          },
        ]);
        expect(
          journalEntries.some((entry) =>
            ct.productSelections.changes.created.is(entry)
          )
        ).toBe(false);
        expect(JSON.stringify(journalEntries)).not.toContain("headers");
        expect(JSON.stringify(journalEntries)).not.toContain("secret-token");
        expect(JSON.stringify(journalEntries)).not.toContain(
          "provider-internal"
        );
      })
  );

  it.effect(
    "records customer diagnostics with customerKey instead of customer email",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const sdk = makeScriptedCommercetoolsSdk({
          projectKey: "test-project",
          routes: [
            scriptedCommercetoolsSdkRoute("customers.create").fail({
              body: {
                message: "Customer already exists",
                statusCode: 409,
              },
              statusCode: 409,
            }),
          ],
        });
        const ct = CommercetoolsDestination.make().provide(sdk.layer);

        const definition = MigrationDefinition.make({
          id: "resource-helpers",
          process: () =>
            ct.customers
              .create({
                email: "customer@example.com",
                key: "customer-1",
              })
              .pipe(Effect.asVoid),
          source: makeOneItemSource(),
          store: InMemoryMigrationStore.layer(storeState),
        });

        const summary = yield* runMigrations({ definitions: [definition] });
        const itemState = storeItem(storeState);
        const journalEntries =
          itemState?.status === "failed"
            ? (itemState.journal?.process.entries ?? [])
            : [];

        expect(summary.status).toBe("failed");
        expect(journalEntries).toEqual([
          {
            details: {
              customerKey: "customer-1",
              operation: "customers.create",
              resourceType: "customer",
              sourceIdentity: "source-1",
              statusCode: 409,
            },
            kind: "diagnostic",
            message: "Commercetools customer create failed",
            sequence: 0,
            severity: "error",
          },
        ]);
        expect(JSON.stringify(journalEntries)).not.toContain(
          "customer@example.com"
        );
        expect(JSON.stringify(journalEntries)).not.toContain("customerEmail");
      })
  );

  it.effect(
    "records rollback-attempt evidence from descriptor-narrowed journal entries",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const sdk = makeScriptedCommercetoolsSdk({
          projectKey: "test-project",
          routes: [
            scriptedCommercetoolsSdkRoute("products.create").replyWith(
              (request) => productResponse(request.body as ProductDraft)
            ),
          ],
        });
        const ct = CommercetoolsDestination.make().provide(sdk.layer);
        const rollbackError = {
          _tag: "RollbackRejected",
          message: "Rollback failed after inspecting product change",
        };

        const definition = MigrationDefinition.make({
          id: "resource-helpers",
          process: () =>
            ct.products
              .create({
                key: "product-1",
                name: {
                  "en-US": "Product",
                },
                productType: {
                  key: "book",
                  typeId: "product-type",
                },
                slug: {
                  "en-US": "product",
                },
              })
              .pipe(Effect.asVoid),
          rollback: (itemState) =>
            Effect.gen(function* () {
              const productEntry = itemState.journal?.process.entries.find(
                ct.products.changes.created.is
              );

              if (productEntry !== undefined) {
                const decoded =
                  yield* ct.products.changes.created.decode(productEntry);

                yield* Tracking.logDiagnostic({
                  details: {
                    operation: "rollback.products.delete",
                    productId: decoded.value.resourceId,
                    productKey: decoded.value.resourceKey,
                  },
                  message: "Product rollback failed",
                  severity: "error",
                });
              }

              return yield* Effect.fail(rollbackError);
            }),
          source: makeOneItemSource(),
          store: InMemoryMigrationStore.layer(storeState),
        });

        const runSummary = yield* runMigrations({ definitions: [definition] });
        const rollbackSummary = yield* rollbackMigration(definition);
        const itemState = storeItem(storeState);
        const rollbackAttempt = itemState?.journal?.rollbackAttempts[0];

        expect(runSummary.status).toBe("succeeded");
        expect(rollbackSummary.status).toBe("failed");
        expect(rollbackAttempt?.entries).toEqual([
          {
            details: {
              operation: "rollback.products.delete",
              productId: "product:product-1",
              productKey: "product-1",
            },
            kind: "diagnostic",
            message: "Product rollback failed",
            sequence: 0,
            severity: "error",
          },
        ]);
        expect(rollbackAttempt?.error).toMatchObject({
          kind: "process",
          message: "Rollback failed after inspecting product change",
        });
      })
  );
});
