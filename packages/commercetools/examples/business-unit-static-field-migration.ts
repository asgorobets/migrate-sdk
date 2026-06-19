import type { CommercetoolsSdkLayer } from "@migrate-sdk/commercetools";
import { CommercetoolsDestination } from "@migrate-sdk/commercetools/destination";
import { CommercetoolsSourcePlugin } from "@migrate-sdk/commercetools/source";
import { Effect, type Layer } from "effect";
import {
  defineMigration,
  type MigrationStore,
  type MigrationStoreError,
  skipItem,
} from "migrate-sdk";

export const businessUnitStaticFieldDefinitionId = "business-unit-static-field";

export const businessUnitStaticFieldStoreOptions = {
  container: "migrate-sdk-examples",
  namespace: "business-unit-static-field",
};

export interface BusinessUnitStaticFieldMigrationOptions {
  readonly batchSize?: number;
  readonly sdkLayer: CommercetoolsSdkLayer;
  readonly storeLayer: Layer.Layer<MigrationStore, MigrationStoreError>;
}

export const makeBusinessUnitStaticFieldMigration = (
  options: BusinessUnitStaticFieldMigrationOptions
) => {
  const ct = CommercetoolsDestination.make().provide(options.sdkLayer);
  const source = CommercetoolsSourcePlugin.businessUnits({
    batchSize: options.batchSize ?? 20,
    identity: "key",
  }).provide(options.sdkLayer);

  return defineMigration({
    id: businessUnitStaticFieldDefinitionId,
    source,
    store: options.storeLayer,
    process: Effect.fn("businessUnitsStaticField.process")(
      function* (sourceItem) {
        const businessUnit = sourceItem.item;
        const contactEmail = businessUnit.contactEmail;

        if (contactEmail === undefined) {
          return yield* skipItem(
            `Business Unit ${businessUnit.key} does not have a contactEmail to set back`
          );
        }

        yield* ct.businessUnits.update({
          actions: [
            {
              action: "setContactEmail",
              contactEmail,
            },
          ],
          selector: {
            key: businessUnit.key,
            kind: "key",
          },
          version: businessUnit.version,
        });
      }
    ),
  });
};
