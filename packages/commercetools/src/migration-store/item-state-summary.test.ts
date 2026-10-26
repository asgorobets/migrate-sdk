import { ApiRoot } from "@commercetools/platform-sdk";
import { describe, expect, it } from "@effect/vitest";
import { CommercetoolsMigrationStore } from "@migrate-sdk/commercetools/migration-store";
import { Effect } from "effect";
import { MigrationStore, toMigrationDefinitionId } from "migrate-sdk";

const definitionId = toMigrationDefinitionId("summary-products");

describe("Commercetools summary response validation", () => {
  it.effect(
    "rejects a repeated cursor instead of looping or returning partial counts",
    () => {
      let requests = 0;
      const apiRoot = new ApiRoot({
        executeRequest: () => {
          requests++;
          return Promise.resolve({
            body: {
              data: {
                invalid: { exists: false },
                migrated: { count: 1, results: [{ key: "repeated" }] },
                failed: { count: 0, results: [] },
                skipped: { count: 0, results: [] },
                needsUpdate: { count: 0, results: [] },
              },
            },
          });
        },
      });
      return Effect.gen(function* () {
        const store = yield* MigrationStore;
        const failure = yield* store
          .getItemStateSummary(definitionId)
          .pipe(Effect.flip);
        expect(failure.message).toContain("non-advancing keyset page");
        expect(requests).toBe(2);
      }).pipe(
        Effect.provide(
          CommercetoolsMigrationStore.layerFromApiRoot({
            apiRoot,
            namespace: "summary-tests",
            projectKey: "test-project",
            pageSize: 1,
          })
        )
      );
    }
  );

  for (const [description, response] of [
    [
      "GraphQL errors with partial data",
      { errors: [{ message: "Denied" }], data: {} },
    ],
    ["missing data", {}],
    ["missing status page", { data: { invalid: { exists: false } } }],
    [
      "inconsistent page count",
      {
        data: {
          invalid: { exists: false },
          migrated: { count: 2, results: [{ key: "a" }] },
        },
      },
    ],
    [
      "unordered keys",
      {
        data: {
          invalid: { exists: false },
          migrated: { count: 2, results: [{ key: "b" }, { key: "a" }] },
        },
      },
    ],
  ] as const) {
    it.effect(
      `fails rather than returning a partial summary for ${description}`,
      () => {
        const apiRoot = new ApiRoot({
          executeRequest: () => Promise.resolve({ body: response }),
        });
        return Effect.gen(function* () {
          const store = yield* MigrationStore;
          const failure = yield* store
            .getItemStateSummary(definitionId)
            .pipe(Effect.flip);
          expect(failure).toMatchObject({ _tag: "MigrationStoreError" });
        }).pipe(
          Effect.provide(
            CommercetoolsMigrationStore.layerFromApiRoot({
              apiRoot,
              namespace: "summary-tests",
              projectKey: "test-project",
            })
          )
        );
      }
    );
  }
});
