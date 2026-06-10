import { createHash, randomUUID } from "node:crypto";
import type {
  CustomObject,
  CustomObjectDraft,
} from "@commercetools/platform-sdk";
import { Effect, Layer, Schema } from "effect";
import {
  DestinationIdentity as DestinationIdentitySchema,
  DestinationVersion as DestinationVersionSchema,
  EncodedSourceCursor as EncodedSourceCursorSchema,
  MigrationDefinitionId as MigrationDefinitionIdSchema,
  MigrationItemError,
  MigrationRunId as MigrationRunIdSchema,
  type MigrationRunState,
  MigrationStore,
  MigrationStoreError,
  SourceIdentity as SourceIdentitySchema,
  SourceVersion as SourceVersionSchema,
  toMigrationRunId,
} from "migrate-sdk";
import {
  CommercetoolsSdk,
  type CommercetoolsSdkError,
  type CommercetoolsSdkLayerOptions,
} from "../sdk.ts";

type EncodedSourceCursor = typeof EncodedSourceCursorSchema.Type;
type MigrationDefinitionId = typeof MigrationDefinitionIdSchema.Type;
type MigrationRunId = typeof MigrationRunIdSchema.Type;
type MigrationRunStateType = typeof MigrationRunState.Type;
type SourceIdentity = typeof SourceIdentitySchema.Type;

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

const formatVersion = 1;
const customObjectIdentifierPattern = /^[-_~.a-zA-Z0-9]+$/u;
const maxCustomObjectContainerLength = 256;
const maxCustomObjectNamespaceLength = 64;
const maxCustomObjectPageSize = 500;

const PersistedMigrationRunState = Schema.Struct({
  definitionIds: Schema.Array(MigrationDefinitionIdSchema),
  finishedAt: Schema.optional(Schema.DateFromString),
  runId: MigrationRunIdSchema,
  startedAt: Schema.DateFromString,
  status: Schema.Literals(["running", "succeeded", "failed"]),
});

const LatestRunStateRecord = Schema.Struct({
  formatVersion: Schema.Literal(formatVersion),
  index: Schema.Struct({
    definitionId: MigrationDefinitionIdSchema,
    finishedAt: Schema.optional(Schema.DateFromString),
    runId: MigrationRunIdSchema,
    startedAt: Schema.DateFromString,
    status: Schema.Literals(["running", "succeeded", "failed"]),
  }),
  namespace: Schema.String,
  recordKind: Schema.Literal("latest-run-state"),
  state: PersistedMigrationRunState,
});
type LatestRunStateRecord = typeof LatestRunStateRecord.Type;

const EncodedSourceCursorRecord = Schema.Struct({
  formatVersion: Schema.Literal(formatVersion),
  index: Schema.Struct({
    definitionId: MigrationDefinitionIdSchema,
  }),
  namespace: Schema.String,
  recordKind: Schema.Literal("encoded-source-cursor"),
  state: EncodedSourceCursorSchema,
});
type EncodedSourceCursorRecord = typeof EncodedSourceCursorRecord.Type;

const PersistedMigrationItemStateBaseFields = {
  definitionId: MigrationDefinitionIdSchema,
  lastRunId: MigrationRunIdSchema,
  sourceIdentity: SourceIdentitySchema,
  updatedAt: Schema.DateFromString,
} as const;

const PersistedObservedSourceVersionFields = {
  sourceVersion: SourceVersionSchema,
} as const;

const PersistedMigratedItemState = Schema.Struct({
  ...PersistedMigrationItemStateBaseFields,
  ...PersistedObservedSourceVersionFields,
  destinationIdentity: DestinationIdentitySchema,
  destinationVersion: Schema.optional(DestinationVersionSchema),
  status: Schema.Literal("migrated"),
});

const PersistedSkippedItemState = Schema.Struct({
  ...PersistedMigrationItemStateBaseFields,
  ...PersistedObservedSourceVersionFields,
  skipReason: Schema.String,
  status: Schema.Literal("skipped"),
});

