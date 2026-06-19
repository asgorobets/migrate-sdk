import { createHash, randomUUID } from "node:crypto";
import type {
  CustomObject,
  CustomObjectDraft,
  CustomObjectPagedQueryResponse,
} from "@commercetools/platform-sdk";
import { Effect, Layer, Schema } from "effect";
import {
  DestinationJournalEntry,
  DestinationJournalRollbackAttemptError,
  EncodedSourceCursor as EncodedSourceCursorSchema,
  type EncodedSourceIdentity as EncodedSourceIdentitySchema,
  MigrationContractSchema,
  type MigrationContract as MigrationContractType,
  MigrationDefinitionId as MigrationDefinitionIdSchema,
  type MigrationDefinitionLock as MigrationDefinitionLockSchema,
  MigrationDefinitionLockToken as MigrationDefinitionLockTokenSchema,
  MigrationItemError,
  type MigrationItemState as MigrationItemStateSchema,
  MigrationRunId as MigrationRunIdSchema,
  type MigrationRunState,
  MigrationStore,
  MigrationStoreError,
  SourceIdentitySnapshotSchema,
  SourceVersionContractFingerprint,
  SourceVersion as SourceVersionSchema,
  TrackingRecord,
  toMigrationDefinitionLockToken,
  toMigrationRunId,
} from "migrate-sdk";
import {
  CommercetoolsSdk,
  type CommercetoolsSdkError,
  type CommercetoolsSdkLayerOptions,
} from "../sdk.ts";

type EncodedSourceCursor = typeof EncodedSourceCursorSchema.Type;
type EncodedSourceIdentity = typeof EncodedSourceIdentitySchema.Type;
type MigrationDefinitionLock = typeof MigrationDefinitionLockSchema.Type;
type MigrationDefinitionId = typeof MigrationDefinitionIdSchema.Type;
type MigrationRunId = typeof MigrationRunIdSchema.Type;
type MigrationRunStateType = typeof MigrationRunState.Type;
type MigrationItemState = typeof MigrationItemStateSchema.Type;
type SourceIdentitySnapshot = typeof SourceIdentitySnapshotSchema.Type;

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

const MigrationContractRecord = Schema.Struct({
  formatVersion: Schema.Literal(formatVersion),
  index: Schema.Struct({
    definitionId: MigrationDefinitionIdSchema,
  }),
  namespace: Schema.String,
  recordKind: Schema.Literal("migration-contract"),
  state: MigrationContractSchema,
});
type MigrationContractRecord = typeof MigrationContractRecord.Type;

const PersistedMigrationItemStateBaseFields = {
  definitionId: MigrationDefinitionIdSchema,
  lastRunId: MigrationRunIdSchema,
  sourceIdentity: SourceIdentitySnapshotSchema,
  updatedAt: Schema.DateFromString,
} as const;

const PersistedObservedSourceVersionFields = {
  sourceVersionContractFingerprint: Schema.optional(
    SourceVersionContractFingerprint
  ),
  sourceVersion: SourceVersionSchema,
} as const;

const PersistedDestinationJournalSegmentFields = {
  entries: Schema.Array(DestinationJournalEntry),
  runId: MigrationRunIdSchema,
} as const;

const PersistedDestinationJournalSegment = Schema.Struct(
  PersistedDestinationJournalSegmentFields
);

const PersistedDestinationRollbackAttemptJournalSegment = Schema.Struct({
  ...PersistedDestinationJournalSegmentFields,
  error: DestinationJournalRollbackAttemptError,
  failedAt: Schema.DateFromString,
});

const PersistedDestinationJournal = Schema.Struct({
  process: PersistedDestinationJournalSegment,
  rollbackAttempts: Schema.Array(
    PersistedDestinationRollbackAttemptJournalSegment
  ),
});

const PersistedMigratedItemState = Schema.Struct({
  ...PersistedMigrationItemStateBaseFields,
  ...PersistedObservedSourceVersionFields,
  journal: Schema.optional(PersistedDestinationJournal),
  status: Schema.Literal("migrated"),
  trackingRecord: Schema.optional(TrackingRecord),
});

