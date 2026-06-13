import { CommercetoolsSdk } from "@migrate-sdk/commercetools";
import { CommercetoolsMigrationStore } from "@migrate-sdk/commercetools/migration-store";
import { MigrationDefinitionRegistry } from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";
import {
  businessUnitStaticFieldStoreOptions,
  makeBusinessUnitStaticFieldMigration,
} from "./business-unit-static-field-migration.ts";
import {
  loadLiveCommercetoolsConfigSync,
  makeLiveApiRoot,
} from "./live-commercetools.ts";

const businessUnitBatchSize = 20;

const liveConfig = loadLiveCommercetoolsConfigSync();
const apiRoot = makeLiveApiRoot(liveConfig);
const sdkLayer = CommercetoolsSdk.layerFromApiRoot({
  apiRoot,
  projectKey: liveConfig.projectKey,
});
const storeLayer = CommercetoolsMigrationStore.layerFromApiRoot({
  apiRoot,
  ...businessUnitStaticFieldStoreOptions,
  projectKey: liveConfig.projectKey,
});

const businessUnitStaticFieldMigration = makeBusinessUnitStaticFieldMigration({
  batchSize: businessUnitBatchSize,
  sdkLayer,
  storeLayer,
});

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({
    definitions: [businessUnitStaticFieldMigration],
  }),
});
