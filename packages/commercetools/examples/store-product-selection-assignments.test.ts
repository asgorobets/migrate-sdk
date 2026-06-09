import type { StoreDraft } from "@commercetools/platform-sdk";
import { describe, expect, it } from "@effect/vitest";
import { CommercetoolsSdk } from "@migrate-sdk/commercetools";
import {
  CommercetoolsDestinationPlugin,
  type StoreUpdateActionByName,
  UpdateStoreCommand,
} from "@migrate-sdk/commercetools/destination";
import { makeRecordingCommercetoolsApiRoot } from "@migrate-sdk/commercetools/testing";
import { Effect, Schema } from "effect";
import {
  DestinationPlugin,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceIdentity,
  toSourceVersion,
} from "migrate-sdk";

const destinationContext = {
  definitionId: toMigrationDefinitionId("example-store-assignments"),
  runId: toMigrationRunId("example-run"),
  sourceIdentity: toSourceIdentity("example-source-store"),
  sourceVersion: toSourceVersion("source-version-1"),
};

const makeDestination = () => {
  const recording = makeRecordingCommercetoolsApiRoot();

  const destination = CommercetoolsDestinationPlugin.make({
    sdkLayer: CommercetoolsSdk.layerFromApiRoot({
      apiRoot: recording.apiRoot,
      projectKey: "example-project",
    }),
  });

  return {
    destination,
    recording,
  };
};

const assertStoreUpdateActionTypes = () => {
  const addProductSelection: StoreUpdateActionByName<"addProductSelection"> = {
    action: "addProductSelection",
    active: true,
    productSelection: {
      key: "example-selection",
      typeId: "product-selection",
    },
  };
  const setProductSelections: StoreUpdateActionByName<"setProductSelections"> =
    {
      action: "setProductSelections",
      productSelections: [
        {
          active: true,
          productSelection: {
            key: "example-selection",
            typeId: "product-selection",
          },
        },
      ],
    };
  const { destination } = makeDestination();
  const update = destination.commands.stores.update({
    selector: {
      key: "example-store",
      kind: "key",
    },
    version: 1,
  });

  update.action(addProductSelection);
  update.action(setProductSelections);
  // @ts-expect-error Store addProductSelection actions require productSelection.
  update.action({
    action: "addProductSelection",
  });
  update.action({
    // @ts-expect-error Product assignment actions belong to product selections, not stores.
    action: "addProduct",
    product: {
      key: "example-book",
      typeId: "product",
    },
  });
  update.action({
    action: "addProductSelection",
    // @ts-expect-error Product selection resource identifiers require id or key.
    productSelection: {
      typeId: "product-selection",
    },
  });
  update.action({
    action: "addProductSelection",
    // @ts-expect-error Product selection resource identifiers accept id or key, not both.
    productSelection: {
      id: "recording-product-selection-id",
      key: "example-selection",
      typeId: "product-selection",
    },
  });
  update.action({
    action: "setProductSelections",
    productSelections: [
      {
        active: true,
        // @ts-expect-error Nested product selection identifiers require id or key.
        productSelection: {
          typeId: "product-selection",
        },
      },
    ],
  });
  destination.commands.stores.update.withActions({
    actions: [
      {
        action: "addProductSelection",
        // @ts-expect-error Raw actions use the same refined product selection reference type.
        productSelection: {
          typeId: "product-selection",
        },
      },
    ],
    selector: {
      key: "example-store",
      kind: "key",
    },
    version: 1,
  });

  return [addProductSelection, setProductSelections];
};

describe("store product selection assignment commands", () => {
  it.effect(
    "runs create and update store commands with product selections",
    () =>
      Effect.gen(function* () {
        const { destination, recording } = makeDestination();
        const destinationPlugin = yield* DestinationPlugin.pipe(
          Effect.provide(destination.layer)
        );
        const draft = {
          key: "example-store",
          name: {
            "en-US": "Example Store",
          },
        } satisfies StoreDraft;

        const created = yield* destinationPlugin.execute(
          destination.commands.stores.createDraft(draft),
          destinationContext
        );
        const updateCommand = destination.commands.stores.update
          .withActions({
            actions: [
              {
                action: "addProductSelection",
                active: true,
                productSelection: {
                  key: "example-selection",
                  typeId: "product-selection",
                },
              },
            ],
            selector: {
              id: String(created.destinationIdentity),
              kind: "id",
            },
            version: Number(created.destinationVersion),
          })
          .action({
            action: "changeProductSelectionActive",
            active: false,
            productSelection: {
              key: "example-selection",
              typeId: "product-selection",
            },
          })
          .action({
            action: "setProductSelections",
            productSelections: [
              {
                active: true,
                productSelection: {
                  key: "featured-selection",
                  typeId: "product-selection",
                },
              },
            ],
          })
          .command();
        const updated = yield* destinationPlugin.execute(
          updateCommand,
          destinationContext
        );
        const createRequest = recording.requests[0];
        const updateRequest = recording.requests[1];

        expect(created.destinationIdentity).toBe("recording-store-id");
        expect(created.destinationVersion).toBe("1");
        expect(created.metadata).toEqual({
          storeKey: "example-store",
          storeProductSelectionCount: 0,
          storeVersion: 1,
        });
        expect(updated.destinationVersion).toBe("2");
        expect(updated.metadata).toEqual({
          storeKey: "example-store",
          storeProductSelectionCount: 1,
          storeVersion: 2,
        });
        expect(createRequest?.body).toEqual(draft);
        expect(updateRequest?.body).toEqual({
          actions: updateCommand.actions,
          version: 1,
        });
        expect(updateCommand.actions.map((action) => action.action)).toEqual([
          "addProductSelection",
          "changeProductSelectionActive",
          "setProductSelections",
        ]);
      })
  );

  it("types store product selection actions from the SDK action union", () => {
    expect(assertStoreUpdateActionTypes).toBeTypeOf("function");
  });

  it.effect("validates the store update command envelope", () =>
    Effect.gen(function* () {
      const validAction = yield* Schema.decodeUnknownEffect(UpdateStoreCommand)(
        {
          actions: [
            {
              action: "addProductSelection",
              productSelection: {
                key: "example-selection",
                typeId: "product-selection",
              },
            },
          ],
          kind: "UpdateStore",
          selector: {
            key: "example-store",
            kind: "key",
          },
          version: 1,
        }
      );
      const missingActionError = yield* Schema.decodeUnknownEffect(
        UpdateStoreCommand
      )({
        actions: [
          {
            productSelection: {
              key: "example-selection",
              typeId: "product-selection",
            },
          },
        ],
        kind: "UpdateStore",
        selector: {
          key: "example-store",
          kind: "key",
        },
        version: 1,
      }).pipe(Effect.flip);
      const emptyActionsError = yield* Schema.decodeUnknownEffect(
        UpdateStoreCommand
      )({
        actions: [],
        kind: "UpdateStore",
        selector: {
          key: "example-store",
          kind: "key",
        },
        version: 1,
      }).pipe(Effect.flip);

      expect(validAction.actions).toEqual([
        {
          action: "addProductSelection",
          productSelection: {
            key: "example-selection",
            typeId: "product-selection",
          },
        },
      ]);
      expect(missingActionError).toBeDefined();
      expect(emptyActionsError).toBeDefined();
    })
  );
});
