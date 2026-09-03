import {
  type ClientRequest,
  ApiRoot as ImportApiRoot,
} from "@commercetools/importapi-sdk";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { CommercetoolsImportSdk, CommercetoolsImportSdkError } from "./sdk.ts";

describe("CommercetoolsImportSdk", () => {
  it.effect("binds an Import API root to one project", () => {
    const requests: ClientRequest[] = [];
    const apiRoot = new ImportApiRoot({
      executeRequest: (request) => {
        requests.push(request);

        return Promise.resolve({
          body: {
            operationStatus: [
              { operationId: "operation-1", state: "processing" },
            ],
          },
        });
      },
    });
    const layer = CommercetoolsImportSdk.layerFromApiRoot({
      apiRoot,
      projectKey: "example-project",
    });

    return Effect.gen(function* () {
      const sdk = yield* CommercetoolsImportSdk;
      const response = yield* sdk.request("productDrafts.import", (project) =>
        project
          .productDrafts()
          .importContainers()
          .withImportContainerKeyValue({
            importContainerKey: "catalog-products",
          })
          .post({
            body: {
              resources: [
                {
                  key: "product-1",
                  name: { en: "Product 1" },
                  productType: {
                    key: "book",
                    typeId: "product-type",
                  },
                  slug: { en: "product-1" },
                },
              ],
              type: "product-draft",
            },
          })
      );

      expect(response.operationStatus).toEqual([
        { operationId: "operation-1", state: "processing" },
      ]);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: "POST",
        pathVariables: {
          importContainerKey: "catalog-products",
          projectKey: "example-project",
        },
        uriTemplate:
          "/{projectKey}/product-drafts/import-containers/{importContainerKey}",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("wraps generated SDK failures with operation context", () => {
    const apiRoot = new ImportApiRoot({
      executeRequest: () => Promise.reject(new Error("Import API unavailable")),
    });
    const layer = CommercetoolsImportSdk.layerFromApiRoot({
      apiRoot,
      projectKey: "example-project",
    });

    return Effect.gen(function* () {
      const sdk = yield* CommercetoolsImportSdk;
      const error = yield* sdk
        .request("importOperations.get", (project) =>
          project.importOperations().withIdValue({ id: "operation-1" }).get()
        )
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(CommercetoolsImportSdkError);
      expect(error.operation).toBe("importOperations.get");
      expect(error.message).toBe(
        "Commercetools Import SDK operation failed: importOperations.get"
      );
      expect(String(error.cause)).toContain("Import API unavailable");
      expect(error.acceptance).toBe("unknown");
    }).pipe(Effect.provide(layer));
  });

  it.effect("marks HTTP failures as definitely not accepted", () => {
    const apiRoot = new ImportApiRoot({
      executeRequest: () => Promise.reject({ statusCode: 400 }),
    });
    const layer = CommercetoolsImportSdk.layerFromApiRoot({
      apiRoot,
      projectKey: "example-project",
    });

    return Effect.gen(function* () {
      const sdk = yield* CommercetoolsImportSdk;
      const error = yield* sdk
        .request("importOperations.get", (project) =>
          project.importOperations().withIdValue({ id: "operation-1" }).get()
        )
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        acceptance: "not-accepted",
        statusCode: 400,
      });
    }).pipe(Effect.provide(layer));
  });

  for (const statusCode of [0, 502, 504]) {
    it.effect(`keeps status ${statusCode} acceptance unknown`, () => {
      const apiRoot = new ImportApiRoot({
        executeRequest: () => Promise.reject({ statusCode }),
      });
      const layer = CommercetoolsImportSdk.layerFromApiRoot({
        apiRoot,
        projectKey: "example-project",
      });

      return Effect.gen(function* () {
        const sdk = yield* CommercetoolsImportSdk;
        const error = yield* sdk
          .request("productDrafts.import", (project) =>
            project
              .productDrafts()
              .importContainers()
              .withImportContainerKeyValue({
                importContainerKey: "catalog-products",
              })
              .post({ body: { resources: [], type: "product-draft" } })
          )
          .pipe(Effect.flip);

        expect(error).toMatchObject({ acceptance: "unknown", statusCode });
      }).pipe(Effect.provide(layer));
    });
  }
});