const PersistedSkippedItemState = Schema.Struct({
  ...PersistedMigrationItemStateBaseFields,
  ...PersistedObservedSourceVersionFields,
  journal: Schema.optional(PersistedDestinationJournal),
  skipReason: Schema.String,
  status: Schema.Literal("skipped"),
  trackingRecord: Schema.optional(TrackingRecord),
});

const PersistedFailedItemState = Schema.Struct({
  ...PersistedMigrationItemStateBaseFields,
  sourceVersionContractFingerprint: Schema.optional(
    SourceVersionContractFingerprint
  ),
  sourceVersion: Schema.optional(SourceVersionSchema),
  error: MigrationItemError,
  journal: Schema.optional(PersistedDestinationJournal),
  status: Schema.Literal("failed"),
  trackingRecord: Schema.optional(TrackingRecord),
});

const PersistedNeedsUpdateItemState = Schema.Struct({
  ...PersistedMigrationItemStateBaseFields,
  sourceVersionContractFingerprint: Schema.optional(
    SourceVersionContractFingerprint
  ),
  sourceVersion: Schema.optional(SourceVersionSchema),
  journal: Schema.optional(PersistedDestinationJournal),
  reason: Schema.String,
  status: Schema.Literal("needs-update"),
  trackingRecord: Schema.optional(TrackingRecord),
});

const PersistedMigrationItemState = Schema.Union([
  PersistedMigratedItemState,
  PersistedSkippedItemState,
  PersistedFailedItemState,
  PersistedNeedsUpdateItemState,
]);

const MigrationItemStateRecord = Schema.Struct({
  formatVersion: Schema.Literal(formatVersion),
  index: Schema.Struct({
    definitionId: MigrationDefinitionIdSchema,
    lastRunId: MigrationRunIdSchema,
    sourceIdentity: SourceIdentitySnapshotSchema,
    sourceIdentityHash: Schema.String,
    status: Schema.Literals(["migrated", "skipped", "failed", "needs-update"]),
    updatedAt: Schema.DateFromString,
  }),
  namespace: Schema.String,
  recordKind: Schema.Literal("migration-item-state"),
  state: PersistedMigrationItemState,
});
type MigrationItemStateRecord = typeof MigrationItemStateRecord.Type;

const PersistedMigrationDefinitionLock = Schema.Struct({
  createdAt: Schema.DateFromString,
  definitionId: MigrationDefinitionIdSchema,
  ownerRunId: MigrationRunIdSchema,
  token: MigrationDefinitionLockTokenSchema,
});

const MigrationDefinitionLockRecord = Schema.Struct({
  formatVersion: Schema.Literal(formatVersion),
  index: Schema.Struct({
    definitionId: MigrationDefinitionIdSchema,
    ownerRunId: MigrationRunIdSchema,
  }),
  namespace: Schema.String,
  recordKind: Schema.Literal("migration-definition-lock"),
  state: PersistedMigrationDefinitionLock,
});
type MigrationDefinitionLockRecord = typeof MigrationDefinitionLockRecord.Type;

const storeError = (message: string, cause?: unknown): MigrationStoreError =>
  new MigrationStoreError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const hashSegment = (value: string): string =>
  createHash("sha256").update(value).digest("base64url");

const definitionHashSegment = (definitionId: MigrationDefinitionId): string =>
  `definition-hash_${hashSegment(definitionId)}`;

const sourceIdentityHashSegment = (identity: EncodedSourceIdentity): string =>
  `source-identity-hash_${hashSegment(identity)}`;

const sourceCursorKey = (
  namespace: string,
  definitionId: MigrationDefinitionId
): string =>
  `${namespace}__encoded-source-cursor__${definitionHashSegment(definitionId)}`;

const migrationContractKey = (
  namespace: string,
  definitionId: MigrationDefinitionId
): string =>
  `${namespace}__migration-contract__${definitionHashSegment(definitionId)}`;

const itemStateKey = (
  namespace: string,
  definitionId: MigrationDefinitionId,
  identity: EncodedSourceIdentity
): string =>
  `${namespace}__migration-item-state__${definitionHashSegment(definitionId)}__${sourceIdentityHashSegment(identity)}`;

