import { createHash } from "node:crypto";
import { ApiRoot as PlatformApiRoot } from "@commercetools/platform-sdk";
import { describe, expect, it } from "@effect/vitest";
import { CommercetoolsSdk } from "@migrate-sdk/commercetools";
import { CommercetoolsMigrationStore } from "@migrate-sdk/commercetools/migration-store";
import {
  makeRecordingCommercetoolsApiRoot,
  type RecordedCommercetoolsRequest,
} from "@migrate-sdk/commercetools/testing";
import { Data, Effect, Layer } from "effect";
import {
  MigrationStore,
  toDestinationIdentity,
  toDestinationVersion,
  toEncodedSourceCursor,
  toMigrationDefinitionId,
  toMigrationDefinitionLockToken,
  toMigrationRunId,
  toSourceIdentity,
  toSourceVersion,
} from "migrate-sdk";

const runIdPattern = /^run-/u;
const lockTokenPattern = /^lock-/u;
const definitionId = toMigrationDefinitionId("catalog-products");
const sourceIdentity = toSourceIdentity("product:sku-123");
const namespace = "catalog-import";

const hashedSegment = (value: string): string =>
  createHash("sha256").update(value).digest("base64url");

const sourceCursorKey = (definition: string): string =>
  `${namespace}__encoded-source-cursor__definition_${hashedSegment(definition)}`;

const itemStateKey = (definition: string, identity: string): string =>
  `${namespace}__migration-item-state__definition_${hashedSegment(definition)}__source_${hashedSegment(identity)}`;

const latestRunStateKey = (definition: string): string =>
  `${namespace}__latest-run-state__definition_${hashedSegment(definition)}`;

const definitionLockKey = (definition: string): string =>
  `${namespace}__migration-definition-lock__definition_${hashedSegment(definition)}`;

const itemStateQueryWhere = [
  "value(namespace = :namespace)",
  "value(recordKind = :recordKind)",
  "value(index(definitionId = :definitionId))",
].join(" and ");

const customObjectKey = (
  request: RecordedCommercetoolsRequest
): string | undefined => {
  const body = request.body;

  if (
    typeof body === "object" &&
    body !== null &&
    "container" in body &&
    "key" in body &&
    "value" in body &&
    typeof body.key === "string"
  ) {
    return body.key;
  }

  return undefined;
};

const customObjectQueryRequests = (
  requests: readonly RecordedCommercetoolsRequest[]
): readonly RecordedCommercetoolsRequest[] =>
  requests.filter(
    (request) =>
      request.method === "GET" &&
      request.pathVariables?.container === "migrate-sdk" &&
      request.pathVariables?.key === undefined
  );

class RecordedHttpError extends Data.TaggedError("RecordedHttpError")<{
  readonly cause: unknown;
  readonly statusCode?: number;
}> {}

const recordedHttpError = (cause: unknown): RecordedHttpError =>
  new RecordedHttpError({
    cause,
    ...(() => {
      if (
        typeof cause !== "object" ||
        cause === null ||
        !("statusCode" in cause)
      ) {
        return {};
      }

      const statusCode = cause.statusCode;

      return typeof statusCode === "number" ? { statusCode } : {};
    })(),
  });

const makeStoreLayer = (
  recording: ReturnType<typeof makeRecordingCommercetoolsApiRoot>,
  options: { readonly pageSize?: number } = {}
) =>
  CommercetoolsMigrationStore.layerFromApiRoot({
    apiRoot: recording.apiRoot,
    container: "migrate-sdk",
    namespace,
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    projectKey: "test-project",
  });

