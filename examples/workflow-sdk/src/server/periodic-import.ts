import { Effect } from "effect";
import { toMigrationDefinitionGroupId } from "migrate-sdk";
import type { MigrateOperationRequest } from "migrate-sdk/protocol";
import { MigrateServer } from "migrate-sdk/server/http";

const catalogImportRequest = {
  action: "run",
  options: {},
  target: {
    groupId: toMigrationDefinitionGroupId("catalog"),
    kind: "group",
  },
} satisfies MigrateOperationRequest;

export const startPeriodicCatalogImport = Effect.fn(
  "workflowSdkExample.startPeriodicCatalogImport"
)(function* () {
  const server = yield* MigrateServer;
  const operation = yield* server.prepareOperation(catalogImportRequest);

  return yield* server.startOperation({
    acceptedFingerprint: operation.fingerprint,
    request: catalogImportRequest,
  });
});
