import { randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import {
  MigrationStore,
  MigrationStoreError,
  toMigrationRunId,
} from "migrate-sdk";
import { CommercetoolsSdk, type CommercetoolsSdkLayerOptions } from "../sdk.ts";

export interface CommercetoolsMigrationStoreOptions {
  readonly container?: string;
  readonly namespace?: string;
  readonly pageSize?: number;
}

interface ResolvedCommercetoolsMigrationStoreOptions {
  readonly container: string;
  readonly namespace: string;
  readonly pageSize: number;
}

const defaultOptions = {
  container: "migrate-sdk",
  namespace: "default",
  pageSize: 500,
} as const satisfies ResolvedCommercetoolsMigrationStoreOptions;

const customObjectIdentifierPattern = /^[-_~.a-zA-Z0-9]+$/u;
const maxCustomObjectIdentifierLength = 256;
const maxCustomObjectPageSize = 500;

const storeError = (message: string, cause?: unknown): MigrationStoreError =>
  new MigrationStoreError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const unsupportedOperation = (operation: string): MigrationStoreError =>
  storeError(
    `Commercetools migration store operation is not implemented yet: ${operation}`
  );

const resolveOptions = (
  options: CommercetoolsMigrationStoreOptions = {}
): Effect.Effect<
  ResolvedCommercetoolsMigrationStoreOptions,
  MigrationStoreError
> =>
  Effect.gen(function* () {
    const container = yield* validateCustomObjectIdentifier(
      "container",
      options.container ?? defaultOptions.container
    );
    const namespace = yield* validateCustomObjectIdentifier(
      "namespace",
      options.namespace ?? defaultOptions.namespace
    );
    const pageSize = yield* validatePageSize(
      options.pageSize ?? defaultOptions.pageSize
    );

    return {
      container,
      namespace,
      pageSize,
    };
  });

const validateCustomObjectIdentifier = (
  fieldName: "container" | "namespace",
  value: string
): Effect.Effect<string, MigrationStoreError> => {
  if (value.length === 0) {
    return Effect.fail(
      storeError(`Commercetools migration store ${fieldName} cannot be empty`)
    );
  }

  if (value.length > maxCustomObjectIdentifierLength) {
    return Effect.fail(
      storeError(
        `Commercetools migration store ${fieldName} cannot exceed ${maxCustomObjectIdentifierLength} characters`
      )
    );
  }

  if (!customObjectIdentifierPattern.test(value)) {
    return Effect.fail(
      storeError(
        `Commercetools migration store ${fieldName} contains characters that are not valid in Custom Object keys`
      )
    );
  }

  return Effect.succeed(value);
};

const validatePageSize = (
  value: number
): Effect.Effect<number, MigrationStoreError> => {
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > maxCustomObjectPageSize
  ) {
    return Effect.fail(
      storeError(
        `Commercetools migration store pageSize must be an integer between 1 and ${maxCustomObjectPageSize}`
      )
    );
  }

  return Effect.succeed(value);
};

const makeService = (): (typeof MigrationStore)["Service"] => ({
  getSourceCursor: () => Effect.fail(unsupportedOperation("getSourceCursor")),
  setSourceCursor: () => Effect.fail(unsupportedOperation("setSourceCursor")),
  getItemState: () => Effect.fail(unsupportedOperation("getItemState")),
  listItemStates: () => Effect.fail(unsupportedOperation("listItemStates")),
  deleteItemState: () => Effect.fail(unsupportedOperation("deleteItemState")),
  upsertItemState: () => Effect.fail(unsupportedOperation("upsertItemState")),
  createRunId: Effect.sync(() => toMigrationRunId(`run-${randomUUID()}`)),
  beginRun: () => Effect.fail(unsupportedOperation("beginRun")),
  completeRun: () => Effect.fail(unsupportedOperation("completeRun")),
  failRun: () => Effect.fail(unsupportedOperation("failRun")),
  acquireDefinitionLock: () =>
    Effect.fail(unsupportedOperation("acquireDefinitionLock")),
  releaseDefinitionLock: () =>
    Effect.fail(unsupportedOperation("releaseDefinitionLock")),
});

const makeLayer = (
  options?: CommercetoolsMigrationStoreOptions
): Layer.Layer<MigrationStore, MigrationStoreError, CommercetoolsSdk> =>
  Layer.effect(
    MigrationStore,
    Effect.gen(function* () {
      yield* CommercetoolsSdk;
      yield* resolveOptions(options);

      return makeService();
    })
  );

export const CommercetoolsMigrationStore = {
  layer: makeLayer,
  layerFromApiRoot: (
    options: CommercetoolsSdkLayerOptions & CommercetoolsMigrationStoreOptions
  ): Layer.Layer<MigrationStore, MigrationStoreError> =>
    makeLayer(options).pipe(
      Layer.provide(CommercetoolsSdk.layerFromApiRoot(options))
    ),
} as const;
