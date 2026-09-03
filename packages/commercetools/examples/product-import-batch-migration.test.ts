import {
  type ClientRequest,
  type ErrorObject,
  ApiRoot as ImportApiRoot,
  type ImportOperation,
  type ProductDraftImport,
  type ProductDraftImportRequest,
} from "@commercetools/importapi-sdk";
import { describe, expect, it } from "@effect/vitest";
import { CommercetoolsImportSdk } from "@migrate-sdk/commercetools/import-api";
import { Effect } from "effect";
import {
  DestinationJournalExtensionId,
  type MigrationItemState,
  ProcessBatchContractError,
} from "migrate-sdk";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import {
  catalogProductImportContainerKey,
  catalogProductImportItems,
  runCatalogProductImportMigration,
} from "./product-import-batch-migration.ts";

interface ImportApiFixture {
  readonly layer: ReturnType<typeof CommercetoolsImportSdk.layerFromApiRoot>;
  readonly submissions: readonly (readonly string[])[];
}

const operationError: ErrorObject = {
  code: "Generic",
  message: "Scripted Import API operation failed",
};
const productDraftImportOperationExtensionId =
  DestinationJournalExtensionId.make(
    "commercetools.product-draft.import-operation@v1"
  );

const makeImportApiFixture = (): ImportApiFixture => {
  const submissions: string[][] = [];
  const operations = new Map<string, ImportOperation>();
  const attempts = new Map<string, number>();
  const polls = new Map<string, number>();
  let containerExists = false;
  let nextOperation = 1;
  const containerExpiresAt = new Date(
    Date.now() + 30 * 24 * 60 * 60 * 1000
  ).toISOString();

  const executeRequest = (request: ClientRequest) => {
    if (
      request.method === "GET" &&
      request.uriTemplate?.endsWith(
        "/import-containers/{importContainerKey}"
      ) === true
    ) {
      return containerExists
        ? Promise.resolve({
            body: {
              createdAt: "2026-09-01T00:00:00.000Z",
              expiresAt: containerExpiresAt,
              key: catalogProductImportContainerKey,
              lastModifiedAt: "2026-09-01T00:00:00.000Z",
              resourceType: "product-draft",
              retentionPolicy: {
                config: { timeToLive: "30d" },
                strategy: "ttl",
              },
              version: 1,
            },
          })
        : Promise.reject({ statusCode: 404 });
    }

    if (
      request.method === "POST" &&
      request.uriTemplate?.endsWith("/{projectKey}/import-containers") === true
    ) {
      containerExists = true;

      return Promise.resolve({
        body: {
          createdAt: "2026-09-01T00:00:00.000Z",
          expiresAt: containerExpiresAt,
          key: catalogProductImportContainerKey,
          lastModifiedAt: "2026-09-01T00:00:00.000Z",
          resourceType: "product-draft",
          retentionPolicy: {
            config: { timeToLive: "30d" },
            strategy: "ttl",
          },
          version: 1,
        },
      });
    }

    if (
      request.method === "POST" &&
      request.uriTemplate?.includes("/product-drafts/import-containers/") ===
        true
    ) {
      const body = request.body as ProductDraftImportRequest;
      const resources = body.resources as ProductDraftImport[];
      const operationIds = resources.map((resource) => {
        const attempt = (attempts.get(resource.key) ?? 0) + 1;
        attempts.set(resource.key, attempt);
        const id = `operation-${nextOperation}`;
        nextOperation += 1;
        const firstPartialAttempt =
          resource.key === "catalog-product-05" && attempt === 1;
        const firstRejectedAttempt =
          resource.key === "catalog-product-06" && attempt === 1;
        const firstPendingAttempt =
          resource.key === "catalog-product-07" && attempt === 1;
        let state:
          | "imported"
          | "partiallyImported"
          | "processing"
          | "validationFailed" = "imported";

        if (firstPartialAttempt) {
          state = "partiallyImported";
        } else if (firstRejectedAttempt) {
          state = "validationFailed";
        } else if (firstPendingAttempt) {
          state = "processing";
        }

        operations.set(id, {
          createdAt: "2026-01-01T00:00:00.000Z",
          ...(state === "imported" || state === "partiallyImported"
            ? { resourceVersion: attempt }
            : {}),
          ...(state === "partiallyImported" || state === "validationFailed"
            ? { errors: [operationError] }
            : {}),
          expiresAt: "2026-01-03T00:00:00.000Z",
          id,
          importContainerKey: catalogProductImportContainerKey,
          lastModifiedAt: "2026-01-01T00:00:01.000Z",
          resourceKey: resource.key,
          state,
          version: 1,
        });

        return id;
      });

      submissions.push(resources.map((resource) => resource.key));

      return Promise.resolve({
        body: {
          // Deliberately reverse the provider response. The helper must poll
          // and correlate by ImportOperation.resourceKey, never array order.
          operationStatus: [...operationIds]
            .reverse()
            .map((operationId) => ({ operationId, state: "processing" })),
        },
      });
    }

    if (
      request.method === "GET" &&
      request.uriTemplate?.includes("/import-operations/{id}") === true
    ) {
      const id = String(request.pathVariables?.id);
      const operation = operations.get(id);

      if (operation === undefined) {
        return Promise.reject(
          new Error(`Unknown scripted Import Operation ${id}`)
        );
      }

      if (
        operation.resourceKey === "catalog-product-07" &&
        operation.state === "processing"
      ) {
        const pollCount = (polls.get(id) ?? 0) + 1;
        polls.set(id, pollCount);

        if (pollCount > 1) {
          const imported: ImportOperation = {
            ...operation,
            resourceVersion: 1,
            state: "imported",
          };
          operations.set(id, imported);
          return Promise.resolve({ body: imported });
        }
      }

      return Promise.resolve({ body: operation });
    }

    return Promise.reject(
      new Error(
        `Unexpected scripted Import API request: ${request.method} ${request.uriTemplate}`
      )
    );
  };

  const apiRoot = new ImportApiRoot({ executeRequest });

  return {
    layer: CommercetoolsImportSdk.layerFromApiRoot({
      apiRoot,
      projectKey: "example-import-project",
    }),
    submissions,
  };
};