const latestRunStateKey = (
  namespace: string,
  definitionId: MigrationDefinitionId
): string =>
  `${namespace}__latest-run-state__${definitionHashSegment(definitionId)}`;

const definitionLockKey = (
  namespace: string,
  definitionId: MigrationDefinitionId
): string =>
  `${namespace}__migration-definition-lock__${definitionHashSegment(definitionId)}`;

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

const isConcurrentModificationSdkError = (
  cause: CommercetoolsSdkError
): boolean => hasStatusCode(cause.cause, 409);

interface CustomObjectQueryPredicate {
  readonly variables: Readonly<Record<`var.${string}`, string>>;
  readonly where: string;
}

const formatVersionValue = (value: unknown): unknown => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("formatVersion" in value)
  ) {
    return undefined;
  }

  return value.formatVersion;
};

const itemStateListPredicate = ({
  definitionId,
  lastKey,
  namespace,
}: {
  readonly definitionId: MigrationDefinitionId;
  readonly lastKey?: string;
  readonly namespace: string;
}): CustomObjectQueryPredicate => ({
  variables: {
    "var.definitionId": definitionId,
    ...(lastKey === undefined ? {} : { "var.lastKey": lastKey }),
    "var.namespace": namespace,
    "var.recordKind": "migration-item-state",
  },
  where: [
    "value(namespace = :namespace)",
    "value(recordKind = :recordKind)",
    "value(index(definitionId = :definitionId))",
    ...(lastKey === undefined ? [] : ["key > :lastKey"]),
  ].join(" and "),
});

const lockAcquisitionError = (
  definitionId: MigrationDefinitionId,
  cause: CommercetoolsSdkError
): MigrationStoreError =>
  isConcurrentModificationSdkError(cause)
    ? storeError("Migration definition is already locked", definitionId)
    : storeError(
        `Unable to acquire migration definition lock ${definitionId}`,
        cause
      );

const lockOwnershipError = (
  lock: MigrationDefinitionLock,
  current: MigrationDefinitionLock
): MigrationStoreError =>
  storeError("Migration definition lock is owned by another runner", {
    currentOwnerRunId: current.ownerRunId,
    currentToken: current.token,
    definitionId: lock.definitionId,
    releaseOwnerRunId: lock.ownerRunId,
    releaseToken: lock.token,
  });

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
): Effect.Effect<A, MigrationStoreError> => {
  const persistedFormatVersion = formatVersionValue(value);

  if (
    persistedFormatVersion !== undefined &&
    persistedFormatVersion !== formatVersion
  ) {
    return Effect.fail(
      storeError(
        `Unsupported migration store record format version ${String(
          persistedFormatVersion
        )} for ${key}; expected ${formatVersion}`
      )
    );
  }

  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) =>
      storeError(`Unable to decode migration store record ${key}`, cause)
    )
  );
};

const metadataMismatchError = (
  key: string,
  fieldName: string,
  expected: unknown,
  actual: unknown
): MigrationStoreError =>
  storeError(`Migration store record metadata mismatch for ${key}`, {
    actual,
    expected,
    fieldName,
  });

const validateMetadata = (
  key: string,
  fieldName: string,
  expected: unknown,
  actual: unknown
): Effect.Effect<void, MigrationStoreError> =>
  actual === expected
    ? Effect.void
    : Effect.fail(metadataMismatchError(key, fieldName, expected, actual));

const sourceIdentitySnapshotKeyValue = (
  value: SourceIdentitySnapshot["key"]
): string => JSON.stringify(value);

const sameSourceIdentitySnapshots = (
  left: SourceIdentitySnapshot,
  right: SourceIdentitySnapshot
): boolean =>
  left.encoded === right.encoded &&
  left.fingerprint === right.fingerprint &&
  left.id === right.id &&
  sourceIdentitySnapshotKeyValue(left.key) ===
    sourceIdentitySnapshotKeyValue(right.key);

const validateSourceIdentitySnapshotMetadata = (
  key: string,
  fieldName: string,
  expected: SourceIdentitySnapshot,
  actual: SourceIdentitySnapshot
): Effect.Effect<void, MigrationStoreError> =>
  sameSourceIdentitySnapshots(expected, actual)
    ? Effect.void
    : Effect.fail(metadataMismatchError(key, fieldName, expected, actual));

