import { ApiRoot } from "@commercetools/platform-sdk";
import { describe, expect, it } from "@effect/vitest";
import { CommercetoolsMigrationStore } from "@migrate-sdk/commercetools/migration-store";
import { makeRecordingCustomObjectApiRoot } from "@migrate-sdk/commercetools/testing";
import { Effect, Schema } from "effect";
import {
  type MigrationItemState,
  MigrationStore,
  SourceIdentity,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceVersion,
} from "migrate-sdk";

const definitionId = toMigrationDefinitionId("summary-products");
const valueSelectionPattern = /\bvalue\b/u;
const finishedSelectionPattern =
  /\b(?:failed|skipped|needsUpdate|total|offset|value)\b/u;
const graphqlPathPattern = /\/graphql$/u;
const identity = SourceIdentity.make({
  id: "summary-products@v1",
  schema: SourceIdentity.key("id", Schema.String),
});
const state = (
  id: string,
  status: MigrationItemState["status"]
): MigrationItemState => ({
  definitionId,
  error: { errorTag: "Example", kind: "process", message: "Example failure" },
  lastRunId: toMigrationRunId("run-summary"),
  reason: "Example update",
  skipReason: "Example skip",
  sourceIdentity: SourceIdentity.fromKey(identity, id),
  sourceVersion: toSourceVersion("1"),
  status,
  trackingRecord: { nullable: null },
  updatedAt: new Date("2026-10-26T00:00:00.000Z"),
});

