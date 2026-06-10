import { describe, expect, it } from "@effect/vitest";
import { CommercetoolsSdk } from "@migrate-sdk/commercetools";
import { CommercetoolsMigrationStore } from "@migrate-sdk/commercetools/migration-store";
import { makeRecordingCommercetoolsApiRoot } from "@migrate-sdk/commercetools/testing";
import { Effect, Layer } from "effect";
import { MigrationStore } from "migrate-sdk";

const runIdPattern = /^run-/u;

describe("CommercetoolsMigrationStore", () => {
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
});
