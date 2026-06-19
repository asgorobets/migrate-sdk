import type {
  ProductSelection,
  ProductSelectionDraft,
} from "@commercetools/platform-sdk";
import { describe, expect, it } from "@effect/vitest";
import type { CommercetoolsSdk } from "@migrate-sdk/commercetools";
import { CommercetoolsDestination } from "@migrate-sdk/commercetools/destination";
import {
  makeScriptedCommercetoolsSdk,
  scriptedCommercetoolsSdkRoute,
} from "@migrate-sdk/commercetools/testing";
import { Effect, Schema } from "effect";
import {
  type DestinationPluginError,
  defineMigration,
  InMemoryMigrationStore,
  InMemorySourcePlugin,
  runMigrations,
  SourceIdentity,
  Tracking,
} from "migrate-sdk";
import { expectTypeOf } from "vitest";

const ProductSelectionSource = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
});

const ProductSelectionSourceIdentity = SourceIdentity.make({
  id: "commercetools-product-selection-source@v1",
  schema: SourceIdentity.key("key", Schema.String),
});

const ProductSelectionTrackingRecord = Tracking.record({
  id: "commercetools-product-selection-tracking@v1",
  schema: Schema.Struct({
    productSelectionId: Schema.String,
    productSelectionKey: Schema.String,
  }),
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

const productSelectionResponse = (
  draft: ProductSelectionDraft,
  version = 1
): ProductSelection =>
  ({
    createdAt: "2026-01-01T00:00:00.000Z",
    id: `product-selection:${draft.key}`,
    ...(draft.key === undefined ? {} : { key: draft.key }),
    lastModifiedAt: "2026-01-01T00:00:00.000Z",
    mode: draft.mode ?? "Individual",
    name: draft.name,
    productCount: 0,
    version,
  }) as ProductSelection;

interface ProcessFailedAfterDestination {
  readonly _tag: "ProcessFailedAfterDestination";
  readonly message: string;
}

describe("CommercetoolsDestination capability module", () => {
  it.effect(
    "runs a provided product selection helper inside process and records one destination change",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const sdk = makeScriptedCommercetoolsSdk({
          projectKey: "test-project",
          routes: [
            scriptedCommercetoolsSdkRoute("productSelections.create").replyWith(
              (request) =>
                productSelectionResponse(request.body as ProductSelectionDraft)
            ),
          ],
        });
        const ct = CommercetoolsDestination.make().provide(sdk.layer);

        const definition = defineMigration({
          id: "product-selections",
          source: InMemorySourcePlugin.make({
            identity: ProductSelectionSourceIdentity,
            sourceSchema: ProductSelectionSource,
            items: [
              {
                identityKey: "selection-1",
                item: {
                  key: "selection-1",
                  name: "Summer catalog",
                },
                version: "source-version-1",
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          tracking: ProductSelectionTrackingRecord,
          process: (source) =>
            Effect.gen(function* () {
              const selection = yield* ct.productSelections.create({
                key: source.item.key,
                name: {
                  "en-US": source.item.name,
                },
              });

              yield* Tracking.setRecord({
                productSelectionId: selection.id,
                productSelectionKey: selection.key ?? source.item.key,
              });
            }),
        });

        const summary = yield* runMigrations({ definitions: [definition] });
        const itemState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey(
            "product-selections",
            "selection-1"
          )
        );
        const journalEntries =
          itemState?.status === "migrated"
            ? (itemState.journal?.process.entries ?? [])
            : [];

        expect(summary.status).toBe("succeeded");
        expect(sdk.requests).toMatchObject([
          {
            body: {
              key: "selection-1",
              name: {
                "en-US": "Summer catalog",
              },
            },
            method: "POST",
            operation: "productSelections.create",
          },
        ]);
        expect(itemState).toEqual(
          expect.objectContaining({
            status: "migrated",
            trackingRecord: {
              productSelectionId: "product-selection:selection-1",
              productSelectionKey: "selection-1",
            },
          })
        );
        expect(journalEntries).toHaveLength(1);
        expect(journalEntries[0]).toEqual(
          expect.objectContaining({
            descriptorId: ct.productSelections.changes.created.id,
            kind: "change",
            sequence: 0,
          })
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
                  draft.key === "selection-1" ? 1 : 2
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

        const definition = defineMigration({
          id: "product-selections",
          source: InMemorySourcePlugin.make({
            identity: ProductSelectionSourceIdentity,
            sourceSchema: ProductSelectionSource,
            items: [
              {
                identityKey: "selection-1",
                item: {
                  key: "selection-1",
                  name: "Summer catalog",
                },
                version: "source-version-1",
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          tracking: ProductSelectionTrackingRecord,
          process: (source) =>
            Effect.gen(function* () {
              yield* ct.productSelections.create({
                key: source.item.key,
                name: {
                  "en-US": source.item.name,
                },
              });
              yield* ct.productSelections.create({
                key: `${source.item.key}-archive`,
                name: {
                  "en-US": `${source.item.name} Archive`,
                },
              });

              return yield* Effect.fail(processError);
            }),
        });

        const summary = yield* runMigrations({ definitions: [definition] });
        const itemState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey(
            "product-selections",
            "selection-1"
          )
        );
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
          productSelectionChanges.map(
            (entry) => entry.value.productSelectionKey
          )
        ).toEqual(["selection-1", "selection-1-archive"]);
        expect(
          productSelectionChanges.map(
            (entry) => entry.value.productSelectionVersion
          )
        ).toEqual([1, 2]);
        expect(sdk.requests.map((request) => request.body)).toEqual([
          {
            key: "selection-1",
            name: {
              "en-US": "Summer catalog",
            },
          },
          {
            key: "selection-1-archive",
            name: {
              "en-US": "Summer catalog Archive",
            },
          },
        ]);
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

        const definition = defineMigration({
          id: "product-selections",
          source: InMemorySourcePlugin.make({
            identity: ProductSelectionSourceIdentity,
            sourceSchema: ProductSelectionSource,
            items: [
              {
                identityKey: "selection-1",
                item: {
                  key: "selection-1",
                  name: "Summer catalog",
                },
                version: "source-version-1",
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          tracking: ProductSelectionTrackingRecord,
          process: (source) =>
            Effect.gen(function* () {
              yield* ct.productSelections.create({
                key: source.item.key,
                name: {
                  "en-US": source.item.name,
                },
              });
            }),
        });

        const summary = yield* runMigrations({ definitions: [definition] });
        const itemState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey(
            "product-selections",
            "selection-1"
          )
        );
        const journalEntries =
          itemState?.status === "failed"
            ? (itemState.journal?.process.entries ?? [])
            : [];

        expect(summary.status).toBe("failed");
        expect(journalEntries).toEqual([
          {
            details: {
              operation: "productSelections.create",
              productSelectionKey: "selection-1",
              sourceIdentity: "selection-1",
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
});