describe("Commercetools item state summary", () => {
  it.effect(
    "counts every status in one request without reading item values",
    () => {
      const recording = makeRecordingCustomObjectApiRoot({
        beforeRequest: (request) => {
          if (request.method === "GET") {
            throw new Error("Summary must not retrieve item values");
          }
        },
      });
      return Effect.gen(function* () {
        const store = yield* MigrationStore;
        for (const [id, status] of [
          ["a", "migrated"],
          ["b", "migrated"],
          ["c", "failed"],
          ["d", "skipped"],
          ["e", "needs-update"],
        ] as const) {
          yield* store.upsertItemState(state(id, status));
        }
        yield* store.upsertItemState({
          ...state("other-definition", "failed"),
          definitionId: toMigrationDefinitionId("another-definition"),
        });
        for (const options of [
          { container: "migrate-sdk", namespace: "another-namespace" },
          { container: "another-container", namespace: "summary-tests" },
        ]) {
          yield* Effect.flatMap(MigrationStore, (otherStore) =>
            otherStore.upsertItemState(state("other-store", "failed"))
          ).pipe(
            Effect.provide(
              CommercetoolsMigrationStore.layerFromApiRoot({
                apiRoot: recording.apiRoot,
                projectKey: "test-project",
                ...options,
              })
            )
          );
        }
        expect(yield* store.getItemStateSummary(definitionId)).toEqual({
          migrated: 2,
          failed: 1,
          skipped: 1,
          needsUpdate: 1,
        });
        const queries = recording.requests.filter((request) =>
          request.uriTemplate?.endsWith("/graphql")
        );
        expect(queries).toHaveLength(1);
        expect(queries[0]?.body).toEqual(
          expect.objectContaining({
            query: expect.not.stringMatching(valueSelectionPattern),
          })
        );
      }).pipe(
        Effect.provide(
          CommercetoolsMigrationStore.layerFromApiRoot({
            apiRoot: recording.apiRoot,
            namespace: "summary-tests",
            projectKey: "test-project",
          })
        )
      );
    }
  );

  it.effect(
    "paginates each status independently and counts beyond the total limit",
    () => {
      const recording = makeRecordingCustomObjectApiRoot();
      return Effect.gen(function* () {
        const store = yield* MigrationStore;
        for (let index = 0; index < 10_003; index++) {
          yield* store.upsertItemState(state(String(index), "migrated"));
        }
        yield* store.upsertItemState(state("failure", "failed"));
        yield* store.upsertItemState(state("skip", "skipped"));
        yield* store.upsertItemState(state("update", "needs-update"));
        expect(yield* store.getItemStateSummary(definitionId)).toEqual({
          migrated: 10_003,
          failed: 1,
          skipped: 1,
          needsUpdate: 1,
        });
        const queries = recording.requests.filter((request) =>
          request.uriTemplate?.endsWith("/graphql")
        );
        expect(queries).toHaveLength(21);
        for (const request of queries.slice(1)) {
          expect(request.body).toEqual(
            expect.objectContaining({
              query: expect.not.stringMatching(finishedSelectionPattern),
            })
          );
        }
      }).pipe(
        Effect.provide(
          CommercetoolsMigrationStore.layerFromApiRoot({
            apiRoot: recording.apiRoot,
            namespace: "summary-tests",
            projectKey: "test-project",
          })
        )
      );
    }
  );

  it.effect("returns an empty summary without writing anything", () => {
    const recording = makeRecordingCustomObjectApiRoot();
    return Effect.gen(function* () {
      const store = yield* MigrationStore;
      expect(yield* store.getItemStateSummary(definitionId)).toEqual({
        migrated: 0,
        failed: 0,
        skipped: 0,
        needsUpdate: 0,
      });
      expect(recording.requests).toHaveLength(1);
      expect(recording.requests[0]?.uriTemplate).toMatch(graphqlPathPattern);
    }).pipe(
      Effect.provide(
        CommercetoolsMigrationStore.layerFromApiRoot({
          apiRoot: recording.apiRoot,
          namespace: "summary-tests",
          projectKey: "test-project",
        })
      )
    );
  });

  it.effect("converges after a status changes during a paginated scan", () => {
    let changeDuringScan: (() => Promise<void>) | undefined;
    let changeApplied = false;
    let summaryRequests = 0;
    let forbidValueReads = false;
    const recording = makeRecordingCustomObjectApiRoot({
      beforeRequest: (request) => {
        if (forbidValueReads && request.method === "GET") {
          throw new Error("Summary must not retrieve item values");
        }
        if (request.uriTemplate?.endsWith("/graphql")) {
          summaryRequests++;
          if (summaryRequests === 2 && changeDuringScan !== undefined) {
            changeApplied = true;
            return changeDuringScan();
          }
        }
      },
    });
    return Effect.gen(function* () {
      const store = yield* MigrationStore;
      yield* store.upsertItemState(state("first", "migrated"));
      yield* store.upsertItemState(state("second", "migrated"));
      const [lowerKeyItem, higherKeyItem] =
        yield* store.listItemStates(definitionId);
      if (lowerKeyItem === undefined || higherKeyItem === undefined) {
        throw new Error("Expected two stored items");
      }
      yield* store.upsertItemState({
        ...lowerKeyItem,
        status: "failed",
        error: {
          errorTag: "Example",
          kind: "process",
          message: "Example failure",
        },
      });
      const runPromise = Effect.runPromiseWith(
        yield* Effect.context<MigrationStore>()
      );
      changeDuringScan = () =>
        runPromise(
          store.upsertItemState({
            ...higherKeyItem,
            status: "failed",
            error: {
              errorTag: "Example",
              kind: "process",
              message: "Example failure",
            },
            updatedAt: new Date("2026-10-26T00:01:00.000Z"),
          })
        );
      forbidValueReads = true;

      // A live scan may straddle both statuses. Its transient distribution is
      // deliberately not part of the contract; the next stable scan is.
      yield* store.getItemStateSummary(definitionId);
      expect(changeApplied).toBe(true);
      expect(yield* store.getItemStateSummary(definitionId)).toEqual({
        migrated: 0,
        failed: 2,
        skipped: 0,
        needsUpdate: 0,
      });
    }).pipe(
      Effect.provide(
        CommercetoolsMigrationStore.layerFromApiRoot({
          apiRoot: recording.apiRoot,
          namespace: "summary-tests",
          projectKey: "test-project",
          pageSize: 1,
        })
      )
    );
  });

  it.effect("escapes definition identifiers inside predicate variables", () => {
    const recording = makeRecordingCustomObjectApiRoot();
    const quotedId = toMigrationDefinitionId('catalog-"quoted"-\\path');
    return Effect.gen(function* () {
      const store = yield* MigrationStore;
      yield* store.upsertItemState({
        ...state("quoted", "migrated"),
        definitionId: quotedId,
      });
      expect(yield* store.getItemStateSummary(quotedId)).toEqual({
        migrated: 1,
        failed: 0,
        skipped: 0,
        needsUpdate: 0,
      });
    }).pipe(
      Effect.provide(
        CommercetoolsMigrationStore.layerFromApiRoot({
          apiRoot: recording.apiRoot,
          namespace: "summary-tests",
          projectKey: "test-project",
        })
      )
    );
  });

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

  for (const [description, formatVersion, indexStatus, stateStatus] of [
    ["future format", 2, "migrated", "migrated"],
    ["missing format", undefined, "migrated", "migrated"],
    ["unknown status", 1, "unknown", "unknown"],
    ["missing status", 1, undefined, undefined],
    ["mismatched status", 1, "failed", "migrated"],
  ] as const) {
    it.effect(`rejects ${description} without retrieving the value`, () => {
      const recording = makeRecordingCustomObjectApiRoot();
      return Effect.gen(function* () {
        yield* Effect.promise(() =>
          recording.apiRoot
            .withProjectKey({ projectKey: "test-project" })
            .customObjects()
            .post({
              body: {
                container: "migrate-sdk",
                key: "legacy-state",
                value: {
                  formatVersion,
                  namespace: "summary-tests",
                  recordKind: "migration-item-state",
                  index: { definitionId, status: indexStatus },
                  state: { status: stateStatus },
                },
              },
            })
            .execute()
        );
        const store = yield* MigrationStore;
        const failure = yield* store
          .getItemStateSummary(definitionId)
          .pipe(Effect.flip);
        expect(failure).toMatchObject({
          _tag: "MigrationStoreError",
          message: expect.stringContaining(
            "invalid status metadata or unsupported record format"
          ),
        });
        expect(recording.requests.some(({ method }) => method === "GET")).toBe(
          false
        );
      }).pipe(
        Effect.provide(
          CommercetoolsMigrationStore.layerFromApiRoot({
            apiRoot: recording.apiRoot,
            namespace: "summary-tests",
            projectKey: "test-project",
          })
        )
      );
    });
  }

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
