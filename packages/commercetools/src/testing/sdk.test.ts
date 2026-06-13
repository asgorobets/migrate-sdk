import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  MigrationStore,
  toMigrationDefinitionId,
  toMigrationRunId,
} from "migrate-sdk";
import { CommercetoolsMigrationStore } from "../migration-store/index.ts";
import { CommercetoolsSdk, CommercetoolsSdkError } from "../sdk.ts";
import { makeScriptedCustomObjectRoutes } from "./custom-objects.ts";
import {
  makeScriptedCommercetoolsSdk,
  scriptedCommercetoolsSdkRoute,
} from "./sdk.ts";

describe("makeScriptedCommercetoolsSdk", () => {
  it.effect(
    "routes generated SDK requests by operation and request shape",
    () =>
      Effect.gen(function* () {
        const scripted = makeScriptedCommercetoolsSdk({
          projectKey: "test-project",
          routes: [
            scriptedCommercetoolsSdkRoute("products.createDraft")
              .matchBody(
                (body) =>
                  typeof body === "object" &&
                  body !== null &&
                  "key" in body &&
                  body.key === "example-product"
              )
              .reply({
                id: "product-1",
                version: 1,
              }),
          ],
        });
        const sdk = yield* CommercetoolsSdk.pipe(
          Effect.provide(scripted.layer)
        );

        const product = yield* sdk.request("products.createDraft", (project) =>
          project.products().post({
            body: {
              key: "example-product",
              name: {
                "en-US": "Example Product",
              },
              productType: {
                key: "book",
                typeId: "product-type",
              },
              slug: {
                "en-US": "example-product",
              },
            },
          })
        );

        expect(product).toEqual({
          id: "product-1",
          version: 1,
        });
        expect(scripted.requests).toHaveLength(1);
        expect(scripted.requests[0]).toMatchObject({
          body: {
            key: "example-product",
          },
          method: "POST",
          operation: "products.createDraft",
          pathVariables: {
            projectKey: "test-project",
          },
          uri: "/test-project/products",
          uriTemplate: "/{projectKey}/products",
        });
      })
  );

  it.effect("matches path variables without counting request order", () =>
    Effect.gen(function* () {
      const scripted = makeScriptedCommercetoolsSdk({
        projectKey: "test-project",
        routes: [
          scriptedCommercetoolsSdkRoute("products.readById")
            .matchPath({
              ID: "product-1",
            })
            .reply({
              id: "product-1",
              version: 1,
            }),
        ],
      });
      const sdk = yield* CommercetoolsSdk.pipe(Effect.provide(scripted.layer));

      const product = yield* sdk.request("products.readById", (project) =>
        project.products().withId({ ID: "product-1" }).get()
      );

      expect(product).toEqual({
        id: "product-1",
        version: 1,
      });
    })
  );

  it.effect(
    "can provide the migration store through scripted Custom Object routes",
    () => {
      const customObjects = makeScriptedCustomObjectRoutes();
      const scripted = makeScriptedCommercetoolsSdk({
        projectKey: "test-project",
        routes: customObjects.routes,
      });
      const storeLayer = CommercetoolsMigrationStore.layer({
        container: "migrate-sdk",
        namespace: "scripted-sdk",
      }).pipe(Layer.provide(scripted.layer));

      return Effect.gen(function* () {
        const store = yield* MigrationStore;
        const lock = yield* store.acquireDefinitionLock(
          toMigrationDefinitionId("products"),
          toMigrationRunId("run-scripted-sdk")
        );

        yield* store.releaseDefinitionLock(lock);

        expect(
          customObjects.requests.map((request) => request.operation)
        ).toEqual([
          "customObjects.upsertMigrationStoreRecord",
          "customObjects.getMigrationStoreRecord",
          "customObjects.deleteMigrationStoreRecord",
        ]);
        expect(scripted.requests).toHaveLength(customObjects.requests.length);
      }).pipe(Effect.provide(storeLayer));
    }
  );

  it.effect("fails with request details when no scripted route matches", () =>
    Effect.gen(function* () {
      const scripted = makeScriptedCommercetoolsSdk({
        projectKey: "test-project",
        routes: [],
      });
      const sdk = yield* CommercetoolsSdk.pipe(Effect.provide(scripted.layer));

      const error = yield* sdk
        .request("products.createDraft", (project) =>
          project.products().post({
            body: {
              key: "example-product",
              name: {
                "en-US": "Example Product",
              },
              productType: {
                key: "book",
                typeId: "product-type",
              },
              slug: {
                "en-US": "example-product",
              },
            },
          })
        )
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(CommercetoolsSdkError);
      expect(error.message).toBe(
        "Commercetools SDK operation failed: products.createDraft"
      );
      expect(error.cause).toBeInstanceOf(Error);
      expect(String(error.cause)).toContain(
        "No scripted Commercetools SDK route matched request"
      );
      expect(String(error.cause)).toContain("/{projectKey}/products");
    })
  );
});