const dateMetadataValue = (date: Date | undefined): string | undefined =>
  date?.toISOString();

const validateDateMetadata = (
  key: string,
  fieldName: string,
  expected: Date | undefined,
  actual: Date | undefined
): Effect.Effect<void, MigrationStoreError> =>
  validateMetadata(
    key,
    fieldName,
    dateMetadataValue(expected),
    dateMetadataValue(actual)
  );

const sameDefinitionIds = (
  left: readonly MigrationDefinitionId[],
  right: readonly MigrationDefinitionId[]
): boolean =>
  left.length === right.length &&
  left.every((definitionId, index) => definitionId === right[index]);

const validateDefinitionIdsMetadata = (
  key: string,
  fieldName: string,
  expected: readonly MigrationDefinitionId[],
  actual: readonly MigrationDefinitionId[]
): Effect.Effect<void, MigrationStoreError> =>
  sameDefinitionIds(expected, actual)
    ? Effect.void
    : Effect.fail(metadataMismatchError(key, fieldName, expected, actual));

const validateRecordNamespace = (
  options: ResolvedCommercetoolsMigrationStoreOptions,
  key: string,
  record: { readonly namespace: string }
): Effect.Effect<void, MigrationStoreError> =>
  validateMetadata(key, "namespace", options.namespace, record.namespace);

const validateSourceCursorRecord = (
  options: ResolvedCommercetoolsMigrationStoreOptions,
  key: string,
  definitionId: MigrationDefinitionId,
  record: EncodedSourceCursorRecord
): Effect.Effect<void, MigrationStoreError> =>
  validateRecordNamespace(options, key, record).pipe(
    Effect.andThen(
      validateMetadata(
        key,
        "definitionId",
        definitionId,
        record.index.definitionId
      )
    )
  );

const validateMigrationContractRecord = (
  options: ResolvedCommercetoolsMigrationStoreOptions,
  key: string,
  definitionId: MigrationDefinitionId,
  record: MigrationContractRecord
): Effect.Effect<void, MigrationStoreError> =>
  validateRecordNamespace(options, key, record).pipe(
    Effect.andThen(
      validateMetadata(
        key,
        "key",
        migrationContractKey(options.namespace, record.index.definitionId),
        key
      )
    ),
    Effect.andThen(
      validateMetadata(
        key,
        "index.definitionId",
        definitionId,
        record.index.definitionId
      )
    ),
    Effect.andThen(
      validateMetadata(
        key,
        "state.definitionId",
        definitionId,
        record.state.definitionId
      )
    )
  );

const validateItemStateRecord = (
  options: ResolvedCommercetoolsMigrationStoreOptions,
  key: string,
  record: MigrationItemStateRecord,
  expected: {
    readonly definitionId: MigrationDefinitionId;
    readonly sourceIdentity?: EncodedSourceIdentity;
  }
): Effect.Effect<void, MigrationStoreError> =>
  Effect.all(
    [
      validateRecordNamespace(options, key, record),
      validateMetadata(
        key,
        "index.definitionId",
        expected.definitionId,
        record.index.definitionId
      ),
      validateMetadata(
        key,
        "state.definitionId",
        expected.definitionId,
        record.state.definitionId
      ),
      validateMetadata(
        key,
        "key",
        itemStateKey(
          options.namespace,
          record.state.definitionId,
          record.state.sourceIdentity.encoded
        ),
        key
      ),
      validateMetadata(
        key,
        "index.lastRunId",
        record.state.lastRunId,
        record.index.lastRunId
      ),
      validateSourceIdentitySnapshotMetadata(
        key,
        "index.sourceIdentity",
        record.state.sourceIdentity,
        record.index.sourceIdentity
      ),
      validateMetadata(
        key,
        "index.sourceIdentityHash",
        hashSegment(record.state.sourceIdentity.encoded),
        record.index.sourceIdentityHash
      ),
      validateMetadata(
        key,
        "index.status",
        record.state.status,
        record.index.status
      ),
      validateDateMetadata(
        key,
        "index.updatedAt",
        record.state.updatedAt,
        record.index.updatedAt
      ),
      ...(expected.sourceIdentity === undefined
        ? []
        : [
            validateMetadata(
              key,
              "state.sourceIdentity.encoded",
              expected.sourceIdentity,
              record.state.sourceIdentity.encoded
            ),
          ]),
    ],
    { discard: true }
  );

