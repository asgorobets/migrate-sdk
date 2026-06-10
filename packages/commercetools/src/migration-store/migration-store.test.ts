import { createHash } from "node:crypto";
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
  toMigrationRunId,
  toSourceIdentity,
  toSourceVersion,
} from "migrate-sdk";

const runIdPattern = /^run-/u;
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
  recording: ReturnType<typeof makeRecordingCommercetoolsApiRoot>
) =>
  CommercetoolsMigrationStore.layerFromApiRoot({
    apiRoot: recording.apiRoot,
    container: "migrate-sdk",
    namespace,
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