const PersistedFailedItemState = Schema.Struct({
  ...PersistedMigrationItemStateBaseFields,
  sourceVersion: Schema.optional(SourceVersionSchema),
  destinationIdentity: Schema.optional(DestinationIdentitySchema),
  destinationVersion: Schema.optional(DestinationVersionSchema),
  error: MigrationItemError,
  status: Schema.Literal("failed"),
});

const PersistedNeedsUpdateItemState = Schema.Struct({
  ...PersistedMigrationItemStateBaseFields,
  sourceVersion: Schema.optional(SourceVersionSchema),
  destinationIdentity: DestinationIdentitySchema,
  destinationVersion: Schema.optional(DestinationVersionSchema),
  reason: Schema.String,
  status: Schema.Literal("needs-update"),
});

const PersistedMigrationItemState = Schema.Union([
  PersistedMigratedItemState,
  PersistedSkippedItemState,
  PersistedFailedItemState,
  PersistedNeedsUpdateItemState,
]);
type MigrationItemState = typeof PersistedMigrationItemState.Type;

const MigrationItemStateRecord = Schema.Struct({
  formatVersion: Schema.Literal(formatVersion),
  index: Schema.Struct({
    definitionId: MigrationDefinitionIdSchema,
    lastRunId: MigrationRunIdSchema,
    sourceIdentity: SourceIdentitySchema,
    sourceIdentityHash: Schema.String,
    status: Schema.Literals(["migrated", "skipped", "failed", "needs-update"]),
    updatedAt: Schema.DateFromString,
  }),
  namespace: Schema.String,
  recordKind: Schema.Literal("migration-item-state"),
  state: PersistedMigrationItemState,
});
type MigrationItemStateRecord = typeof MigrationItemStateRecord.Type;

const storeError = (message: string, cause?: unknown): MigrationStoreError =>
  new MigrationStoreError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const unsupportedOperation = (operation: string): MigrationStoreError =>
  storeError(
    `Commercetools migration store operation is not implemented yet: ${operation}`
  );

const hashSegment = (value: string): string =>
  createHash("sha256").update(value).digest("base64url");

const sourceCursorKey = (
  namespace: string,
  definitionId: MigrationDefinitionId
): string =>
  `${namespace}__encoded-source-cursor__definition_${hashSegment(definitionId)}`;

const itemStateKey = (
  namespace: string,
  definitionId: MigrationDefinitionId,
  identity: SourceIdentity
): string =>
  `${namespace}__migration-item-state__definition_${hashSegment(definitionId)}__source_${hashSegment(identity)}`;

const latestRunStateKey = (
  namespace: string,
  definitionId: MigrationDefinitionId
): string =>
  `${namespace}__latest-run-state__definition_${hashSegment(definitionId)}`;

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
  const maxLength =
    fieldName === "container"
      ? maxCustomObjectContainerLength
      : maxCustomObjectNamespaceLength;

  if (value.length === 0) {
    return Effect.fail(
      storeError(`Commercetools migration store ${fieldName} cannot be empty`)
    );
  }

  if (value.length > maxLength) {
    return Effect.fail(
      storeError(
        `Commercetools migration store ${fieldName} cannot exceed ${maxLength} characters`
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

const hasStatusCode = (cause: unknown, statusCode: number): boolean => {
  if (typeof cause !== "object" || cause === null) {
    return false;
  }

  if ("statusCode" in cause && cause.statusCode === statusCode) {
    return true;
  }

  if ("code" in cause && cause.code === statusCode) {
    return true;
  }

  if (
    "body" in cause &&
    typeof cause.body === "object" &&
    cause.body !== null &&
    "statusCode" in cause.body &&
    cause.body.statusCode === statusCode
  ) {
    return true;
  }

  return false;
};

const isNotFoundSdkError = (cause: CommercetoolsSdkError): boolean =>
  hasStatusCode(cause.cause, 404);

const encodeRecord = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
  value: A,
  key: string
): Effect.Effect<unknown, MigrationStoreError> =>
  Schema.encodeEffect(schema)(value).pipe(
    Effect.mapError((cause) =>
      storeError(`Unable to encode migration store record ${key}`, cause)
    )
  );

const decodeRecord = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
  value: unknown,
  key: string
): Effect.Effect<A, MigrationStoreError> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) =>
      storeError(`Unable to decode migration store record ${key}`, cause)
    )
  );

