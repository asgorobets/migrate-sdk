import type {
  BusinessUnit,
  BusinessUnitDraft,
} from "@commercetools/platform-sdk";
import { describe, expect, it } from "@effect/vitest";
import {
  type BusinessUnitUpdateActionByName,
  CommercetoolsDestinationPlugin,
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

const RepoBusinessUnitCustomFields = Schema.Struct({
  approvalStatus: Schema.Literals(["pending", "approved", "rejected"]),
  hasStoreCredit: Schema.Boolean,
  taxId: Schema.optional(Schema.String),
  taxIdValidationReason: Schema.optional(Schema.String),
});

const destinationContext = {
  definitionId: toMigrationDefinitionId("example-business-units"),
  runId: toMigrationRunId("example-run"),
  sourceIdentity: toSourceIdentity("example-source-business-unit"),
  sourceVersion: toSourceVersion("source-version-1"),
};

const businessUnitResponse = ({
  draft,
  version,
}: {
  readonly draft: BusinessUnitDraft;
  readonly version: number;
}): BusinessUnit => {
  const topLevelUnit: BusinessUnit["topLevelUnit"] = {
    key:
      draft.unitType === "Company"
        ? draft.key
        : (draft.parentUnit.key ?? "recording-top-level-business-unit"),
    typeId: "business-unit",
  };
  const shared = {
    addresses: [],
    approvalRuleMode:
      draft.approvalRuleMode ??
      (draft.unitType === "Company" ? "Explicit" : "ExplicitAndFromParent"),
    associateMode:
      draft.associateMode ??
      (draft.unitType === "Company" ? "Explicit" : "ExplicitAndFromParent"),
    associates: [],
    billingAddressIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "recording-business-unit-id",
    key: draft.key,
    lastModifiedAt: "2026-01-01T00:00:00.000Z",
    name: draft.name,
    shippingAddressIds: [],
    status: draft.status ?? "Active",
    storeMode:
      draft.storeMode ??
      (draft.unitType === "Company" ? "Explicit" : "FromParent"),
    topLevelUnit,
    version,
  } satisfies Omit<BusinessUnit, "unitType">;

  if (draft.unitType === "Company") {
    return {
      ...shared,
      unitType: "Company",
    };
  }

  return {
    ...shared,
    parentUnit: {
      key: draft.parentUnit.key ?? "recording-parent-business-unit",
      typeId: "business-unit",
    },
    unitType: "Division",
  };
};

const makeDestination = () => {
  const recording = makeScriptedCommercetoolsSdk({
    projectKey: "example-project",
    routes: [
      scriptedCommercetoolsSdkRoute("businessUnits.createDraft").replyWith(
        (request) =>
          businessUnitResponse({
            draft: request.body as BusinessUnitDraft,
            version: 1,
          })
      ),
      scriptedCommercetoolsSdkRoute("businessUnits.update").reply(
        businessUnitResponse({
          draft: {
            key: "buyer-org",
            name: "Buyer Org",
            unitType: "Company",
          },
          version: 2,
        })
      ),
    ],
  });

  const destination = CommercetoolsDestinationPlugin.make({
    customTypes: {
      businessUnits: {
        fields: RepoBusinessUnitCustomFields,
        typeKey: "repoBusinessUnit",
      },
    },
    sdkLayer: recording.layer,
  });

  return {
    destination,
    recording,
  };
};

const assertBusinessUnitUpdateActionTypes = () => {
  const { destination } = makeDestination();
  const update = destination.commands.businessUnits.update({
    selector: {
      id: "recording-business-unit-id",
      kind: "id",
    },
    version: 1,
  });

  update.action({
    action: "setDefaultBillingAddress",
    addressKey: "billing-address",
  });
  update.action({
    action: "setAddressCustomField",
    addressId: "address-id",
    name: "repoTaxId",
    value: "123",
  });
  update.action({
    action: "addAssociate",
    associate: {
      associateRoleAssignments: [
        {
          associateRole: {
            key: "buyer-admin",
            typeId: "associate-role",
          },
          inheritance: "Enabled",
        },
      ],
      customer: {
        key: "repo-buyer",
        typeId: "customer",
      },
    },
  });
  update.action({
    action: "setAssociates",
    associates: [
      {
        associateRoleAssignments: [
          {
            associateRole: {
              key: "buyer-admin",
              typeId: "associate-role",
            },
          },
        ],
        customer: {
          key: "repo-buyer",
          typeId: "customer",
        },
      },
    ],
  });

  // @ts-expect-error The Commerce Tools API requires addressId or addressKey.
  update.action({
    action: "setDefaultBillingAddress",
  });
  update.action({
    action: "setAddressCustomField",
    // @ts-expect-error Business unit address custom field actions require addressId.
    addressKey: "address-key",
    name: "repoTaxId",
  });
  destination.commands.businessUnits.update.withActions({
    actions: [
      // @ts-expect-error Raw actions use the same refined business unit action type.
      {
        action: "setDefaultBillingAddress",
      },
    ],
    selector: {
      id: "recording-business-unit-id",
      kind: "id",
    },
    version: 1,
  });
  // @ts-expect-error Business unit addAssociate actions require associate.
  update.action({
    action: "addAssociate",
  });

  // @ts-expect-error The refined action type requires addressId or addressKey.
  const missingDefaultBillingSelector: BusinessUnitUpdateActionByName<"setDefaultBillingAddress"> =
    {
      action: "setDefaultBillingAddress",
    };

  return missingDefaultBillingSelector;
};

describe("business unit custom field helpers", () => {
  it.effect("projects typed fields into a custom fields draft", () =>
    Effect.gen(function* () {
      const { destination } = makeDestination();
      const custom = yield* destination.helpers.businessUnits.customFields
        .withFields({
          approvalStatus: "pending",
          hasStoreCredit: false,
        })
        .set("taxId", "123456789")
        .toDraft();

      expect(custom).toEqual({
        fields: {
          approvalStatus: "pending",
          hasStoreCredit: false,
          taxId: "123456789",
        },
        type: {
          key: "repoBusinessUnit",
          typeId: "type",
        },
      });
    })
  );

  it.effect("projects field edits into set custom field actions", () =>
    Effect.gen(function* () {
      const { destination } = makeDestination();
      const actions = yield* destination.helpers.businessUnits.customFields
        .withFields({
          approvalStatus: "approved",
        })
        .set("hasStoreCredit", true)
        .unset("taxIdValidationReason")
        .toActions();

      expect(actions).toEqual([
        {
          action: "setCustomField",
          name: "approvalStatus",
          value: "approved",
        },
        {
          action: "setCustomField",
          name: "hasStoreCredit",
          value: true,
        },
        {
          action: "setCustomField",
          name: "taxIdValidationReason",
        },
      ]);
    })
  );

  it.effect("rejects provided field values that do not match the schema", () =>
    Effect.gen(function* () {
      const { destination } = makeDestination();
      const error = yield* destination.helpers.businessUnits.customFields
        .withFields({
          approvalStatus: "approved",
        })
        // @ts-expect-error Runtime validation protects untyped callers too.
        .set("taxId", 123)
        .toDraft()
        .pipe(Effect.flip);

      expect(Schema.isSchemaError(error)).toBe(true);
    })
  );

  it.effect(
    "runs create and update business unit commands with custom fields",
    () =>
      Effect.gen(function* () {
        const { destination, recording } = makeDestination();
        const destinationPlugin = yield* DestinationPlugin.pipe(
          Effect.provide(destination.layer)
        );
        const custom = yield* destination.helpers.businessUnits.customFields
          .withFields({
            approvalStatus: "pending",
            hasStoreCredit: false,
          })
          .toDraft();
        const draft = {
          custom,
          key: "buyer-org",
          name: "Buyer Org",
          unitType: "Company",
        } satisfies BusinessUnitDraft;

        const created = yield* destinationPlugin.execute(
          destination.commands.businessUnits.createDraft(draft),
          destinationContext
        );
        const actions = yield* destination.helpers.businessUnits.customFields
          .withFields({
            approvalStatus: "approved",
            hasStoreCredit: true,
          })
          .unset("taxId")
          .toActions();
        const updateCommand = destination.commands.businessUnits.update
          .withActions({
            actions,
            selector: {
              id: String(created.destinationIdentity),
              kind: "id",
            },
            version: Number(created.destinationVersion),
          })
          .action({
            action: "setContactEmail",
            contactEmail: "buyer@example.com",
          })
          .command();
        const updated = yield* destinationPlugin.execute(
          updateCommand,
          destinationContext
        );
        const createRequest = recording.requests[0];
        const updateRequest = recording.requests[1];

        expect(created.destinationIdentity).toBe("recording-business-unit-id");
        expect(created.destinationVersion).toBe("1");
        expect(updated.destinationIdentity).toBe("recording-business-unit-id");
        expect(updated.destinationVersion).toBe("2");
        expect(createRequest?.body).toEqual(draft);
        expect(updateRequest?.body).toEqual({
          actions: updateCommand.actions,
          version: 1,
        });
      })
  );

  it("types business unit actions from the refined SDK action union", () => {
    const { destination } = makeDestination();
    expect(assertBusinessUnitUpdateActionTypes).toBeTypeOf("function");
    const update = destination.commands.businessUnits.update({
      selector: {
        id: "recording-business-unit-id",
        kind: "id",
      },
      version: 1,
    });
    const defaultAddressCommand = update
      .action({
        action: "setDefaultBillingAddress",
        addressKey: "billing-address",
      })
      .command();

    expect(defaultAddressCommand.actions[0]).toEqual({
      action: "setDefaultBillingAddress",
      addressKey: "billing-address",
    });
  });
});
