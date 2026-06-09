import type { BusinessUnitDraft } from "@commercetools/platform-sdk";
import { describe, expect, it } from "@effect/vitest";
import { CommercetoolsSdk } from "@migrate-sdk/commercetools";
import { CommercetoolsDestinationPlugin } from "@migrate-sdk/commercetools/destination";
import { makeRecordingCommercetoolsApiRoot } from "@migrate-sdk/commercetools/testing";
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

const makeDestination = () => {
  const recording = makeRecordingCommercetoolsApiRoot();

  const destination = CommercetoolsDestinationPlugin.make({
    customTypes: {
      businessUnits: {
        fields: RepoBusinessUnitCustomFields,
        typeKey: "repoBusinessUnit",
      },
    },
    projectKey: "example-project",
    sdkLayer: CommercetoolsSdk.layerFromApiRoot(recording.apiRoot),
  });

  return {
    destination,
    recording,
  };
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
          .setContactEmail({
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
        expect(updated.destinationVersion).toBe("2");
        expect(createRequest?.body).toEqual(draft);
        expect(updateRequest?.body).toEqual({
          actions: updateCommand.actions,
          version: 1,
        });
      })
  );
});