const readCustomObjectOptional = (
  sdk: typeof CommercetoolsSdk.Service,
  options: ResolvedCommercetoolsMigrationStoreOptions,
  key: string
): Effect.Effect<CustomObject | null, MigrationStoreError> =>
  sdk
    .request("customObjects.getMigrationStoreRecord", (project) =>
      project
        .customObjects()
        .withContainerAndKey({ container: options.container, key })
        .get()
    )
    .pipe(
      Effect.catchIf(isNotFoundSdkError, () => Effect.succeed(null)),
      Effect.mapError((cause) =>
        storeError(`Unable to read migration store Custom Object ${key}`, cause)
      )
    );

const upsertCustomObject = (
  sdk: typeof CommercetoolsSdk.Service,
  options: ResolvedCommercetoolsMigrationStoreOptions,
  key: string,
  value: unknown
): Effect.Effect<CustomObject, MigrationStoreError> => {
  const body: CustomObjectDraft = {
    container: options.container,
    key,
    value,
  };

  return sdk
    .request("customObjects.upsertMigrationStoreRecord", (project) =>
      project.customObjects().post({ body })
    )
    .pipe(
      Effect.mapError((cause) =>
        storeError(
          `Unable to upsert migration store Custom Object ${key}`,
          cause
        )
      )
    );
};

const deleteCustomObject = (
  sdk: typeof CommercetoolsSdk.Service,
  options: ResolvedCommercetoolsMigrationStoreOptions,
  key: string,
  version: number
): Effect.Effect<void, MigrationStoreError> =>
  sdk
    .request("customObjects.deleteMigrationStoreRecord", (project) =>
      project
        .customObjects()
        .withContainerAndKey({ container: options.container, key })
        .delete({ queryArgs: { version } })
    )
    .pipe(
      Effect.asVoid,
      Effect.mapError((cause) =>
        storeError(
          `Unable to delete migration store Custom Object ${key}`,
          cause
        )
      )
    );

const readRecordOptional = <A>(
  sdk: typeof CommercetoolsSdk.Service,
  options: ResolvedCommercetoolsMigrationStoreOptions,
  key: string,
  schema: Schema.Codec<A, unknown, never, never>
): Effect.Effect<A | null, MigrationStoreError> =>
  Effect.flatMap(readCustomObjectOptional(sdk, options, key), (customObject) =>
    customObject === null
      ? Effect.succeed(null)
      : decodeRecord(schema, customObject.value, key)
  );

const writeRecord = <A>(
  sdk: typeof CommercetoolsSdk.Service,
  options: ResolvedCommercetoolsMigrationStoreOptions,
  key: string,
  schema: Schema.Codec<A, unknown, never, never>,
  record: A
): Effect.Effect<void, MigrationStoreError> =>
  encodeRecord(schema, record, key).pipe(
    Effect.flatMap((value) => upsertCustomObject(sdk, options, key, value)),
    Effect.asVoid
  );

const sourceCursorRecord = (
  options: ResolvedCommercetoolsMigrationStoreOptions,
  definitionId: MigrationDefinitionId,
  cursor: EncodedSourceCursor
): EncodedSourceCursorRecord => ({
  formatVersion,
  index: {
    definitionId,
  },
  namespace: options.namespace,
  recordKind: "encoded-source-cursor",
  state: cursor,
});