const stateFor = (
  states: Iterable<MigrationItemState>,
  sourceIdentity: string
): MigrationItemState | undefined =>
  Array.from(states).find(
    (state) => state.sourceIdentity.encoded === sourceIdentity
  );

describe("product Import API Process Batch example", () => {
  it.live("runs inline and durably settles mixed batch outcomes", () =>
    Effect.gen(function* () {
      const importApi = makeImportApiFixture();
      const storeState = InMemoryMigrationStore.makeState();
      const options = {
        importSdkLayer: importApi.layer,
        pollTimeout: 0,
        sourceBatchSize: 21,
        storeLayer: InMemoryMigrationStore.layer(storeState),
      };

      const first = yield* runCatalogProductImportMigration(options);
      const states = [...storeState.itemStates.values()];
      const imported = stateFor(states, "catalog-product-01");
      const partiallyImported = stateFor(states, "catalog-product-05");
      const validationFailed = stateFor(states, "catalog-product-06");
      const pending = stateFor(states, "catalog-product-07");

      expect(first.status).toBe("failed");
      expect(first.definitions[0]?.counts).toMatchObject({
        failed: 3,
        migrated: 22,
        skipped: 0,
      });
      expect(importApi.submissions.map((batch) => batch.length)).toEqual([
        20, 1, 4,
      ]);
      expect(importApi.submissions[0]).toEqual(
        catalogProductImportItems.slice(0, 20).map((item) => item.identityKey)
      );
      expect(importApi.submissions[1]).toEqual([
        catalogProductImportItems[20]?.identityKey,
      ]);
      expect(importApi.submissions[2]).toEqual(
        catalogProductImportItems.slice(21).map((item) => item.identityKey)
      );
      expect(storeState.sourceCursorCommits).toHaveLength(1);
      expect(storeState.sourceCursors.size).toBe(0);

      expect(imported).toMatchObject({
        journal: {
          extensions: {
            "commercetools.product-draft.import-operation@v1": {
              resourceKey: "catalog-product-01",
              state: "imported",
            },
          },
        },
        status: "migrated",
        trackingRecord: {
          productKey: "catalog-product-01",
          productVersion: 1,
        },
      });
      expect(imported?.journal?.process.entries).toEqual([
        expect.objectContaining({
          descriptorId: "commercetools.product-draft.imported",
          kind: "change",
          value: expect.objectContaining({
            resourceKey: "catalog-product-01",
            state: "imported",
          }),
        }),
      ]);
      expect(partiallyImported?.status).toBe("failed");
      expect(partiallyImported?.journal?.extensions).toMatchObject({
        "commercetools.product-draft.import-operation@v1": {
          issues: [operationError],
          resourceKey: "catalog-product-05",
          state: "partiallyImported",
        },
      });
      expect(partiallyImported?.journal?.process.entries).toEqual([
        expect.objectContaining({
          descriptorId: "commercetools.product-draft.partially-imported",
          kind: "change",
          value: expect.objectContaining({
            issues: [operationError],
            resourceKey: "catalog-product-05",
            state: "partiallyImported",
          }),
        }),
      ]);
      expect(validationFailed).toMatchObject({ status: "failed" });
      expect(validationFailed?.journal).toMatchObject({
        extensions: {
          "commercetools.product-draft.import-operation@v1": {
            issues: [operationError],
            resourceKey: "catalog-product-06",
            state: "validationFailed",
          },
        },
        process: { entries: [] },
      });
      expect(pending?.journal).toMatchObject({
        extensions: {
          "commercetools.product-draft.import-operation@v1": {
            resourceKey: "catalog-product-07",
            state: "processing",
          },
        },
        process: { entries: [] },
      });

      const second = yield* runCatalogProductImportMigration(options);

      expect(second.status).toBe("succeeded");
      expect(second.definitions[0]?.counts).toMatchObject({
        failed: 0,
        migrated: 3,
      });
      expect(importApi.submissions.map((batch) => batch.length)).toEqual([
        20, 1, 4, 2,
      ]);
      expect(importApi.submissions[3]).toEqual([
        "catalog-product-05",
        "catalog-product-06",
      ]);
      expect(storeState.itemStates.size).toBe(25);
      expect(
        Array.from(storeState.itemStates.values()).every(
          (state) => state.status === "migrated"
        )
      ).toBe(true);

      const retriedPartial = stateFor(
        storeState.itemStates.values(),
        "catalog-product-05"
      );
      expect(
        retriedPartial?.journal?.process.entries.map((entry) => ({
          descriptorId: entry.kind === "change" ? entry.descriptorId : null,
          sequence: entry.sequence,
        }))
      ).toEqual([
        {
          descriptorId: "commercetools.product-draft.imported",
          sequence: 0,
        },
      ]);
      expect(retriedPartial?.journal?.extensions).toMatchObject({
        "commercetools.product-draft.import-operation@v1": {
          resourceKey: "catalog-product-05",
          state: "imported",
        },
      });
    })
  );

  it.live(
    "fails only the item whose saved Import Operation extension is invalid",
    () =>
      Effect.gen(function* () {
        const importApi = makeImportApiFixture();
        const storeState = InMemoryMigrationStore.makeState();
        const initialItems = catalogProductImportItems.slice(0, 2);
        const options = {
          importSdkLayer: importApi.layer,
          items: initialItems,
          pollTimeout: 0,
          sourceBatchSize: 2,
          storeLayer: InMemoryMigrationStore.layer(storeState),
        };

        const first = yield* runCatalogProductImportMigration(options);
        const corruptStateKey = InMemoryMigrationStore.itemStateKey(
          "product-import-batch",
          "catalog-product-01"
        );
        const corruptState = storeState.itemStates.get(corruptStateKey);

        if (corruptState?.journal === undefined) {
          return yield* Effect.die(
            "Expected the first imported item to have a journal"
          );
        }

        storeState.itemStates.set(corruptStateKey, {
          ...corruptState,
          journal: {
            ...corruptState.journal,
            extensions: {
              ...corruptState.journal.extensions,
              [productDraftImportOperationExtensionId]: {
                containerKey: catalogProductImportContainerKey,
                operationId: "operation-corrupt",
                resourceKey: "a-different-product",
                resourceType: "product-draft",
                resourceVersion: 1,
                state: "imported",
              },
            },
          },
        });

        const updatedItems = initialItems.map((item) => ({
          ...item,
          version: "source-version-2",
        }));
        const second = yield* runCatalogProductImportMigration({
          ...options,
          items: updatedItems,
        });
        const failed = stateFor(
          storeState.itemStates.values(),
          "catalog-product-01"
        );
        const migrated = stateFor(
          storeState.itemStates.values(),
          "catalog-product-02"
        );

        expect(first.status).toBe("succeeded");
        expect(second.status).toBe("failed");
        expect(second.definitions[0]?.counts).toMatchObject({
          failed: 1,
          migrated: 1,
          skipped: 0,
        });
        expect(importApi.submissions).toEqual([
          ["catalog-product-01", "catalog-product-02"],
          ["catalog-product-02"],
        ]);
        expect(failed).toMatchObject({
          error: { kind: "process" },
          sourceVersion: "source-version-2",
          status: "failed",
        });
        expect(failed?.journal?.extensions).toMatchObject({
          [productDraftImportOperationExtensionId]: {
            resourceKey: "a-different-product",
          },
        });
        expect(migrated).toMatchObject({
          sourceVersion: "source-version-2",
          status: "migrated",
          trackingRecord: {
            productKey: "catalog-product-02",
            productVersion: 2,
          },
        });
      })
  );

  it.live(
    "does not settle items or advance the cursor when provider operations cannot be correlated",
    () =>
      Effect.gen(function* () {
        const expiresAt = new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000
        ).toISOString();
        const apiRoot = new ImportApiRoot({
          executeRequest: (request) => {
            if (
              request.method === "GET" &&
              request.uriTemplate?.endsWith(
                "/import-containers/{importContainerKey}"
              ) === true
            ) {
              return Promise.resolve({
                body: {
                  createdAt: "2026-09-01T00:00:00.000Z",
                  expiresAt,
                  key: catalogProductImportContainerKey,
                  lastModifiedAt: "2026-09-01T00:00:00.000Z",
                  resourceType: "product-draft",
                  retentionPolicy: {
                    config: { timeToLive: "30d" },
                    strategy: "ttl",
                  },
                  version: 1,
                },
              });
            }
            if (
              request.method === "POST" &&
              request.uriTemplate?.includes(
                "/product-drafts/import-containers/"
              ) === true
            ) {
              return Promise.resolve({
                body: {
                  operationStatus: [{ state: "processing" }],
                },
              });
            }

            return Promise.reject(
              new Error(
                `Unexpected scripted Import API request: ${request.method} ${request.uriTemplate}`
              )
            );
          },
        });
        const storeState = InMemoryMigrationStore.makeState();
        const item = catalogProductImportItems[0];
        if (item === undefined) {
          return yield* Effect.die("Expected one catalog import fixture item");
        }
        const error = yield* runCatalogProductImportMigration({
          importSdkLayer: CommercetoolsImportSdk.layerFromApiRoot({
            apiRoot,
            projectKey: "example-import-project",
          }),
          items: [item],
          pollTimeout: 0,
          storeLayer: InMemoryMigrationStore.layer(storeState),
        }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(ProcessBatchContractError);
        expect(storeState.itemStates.size).toBe(0);
        expect(storeState.sourceCursorCommits).toEqual([]);
        expect(storeState.sourceCursors.size).toBe(0);
      })
  );
});
