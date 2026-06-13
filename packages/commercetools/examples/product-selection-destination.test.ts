import type {
  ProductSelection,
  ProductSelectionDraft,
} from "@commercetools/platform-sdk";
import { describe, expect, it } from "@effect/vitest";
import {
  CommercetoolsDestinationPlugin,
  type ProductSelectionUpdateActionByName,
  UpdateProductSelectionCommand,
} from "@migrate-sdk/commercetools/destination";
import {
  makeScriptedCommercetoolsSdk,
  scriptedCommercetoolsSdkRoute,
} from "@migrate-sdk/commercetools/testing";
import { Effect, Schema } from "effect";
import {
  DestinationPlugin,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceIdentity,
  toSourceVersion,
} from "migrate-sdk";

const destinationContext = {
  definitionId: toMigrationDefinitionId("example-product-selections"),
  runId: toMigrationRunId("example-run"),
  sourceIdentity: toSourceIdentity("example-source-product-selection"),
  sourceVersion: toSourceVersion("source-version-1"),
};

const productSelectionResponse = ({
  draft,
  productCount,
  version,
}: {
  readonly draft: ProductSelectionDraft;
  readonly productCount: number;
  readonly version: number;
}): ProductSelection => ({
  createdAt: "2026-01-01T00:00:00.000Z",
  id: "recording-product-selection-id",
  ...(draft.key === undefined ? {} : { key: draft.key }),
  lastModifiedAt: "2026-01-01T00:00:00.000Z",
  mode: draft.mode ?? "Individual",
  name: draft.name,
  productCount,
  version,
});

const makeDestination = () => {
  const recording = makeScriptedCommercetoolsSdk({
    projectKey: "example-project",
    routes: [
      scriptedCommercetoolsSdkRoute("productSelections.createDraft").replyWith(
        (request) =>
          productSelectionResponse({
            draft: request.body as ProductSelectionDraft,
            productCount: 0,
            version: 1,
          })
      ),
      scriptedCommercetoolsSdkRoute("productSelections.update").reply(
        productSelectionResponse({
          draft: {
            key: "example-selection-updated",
            mode: "Individual",
            name: {
              "en-US": "Example Product Selection Updated",
            },
          },
          productCount: 1,
          version: 2,
        })
      ),
    ],
  });

  const destination = CommercetoolsDestinationPlugin.make({
    sdkLayer: recording.layer,
  });

  return {
    destination,
    recording,
  };
};

const assertProductSelectionUpdateActionTypes = () => {
  const addProduct: ProductSelectionUpdateActionByName<"addProduct"> = {
    action: "addProduct",
    product: {
      key: "example-book",
      typeId: "product",
    },
    variantSelection: {
      skus: ["example-book-paperback"],
      type: "includeOnly",
    },
  };
  const changeName: ProductSelectionUpdateActionByName<"changeName"> = {
    action: "changeName",
    name: {
      "en-US": "Example Product Selection Updated",
    },
  };
  const { destination } = makeDestination();
  const update = destination.commands.productSelections.update({
    selector: {
      id: "recording-product-selection-id",
      kind: "id",
    },
    version: 1,
  });

  update.action(addProduct);
  update.action(changeName);
  // @ts-expect-error Product selection addProduct actions require product.
  update.action({
    action: "addProduct",
  });
  update.action({
    // @ts-expect-error The SDK product selection action union does not include this action.
    action: "assignProduct",
    product: {
      key: "example-book",
      typeId: "product",
    },
  });
  update.action({
    action: "addProduct",
    // @ts-expect-error Product resource identifiers require id or key.
    product: {
      typeId: "product",
    },
  });
  update.action({
    action: "addProduct",
    // @ts-expect-error Product resource identifiers accept id or key, not both.
    product: {
      id: "recording-product-id",
      key: "example-book",
      typeId: "product",
    },
  });
  destination.commands.productSelections.update.withActions({
    actions: [
      {
        action: "addProduct",
        // @ts-expect-error Raw actions use the same refined product reference type.
        product: {
          typeId: "product",
        },
      },
    ],
    selector: {
      id: "recording-product-selection-id",
      kind: "id",
    },
    version: 1,
  });

  return [addProduct, changeName];
};