const itemStateRecord = (
  options: ResolvedCommercetoolsMigrationStoreOptions,
  state: MigrationItemState
): MigrationItemStateRecord => ({
  formatVersion,
  index: {
    definitionId: state.definitionId,
    lastRunId: state.lastRunId,
    sourceIdentity: state.sourceIdentity,
    sourceIdentityHash: hashSegment(state.sourceIdentity),
    status: state.status,
    updatedAt: state.updatedAt,
  },
  namespace: options.namespace,
  recordKind: "migration-item-state",
  state,
});

const latestRunStateRecord = (
  options: ResolvedCommercetoolsMigrationStoreOptions,
  definitionId: MigrationDefinitionId,
  state: MigrationRunStateType
): LatestRunStateRecord => ({
  formatVersion,
  index: {
    definitionId,
    ...(state.finishedAt === undefined ? {} : { finishedAt: state.finishedAt }),
    runId: state.runId,
    startedAt: state.startedAt,
    status: state.status,
  },
  namespace: options.namespace,
  recordKind: "latest-run-state",
  state,
});

const readLatestRunState = (
  sdk: typeof CommercetoolsSdk.Service,
  options: ResolvedCommercetoolsMigrationStoreOptions,
  definitionId: MigrationDefinitionId
): Effect.Effect<MigrationRunStateType | null, MigrationStoreError> =>
  readRecordOptional(
    sdk,
    options,
    latestRunStateKey(options.namespace, definitionId),
    LatestRunStateRecord
  ).pipe(Effect.map((record) => record?.state ?? null));

const readRunState = (
  sdk: typeof CommercetoolsSdk.Service,
  options: ResolvedCommercetoolsMigrationStoreOptions,
  runId: MigrationRunId,
  definitionIds: readonly MigrationDefinitionId[]
): Effect.Effect<MigrationRunStateType, MigrationStoreError> =>
  Effect.gen(function* () {
    const runStates: MigrationRunStateType[] = [];

    for (const definitionId of definitionIds) {
      const runState = yield* readLatestRunState(sdk, options, definitionId);

      if (runState === null) {
        return yield* storeError("Migration run was not found", runId);
      }

      runStates.push(runState);
    }

    const current = runStates[0];

    if (
      current === undefined ||
      runStates.some((runState) => runState.runId !== runId)
    ) {
      return yield* storeError("Migration run was not found", runId);
    }

    return current;
  });

const writeLatestRunState = (
  sdk: typeof CommercetoolsSdk.Service,
  options: ResolvedCommercetoolsMigrationStoreOptions,
  state: MigrationRunStateType,
  definitionIds: readonly MigrationDefinitionId[]
): Effect.Effect<void, MigrationStoreError> =>
  Effect.gen(function* () {
    for (const definitionId of definitionIds) {
      const key = latestRunStateKey(options.namespace, definitionId);

      yield* writeRecord(
        sdk,
        options,
        key,
        LatestRunStateRecord,
        latestRunStateRecord(options, definitionId, state)
      );
    }
  });

const updateLatestRunState = (
  sdk: typeof CommercetoolsSdk.Service,
  options: ResolvedCommercetoolsMigrationStoreOptions,
  runId: MigrationRunId,
  definitionIds: readonly MigrationDefinitionId[],
  status: Extract<MigrationRunStateType["status"], "succeeded" | "failed">
): Effect.Effect<MigrationRunStateType, MigrationStoreError> =>
  Effect.gen(function* () {
    const current = yield* readRunState(sdk, options, runId, definitionIds);
    const updated: MigrationRunStateType = {
      ...current,
      finishedAt: new Date(),
      status,
    };

    yield* writeLatestRunState(sdk, options, updated, definitionIds);

    return updated;
  });

