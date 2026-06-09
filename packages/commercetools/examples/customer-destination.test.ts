import type { CustomerDraft } from "@commercetools/platform-sdk";
import { describe, expect, it } from "@effect/vitest";
import { CommercetoolsSdk } from "@migrate-sdk/commercetools";
import {
  CommercetoolsDestinationPlugin,
  type CustomerUpdateActionByName,
  UpdateCustomerCommand,
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
  definitionId: toMigrationDefinitionId("example-customers"),
  runId: toMigrationRunId("example-run"),
  sourceIdentity: toSourceIdentity("example-source-customer"),
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

const assertCustomerUpdateActionTypes = () => {
  const { destination } = makeDestination();
  const update = destination.commands.customers.update({
    selector: {
      id: "recording-customer-id",
      kind: "id",
    },
    version: 1,
  });

  update.action({
    action: "setAuthenticationMode",
    authMode: "ExternalAuth",
  });
  update.action({
    action: "setDefaultBillingAddress",
    addressKey: "billing-address",
  });
  update.action({
    action: "setAddressCustomField",
    addressId: "address-id",
    name: "erpCustomerNumber",
    value: "123",
  });

  update.action({
    action: "setAuthenticationMode",
    // @ts-expect-error CustomerSetAuthenticationModeAction uses authMode.
    authenticationMode: "ExternalAuth",
  });
  // @ts-expect-error The Commerce Tools API requires addressId or addressKey.
  update.action({
    action: "setDefaultBillingAddress",
  });
  update.action({
    action: "setAddressCustomField",
    // @ts-expect-error Customer address custom field actions require addressId.
    addressKey: "address-key",
    name: "erpCustomerNumber",
  });
  destination.commands.customers.update.withActions({
    actions: [
      // @ts-expect-error Raw actions use the same refined customer action type.
      {
        action: "setDefaultBillingAddress",
      },
    ],
    selector: {
      id: "recording-customer-id",
      kind: "id",
    },
    version: 1,
  });

  // @ts-expect-error The refined action type requires addressId or addressKey.
  const missingDefaultBillingSelector: CustomerUpdateActionByName<"setDefaultBillingAddress"> =
    {
      action: "setDefaultBillingAddress",
    };

  return missingDefaultBillingSelector;
};

describe("customer destination commands", () => {
  it.effect("runs create and update customer commands", () =>
    Effect.gen(function* () {
      const { destination, recording } = makeDestination();
      const destinationPlugin = yield* DestinationPlugin.pipe(
        Effect.provide(destination.layer)
      );
      const draft = {
        email: "ada@example.com",
        firstName: "Ada",
        key: "ada",
        lastName: "Byron",
        password: "correct-horse-battery-staple",
      } satisfies CustomerDraft;

      const created = yield* destinationPlugin.execute(
        destination.commands.customers.createDraft(draft),
        destinationContext
      );
      const updateCommand = destination.commands.customers.update
        .withActions({
          actions: [
            {
              action: "changeEmail",
              email: "ada.lovelace@example.com",
            },
          ],
          selector: {
            id: String(created.destinationIdentity),
            kind: "id",
          },
          version: Number(created.destinationVersion),
        })
        .action({
          action: "setFirstName",
          firstName: "Augusta Ada",
        })
        .action({
          action: "setLastName",
          lastName: "Lovelace",
        })
        .action({
          action: "setKey",
          key: "ada-lovelace",
        })
        .command();
      const updated = yield* destinationPlugin.execute(
        updateCommand,
        destinationContext
      );
      const createRequest = recording.requests[0];
      const updateRequest = recording.requests[1];

      expect(created.destinationIdentity).toBe("recording-customer-id");
      expect(created.destinationVersion).toBe("1");
      expect(created.metadata).toEqual({
        customerEmail: "ada@example.com",
        customerKey: "ada",
        customerVersion: 1,
      });
      expect(updated.destinationVersion).toBe("2");
      expect(updated.metadata).toEqual({
        customerEmail: "ada.lovelace@example.com",
        customerKey: "ada-lovelace",
        customerVersion: 2,
      });
      expect(createRequest?.body).toEqual(draft);
      expect(updateRequest?.body).toEqual({
        actions: updateCommand.actions,
        version: 1,
      });
      expect(updateCommand.actions.map((action) => action.action)).toEqual([
        "changeEmail",
        "setFirstName",
        "setLastName",
        "setKey",
      ]);
    })
  );

  it("types customer actions from the refined SDK action union", () => {
    const { destination } = makeDestination();
    expect(assertCustomerUpdateActionTypes).toBeTypeOf("function");
    const update = destination.commands.customers.update({
      selector: {
        id: "recording-customer-id",
        kind: "id",
      },
      version: 1,
    });
    const authModeCommand = update
      .action({
        action: "setAuthenticationMode",
        authMode: "ExternalAuth",
      })
      .command();
    const defaultAddressCommand = update
      .action({
        action: "setDefaultBillingAddress",
        addressKey: "billing-address",
      })
      .command();

    expect(authModeCommand.actions[0]).toEqual({
      action: "setAuthenticationMode",
      authMode: "ExternalAuth",
    });
    expect(defaultAddressCommand.actions[0]).toEqual({
      action: "setDefaultBillingAddress",
      addressKey: "billing-address",
    });
  });

  it.effect("validates the customer update command envelope", () =>
    Effect.gen(function* () {
      const validAuthenticationModeAction = yield* Schema.decodeUnknownEffect(
        UpdateCustomerCommand
      )({
        actions: [
          {
            action: "setAuthenticationMode",
            authMode: "ExternalAuth",
          },
        ],
        kind: "UpdateCustomer",
        selector: {
          id: "recording-customer-id",
          kind: "id",
        },
        version: 1,
      });
      const missingActionError = yield* Schema.decodeUnknownEffect(
        UpdateCustomerCommand
      )({
        actions: [
          {
            authMode: "ExternalAuth",
          },
        ],
        kind: "UpdateCustomer",
        selector: {
          id: "recording-customer-id",
          kind: "id",
        },
        version: 1,
      }).pipe(Effect.flip);
      const emptyActionsError = yield* Schema.decodeUnknownEffect(
        UpdateCustomerCommand
      )({
        actions: [],
        kind: "UpdateCustomer",
        selector: {
          id: "recording-customer-id",
          kind: "id",
        },
        version: 1,
      }).pipe(Effect.flip);

      expect(validAuthenticationModeAction.actions).toEqual([
        {
          action: "setAuthenticationMode",
          authMode: "ExternalAuth",
        },
      ]);
      expect(missingActionError).toBeDefined();
      expect(emptyActionsError).toBeDefined();
    })
  );
});
