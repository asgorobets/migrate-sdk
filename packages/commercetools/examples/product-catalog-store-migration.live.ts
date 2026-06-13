import { fileURLToPath } from "node:url";
import { CommercetoolsSdk } from "@migrate-sdk/commercetools";
import { CommercetoolsMigrationStore } from "@migrate-sdk/commercetools/migration-store";
import { Console, Effect } from "effect";
import {
  loadLiveCommercetoolsConfig,
  makeLiveApiRoot,
} from "./live-commercetools.ts";
import {
  catalogStoreOptions,
  type ProductCatalogStoreMigrationExampleResult,
  runProductCatalogStoreMigration,
} from "./product-catalog-store-migration.ts";

export const runLiveProductCatalogStoreMigrationExample = Effect.fn(
  "runLiveProductCatalogStoreMigrationExample"
)(function* () {
  const config = yield* loadLiveCommercetoolsConfig();
  const apiRoot = makeLiveApiRoot(config);

  return yield* runProductCatalogStoreMigration({
    sdkLayer: CommercetoolsSdk.layerFromApiRoot({
      apiRoot,
      projectKey: config.projectKey,
    }),
    storeLayer: CommercetoolsMigrationStore.layerFromApiRoot({
      apiRoot,
      ...catalogStoreOptions,
      projectKey: config.projectKey,
    }),
  });
});

export const formatLiveProductCatalogStoreMigrationExampleResult = (
  result: ProductCatalogStoreMigrationExampleResult
): string => {
  const definition = result.summary.definitions[0];

  return [
    "Commercetools Product Catalog Store Migration Live Example",
    `status: ${result.summary.status}`,
    `definitions: ${result.summary.definitions.length}`,
    `products migrated: ${definition?.counts.migrated ?? 0}`,
    `persisted item states: ${result.itemStates.length}`,
  ].join("\n");
};

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  Effect.runPromise(
    runLiveProductCatalogStoreMigrationExample().pipe(
      Effect.map(formatLiveProductCatalogStoreMigrationExampleResult),
      Effect.flatMap(Console.log)
    )
  ).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