const makeService = (
  sdk: typeof CommercetoolsSdk.Service,
  options: ResolvedCommercetoolsMigrationStoreOptions
): (typeof MigrationStore)["Service"] => {
  const getSourceCursor = Effect.fn(
    "CommercetoolsMigrationStore.getSourceCursor"
  )((definitionId: MigrationDefinitionId) =>
    readRecordOptional(
      sdk,
      options,
      sourceCursorKey(options.namespace, definitionId),
      EncodedSourceCursorRecord
    ).pipe(Effect.map((record) => record?.state ?? null))
  );

  const setSourceCursor = Effect.fn(
    "CommercetoolsMigrationStore.setSourceCursor"
  )((definitionId: MigrationDefinitionId, cursor: EncodedSourceCursor) => {
    const key = sourceCursorKey(options.namespace, definitionId);

    return writeRecord(
      sdk,
      options,
      key,
      EncodedSourceCursorRecord,
      sourceCursorRecord(options, definitionId, cursor)
    );
  });

  const getItemState = Effect.fn("CommercetoolsMigrationStore.getItemState")(
    (definitionId: MigrationDefinitionId, identity: SourceIdentity) =>
      readRecordOptional(
        sdk,
        options,
        itemStateKey(options.namespace, definitionId, identity),
        MigrationItemStateRecord
      ).pipe(Effect.map((record) => record?.state ?? null))
  );

  const deleteItemState = Effect.fn(
    "CommercetoolsMigrationStore.deleteItemState"
  )(function* (definitionId: MigrationDefinitionId, identity: SourceIdentity) {
    const key = itemStateKey(options.namespace, definitionId, identity);
    const customObject = yield* readCustomObjectOptional(sdk, options, key);

    if (customObject === null) {
      return;
    }

    yield* decodeRecord(MigrationItemStateRecord, customObject.value, key);
    yield* deleteCustomObject(sdk, options, key, customObject.version);
  });

  const upsertItemState = Effect.fn(
    "CommercetoolsMigrationStore.upsertItemState"
  )((state: MigrationItemState) => {
    const key = itemStateKey(
      options.namespace,
      state.definitionId,
      state.sourceIdentity
    );

    return writeRecord(
      sdk,
      options,
      key,
      MigrationItemStateRecord,
      itemStateRecord(options, state)
    );
  });

  const beginRun = Effect.fn("CommercetoolsMigrationStore.beginRun")(
    (runId: MigrationRunId, definitionIds: readonly MigrationDefinitionId[]) =>
      Effect.gen(function* () {
        const runState: MigrationRunStateType = {
          definitionIds,
          runId,
          startedAt: new Date(),
          status: "running",
        };

        yield* writeLatestRunState(sdk, options, runState, definitionIds);

        return runState;
      })
  );

  const completeRun = Effect.fn("CommercetoolsMigrationStore.completeRun")(
    (runId: MigrationRunId, definitionIds: readonly MigrationDefinitionId[]) =>
      updateLatestRunState(sdk, options, runId, definitionIds, "succeeded")
  );

  const failRun = Effect.fn("CommercetoolsMigrationStore.failRun")(
    (runId: MigrationRunId, definitionIds: readonly MigrationDefinitionId[]) =>
      updateLatestRunState(sdk, options, runId, definitionIds, "failed")
  );

  return {
    getSourceCursor,
    setSourceCursor,
    getItemState,
    listItemStates: () => Effect.fail(unsupportedOperation("listItemStates")),
    deleteItemState,
    upsertItemState,
    createRunId: Effect.sync(() => toMigrationRunId(`run-${randomUUID()}`)),
    beginRun,
    completeRun,
    failRun,
    acquireDefinitionLock: () =>
      Effect.fail(unsupportedOperation("acquireDefinitionLock")),
    releaseDefinitionLock: () =>
      Effect.fail(unsupportedOperation("releaseDefinitionLock")),
  };
};

const makeLayer = (
  options?: CommercetoolsMigrationStoreOptions
): Layer.Layer<MigrationStore, MigrationStoreError, CommercetoolsSdk> =>
  Layer.effect(
    MigrationStore,
    Effect.gen(function* () {
      const sdk = yield* CommercetoolsSdk;
      const resolvedOptions = yield* resolveOptions(options);

      return makeService(sdk, resolvedOptions);
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