const validateLatestRunStateRecord = (
  options: ResolvedCommercetoolsMigrationStoreOptions,
  key: string,
  definitionId: MigrationDefinitionId,
  record: LatestRunStateRecord
): Effect.Effect<void, MigrationStoreError> =>
  validateRecordNamespace(options, key, record).pipe(
    Effect.andThen(
      validateMetadata(
        key,
        "key",
        latestRunStateKey(options.namespace, record.index.definitionId),
        key
      )
    ),
    Effect.andThen(
      validateMetadata(
        key,
        "index.definitionId",
        definitionId,
        record.index.definitionId
      )
    ),
    Effect.andThen(
      validateMetadata(
        key,
        "index.runId",
        record.state.runId,
        record.index.runId
      )
    ),
    Effect.andThen(
      validateDateMetadata(
        key,
        "index.startedAt",
        record.state.startedAt,
        record.index.startedAt
      )
    ),
    Effect.andThen(
      validateMetadata(
        key,
        "index.status",
        record.state.status,
        record.index.status
      )
    ),
    Effect.andThen(
      validateDateMetadata(
        key,
        "index.finishedAt",
        record.state.finishedAt,
        record.index.finishedAt
      )
    ),
    Effect.andThen(
      record.state.definitionIds.includes(definitionId)
        ? Effect.void
        : Effect.fail(
            metadataMismatchError(
              key,
              "state.definitionIds",
              definitionId,
              record.state.definitionIds
            )
          )
    )
  );

const validateDefinitionLockRecord = (
  options: ResolvedCommercetoolsMigrationStoreOptions,
  key: string,
  definitionId: MigrationDefinitionId,
  record: MigrationDefinitionLockRecord
): Effect.Effect<void, MigrationStoreError> =>
  validateRecordNamespace(options, key, record).pipe(
    Effect.andThen(
      validateMetadata(
        key,
        "key",
        definitionLockKey(options.namespace, record.state.definitionId),
        key
      )
    ),
    Effect.andThen(
      validateMetadata(
        key,
        "index.definitionId",
        definitionId,
        record.index.definitionId
      )
    ),
    Effect.andThen(
      validateMetadata(
        key,
        "state.definitionId",
        definitionId,
        record.state.definitionId
      )
    ),
    Effect.andThen(
      validateMetadata(
        key,
        "index.ownerRunId",
        record.state.ownerRunId,
        record.index.ownerRunId
      )
    )
  );

