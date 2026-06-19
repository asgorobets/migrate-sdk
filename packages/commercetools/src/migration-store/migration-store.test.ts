import { createHash } from "node:crypto";
import { ApiRoot as PlatformApiRoot } from "@commercetools/platform-sdk";
import { describe, expect, it } from "@effect/vitest";
import { CommercetoolsMigrationStore } from "@migrate-sdk/commercetools/migration-store";
import {
  makeRecordingCustomObjectApiRoot,
  type RecordedCustomObjectRequest,
} from "@migrate-sdk/commercetools/testing";
import { Data, Effect, Layer, Schema } from "effect";
import {
  DestinationChangeDescriptorId,
  MigrationStore,
  makeSourceVersionContractFingerprint,
  SourceIdentity,
  toEncodedSourceCursor,
  toMigrationDefinitionId,
  toMigrationDefinitionLockToken,
  toMigrationRunId,
  toSourceVersion,
} from "migrate-sdk";
import { CommercetoolsSdk } from "../sdk.ts";

const runIdPattern = /^run-/u;
const lockTokenPattern = /^lock-/u;
const safeCustomObjectKeyPattern = /^[A-Za-z0-9_.~-]+(?:__[A-Za-z0-9_.~-]+)+$/u;
const definitionId = toMigrationDefinitionId("catalog-products");
const TestSourceIdentity = SourceIdentity.make({
  id: "test-product-source@v1",
  schema: SourceIdentity.key("sourceKey", Schema.String),
});
const AlternateTestSourceIdentity = SourceIdentity.make({
  id: "alternate-test-product-source@v1",
  schema: SourceIdentity.key("sourceKey", Schema.String),
});
const sourceIdentityFor = (key: string) =>
  SourceIdentity.fromKey(TestSourceIdentity, key);
const sourceIdentity = sourceIdentityFor("product:sku-123");
const namespace = "catalog-import";

const hashedSegment = (value: string): string =>
  createHash("sha256").update(value).digest("base64url");

const definitionHashSegment = (definition: string): string =>
  `definition-hash_${hashedSegment(definition)}`;

const sourceIdentityText = (
  identity: string | { readonly encoded: string }
): string => (typeof identity === "string" ? identity : identity.encoded);

const sourceIdentityHashSegment = (
  identity: string | { readonly encoded: string }
): string =>
  `source-identity-hash_${hashedSegment(sourceIdentityText(identity))}`;

const sourceCursorKey = (definition: string): string =>
  `${namespace}__encoded-source-cursor__${definitionHashSegment(definition)}`;

const migrationContractKey = (definition: string): string =>
  `${namespace}__migration-contract__${definitionHashSegment(definition)}`;

const itemStateKey = (
  definition: string,
  identity: string | { readonly encoded: string }
): string =>
  `${namespace}__migration-item-state__${definitionHashSegment(definition)}__${sourceIdentityHashSegment(identity)}`;

const latestRunStateKey = (definition: string): string =>
  `${namespace}__latest-run-state__${definitionHashSegment(definition)}`;

const definitionLockKey = (definition: string): string =>
  `${namespace}__migration-definition-lock__${definitionHashSegment(definition)}`;

const itemStateQueryWhere = [
  "value(namespace = :namespace)",
  "value(recordKind = :recordKind)",
  "value(index(definitionId = :definitionId))",
].join(" and ");

const customObjectKey = (
  request: RecordedCustomObjectRequest
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

const customObjectValue = (request: RecordedCustomObjectRequest): unknown => {
  const body = request.body;

  if (
    typeof body === "object" &&
    body !== null &&
    "container" in body &&
    "key" in body &&
    "value" in body
  ) {
    return body.value;
  }

  return undefined;
};

const customObjectQueryRequests = (
  requests: readonly RecordedCustomObjectRequest[]
): readonly RecordedCustomObjectRequest[] =>
  requests.filter(
    (request) =>
      request.method === "GET" &&
      request.pathVariables?.container === "migrate-sdk" &&
      request.pathVariables?.key === undefined
  );

const containsExplicitNull = (value: unknown): boolean => {
  if (value === null) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some(containsExplicitNull);
  }

  if (typeof value === "object") {
    return Object.values(value).some(containsExplicitNull);
  }

  return false;
};

