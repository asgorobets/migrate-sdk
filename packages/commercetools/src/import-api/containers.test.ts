import type { ImportContainer } from "@commercetools/importapi-sdk";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  makeScriptedCommercetoolsImportSdk,
  scriptedCommercetoolsImportSdkRoute,
} from "../testing/import-sdk.ts";
import {
  CommercetoolsImportContainerContractError,
  CommercetoolsImportContainers,
} from "./containers.ts";

const container = (expiresAt: string): ImportContainer => ({
  createdAt: "2026-09-01T00:00:00.000Z",
  expiresAt,
  key: "catalog-products",
  lastModifiedAt: "2026-09-01T00:00:00.000Z",
  resourceType: "product-draft",
  retentionPolicy: {
    config: { timeToLive: "30d" },
    strategy: "ttl",
  },
  version: 1,
});

describe("CommercetoolsImportContainers", () => {
  it.effect("creates a missing stable container key", () => {
    const created = container("2026-10-01T00:00:00.000Z");
    const scripted = makeScriptedCommercetoolsImportSdk({
      projectKey: "example-project",
      routes: [
        scriptedCommercetoolsImportSdkRoute("importContainers.get").fail({
          statusCode: 404,
        }),
        scriptedCommercetoolsImportSdkRoute("importContainers.create").reply(
          created
        ),
      ],
    });

    return Effect.gen(function* () {
      const ensured = yield* CommercetoolsImportContainers.ensure({
        key: "catalog-products",
        resourceType: "product-draft",
        retentionPolicy: {
          config: { timeToLive: "30d" },
          strategy: "ttl",
        },
      }).pipe(Effect.provide(scripted.layer));

      expect(ensured).toEqual(created);
      expect(scripted.requests.map((request) => request.operation)).toEqual([
        "importContainers.get",
        "importContainers.create",
      ]);
    });
  });

  it.effect(
    "requires key rotation when a container is too close to expiry",
    () => {
      const scripted = makeScriptedCommercetoolsImportSdk({
        projectKey: "example-project",
        routes: [
          scriptedCommercetoolsImportSdkRoute("importContainers.get").reply(
            container("1960-01-01T00:00:00.000Z")
          ),
        ],
      });

      return Effect.gen(function* () {
        const error = yield* CommercetoolsImportContainers.ensure({
          key: "catalog-products",
          resourceType: "product-draft",
        }).pipe(Effect.provide(scripted.layer), Effect.flip);

        expect(error).toBeInstanceOf(CommercetoolsImportContainerContractError);
        expect(error.message).toContain("rotate to a new container key");
        expect(scripted.requests).toHaveLength(1);
      });
    }
  );
});