const validateRunStateRecords = (
  runId: MigrationRunId,
  definitionIds: readonly MigrationDefinitionId[],
  runStates: readonly MigrationRunStateType[]
): Effect.Effect<MigrationRunStateType, MigrationStoreError> =>
  Effect.gen(function* () {
    const current = runStates[0];

    if (
      current === undefined ||
      runStates.some((runState) => runState.runId !== runId)
    ) {
      return yield* storeError("Migration run was not found", runId);
    }

    const key = `migration run ${runId}`;

    for (const runState of runStates) {
      yield* validateDefinitionIdsMetadata(
        key,
        "definitionIds",
        definitionIds,
        runState.definitionIds
      );
      yield* validateMetadata(key, "status", current.status, runState.status);
      yield* validateDateMetadata(
        key,
        "startedAt",
        current.startedAt,
        runState.startedAt
      );
      yield* validateDateMetadata(
        key,
        "finishedAt",
        current.finishedAt,
        runState.finishedAt
      );
    }

    return current;
  });

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
  value: unknown,
  writeOptions: {
    readonly mapError?: (cause: CommercetoolsSdkError) => MigrationStoreError;
    readonly version?: number;
  } = {}
): Effect.Effect<CustomObject, MigrationStoreError> => {
  const body: CustomObjectDraft = {
    container: options.container,
    key,
    value,
    ...(writeOptions.version === undefined
      ? {}
      : { version: writeOptions.version }),
  };
  const mapError =
    writeOptions.mapError ??
    ((cause: CommercetoolsSdkError) =>
      storeError(
        `Unable to upsert migration store Custom Object ${key}`,
        cause
      ));

  return sdk
    .request("customObjects.upsertMigrationStoreRecord", (project) =>
      project.customObjects().post({ body })
    )
    .pipe(Effect.mapError(mapError));
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

const queryCustomObjects = (
  sdk: typeof CommercetoolsSdk.Service,
  options: ResolvedCommercetoolsMigrationStoreOptions,
  predicate: CustomObjectQueryPredicate
): Effect.Effect<CustomObjectPagedQueryResponse, MigrationStoreError> =>
  sdk
    .request("customObjects.queryMigrationStoreRecords", (project) =>
      project
        .customObjects()
        .withContainer({ container: options.container })
        .get({
          queryArgs: {
            limit: options.pageSize,
            sort: "key asc",
            where: predicate.where,
            withTotal: false,
            ...predicate.variables,
          },
        })
    )
    .pipe(
      Effect.mapError((cause) =>
        storeError("Unable to query migration store Custom Objects", cause)
      )
    );

const readRecordOptional = <A>(
  sdk: typeof CommercetoolsSdk.Service,
  options: ResolvedCommercetoolsMigrationStoreOptions,
  key: string,
  schema: Schema.Codec<A, unknown, never, never>,
  validateRecord: (
    record: A
  ) => Effect.Effect<void, MigrationStoreError> = () => Effect.void
): Effect.Effect<A | null, MigrationStoreError> =>
  Effect.flatMap(readCustomObjectOptional(sdk, options, key), (customObject) =>
    customObject === null
      ? Effect.succeed(null)
      : decodeRecord(schema, customObject.value, key).pipe(
          Effect.tap(validateRecord)
        )
  );

const writeRecord = <A>(
  sdk: typeof CommercetoolsSdk.Service,
  options: ResolvedCommercetoolsMigrationStoreOptions,
  key: string,
  schema: Schema.Codec<A, unknown, never, never>,
  record: A,
  writeOptions?: {
    readonly mapError?: (cause: CommercetoolsSdkError) => MigrationStoreError;
    readonly version?: number;
  }
): Effect.Effect<void, MigrationStoreError> =>
  encodeRecord(schema, record, key).pipe(
    Effect.flatMap((value) =>
      upsertCustomObject(sdk, options, key, value, writeOptions)
    ),
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

const migrationContractRecord = (
  options: ResolvedCommercetoolsMigrationStoreOptions,
  contract: MigrationContractType
): MigrationContractRecord => ({
  formatVersion,
  index: {
    definitionId: contract.definitionId,
  },
  namespace: options.namespace,
  recordKind: "migration-contract",
  state: contract,
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
    sourceIdentityHash: hashSegment(state.sourceIdentity.encoded),
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

const definitionLockRecord = (
  options: ResolvedCommercetoolsMigrationStoreOptions,
  lock: MigrationDefinitionLock
): MigrationDefinitionLockRecord => ({
  formatVersion,
  index: {
    definitionId: lock.definitionId,
    ownerRunId: lock.ownerRunId,
  },
  namespace: options.namespace,
  recordKind: "migration-definition-lock",
  state: lock,
});

const readLatestRunState = (
  sdk: typeof CommercetoolsSdk.Service,
  options: ResolvedCommercetoolsMigrationStoreOptions,
  definitionId: MigrationDefinitionId
): Effect.Effect<MigrationRunStateType | null, MigrationStoreError> => {
  const key = latestRunStateKey(options.namespace, definitionId);

  return readRecordOptional(sdk, options, key, LatestRunStateRecord, (record) =>
    validateLatestRunStateRecord(options, key, definitionId, record)
  ).pipe(Effect.map((record) => record?.state ?? null));
};

const listItemStates = (
  sdk: typeof CommercetoolsSdk.Service,
  options: ResolvedCommercetoolsMigrationStoreOptions,
  definitionId: MigrationDefinitionId
): Effect.Effect<readonly MigrationItemState[], MigrationStoreError> =>
  Effect.gen(function* () {
    const itemStates: MigrationItemState[] = [];
    let lastKey: string | undefined;

    while (true) {
      const page = yield* queryCustomObjects(
        sdk,
        options,
        itemStateListPredicate({
          definitionId,
          namespace: options.namespace,
          ...(lastKey === undefined ? {} : { lastKey }),
        })
      );

      for (const customObject of page.results) {
        const record = yield* decodeRecord(
          MigrationItemStateRecord,
          customObject.value,
          customObject.key
        );

        yield* validateItemStateRecord(options, customObject.key, record, {
          definitionId,
        });

        itemStates.push(record.state);
      }

      if (page.results.length < options.pageSize) {
        break;
      }

      const nextLastKey = page.results.at(-1)?.key;

      if (nextLastKey === undefined || nextLastKey === lastKey) {
        break;
      }

      lastKey = nextLastKey;
    }

    return itemStates;
  });

const summarizeItemStates = (
  itemStates: readonly MigrationItemState[]
): {
  readonly failed: number;
  readonly migrated: number;
  readonly needsUpdate: number;
  readonly skipped: number;
} => {
  const summary = {
    failed: 0,
    migrated: 0,
    needsUpdate: 0,
    skipped: 0,
  };

  for (const itemState of itemStates) {
    switch (itemState.status) {
      case "failed":
        summary.failed += 1;
        break;
      case "migrated":
        summary.migrated += 1;
        break;
      case "needs-update":
        summary.needsUpdate += 1;
        break;
      case "skipped":
        summary.skipped += 1;
        break;
      default:
        break;
    }
  }

  return summary;
};

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

    return yield* validateRunStateRecords(runId, definitionIds, runStates);
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
  )((definitionId: MigrationDefinitionId) => {
    const key = sourceCursorKey(options.namespace, definitionId);

    return readRecordOptional(
      sdk,
      options,
      key,
      EncodedSourceCursorRecord,
      (record) => validateSourceCursorRecord(options, key, definitionId, record)
    ).pipe(Effect.map((record) => record?.state ?? null));
  });

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

  const deleteSourceCursor = Effect.fn(
    "CommercetoolsMigrationStore.deleteSourceCursor"
  )(function* (definitionId: MigrationDefinitionId) {
    const key = sourceCursorKey(options.namespace, definitionId);
    const customObject = yield* readCustomObjectOptional(sdk, options, key);

    if (customObject === null) {
      return;
    }

    yield* deleteCustomObject(sdk, options, key, customObject.version);
  });

  const getMigrationContract = Effect.fn(
    "CommercetoolsMigrationStore.getMigrationContract"
  )((definitionId: MigrationDefinitionId) => {
    const key = migrationContractKey(options.namespace, definitionId);

    return readRecordOptional(
      sdk,
      options,
      key,
      MigrationContractRecord,
      (record) =>
        validateMigrationContractRecord(options, key, definitionId, record)
    ).pipe(Effect.map((record) => record?.state ?? null));
  });

  const upsertMigrationContract = Effect.fn(
    "CommercetoolsMigrationStore.upsertMigrationContract"
  )((contract: MigrationContractType) => {
    const key = migrationContractKey(options.namespace, contract.definitionId);

    return writeRecord(
      sdk,
      options,
      key,
      MigrationContractRecord,
      migrationContractRecord(options, contract)
    );
  });

  const getItemState = Effect.fn("CommercetoolsMigrationStore.getItemState")(
    (definitionId: MigrationDefinitionId, identity: EncodedSourceIdentity) => {
      const key = itemStateKey(options.namespace, definitionId, identity);

      return readRecordOptional(
        sdk,
        options,
        key,
        MigrationItemStateRecord,
        (record) =>
          validateItemStateRecord(options, key, record, {
            definitionId,
            sourceIdentity: identity,
          })
      ).pipe(Effect.map((record) => record?.state ?? null));
    }
  );

  const getItemStateSummary = Effect.fn(
    "CommercetoolsMigrationStore.getItemStateSummary"
  )(function* (definitionId: MigrationDefinitionId) {
    const itemStates = yield* listItemStates(sdk, options, definitionId);

    return summarizeItemStates(itemStates);
  });

  const deleteItemState = Effect.fn(
    "CommercetoolsMigrationStore.deleteItemState"
  )(function* (
    definitionId: MigrationDefinitionId,
    identity: EncodedSourceIdentity
  ) {
    const key = itemStateKey(options.namespace, definitionId, identity);
    const customObject = yield* readCustomObjectOptional(sdk, options, key);

    if (customObject === null) {
      return;
    }

    const record = yield* decodeRecord(
      MigrationItemStateRecord,
      customObject.value,
      key
    );

    yield* validateItemStateRecord(options, key, record, {
      definitionId,
      sourceIdentity: identity,
    });
    yield* deleteCustomObject(sdk, options, key, customObject.version);
  });

  const upsertItemState = Effect.fn(
    "CommercetoolsMigrationStore.upsertItemState"
  )((state: MigrationItemState) => {
    const key = itemStateKey(
      options.namespace,
      state.definitionId,
      state.sourceIdentity.encoded
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

  const getLatestRunState = Effect.fn(
    "CommercetoolsMigrationStore.getLatestRunState"
  )((definitionId: MigrationDefinitionId) =>
    readLatestRunState(sdk, options, definitionId)
  );

  const completeRun = Effect.fn("CommercetoolsMigrationStore.completeRun")(
    (runId: MigrationRunId, definitionIds: readonly MigrationDefinitionId[]) =>
      updateLatestRunState(sdk, options, runId, definitionIds, "succeeded")
  );

  const failRun = Effect.fn("CommercetoolsMigrationStore.failRun")(
    (runId: MigrationRunId, definitionIds: readonly MigrationDefinitionId[]) =>
      updateLatestRunState(sdk, options, runId, definitionIds, "failed")
  );

  const acquireDefinitionLock = Effect.fn(
    "CommercetoolsMigrationStore.acquireDefinitionLock"
  )(function* (
    definitionId: MigrationDefinitionId,
    ownerRunId: MigrationRunId
  ) {
    const lock: MigrationDefinitionLock = {
      createdAt: new Date(),
      definitionId,
      ownerRunId,
      token: toMigrationDefinitionLockToken(`lock-${randomUUID()}`),
    };
    const key = definitionLockKey(options.namespace, definitionId);

    yield* writeRecord(
      sdk,
      options,
      key,
      MigrationDefinitionLockRecord,
      definitionLockRecord(options, lock),
      {
        mapError: (cause) => lockAcquisitionError(definitionId, cause),
        version: 0,
      }
    );

    return lock;
  });

  const releaseDefinitionLock = Effect.fn(
    "CommercetoolsMigrationStore.releaseDefinitionLock"
  )(function* (lock: MigrationDefinitionLock) {
    const key = definitionLockKey(options.namespace, lock.definitionId);
    const customObject = yield* readCustomObjectOptional(sdk, options, key);

    if (customObject === null) {
      return;
    }

    const record = yield* decodeRecord(
      MigrationDefinitionLockRecord,
      customObject.value,
      key
    );

    yield* validateDefinitionLockRecord(
      options,
      key,
      lock.definitionId,
      record
    );

    if (
      record.state.ownerRunId !== lock.ownerRunId ||
      record.state.token !== lock.token
    ) {
      return yield* lockOwnershipError(lock, record.state);
    }

    yield* deleteCustomObject(sdk, options, key, customObject.version);
  });

  return {
    getSourceCursor,
    setSourceCursor,
    deleteSourceCursor,
    getMigrationContract,
    upsertMigrationContract,
    getItemState,
    listItemStates: (definitionId: MigrationDefinitionId) =>
      listItemStates(sdk, options, definitionId),
    getItemStateSummary,
    deleteItemState,
    upsertItemState,
    createRunId: Effect.sync(() => toMigrationRunId(`run-${randomUUID()}`)),
    getLatestRunState,
    beginRun,
    completeRun,
    failRun,
    acquireDefinitionLock,
    releaseDefinitionLock,
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