const seedCustomObject = (
  recording: ReturnType<typeof makeRecordingCustomObjectApiRoot>,
  key: string,
  value: unknown
): Effect.Effect<void, RecordedHttpError> => {
  const project = recording.apiRoot.withProjectKey({
    projectKey: "test-project",
  });

  return Effect.tryPromise({
    try: () =>
      project
        .customObjects()
        .post({
          body: {
            container: "migrate-sdk",
            key,
            value,
          },
        })
        .execute(),
    catch: recordedHttpError,
  }).pipe(Effect.asVoid);
};

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
  recording: ReturnType<typeof makeRecordingCustomObjectApiRoot>,
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
    const recording = makeRecordingCustomObjectApiRoot();
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
      const recording = makeRecordingCustomObjectApiRoot();
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
      const recording = makeRecordingCustomObjectApiRoot();
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
      const recording = makeRecordingCustomObjectApiRoot();
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
    const recording = makeRecordingCustomObjectApiRoot();
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

  it.effect("rejects definition locks whose index metadata drifted", () => {
    const recording = makeRecordingCustomObjectApiRoot();
    const ownerRunId = toMigrationRunId("run-lock-index-state");
    const otherRunId = toMigrationRunId("run-lock-index-other");
    const token = toMigrationDefinitionLockToken("lock-index-state");
    const key = definitionLockKey(definitionId);

    return Effect.gen(function* () {
      yield* seedCustomObject(recording, key, {
        formatVersion: 1,
        index: {
          definitionId,
          ownerRunId: otherRunId,
        },
        namespace,
        recordKind: "migration-definition-lock",
        state: {
          createdAt: "2026-06-09T12:00:00.000Z",
          definitionId,
          ownerRunId,
          token,
        },
      });

      const error = yield* Effect.gen(function* () {
        const store = yield* MigrationStore;

        return yield* store.releaseDefinitionLock({
          createdAt: new Date("2026-06-09T12:00:00.000Z"),
          definitionId,
          ownerRunId,
          token,
        });
      }).pipe(Effect.provide(makeStoreLayer(recording)), Effect.flip);

      expect(error).toEqual(
        expect.objectContaining({
          _tag: "MigrationStoreError",
          message: expect.stringContaining(
            "Migration store record metadata mismatch"
          ),
        })
      );
      expect(
        recording.requests.some((request) => request.method === "DELETE")
      ).toBe(false);
    });
  });

  it.effect("treats releasing a missing definition lock as a no-op", () => {
    const recording = makeRecordingCustomObjectApiRoot();
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
    const recording = makeRecordingCustomObjectApiRoot();

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
    const recording = makeRecordingCustomObjectApiRoot();
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
    const recording = makeRecordingCustomObjectApiRoot();

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
    const recording = makeRecordingCustomObjectApiRoot();

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
    const recording = makeRecordingCustomObjectApiRoot();

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
      const recording = makeRecordingCustomObjectApiRoot();
      const cursor = toEncodedSourceCursor(
        JSON.stringify({ lastId: "product-123", page: 2 })
      );
      const expectedKey = sourceCursorKey(definitionId);

      return Effect.gen(function* () {
        const store = yield* MigrationStore;

        expect(yield* store.getSourceCursor(definitionId)).toBeNull();

        yield* store.setSourceCursor(definitionId, cursor);

        expect(yield* store.getSourceCursor(definitionId)).toBe(cursor);

        yield* store.deleteSourceCursor(definitionId);

        expect(yield* store.getSourceCursor(definitionId)).toBeNull();

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

  it.effect(
    "round-trips migration contracts as Custom Objects with deterministic keys",
    () => {
      const recording = makeRecordingCustomObjectApiRoot();
      const expectedKey = migrationContractKey(definitionId);
      const sourceVersionContractFingerprint =
        makeSourceVersionContractFingerprint({
          kind: "commercetools-version",
          field: "version",
        });
      const contract = {
        definitionId,
        sourceIdentityContractFingerprint: TestSourceIdentity.fingerprint,
        sourceVersionContractFingerprint,
      };

      return Effect.gen(function* () {
        const store = yield* MigrationStore;

        expect(yield* store.getMigrationContract(definitionId)).toBeNull();

        yield* store.upsertMigrationContract(contract);

        expect(yield* store.getMigrationContract(definitionId)).toEqual(
          contract
        );

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
              recordKind: "migration-contract",
              state: contract,
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

  it.effect(
    "uses safe bounded hashed key segments for unsafe long values",
    () => {
      const recording = makeRecordingCustomObjectApiRoot();
      const unsafeDefinitionId = toMigrationDefinitionId(
        `catalog products/"special"|${"x".repeat(500)}`
      );
      const unsafeSourceIdentity = sourceIdentityFor(
        `sku/"special"|${"y".repeat(500)}`
      );
      const cursor = toEncodedSourceCursor("cursor-long-values");
      const itemState = {
        definitionId: unsafeDefinitionId,
        lastRunId: toMigrationRunId("run-long-values"),
        sourceIdentity: unsafeSourceIdentity,
        sourceVersion: toSourceVersion("source-long-values"),
        status: "migrated",
        updatedAt: new Date("2026-06-09T12:00:00.000Z"),
      } as const;

      return Effect.gen(function* () {
        const store = yield* MigrationStore;

        yield* store.setSourceCursor(unsafeDefinitionId, cursor);
        yield* store.upsertItemState(itemState);

        const keys = recording.requests
          .map(customObjectKey)
          .filter((key): key is string => key !== undefined);
        const sourceCursorCustomObjectKey = keys[0];
        const itemStateCustomObjectKey = keys[1];

        expect(sourceCursorCustomObjectKey).toBeDefined();
        expect(itemStateCustomObjectKey).toBeDefined();
        expect(sourceCursorCustomObjectKey).toHaveLength(
          sourceCursorKey(unsafeDefinitionId).length
        );
        expect(itemStateCustomObjectKey).toHaveLength(
          itemStateKey(unsafeDefinitionId, unsafeSourceIdentity).length
        );
        expect(sourceCursorCustomObjectKey?.length).toBeLessThanOrEqual(256);
        expect(itemStateCustomObjectKey?.length).toBeLessThanOrEqual(256);
        expect(sourceCursorCustomObjectKey).toMatch(safeCustomObjectKeyPattern);
        expect(itemStateCustomObjectKey).toMatch(safeCustomObjectKeyPattern);
        expect(sourceCursorCustomObjectKey).toContain("definition-hash_");
        expect(itemStateCustomObjectKey).toContain("definition-hash_");
        expect(itemStateCustomObjectKey).toContain("source-identity-hash_");
        expect(sourceCursorCustomObjectKey).not.toContain(unsafeDefinitionId);
        expect(itemStateCustomObjectKey).not.toContain(unsafeSourceIdentity);
      }).pipe(Effect.provide(makeStoreLayer(recording)));
    }
  );

  it.effect("persists store records without explicit null values", () => {
    const recording = makeRecordingCustomObjectApiRoot();
    const runId = toMigrationRunId("run-no-explicit-nulls");
    const itemState = {
      definitionId,
      lastRunId: runId,
      reason: "destination version was not observed yet",
      sourceIdentity,
      status: "needs-update",
      updatedAt: new Date("2026-06-09T12:00:00.000Z"),
    } as const;

    return Effect.gen(function* () {
      const store = yield* MigrationStore;

      yield* store.setSourceCursor(
        definitionId,
        toEncodedSourceCursor("cursor-no-explicit-nulls")
      );
      yield* store.upsertItemState(itemState);
      yield* store.beginRun(runId, [definitionId]);
      yield* store.acquireDefinitionLock(definitionId, runId);

      const upserts = recording.requests.filter(
        (request) => request.method === "POST"
      );

      expect(upserts).toHaveLength(4);
      expect(
        upserts.some((request) =>
          containsExplicitNull(customObjectValue(request))
        )
      ).toBe(false);
    }).pipe(Effect.provide(makeStoreLayer(recording)));
  });

  it.effect("round-trips all migration item states as Custom Objects", () => {
    const recording = makeRecordingCustomObjectApiRoot();
    const runId = toMigrationRunId("run-item-states");
    const updatedAt = new Date("2026-06-09T12:00:00.000Z");
    const itemStates = [
      {
        definitionId,
        journal: {
          process: {
            entries: [
              {
                descriptorId: DestinationChangeDescriptorId.make(
                  "commercetools.product.upserted"
                ),
                kind: "change",
                sequence: 0,
                value: {
                  id: "ct-product-123",
                  key: "sku-123",
                  version: 7,
                },
              },
            ],
            runId,
          },
          rollbackAttempts: [
            {
              entries: [
                {
                  kind: "diagnostic",
                  message: "Rollback failed after product lookup",
                  sequence: 0,
                  severity: "error",
                },
              ],
              error: {
                errorTag: "RollbackRejected",
                kind: "destination",
                message: "Product rollback was rejected",
              },
              failedAt: new Date("2026-06-09T12:05:00.000Z"),
              runId: toMigrationRunId("run-rollback-item-states"),
            },
          ],
        },
        lastRunId: runId,
        sourceIdentity,
        sourceVersion: toSourceVersion("source-v1"),
        status: "migrated",
        trackingRecord: {
          productId: "ct-product-123",
          productKey: "sku-123",
        },
        updatedAt,
      },
      {
        definitionId,
        lastRunId: runId,
        skipReason: "unchanged by policy",
        sourceIdentity,
        sourceVersion: toSourceVersion("source-v2"),
        status: "skipped",
        trackingRecord: {
          productId: "ct-product-skipped",
          productKey: "sku-skipped",
        },
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
        trackingRecord: {
          productId: "ct-product-failed",
          productKey: "sku-failed",
        },
        updatedAt,
      },
      {
        definitionId,
        lastRunId: runId,
        reason: "source version changed",
        sourceIdentity,
        sourceVersion: toSourceVersion("source-v4"),
        status: "needs-update",
        trackingRecord: {
          productId: "ct-product-123",
        },
        updatedAt,
      },
    ] as const;

    return Effect.gen(function* () {
      const store = yield* MigrationStore;

      expect(
        yield* store.getItemState(definitionId, sourceIdentity.encoded)
      ).toBeNull();

      for (const itemState of itemStates) {
        yield* store.upsertItemState(itemState);
        const persisted = yield* store.getItemState(
          itemState.definitionId,
          itemState.sourceIdentity.encoded
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
              sourceIdentityHash: hashedSegment(sourceIdentity.encoded),
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
      expect(
        upserts.some((request) =>
          containsExplicitNull(customObjectValue(request))
        )
      ).toBe(false);
    }).pipe(Effect.provide(makeStoreLayer(recording)));
  });

  it.effect(
    "fails clearly for unsupported future record format versions",
    () => {
      const recording = makeRecordingCustomObjectApiRoot();
      const cursor = toEncodedSourceCursor("future-version-cursor");
      const key = sourceCursorKey(definitionId);

      return Effect.gen(function* () {
        yield* seedCustomObject(recording, key, {
          formatVersion: 2,
          index: {
            definitionId,
          },
          namespace,
          recordKind: "encoded-source-cursor",
          state: cursor,
        });

        const error = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;

          return yield* store.getSourceCursor(definitionId);
        }).pipe(Effect.provide(makeStoreLayer(recording)), Effect.flip);

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationStoreError",
            message: expect.stringContaining(
              "Unsupported migration store record format version"
            ),
          })
        );
      });
    }
  );

  it.effect(
    "rejects source cursor records whose metadata targets another definition",
    () => {
      const recording = makeRecordingCustomObjectApiRoot();
      const requestedDefinitionId = toMigrationDefinitionId("catalog-products");
      const persistedDefinitionId = toMigrationDefinitionId("catalog-prices");
      const key = sourceCursorKey(requestedDefinitionId);

      return Effect.gen(function* () {
        yield* seedCustomObject(recording, key, {
          formatVersion: 1,
          index: {
            definitionId: persistedDefinitionId,
          },
          namespace,
          recordKind: "encoded-source-cursor",
          state: toEncodedSourceCursor("wrong-definition-cursor"),
        });

        const error = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;

          return yield* store.getSourceCursor(requestedDefinitionId);
        }).pipe(Effect.provide(makeStoreLayer(recording)), Effect.flip);

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationStoreError",
            message: expect.stringContaining(
              "Migration store record metadata mismatch"
            ),
          })
        );
      });
    }
  );

  it.effect(
    "rejects migration contract records whose metadata targets another definition",
    () => {
      const recording = makeRecordingCustomObjectApiRoot();
      const requestedDefinitionId = toMigrationDefinitionId("catalog-products");
      const persistedDefinitionId = toMigrationDefinitionId("catalog-prices");
      const key = migrationContractKey(requestedDefinitionId);
      const sourceVersionContractFingerprint =
        makeSourceVersionContractFingerprint({
          kind: "commercetools-version",
          field: "version",
        });

      return Effect.gen(function* () {
        yield* seedCustomObject(recording, key, {
          formatVersion: 1,
          index: {
            definitionId: persistedDefinitionId,
          },
          namespace,
          recordKind: "migration-contract",
          state: {
            definitionId: persistedDefinitionId,
            sourceIdentityContractFingerprint: TestSourceIdentity.fingerprint,
            sourceVersionContractFingerprint,
          },
        });

        const error = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;

          return yield* store.getMigrationContract(requestedDefinitionId);
        }).pipe(Effect.provide(makeStoreLayer(recording)), Effect.flip);

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationStoreError",
            message: expect.stringContaining(
              "Migration store record metadata mismatch"
            ),
          })
        );
      });
    }
  );

  it.effect(
    "rejects item state records whose metadata targets another item",
    () => {
      const recording = makeRecordingCustomObjectApiRoot();
      const requestedSourceIdentity = sourceIdentityFor("product:requested");
      const persistedSourceIdentity = sourceIdentityFor("product:persisted");
      const key = itemStateKey(definitionId, requestedSourceIdentity);

      return Effect.gen(function* () {
        yield* seedCustomObject(recording, key, {
          formatVersion: 1,
          index: {
            definitionId,
            lastRunId: toMigrationRunId("run-corrupt-item"),
            sourceIdentity: persistedSourceIdentity,
            sourceIdentityHash: hashedSegment(persistedSourceIdentity.encoded),
            status: "migrated",
            updatedAt: "2026-06-09T12:00:00.000Z",
          },
          namespace,
          recordKind: "migration-item-state",
          state: {
            definitionId,
            lastRunId: toMigrationRunId("run-corrupt-item"),
            sourceIdentity: persistedSourceIdentity,
            sourceVersion: toSourceVersion("source-corrupt-item"),
            status: "migrated",
            updatedAt: "2026-06-09T12:00:00.000Z",
          },
        });

        const error = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;

          return yield* store.getItemState(
            definitionId,
            requestedSourceIdentity.encoded
          );
        }).pipe(Effect.provide(makeStoreLayer(recording)), Effect.flip);

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationStoreError",
            message: expect.stringContaining(
              "Migration store record metadata mismatch"
            ),
          })
        );
      });
    }
  );

  it.effect("rejects item state records whose index metadata drifted", () => {
    const recording = makeRecordingCustomObjectApiRoot();
    const key = itemStateKey(definitionId, sourceIdentity);

    return Effect.gen(function* () {
      yield* seedCustomObject(recording, key, {
        formatVersion: 1,
        index: {
          definitionId,
          lastRunId: toMigrationRunId("run-index-state"),
          sourceIdentity,
          sourceIdentityHash: hashedSegment(sourceIdentity.encoded),
          status: "migrated",
          updatedAt: "2026-06-09T12:00:00.000Z",
        },
        namespace,
        recordKind: "migration-item-state",
        state: {
          definitionId,
          error: {
            errorTag: "DestinationRejected",
            kind: "destination",
            message: "Product was rejected",
          },
          lastRunId: toMigrationRunId("run-index-state"),
          sourceIdentity,
          sourceVersion: toSourceVersion("source-index-state"),
          status: "failed",
          updatedAt: "2026-06-09T12:00:00.000Z",
        },
      });

      const error = yield* Effect.gen(function* () {
        const store = yield* MigrationStore;

        return yield* store.getItemState(definitionId, sourceIdentity.encoded);
      }).pipe(Effect.provide(makeStoreLayer(recording)), Effect.flip);

      expect(error).toEqual(
        expect.objectContaining({
          _tag: "MigrationStoreError",
          message: expect.stringContaining(
            "Migration store record metadata mismatch"
          ),
        })
      );
    });
  });

  it.effect(
    "rejects item state records whose source identity snapshot metadata drifted",
    () => {
      const recording = makeRecordingCustomObjectApiRoot();
      const driftedSourceIdentity = SourceIdentity.fromKey(
        AlternateTestSourceIdentity,
        "product:sku-123"
      );
      const key = itemStateKey(definitionId, sourceIdentity);

      return Effect.gen(function* () {
        yield* seedCustomObject(recording, key, {
          formatVersion: 1,
          index: {
            definitionId,
            lastRunId: toMigrationRunId("run-index-identity-contract"),
            sourceIdentity: driftedSourceIdentity,
            sourceIdentityHash: hashedSegment(sourceIdentity.encoded),
            status: "migrated",
            updatedAt: "2026-06-09T12:00:00.000Z",
          },
          namespace,
          recordKind: "migration-item-state",
          state: {
            definitionId,
            lastRunId: toMigrationRunId("run-index-identity-contract"),
            sourceIdentity,
            sourceVersion: toSourceVersion("source-index-identity-contract"),
            status: "migrated",
            updatedAt: "2026-06-09T12:00:00.000Z",
          },
        });

        const error = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;

          return yield* store.getItemState(
            definitionId,
            sourceIdentity.encoded
          );
        }).pipe(Effect.provide(makeStoreLayer(recording)), Effect.flip);

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationStoreError",
            message: expect.stringContaining(
              "Migration store record metadata mismatch"
            ),
          })
        );
      });
    }
  );

  it.effect("rejects listed item state records with non-canonical keys", () => {
    const recording = makeRecordingCustomObjectApiRoot();
    const nonCanonicalKey = `${namespace}__migration-item-state__definition-hash_wrong__source-identity-hash_wrong`;

    return Effect.gen(function* () {
      yield* seedCustomObject(recording, nonCanonicalKey, {
        formatVersion: 1,
        index: {
          definitionId,
          lastRunId: toMigrationRunId("run-non-canonical-key"),
          sourceIdentity,
          sourceIdentityHash: hashedSegment(sourceIdentity.encoded),
          status: "migrated",
          updatedAt: "2026-06-09T12:00:00.000Z",
        },
        namespace,
        recordKind: "migration-item-state",
        state: {
          definitionId,
          lastRunId: toMigrationRunId("run-non-canonical-key"),
          sourceIdentity,
          sourceVersion: toSourceVersion("source-non-canonical-key"),
          status: "migrated",
          updatedAt: "2026-06-09T12:00:00.000Z",
        },
      });

      const error = yield* Effect.gen(function* () {
        const store = yield* MigrationStore;

        return yield* store.listItemStates(definitionId);
      }).pipe(Effect.provide(makeStoreLayer(recording)), Effect.flip);

      expect(error).toEqual(
        expect.objectContaining({
          _tag: "MigrationStoreError",
          message: expect.stringContaining(
            "Migration store record metadata mismatch"
          ),
        })
      );
    });
  });

  it.effect("lists item states by definition through indexed queries", () => {
    const recording = makeRecordingCustomObjectApiRoot();
    const runId = toMigrationRunId("run-list-item-states");
    const additionalDefinitionId = toMigrationDefinitionId("catalog-prices");
    const firstState = {
      definitionId,
      lastRunId: runId,
      sourceIdentity: sourceIdentityFor("product:sku-a"),
      sourceVersion: toSourceVersion("source-a"),
      status: "migrated",
      updatedAt: new Date("2026-06-09T12:00:00.000Z"),
    } as const;
    const secondState = {
      definitionId,
      lastRunId: runId,
      skipReason: "unchanged",
      sourceIdentity: sourceIdentityFor("product:sku-b"),
      sourceVersion: toSourceVersion("source-b"),
      status: "skipped",
      updatedAt: new Date("2026-06-09T12:01:00.000Z"),
    } as const;
    const otherDefinitionState = {
      definitionId: additionalDefinitionId,
      lastRunId: runId,
      sourceIdentity: sourceIdentityFor("price:sku-a"),
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
    const recording = makeRecordingCustomObjectApiRoot();
    const runId = toMigrationRunId("run-list-item-states-pages");
    const itemStates = [
      {
        definitionId,
        lastRunId: runId,
        sourceIdentity: sourceIdentityFor("product:sku-a"),
        sourceVersion: toSourceVersion("source-a"),
        status: "migrated",
        updatedAt: new Date("2026-06-09T12:00:00.000Z"),
      },
      {
        definitionId,
        lastRunId: runId,
        sourceIdentity: sourceIdentityFor("product:sku-b"),
        sourceVersion: toSourceVersion("source-b"),
        status: "migrated",
        updatedAt: new Date("2026-06-09T12:01:00.000Z"),
      },
      {
        definitionId,
        lastRunId: runId,
        sourceIdentity: sourceIdentityFor("product:sku-c"),
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
    const recording = makeRecordingCustomObjectApiRoot();
    const quotedDefinitionId = toMigrationDefinitionId(
      'catalog "special" \\ products'
    );
    const itemState = {
      definitionId: quotedDefinitionId,
      lastRunId: toMigrationRunId("run-list-item-states-escaping"),
      sourceIdentity: sourceIdentityFor("product:sku-special"),
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
      const recording = makeRecordingCustomObjectApiRoot();
      const itemState = {
        definitionId,
        lastRunId: toMigrationRunId("run-delete-item-state"),
        sourceIdentity,
        sourceVersion: toSourceVersion("source-v1"),
        status: "migrated",
        updatedAt: new Date("2026-06-09T12:00:00.000Z"),
      } as const;
      const expectedKey = itemStateKey(definitionId, sourceIdentity);

      return Effect.gen(function* () {
        const store = yield* MigrationStore;

        yield* store.deleteItemState(definitionId, sourceIdentity.encoded);
        yield* store.upsertItemState(itemState);
        yield* store.deleteItemState(definitionId, sourceIdentity.encoded);

        expect(
          yield* store.getItemState(definitionId, sourceIdentity.encoded)
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

  it.effect("rejects latest run states whose index metadata drifted", () => {
    const recording = makeRecordingCustomObjectApiRoot();
    const runId = toMigrationRunId("run-latest-index-state");
    const key = latestRunStateKey(definitionId);

    return Effect.gen(function* () {
      yield* seedCustomObject(recording, key, {
        formatVersion: 1,
        index: {
          definitionId,
          runId: toMigrationRunId("run-latest-index-other"),
          startedAt: "2026-06-09T12:00:00.000Z",
          status: "running",
        },
        namespace,
        recordKind: "latest-run-state",
        state: {
          definitionIds: [definitionId],
          runId,
          startedAt: "2026-06-09T12:00:00.000Z",
          status: "running",
        },
      });

      const error = yield* Effect.gen(function* () {
        const store = yield* MigrationStore;

        return yield* store.completeRun(runId, [definitionId]);
      }).pipe(Effect.provide(makeStoreLayer(recording)), Effect.flip);

      expect(error).toEqual(
        expect.objectContaining({
          _tag: "MigrationStoreError",
          message: expect.stringContaining(
            "Migration store record metadata mismatch"
          ),
        })
      );
    });
  });

  it.effect("rejects run states whose definition ids drifted", () => {
    const recording = makeRecordingCustomObjectApiRoot();
    const runId = toMigrationRunId("run-definition-ids-drift");
    const additionalDefinitionId = toMigrationDefinitionId("catalog-prices");
    const definitionIds = [definitionId, additionalDefinitionId] as const;

    return Effect.gen(function* () {
      yield* seedCustomObject(recording, latestRunStateKey(definitionId), {
        formatVersion: 1,
        index: {
          definitionId,
          runId,
          startedAt: "2026-06-09T12:00:00.000Z",
          status: "running",
        },
        namespace,
        recordKind: "latest-run-state",
        state: {
          definitionIds,
          runId,
          startedAt: "2026-06-09T12:00:00.000Z",
          status: "running",
        },
      });
      yield* seedCustomObject(
        recording,
        latestRunStateKey(additionalDefinitionId),
        {
          formatVersion: 1,
          index: {
            definitionId: additionalDefinitionId,
            runId,
            startedAt: "2026-06-09T12:00:00.000Z",
            status: "running",
          },
          namespace,
          recordKind: "latest-run-state",
          state: {
            definitionIds: [additionalDefinitionId],
            runId,
            startedAt: "2026-06-09T12:00:00.000Z",
            status: "running",
          },
        }
      );

      const error = yield* Effect.gen(function* () {
        const store = yield* MigrationStore;

        return yield* store.completeRun(runId, definitionIds);
      }).pipe(Effect.provide(makeStoreLayer(recording)), Effect.flip);

      expect(error).toEqual(
        expect.objectContaining({
          _tag: "MigrationStoreError",
          message: expect.stringContaining(
            "Migration store record metadata mismatch"
          ),
        })
      );
    });
  });

  it.effect("rejects run states whose per-definition status drifted", () => {
    const recording = makeRecordingCustomObjectApiRoot();
    const runId = toMigrationRunId("run-status-drift");
    const additionalDefinitionId = toMigrationDefinitionId("catalog-prices");
    const definitionIds = [definitionId, additionalDefinitionId] as const;

    return Effect.gen(function* () {
      yield* seedCustomObject(recording, latestRunStateKey(definitionId), {
        formatVersion: 1,
        index: {
          definitionId,
          runId,
          startedAt: "2026-06-09T12:00:00.000Z",
          status: "running",
        },
        namespace,
        recordKind: "latest-run-state",
        state: {
          definitionIds,
          runId,
          startedAt: "2026-06-09T12:00:00.000Z",
          status: "running",
        },
      });
      yield* seedCustomObject(
        recording,
        latestRunStateKey(additionalDefinitionId),
        {
          formatVersion: 1,
          index: {
            definitionId: additionalDefinitionId,
            finishedAt: "2026-06-09T12:01:00.000Z",
            runId,
            startedAt: "2026-06-09T12:00:00.000Z",
            status: "failed",
          },
          namespace,
          recordKind: "latest-run-state",
          state: {
            definitionIds,
            finishedAt: "2026-06-09T12:01:00.000Z",
            runId,
            startedAt: "2026-06-09T12:00:00.000Z",
            status: "failed",
          },
        }
      );

      const error = yield* Effect.gen(function* () {
        const store = yield* MigrationStore;

        return yield* store.completeRun(runId, definitionIds);
      }).pipe(Effect.provide(makeStoreLayer(recording)), Effect.flip);

      expect(error).toEqual(
        expect.objectContaining({
          _tag: "MigrationStoreError",
          message: expect.stringContaining(
            "Migration store record metadata mismatch"
          ),
        })
      );
    });
  });

  it.effect("round-trips latest run states for every definition", () => {
    const recording = makeRecordingCustomObjectApiRoot();
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
