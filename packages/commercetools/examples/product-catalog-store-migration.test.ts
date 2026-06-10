import { describe, expect, it } from "@effect/vitest";
import type { ProductDraftInput } from "@migrate-sdk/commercetools/destination";
import type { RecordedCommercetoolsRequest } from "@migrate-sdk/commercetools/testing";
import { Effect } from "effect";
import {
  formatProductCatalogStoreMigrationExampleResult,
  runProductCatalogStoreMigrationExample,
} from "./product-catalog-store-migration.ts";

const isCustomObjectRequest = (
  request: RecordedCommercetoolsRequest
): boolean => request.uriTemplate?.includes("custom-objects") === true;

const isDirectCustomObjectRequest = (
  request: RecordedCommercetoolsRequest
): boolean =>
  isCustomObjectRequest(request) &&
  typeof request.pathVariables?.key === "string";

const isCustomObjectQueryRequest = (
  request: RecordedCommercetoolsRequest
): boolean =>
  isCustomObjectRequest(request) &&
  typeof request.queryParams?.where === "string";

describe("product catalog store migration example", () => {
  it.effect(
    "runs a product catalog migration with the Commercetools migration store",
    () =>
      Effect.gen(function* () {
        const result = yield* runProductCatalogStoreMigrationExample();
        const itemState = result.itemStates[0];
        const directStoreRequest = result.sdkRequests.find(
          isDirectCustomObjectRequest
        );
        const queryStoreRequest = result.sdkRequests.find(
          isCustomObjectQueryRequest
        );

        expect(result.summary.status).toBe("succeeded");
        expect(result.summary.definitions).toHaveLength(1);
        expect(result.summary.definitions[0]?.counts).toMatchObject({
          failed: 0,
          migrated: 1,
          needsUpdate: 0,
          skipped: 0,
          unchanged: 0,
        });
        expect(result.productRequestCount).toBe(1);
        expect(result.productDraft).toMatchObject({
          key: "effectful-architecture",
          masterVariant: {
            sku: "effectful-architecture-paperback",
          },
          productType: {
            key: "book",
            typeId: "product-type",
          },
        } satisfies Partial<ProductDraftInput>);
        expect(result.customObjectRequestCount).toBeGreaterThan(0);
        expect(directStoreRequest).toBeDefined();
        expect(queryStoreRequest?.queryParams).toMatchObject({
          "var.definitionId": "products",
          "var.namespace": "product-catalog",
          "var.recordKind": "migration-item-state",
          sort: "key asc",
          where:
            "value(namespace = :namespace) and value(recordKind = :recordKind) and value(index(definitionId = :definitionId))",
          withTotal: false,
        });
        expect(result.itemStates).toHaveLength(1);
        expect(itemState).toMatchObject({
          definitionId: "products",
          destinationIdentity: "recording-product-id",
          destinationVersion: "1",
          sourceIdentity: "book:effectful-architecture",
          sourceVersion: "source-version-1",
          status: "migrated",
        });
      })
  );

  it.effect("formats the example output", () =>
    Effect.gen(function* () {
      const result = yield* runProductCatalogStoreMigrationExample();

      expect(formatProductCatalogStoreMigrationExampleResult(result)).toContain(
        "Commercetools Product Catalog Store Migration Example"
      );
    })
  );
});
