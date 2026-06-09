import type { InventoryEntryDraft } from "@commercetools/platform-sdk";
import { describe, expect, it } from "@effect/vitest";
import { CommercetoolsSdk } from "@migrate-sdk/commercetools";
import {
  CommercetoolsDestinationPlugin,
  type InventoryEntryUpdateActionByName,
  UpdateInventoryEntryCommand,
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
  definitionId: toMigrationDefinitionId("example-inventory"),
  runId: toMigrationRunId("example-run"),
  sourceIdentity: toSourceIdentity("example-source-inventory-entry"),
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

const assertInventoryEntryUpdateActionTypes = () => {
  const changeQuantity: InventoryEntryUpdateActionByName<"changeQuantity"> = {
    action: "changeQuantity",
    quantity: 24,
  };
  const setExpectedDelivery: InventoryEntryUpdateActionByName<"setExpectedDelivery"> =
    {
      action: "setExpectedDelivery",
      expectedDelivery: "2026-02-01T00:00:00.000Z",
    };
  const { destination } = makeDestination();
  const update = destination.commands.inventory.update({
    selector: {
      id: "recording-inventory-entry-id",
      kind: "id",
    },
    version: 1,
  });

  update.action(changeQuantity);
  update.action(setExpectedDelivery);
  // @ts-expect-error Inventory changeQuantity actions require quantity.
  update.action({
    action: "changeQuantity",
  });
  update.action({
    // @ts-expect-error The SDK inventory action union does not include this action.
    action: "setQuantity",
    quantity: 24,
  });

  return [changeQuantity, setExpectedDelivery];
};

describe("inventory destination commands", () => {
  it.effect("runs create and update inventory entry commands", () =>
    Effect.gen(function* () {
      const { destination, recording } = makeDestination();
      const destinationPlugin = yield* DestinationPlugin.pipe(
        Effect.provide(destination.layer)
      );
      const draft = {
        key: "example-book-inventory",
        quantityOnStock: 12,
        sku: "example-book-paperback",
      } satisfies InventoryEntryDraft;

      const created = yield* destinationPlugin.execute(
        destination.commands.inventory.createDraft(draft),
        destinationContext
      );
      const updateCommand = destination.commands.inventory.update
        .withActions({
          actions: [
            {
              action: "addQuantity",
              quantity: 8,
            },
          ],
          selector: {
            id: String(created.destinationIdentity),
            kind: "id",
          },
          version: Number(created.destinationVersion),
        })
        .action({
          action: "setExpectedDelivery",
          expectedDelivery: "2026-02-01T00:00:00.000Z",
        })
        .command();
      const updated = yield* destinationPlugin.execute(
        updateCommand,
        destinationContext
      );
      const createRequest = recording.requests[0];
      const updateRequest = recording.requests[1];

      expect(created.destinationIdentity).toBe("recording-inventory-entry-id");
      expect(created.destinationVersion).toBe("1");
      expect(created.metadata).toEqual({
        inventoryEntryKey: "example-book-inventory",
        inventoryEntrySku: "example-book-paperback",
        inventoryEntryVersion: 1,
      });
      expect(updated.destinationVersion).toBe("2");
      expect(updated.metadata).toEqual({
        inventoryEntryKey: "example-book-inventory",
        inventoryEntrySku: "example-book-paperback",
        inventoryEntryVersion: 2,
      });
      expect(createRequest?.body).toEqual(draft);
      expect(updateRequest?.body).toEqual({
        actions: updateCommand.actions,
        version: 1,
      });
      expect(updateCommand.actions.map((action) => action.action)).toEqual([
        "addQuantity",
        "setExpectedDelivery",
      ]);
    })
  );

  it("types inventory entry actions from the SDK action union", () => {
    expect(assertInventoryEntryUpdateActionTypes).toBeTypeOf("function");
  });

  it.effect("validates the inventory entry update command envelope", () =>
    Effect.gen(function* () {
      const validAction = yield* Schema.decodeUnknownEffect(
        UpdateInventoryEntryCommand
      )({
        actions: [
          {
            action: "changeQuantity",
            quantity: 24,
          },
        ],
        kind: "UpdateInventoryEntry",
        selector: {
          id: "recording-inventory-entry-id",
          kind: "id",
        },
        version: 1,
      });
      const missingActionError = yield* Schema.decodeUnknownEffect(
        UpdateInventoryEntryCommand
      )({
        actions: [
          {
            quantity: 24,
          },
        ],
        kind: "UpdateInventoryEntry",
        selector: {
          id: "recording-inventory-entry-id",
          kind: "id",
        },
        version: 1,
      }).pipe(Effect.flip);
      const emptyActionsError = yield* Schema.decodeUnknownEffect(
        UpdateInventoryEntryCommand
      )({
        actions: [],
        kind: "UpdateInventoryEntry",
        selector: {
          id: "recording-inventory-entry-id",
          kind: "id",
        },
        version: 1,
      }).pipe(Effect.flip);

      expect(validAction.actions).toEqual([
        {
          action: "changeQuantity",
          quantity: 24,
        },
      ]);
      expect(missingActionError).toBeDefined();
      expect(emptyActionsError).toBeDefined();
    })
  );
});