describe("product selection destination commands", () => {
  it.effect("runs create and update product selection commands", () =>
    Effect.gen(function* () {
      const { destination, recording } = makeDestination();
      const destinationPlugin = yield* DestinationPlugin.pipe(
        Effect.provide(destination.layer)
      );
      const draft = {
        key: "example-selection",
        mode: "Individual",
        name: {
          "en-US": "Example Product Selection",
        },
      } satisfies ProductSelectionDraft;

      const created = yield* destinationPlugin.execute(
        destination.commands.productSelections.createDraft(draft),
        destinationContext
      );
      const updateCommand = destination.commands.productSelections.update
        .withActions({
          actions: [
            {
              action: "addProduct",
              product: {
                key: "example-book",
                typeId: "product",
              },
              variantSelection: {
                skus: ["example-book-paperback"],
                type: "includeOnly",
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
          action: "changeName",
          name: {
            "en-US": "Example Product Selection Updated",
          },
        })
        .action({
          action: "setKey",
          key: "example-selection-updated",
        })
        .command();
      const updated = yield* destinationPlugin.execute(
        updateCommand,
        destinationContext
      );
      const createRequest = recording.requests[0];
      const updateRequest = recording.requests[1];

      expect(created.destinationIdentity).toBe(
        "recording-product-selection-id"
      );
      expect(created.destinationVersion).toBe("1");
      expect(created.metadata).toEqual({
        productSelectionKey: "example-selection",
        productSelectionProductCount: 0,
        productSelectionVersion: 1,
      });
      expect(updated.destinationVersion).toBe("2");
      expect(updated.metadata).toEqual({
        productSelectionKey: "example-selection-updated",
        productSelectionProductCount: 1,
        productSelectionVersion: 2,
      });
      expect(createRequest?.body).toEqual(draft);
      expect(updateRequest?.body).toEqual({
        actions: updateCommand.actions,
        version: 1,
      });
      expect(updateCommand.actions.map((action) => action.action)).toEqual([
        "addProduct",
        "changeName",
        "setKey",
      ]);
    })
  );

  it("types product selection actions from the SDK action union", () => {
    expect(assertProductSelectionUpdateActionTypes).toBeTypeOf("function");
  });

  it.effect("validates the product selection update command envelope", () =>
    Effect.gen(function* () {
      const validAction = yield* Schema.decodeUnknownEffect(
        UpdateProductSelectionCommand
      )({
        actions: [
          {
            action: "changeName",
            name: {
              "en-US": "Example Product Selection Updated",
            },
          },
        ],
        kind: "UpdateProductSelection",
        selector: {
          id: "recording-product-selection-id",
          kind: "id",
        },
        version: 1,
      });
      const missingActionError = yield* Schema.decodeUnknownEffect(
        UpdateProductSelectionCommand
      )({
        actions: [
          {
            name: {
              "en-US": "Example Product Selection Updated",
            },
          },
        ],
        kind: "UpdateProductSelection",
        selector: {
          id: "recording-product-selection-id",
          kind: "id",
        },
        version: 1,
      }).pipe(Effect.flip);
      const emptyActionsError = yield* Schema.decodeUnknownEffect(
        UpdateProductSelectionCommand
      )({
        actions: [],
        kind: "UpdateProductSelection",
        selector: {
          id: "recording-product-selection-id",
          kind: "id",
        },
        version: 1,
      }).pipe(Effect.flip);

      expect(validAction.actions).toEqual([
        {
          action: "changeName",
          name: {
            "en-US": "Example Product Selection Updated",
          },
        },
      ]);
      expect(missingActionError).toBeDefined();
      expect(emptyActionsError).toBeDefined();
    })
  );
});