describe("CommercetoolsMigrationStore", () => {
  it.effect("records Custom Object create-only writes with version 0", () => {
    const recording = makeRecordingCommercetoolsApiRoot();
    const project = recording.apiRoot.withProjectKey({
      projectKey: "test-project",
    });

    return Effect.gen(function* () {
      const created = yield* Effect.promise(() =>
        project
          .customObjects()
          .post({
            body: {
              container: "migrate-sdk",
              key: "lock__catalog-products",
              value: { ownerRunId: "run-1" },
              version: 0,
            },
          })
          .execute()
      );

      expect(created.body.version).toBe(1);

      const duplicate = yield* Effect.tryPromise({
        try: () =>
          project
            .customObjects()
            .post({
              body: {
                container: "migrate-sdk",
                key: "lock__catalog-products",
                value: { ownerRunId: "run-2" },
                version: 0,
              },
            })
            .execute(),
        catch: recordedHttpError,
      }).pipe(Effect.flip);

      expect(duplicate).toMatchObject({
        statusCode: 409,
      });
    });
  });

  it.effect(
    "acquires definition locks with Custom Object version-zero create semantics",
    () => {
      const recording = makeRecordingCommercetoolsApiRoot();
      const ownerRunId = toMigrationRunId("run-lock-owner");
      const expectedKey = definitionLockKey(definitionId);

      return Effect.gen(function* () {
        const store = yield* MigrationStore;
        const lock = yield* store.acquireDefinitionLock(
          definitionId,
          ownerRunId
        );

        expect(lock).toMatchObject({
          definitionId,
          ownerRunId,
        });
        expect(lock.createdAt).toBeInstanceOf(Date);
        expect(lock.token).toMatch(lockTokenPattern);
        expect(recording.requests).toHaveLength(1);
        expect(recording.requests[0]).toMatchObject({
          body: {
            container: "migrate-sdk",
            key: expectedKey,
            value: {
              formatVersion: 1,
              index: {
                definitionId,
                ownerRunId,
              },
              namespace,
              recordKind: "migration-definition-lock",
              state: {
                createdAt: lock.createdAt.toISOString(),
                definitionId,
                ownerRunId,
                token: lock.token,
              },
            },
            version: 0,
          },
          method: "POST",
        });
      }).pipe(Effect.provide(makeStoreLayer(recording)));
    }
  );

  it.effect(
    "maps duplicate definition lock acquisition to a store error",
    () => {
      const recording = makeRecordingCommercetoolsApiRoot();
      const firstOwnerRunId = toMigrationRunId("run-lock-owner-1");
      const secondOwnerRunId = toMigrationRunId("run-lock-owner-2");

      return Effect.gen(function* () {
        const store = yield* MigrationStore;

        yield* store.acquireDefinitionLock(definitionId, firstOwnerRunId);
        const error = yield* store
          .acquireDefinitionLock(definitionId, secondOwnerRunId)
          .pipe(Effect.flip);

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationStoreError",
            message: "Migration definition is already locked",
          })
        );
        expect(recording.requests).toHaveLength(2);
        expect(recording.requests[1]).toMatchObject({
          body: {
            key: definitionLockKey(definitionId),
            version: 0,
          },
          method: "POST",
        });
      }).pipe(Effect.provide(makeStoreLayer(recording)));
    }
  );

  it.effect(
    "maps non-conflict SDK lock acquisition failures to store errors",
    () => {
      const apiRoot = new PlatformApiRoot({
        executeRequest: () =>
          Promise.reject({
            body: {
              message: "transient platform failure",
              statusCode: 500,
            },
            statusCode: 500,
          }),
      });

      return Effect.gen(function* () {
        const store = yield* MigrationStore;
        const error = yield* store
          .acquireDefinitionLock(
            definitionId,
            toMigrationRunId("run-lock-error")
          )
          .pipe(Effect.flip);

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationStoreError",
            message: expect.stringContaining(
              "Unable to acquire migration definition lock"
            ),
          })
        );
      }).pipe(
        Effect.provide(
          CommercetoolsMigrationStore.layerFromApiRoot({
            apiRoot,
            container: "migrate-sdk",
            namespace,
            projectKey: "test-project",
          })
        )
      );
    }
  );

  it.effect(
    "releases definition locks by reading and deleting the current Custom Object version",
    () => {
      const recording = makeRecordingCommercetoolsApiRoot();
      const ownerRunId = toMigrationRunId("run-lock-release");
      const expectedKey = definitionLockKey(definitionId);

      return Effect.gen(function* () {
        const store = yield* MigrationStore;
        const lock = yield* store.acquireDefinitionLock(
          definitionId,
          ownerRunId
        );

        yield* store.releaseDefinitionLock(lock);
        yield* store.acquireDefinitionLock(definitionId, ownerRunId);

        expect(recording.requests).toHaveLength(4);
        expect(recording.requests[1]).toMatchObject({
          method: "GET",
          pathVariables: {
            container: "migrate-sdk",
            key: expectedKey,
            projectKey: "test-project",
          },
        });
        expect(recording.requests[2]).toMatchObject({
          method: "DELETE",
          pathVariables: {
            container: "migrate-sdk",
            key: expectedKey,
            projectKey: "test-project",
          },
          queryParams: {
            version: 1,
          },
        });
        expect(recording.requests[3]).toMatchObject({
          body: {
            key: expectedKey,
            version: 0,
          },
          method: "POST",
        });
      }).pipe(Effect.provide(makeStoreLayer(recording)));
    }
  );

  it.effect("refuses to release locks owned by another runner", () => {
    const recording = makeRecordingCommercetoolsApiRoot();
    const ownerRunId = toMigrationRunId("run-lock-owner");
    const otherRunId = toMigrationRunId("run-lock-other-owner");

    return Effect.gen(function* () {
      const store = yield* MigrationStore;
      const lock = yield* store.acquireDefinitionLock(definitionId, ownerRunId);

      const error = yield* store
        .releaseDefinitionLock({
          ...lock,
          ownerRunId: otherRunId,
        })
        .pipe(Effect.flip);

      expect(error).toEqual(
        expect.objectContaining({
          _tag: "MigrationStoreError",
          message: "Migration definition lock is owned by another runner",
        })
      );
      expect(
        recording.requests.some((request) => request.method === "DELETE")
      ).toBe(false);

      yield* store.releaseDefinitionLock(lock);
      expect(
        recording.requests.some((request) => request.method === "DELETE")
      ).toBe(true);
    }).pipe(Effect.provide(makeStoreLayer(recording)));
  });

  it.effect("treats releasing a missing definition lock as a no-op", () => {
    const recording = makeRecordingCommercetoolsApiRoot();
    const expectedKey = definitionLockKey(definitionId);

    return Effect.gen(function* () {
      const store = yield* MigrationStore;

      yield* store.releaseDefinitionLock({
        createdAt: new Date("2026-06-09T12:00:00.000Z"),
        definitionId,
        ownerRunId: toMigrationRunId("run-missing-lock"),
        token: toMigrationDefinitionLockToken("lock-missing"),
      });

      expect(recording.requests).toEqual([
        expect.objectContaining({
          method: "GET",
          pathVariables: {
            container: "migrate-sdk",
            key: expectedKey,
            projectKey: "test-project",
          },
        }),
      ]);
    }).pipe(Effect.provide(makeStoreLayer(recording)));
  });

  it.effect("provides the MigrationStore service from an API root", () => {
    const recording = makeRecordingCommercetoolsApiRoot();

    return Effect.gen(function* () {
      const store = yield* MigrationStore;
      const runId = yield* store.createRunId;

      expect(runId).toMatch(runIdPattern);
      expect(recording.requests).toEqual([]);
    }).pipe(
      Effect.provide(
        CommercetoolsMigrationStore.layerFromApiRoot({
          apiRoot: recording.apiRoot,
          projectKey: "test-project",
        })
      )
    );
  });

  it.effect("uses an application-provided Commercetools SDK layer", () => {
    const recording = makeRecordingCommercetoolsApiRoot();
    const sdkLayer = CommercetoolsSdk.layerFromApiRoot({
      apiRoot: recording.apiRoot,
      projectKey: "test-project",
    });
    const storeLayer = CommercetoolsMigrationStore.layer({
      container: "migrate-sdk",
      namespace: "catalog-import",
    }).pipe(Layer.provide(sdkLayer));

    return Effect.gen(function* () {
      const store = yield* MigrationStore;
      const runId = yield* store.createRunId;

      expect(runId).toMatch(runIdPattern);
      expect(recording.requests).toEqual([]);
    }).pipe(Effect.provide(storeLayer));
  });

  it.effect("rejects invalid Custom Object container names", () => {
    const recording = makeRecordingCommercetoolsApiRoot();

    return Effect.gen(function* () {
      const error = yield* MigrationStore.pipe(
        Effect.provide(
          CommercetoolsMigrationStore.layerFromApiRoot({
            apiRoot: recording.apiRoot,
            container: "bad|container",
            projectKey: "test-project",
          })
        ),
        Effect.flip
      );

      expect(error).toEqual(
        expect.objectContaining({
          _tag: "MigrationStoreError",
          message: expect.stringContaining("container"),
        })
      );
      expect(recording.requests).toEqual([]);
    });
  });

  it.effect("rejects invalid Custom Object namespaces", () => {
    const recording = makeRecordingCommercetoolsApiRoot();

    return Effect.gen(function* () {
      const error = yield* MigrationStore.pipe(
        Effect.provide(
          CommercetoolsMigrationStore.layerFromApiRoot({
            apiRoot: recording.apiRoot,
            namespace: "",
            projectKey: "test-project",
          })
        ),
        Effect.flip
      );

      expect(error).toEqual(
        expect.objectContaining({
          _tag: "MigrationStoreError",
          message: expect.stringContaining("namespace"),
        })
      );
      expect(recording.requests).toEqual([]);
    });
  });

  it.effect("rejects page sizes outside the Custom Object query limit", () => {
    const recording = makeRecordingCommercetoolsApiRoot();

    return Effect.gen(function* () {
      const error = yield* MigrationStore.pipe(
        Effect.provide(
          CommercetoolsMigrationStore.layerFromApiRoot({
            apiRoot: recording.apiRoot,
            pageSize: 501,
            projectKey: "test-project",
          })
        ),
        Effect.flip
      );

      expect(error).toEqual(
        expect.objectContaining({
          _tag: "MigrationStoreError",
          message: expect.stringContaining("pageSize"),
        })
      );
      expect(recording.requests).toEqual([]);
    });
  });

  it.effect(
    "round-trips source cursors as Custom Objects with deterministic keys",
    () => {
      const recording = makeRecordingCommercetoolsApiRoot();
      const cursor = toEncodedSourceCursor(
        JSON.stringify({ lastId: "product-123", page: 2 })
      );
      const expectedKey = sourceCursorKey(definitionId);

      return Effect.gen(function* () {
        const store = yield* MigrationStore;

        expect(yield* store.getSourceCursor(definitionId)).toBeNull();

        yield* store.setSourceCursor(definitionId, cursor);

        expect(yield* store.getSourceCursor(definitionId)).toBe(cursor);

        const [missingLookup, upsert, directLookup] = recording.requests;

        expect(missingLookup).toMatchObject({
          method: "GET",
          pathVariables: {
            container: "migrate-sdk",
            key: expectedKey,
            projectKey: "test-project",
          },
        });
        expect(upsert).toMatchObject({
          body: {
            container: "migrate-sdk",
            key: expectedKey,
            value: {
              formatVersion: 1,
              index: {
                definitionId,
              },
              namespace,
              recordKind: "encoded-source-cursor",
              state: cursor,
            },
          },
          method: "POST",
        });
        expect(directLookup).toMatchObject({
          method: "GET",
          pathVariables: {
            container: "migrate-sdk",
            key: expectedKey,
            projectKey: "test-project",
          },
        });
      }).pipe(Effect.provide(makeStoreLayer(recording)));
    }
  );

  it.effect("round-trips all migration item states as Custom Objects", () => {
    const recording = makeRecordingCommercetoolsApiRoot();
    const runId = toMigrationRunId("run-item-states");
    const updatedAt = new Date("2026-06-09T12:00:00.000Z");
    const itemStates = [
      {
        definitionId,
        destinationIdentity: toDestinationIdentity("ct-product-123"),
        destinationVersion: toDestinationVersion("7"),
        lastRunId: runId,
        sourceIdentity,
        sourceVersion: toSourceVersion("source-v1"),
        status: "migrated",
        updatedAt,
      },
      {
        definitionId,
        lastRunId: runId,
        skipReason: "unchanged by policy",
        sourceIdentity,
        sourceVersion: toSourceVersion("source-v2"),
        status: "skipped",
        updatedAt,
      },
      {
        definitionId,
        error: {
          errorTag: "DestinationRejected",
          kind: "destination",
          message: "Product projection was rejected",
        },
        lastRunId: runId,
        sourceIdentity,
        sourceVersion: toSourceVersion("source-v3"),
        status: "failed",
        updatedAt,
      },
      {
        definitionId,
        destinationIdentity: toDestinationIdentity("ct-product-123"),
        destinationVersion: toDestinationVersion("8"),
        lastRunId: runId,
        reason: "source version changed",
        sourceIdentity,
        sourceVersion: toSourceVersion("source-v4"),
        status: "needs-update",
        updatedAt,
      },
    ] as const;

    return Effect.gen(function* () {
      const store = yield* MigrationStore;

      expect(
        yield* store.getItemState(definitionId, sourceIdentity)
      ).toBeNull();

      for (const itemState of itemStates) {
        yield* store.upsertItemState(itemState);
        const persisted = yield* store.getItemState(
          itemState.definitionId,
          itemState.sourceIdentity
        );

        expect(persisted).toEqual(itemState);
      }

      const expectedKey = itemStateKey(definitionId, sourceIdentity);
      const upserts = recording.requests.filter(
        (request) => request.method === "POST"
      );
      const lookups = recording.requests.filter(
        (request) => request.method === "GET"
      );

      expect(upserts).toHaveLength(itemStates.length);
      expect(lookups).toHaveLength(itemStates.length + 1);
      expect(
        lookups.every((request) => request.pathVariables?.key === expectedKey)
      ).toBe(true);
      expect(upserts.at(-1)).toMatchObject({
        body: {
          container: "migrate-sdk",
          key: expectedKey,
          value: {
            formatVersion: 1,
            index: {
              definitionId,
              lastRunId: runId,
              sourceIdentity,
              sourceIdentityHash: hashedSegment(sourceIdentity),
              status: "needs-update",
            },
            namespace,
            recordKind: "migration-item-state",
            state: {
              ...itemStates.at(-1),
              updatedAt: "2026-06-09T12:00:00.000Z",
            },
          },
        },
      });
    }).pipe(Effect.provide(makeStoreLayer(recording)));
  });

  it.effect("lists item states by definition through indexed queries", () => {
    const recording = makeRecordingCommercetoolsApiRoot();
    const runId = toMigrationRunId("run-list-item-states");
    const additionalDefinitionId = toMigrationDefinitionId("catalog-prices");
    const firstState = {
      definitionId,
      destinationIdentity: toDestinationIdentity("ct-product-a"),
      lastRunId: runId,
      sourceIdentity: toSourceIdentity("product:sku-a"),
      sourceVersion: toSourceVersion("source-a"),
      status: "migrated",
      updatedAt: new Date("2026-06-09T12:00:00.000Z"),
    } as const;
    const secondState = {
      definitionId,
      lastRunId: runId,
      skipReason: "unchanged",
      sourceIdentity: toSourceIdentity("product:sku-b"),
      sourceVersion: toSourceVersion("source-b"),
      status: "skipped",
      updatedAt: new Date("2026-06-09T12:01:00.000Z"),
    } as const;
    const otherDefinitionState = {
      definitionId: additionalDefinitionId,
      destinationIdentity: toDestinationIdentity("ct-price-a"),
      lastRunId: runId,
      sourceIdentity: toSourceIdentity("price:sku-a"),
      sourceVersion: toSourceVersion("source-price-a"),
      status: "migrated",
      updatedAt: new Date("2026-06-09T12:02:00.000Z"),
    } as const;

    return Effect.gen(function* () {
      const store = yield* MigrationStore;

      yield* store.upsertItemState(firstState);
      yield* store.upsertItemState(otherDefinitionState);
      yield* store.upsertItemState(secondState);

      const listed = yield* store.listItemStates(definitionId);

      expect(listed).toHaveLength(2);
      expect(listed).toEqual(expect.arrayContaining([firstState, secondState]));

      const [query] = customObjectQueryRequests(recording.requests);

      expect(query).toMatchObject({
        method: "GET",
        pathVariables: {
          container: "migrate-sdk",
          projectKey: "test-project",
        },
        queryParams: {
          "var.definitionId": definitionId,
          "var.namespace": namespace,
          "var.recordKind": "migration-item-state",
          limit: 500,
          sort: "key asc",
          where: itemStateQueryWhere,
          withTotal: false,
        },
      });
      expect(query?.queryParams).not.toHaveProperty("offset");
    }).pipe(Effect.provide(makeStoreLayer(recording)));
  });

  it.effect("scans item states across pages with keyset pagination", () => {
    const recording = makeRecordingCommercetoolsApiRoot();
    const runId = toMigrationRunId("run-list-item-states-pages");
    const itemStates = [
      {
        definitionId,
        destinationIdentity: toDestinationIdentity("ct-product-a"),
        lastRunId: runId,
        sourceIdentity: toSourceIdentity("product:sku-a"),
        sourceVersion: toSourceVersion("source-a"),
        status: "migrated",
        updatedAt: new Date("2026-06-09T12:00:00.000Z"),
      },
      {
        definitionId,
        destinationIdentity: toDestinationIdentity("ct-product-b"),
        lastRunId: runId,
        sourceIdentity: toSourceIdentity("product:sku-b"),
        sourceVersion: toSourceVersion("source-b"),
        status: "migrated",
        updatedAt: new Date("2026-06-09T12:01:00.000Z"),
      },
      {
        definitionId,
        destinationIdentity: toDestinationIdentity("ct-product-c"),
        lastRunId: runId,
        sourceIdentity: toSourceIdentity("product:sku-c"),
        sourceVersion: toSourceVersion("source-c"),
        status: "migrated",
        updatedAt: new Date("2026-06-09T12:02:00.000Z"),
      },
    ] as const;

    return Effect.gen(function* () {
      const store = yield* MigrationStore;

      for (const itemState of itemStates) {
        yield* store.upsertItemState(itemState);
      }

      const listed = yield* store.listItemStates(definitionId);

      expect(listed).toHaveLength(itemStates.length);
      expect(listed).toEqual(expect.arrayContaining([...itemStates]));

      const queries = customObjectQueryRequests(recording.requests);
      const sortedKeys = itemStates
        .map((itemState) =>
          itemStateKey(definitionId, itemState.sourceIdentity)
        )
        .sort();
      const firstPageCursor = sortedKeys[1];

      expect(queries).toHaveLength(2);
      expect(queries[0]?.queryParams).toMatchObject({
        "var.definitionId": definitionId,
        "var.namespace": namespace,
        "var.recordKind": "migration-item-state",
        limit: 2,
        sort: "key asc",
        where: itemStateQueryWhere,
        withTotal: false,
      });
      expect(queries[0]?.queryParams).not.toHaveProperty("offset");
      expect(queries[0]?.queryParams?.where).not.toContain("key >");
      expect(queries[1]?.queryParams).toMatchObject({
        "var.definitionId": definitionId,
        "var.lastKey": firstPageCursor,
        "var.namespace": namespace,
        "var.recordKind": "migration-item-state",
        limit: 2,
        sort: "key asc",
        withTotal: false,
        where: `${itemStateQueryWhere} and key > :lastKey`,
      });
      expect(queries[1]?.queryParams).not.toHaveProperty("offset");
    }).pipe(Effect.provide(makeStoreLayer(recording, { pageSize: 2 })));
  });

  it.effect("binds definition ids as item-state query variables", () => {
    const recording = makeRecordingCommercetoolsApiRoot();
    const quotedDefinitionId = toMigrationDefinitionId(
      'catalog "special" \\ products'
    );
    const itemState = {
      definitionId: quotedDefinitionId,
      destinationIdentity: toDestinationIdentity("ct-product-special"),
      lastRunId: toMigrationRunId("run-list-item-states-escaping"),
      sourceIdentity: toSourceIdentity("product:sku-special"),
      sourceVersion: toSourceVersion("source-special"),
      status: "migrated",
      updatedAt: new Date("2026-06-09T12:03:00.000Z"),
    } as const;

    return Effect.gen(function* () {
      const store = yield* MigrationStore;

      yield* store.upsertItemState(itemState);

      expect(yield* store.listItemStates(quotedDefinitionId)).toEqual([
        itemState,
      ]);

      const [query] = customObjectQueryRequests(recording.requests);

      expect(query?.queryParams).toMatchObject({
        "var.definitionId": quotedDefinitionId,
        "var.namespace": namespace,
        "var.recordKind": "migration-item-state",
        where: itemStateQueryWhere,
      });
      expect(query?.queryParams?.where).toContain(":definitionId");
      expect(query?.queryParams?.where).not.toContain('\\"special\\"');
    }).pipe(Effect.provide(makeStoreLayer(recording)));
  });

  it.effect(
    "deletes item state by reading the current Custom Object version first",
    () => {
      const recording = makeRecordingCommercetoolsApiRoot();
      const itemState = {
        definitionId,
        destinationIdentity: toDestinationIdentity("ct-product-123"),
        lastRunId: toMigrationRunId("run-delete-item-state"),
        sourceIdentity,
        sourceVersion: toSourceVersion("source-v1"),
        status: "migrated",
        updatedAt: new Date("2026-06-09T12:00:00.000Z"),
      } as const;
      const expectedKey = itemStateKey(definitionId, sourceIdentity);

      return Effect.gen(function* () {
        const store = yield* MigrationStore;

        yield* store.deleteItemState(definitionId, sourceIdentity);
        yield* store.upsertItemState(itemState);
        yield* store.deleteItemState(definitionId, sourceIdentity);

        expect(
          yield* store.getItemState(definitionId, sourceIdentity)
        ).toBeNull();

        expect(recording.requests.at(-2)).toMatchObject({
          method: "DELETE",
          pathVariables: {
            container: "migrate-sdk",
            key: expectedKey,
          },
          queryParams: {
            version: 1,
          },
        });
      }).pipe(Effect.provide(makeStoreLayer(recording)));
    }
  );

  it.effect("round-trips latest run states for every definition", () => {
    const recording = makeRecordingCommercetoolsApiRoot();
    const runId = toMigrationRunId("run-latest-state");
    const additionalDefinitionId = toMigrationDefinitionId("catalog-prices");
    const definitionIds = [definitionId, additionalDefinitionId] as const;

    return Effect.gen(function* () {
      const store = yield* MigrationStore;

      const running = yield* store.beginRun(runId, definitionIds);
      const succeeded = yield* store.completeRun(runId, definitionIds);
      const rerun = toMigrationRunId("run-latest-state-retry");
      const retryRunning = yield* store.beginRun(rerun, definitionIds);
      const failed = yield* store.failRun(rerun, definitionIds);

      expect(running).toMatchObject({
        definitionIds,
        runId,
        status: "running",
      });
      expect(succeeded).toMatchObject({
        definitionIds,
        runId,
        status: "succeeded",
      });
      expect(succeeded.finishedAt).toBeInstanceOf(Date);
      expect(retryRunning).toMatchObject({
        definitionIds,
        runId: rerun,
        status: "running",
      });
      expect(failed).toMatchObject({
        definitionIds,
        runId: rerun,
        status: "failed",
      });
      expect(failed.finishedAt).toBeInstanceOf(Date);

      const expectedKeys = definitionIds.map(latestRunStateKey);
      const upserts = recording.requests.filter(
        (request) => request.method === "POST"
      );
      const lookups = recording.requests.filter(
        (request) => request.method === "GET"
      );

      expect(upserts).toHaveLength(8);
      expect(lookups).toHaveLength(4);
      expect(
        upserts.every((request) =>
          expectedKeys.includes(customObjectKey(request) ?? "")
        )
      ).toBe(true);
      expect(upserts.at(0)).toMatchObject({
        body: {
          value: {
            formatVersion: 1,
            index: {
              definitionId,
              runId,
              status: "running",
            },
            namespace,
            recordKind: "latest-run-state",
          },
        },
      });
    }).pipe(Effect.provide(makeStoreLayer(recording)));
  });
});
