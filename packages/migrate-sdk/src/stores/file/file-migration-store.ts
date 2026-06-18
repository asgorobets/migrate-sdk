import { randomUUID } from "node:crypto";
import { layer as nodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { layer as nodePathLayer } from "@effect/platform-node/NodePath";
import { Effect, Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { MigrationStoreError } from "../../domain/errors.ts";
import {
  DestinationIdentity as DestinationIdentitySchema,
  DestinationVersion as DestinationVersionSchema,
  EncodedSourceCursor,
  type EncodedSourceCursor as EncodedSourceCursorType,
  type EncodedSourceIdentity,
  type MigrationDefinitionId,
  MigrationDefinitionId as MigrationDefinitionIdSchema,
  MigrationDefinitionLockToken as MigrationDefinitionLockTokenSchema,
  type MigrationRunId,
  MigrationRunId as MigrationRunIdSchema,
  SourceIdentitySnapshot as SourceIdentitySnapshotSchema,
  SourceVersion as SourceVersionSchema,
  toMigrationDefinitionLockToken,
} from "../../domain/ids.ts";
import type { MigrationDefinitionLock } from "../../domain/lock.ts";
import {
  MigrationContract,
  type MigrationContract as MigrationContractType,
  SourceVersionContractFingerprint,
} from "../../domain/migration-contract.ts";
import type { MigrationRunState } from "../../domain/run.ts";
import type { MigrationItemState } from "../../domain/state.ts";
import { MigrationItemError } from "../../domain/state.ts";
import { summarizeMigrationItemStates } from "../../domain/status.ts";
import {
  DestinationJournalEntry,
  DestinationJournalRollbackAttemptError,
  TrackingRecord,
} from "../../domain/tracking.ts";
import { MigrationStore } from "../../services/migration-store.ts";

export interface FileMigrationStoreOptions {
  readonly directory: string;
  readonly platform?: FileMigrationStorePlatform;
}

const formatVersion = 1;

const ManifestRecord = Schema.Struct({
  formatVersion: Schema.Literal(formatVersion),
  recordKind: Schema.Literal("manifest"),
  state: Schema.Struct({
    createdAt: Schema.DateFromString,
    storeKind: Schema.Literal("file"),
  }),
});
type ManifestRecord = typeof ManifestRecord.Type;

const PersistedMigrationRunState = Schema.Struct({
  definitionIds: Schema.Array(MigrationDefinitionIdSchema),
  finishedAt: Schema.optional(Schema.DateFromString),
  runId: MigrationRunIdSchema,
  startedAt: Schema.DateFromString,
  status: Schema.Literals(["running", "succeeded", "failed"]),
});

const LatestRunStateRecord = Schema.Struct({
  formatVersion: Schema.Literal(formatVersion),
  recordKind: Schema.Literal("latest-run-state"),
  state: PersistedMigrationRunState,
});
type LatestRunStateRecord = typeof LatestRunStateRecord.Type;

const EncodedSourceCursorRecord = Schema.Struct({
  formatVersion: Schema.Literal(formatVersion),
  recordKind: Schema.Literal("encoded-source-cursor"),
  state: EncodedSourceCursor,
});

const MigrationContractRecord = Schema.Struct({
  formatVersion: Schema.Literal(formatVersion),
  recordKind: Schema.Literal("migration-contract"),
  state: MigrationContract,
});

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
  destinationIdentity: Schema.optional(DestinationIdentitySchema),
  destinationVersion: Schema.optional(DestinationVersionSchema),
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
});

const PersistedFailedItemState = Schema.Struct({
  ...PersistedMigrationItemStateBaseFields,
  sourceVersionContractFingerprint: Schema.optional(
    SourceVersionContractFingerprint
  ),
  sourceVersion: Schema.optional(SourceVersionSchema),
  destinationIdentity: Schema.optional(DestinationIdentitySchema),
  destinationVersion: Schema.optional(DestinationVersionSchema),
  error: MigrationItemError,
  journal: Schema.optional(PersistedDestinationJournal),
  status: Schema.Literal("failed"),
});

const PersistedNeedsUpdateItemState = Schema.Struct({
  ...PersistedMigrationItemStateBaseFields,
  sourceVersionContractFingerprint: Schema.optional(
    SourceVersionContractFingerprint
  ),
  sourceVersion: Schema.optional(SourceVersionSchema),
  destinationIdentity: Schema.optional(DestinationIdentitySchema),
  destinationVersion: Schema.optional(DestinationVersionSchema),
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
  recordKind: Schema.Literal("migration-item-state"),
  state: PersistedMigrationItemState,
});

const PersistedMigrationDefinitionLock = Schema.Struct({
  createdAt: Schema.DateFromString,
  definitionId: MigrationDefinitionIdSchema,
  ownerRunId: MigrationRunIdSchema,
  token: MigrationDefinitionLockTokenSchema,
});

const MigrationDefinitionLockRecord = Schema.Struct({
  formatVersion: Schema.Literal(formatVersion),
  recordKind: Schema.Literal("migration-definition-lock"),
  state: PersistedMigrationDefinitionLock,
});

const textEncoder = new TextEncoder();
const safePathSegmentCharacter = /^[A-Za-z0-9._:-]$/u;

const storeError = (message: string, cause?: unknown): MigrationStoreError =>
  new MigrationStoreError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

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

const isPlatformSystemError = (
  cause: PlatformError,
  tag: PlatformError["reason"]["_tag"]
): boolean => cause.reason._tag === tag;

const encodePathSegment = (value: string): string => {
  if (value.length === 0) {
    throw new Error("Migration store path segment cannot be empty");
  }

  let encoded = "";

  for (const character of value) {
    if (safePathSegmentCharacter.test(character)) {
      encoded += character;
      continue;
    }

    for (const byte of textEncoder.encode(character)) {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }

  return encoded;
};

const jsonSchema = <A>(schema: Schema.Codec<A, unknown, never, never>) =>
  Schema.fromJsonString(schema);

const encodeRecord = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
  value: A,
  filePath: string
): Effect.Effect<string, MigrationStoreError> =>
  Schema.encodeEffect(jsonSchema(schema))(value).pipe(
    Effect.mapError((cause) =>
      storeError(
        `Unable to encode migration store record at ${filePath}`,
        cause
      )
    )
  );

const decodeRecord = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
  json: string,
  filePath: string
): Effect.Effect<A, MigrationStoreError> =>
  Schema.decodeUnknownEffect(jsonSchema(schema))(json).pipe(
    Effect.mapError((cause) =>
      storeError(
        `Unable to decode migration store record at ${filePath}`,
        cause
      )
    )
  );

const readFileStringOptional = (
  fs: FileSystem,
  filePath: string
): Effect.Effect<string | null, MigrationStoreError> =>
  fs.readFileString(filePath, "utf8").pipe(
    Effect.catchIf(
      (cause) => isPlatformSystemError(cause, "NotFound"),
      () => Effect.succeed(null)
    ),
    Effect.mapError((cause) => storeError(`Unable to read ${filePath}`, cause))
  );

const readRecordOptional = <A>(
  fs: FileSystem,
  filePath: string,
  schema: Schema.Codec<A, unknown, never, never>
): Effect.Effect<A | null, MigrationStoreError> =>
  Effect.flatMap(readFileStringOptional(fs, filePath), (json) =>
    json === null ? Effect.succeed(null) : decodeRecord(schema, json, filePath)
  );

const readRecord = <A>(
  fs: FileSystem,
  filePath: string,
  schema: Schema.Codec<A, unknown, never, never>
): Effect.Effect<A, MigrationStoreError> =>
  Effect.flatMap(readRecordOptional(fs, filePath, schema), (record) =>
    record === null
      ? Effect.fail(
          storeError(`Migration store record was not found at ${filePath}`)
        )
      : Effect.succeed(record)
  );

const writeFileStringAtomic = (
  fs: FileSystem,
  path: Path,
  filePath: string,
  contents: string
): Effect.Effect<void, MigrationStoreError> =>
  Effect.gen(function* () {
    const parentDirectory = path.dirname(filePath);
    const temporaryPath = path.join(
      parentDirectory,
      `.${path.basename(filePath)}.${randomUUID()}.tmp`
    );

    yield* fs
      .makeDirectory(parentDirectory, { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          storeError(`Unable to create directory ${parentDirectory}`, cause)
        )
      );

    yield* fs
      .writeFileString(temporaryPath, contents)
      .pipe(
        Effect.mapError((cause) =>
          storeError(`Unable to write ${temporaryPath}`, cause)
        )
      );

    yield* fs.rename(temporaryPath, filePath).pipe(
      Effect.mapError((cause) =>
        storeError(`Unable to write ${filePath}`, cause)
      ),
      Effect.catch((error) =>
        fs
          .remove(temporaryPath, { force: true })
          .pipe(Effect.ignore, Effect.andThen(Effect.fail(error)))
      )
    );
  });

const writeRecordAtomic = <A>(
  fs: FileSystem,
  path: Path,
  filePath: string,
  schema: Schema.Codec<A, unknown, never, never>,
  value: A
): Effect.Effect<void, MigrationStoreError> =>
  Effect.flatMap(encodeRecord(schema, value, filePath), (json) =>
    writeFileStringAtomic(fs, path, filePath, json)
  );

const writeNewFileString = (
  fs: FileSystem,
  path: Path,
  filePath: string,
  contents: string,
  alreadyExists: MigrationStoreError
): Effect.Effect<void, MigrationStoreError> =>
  Effect.gen(function* () {
    const parentDirectory = path.dirname(filePath);

    yield* fs
      .makeDirectory(parentDirectory, { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          storeError(`Unable to create directory ${parentDirectory}`, cause)
        )
      );

    yield* fs
      .writeFileString(filePath, contents, { flag: "wx" })
      .pipe(
        Effect.mapError((cause) =>
          isPlatformSystemError(cause, "AlreadyExists")
            ? alreadyExists
            : storeError(`Unable to create ${filePath}`, cause)
        )
      );
  });

const removeFileIfExists = (
  fs: FileSystem,
  filePath: string
): Effect.Effect<void, MigrationStoreError> =>
  fs.remove(filePath).pipe(
    Effect.catchIf(
      (cause) => isPlatformSystemError(cause, "NotFound"),
      () => Effect.void
    ),
    Effect.mapError((cause) =>
      storeError(`Unable to remove ${filePath}`, cause)
    )
  );

const readDirectoryOptional = (
  fs: FileSystem,
  directory: string
): Effect.Effect<readonly string[], MigrationStoreError> =>
  fs.readDirectory(directory).pipe(
    Effect.catchIf(
      (cause) => isPlatformSystemError(cause, "NotFound"),
      () => Effect.succeed([])
    ),
    Effect.mapError((cause) =>
      storeError(`Unable to read directory ${directory}`, cause)
    )
  );

const makePaths = (path: Path, directory: string) => {
  const definitionDirectory = (definitionId: MigrationDefinitionId) =>
    path.join(directory, "definitions", encodePathSegment(definitionId));

  return {
    manifest: path.join(directory, "manifest.json"),
    latestRunState: (definitionId: MigrationDefinitionId) =>
      path.join(definitionDirectory(definitionId), "latest-run.json"),
    sourceCursor: (definitionId: MigrationDefinitionId) =>
      path.join(definitionDirectory(definitionId), "cursor.json"),
    migrationContract: (definitionId: MigrationDefinitionId) =>
      path.join(definitionDirectory(definitionId), "contract.json"),
    itemStatesDirectory: (definitionId: MigrationDefinitionId) =>
      path.join(definitionDirectory(definitionId), "items"),
    itemState: (
      definitionId: MigrationDefinitionId,
      identity: EncodedSourceIdentity
    ) =>
      path.join(
        definitionDirectory(definitionId),
        "items",
        `${encodePathSegment(identity)}.json`
      ),
    lock: (definitionId: MigrationDefinitionId) =>
      path.join(directory, "locks", `${encodePathSegment(definitionId)}.json`),
  };
};

const makeManifestRecord = (): ManifestRecord => ({
  formatVersion,
  recordKind: "manifest",
  state: {
    createdAt: new Date(),
    storeKind: "file",
  },
});

const ensureManifest = (
  fs: FileSystem,
  path: Path,
  filePath: string
): Effect.Effect<void, MigrationStoreError> =>
  Effect.flatMap(
    readRecordOptional(fs, filePath, ManifestRecord),
    (manifest) =>
      manifest === null
        ? writeRecordAtomic(
            fs,
            path,
            filePath,
            ManifestRecord,
            makeManifestRecord()
          )
        : Effect.void
  );

export type FileMigrationStorePlatform<E = never, R = never> = Layer.Layer<
  FileSystem | Path,
  E,
  R
>;

export const FileMigrationStorePlatform = {
  node: Layer.mergeAll(nodeFileSystemLayer, nodePathLayer),
} as const satisfies Record<string, FileMigrationStorePlatform>;

const makeLayerWithoutPlatform = (
  options: Pick<FileMigrationStoreOptions, "directory">
): Layer.Layer<MigrationStore, MigrationStoreError, FileSystem | Path> =>
  Layer.effect(
    MigrationStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const paths = makePaths(path, options.directory);

      yield* ensureManifest(fs, path, paths.manifest);

      const getSourceCursor = Effect.fn("FileMigrationStore.getSourceCursor")(
        function* (definitionId: MigrationDefinitionId) {
          const record = yield* readRecordOptional(
            fs,
            paths.sourceCursor(definitionId),
            EncodedSourceCursorRecord
          );

          return record?.state ?? null;
        }
      );

      const setSourceCursor = Effect.fn("FileMigrationStore.setSourceCursor")(
        (
          definitionId: MigrationDefinitionId,
          cursor: EncodedSourceCursorType
        ) =>
          writeRecordAtomic(
            fs,
            path,
            paths.sourceCursor(definitionId),
            EncodedSourceCursorRecord,
            {
              formatVersion,
              recordKind: "encoded-source-cursor",
              state: cursor,
            }
          )
      );

      const getItemState = Effect.fn("FileMigrationStore.getItemState")(
        function* (
          definitionId: MigrationDefinitionId,
          identity: EncodedSourceIdentity
        ) {
          const record = yield* readRecordOptional(
            fs,
            paths.itemState(definitionId, identity),
            MigrationItemStateRecord
          );

          return record?.state ?? null;
        }
      );

      const getMigrationContract = Effect.fn(
        "FileMigrationStore.getMigrationContract"
      )(function* (definitionId: MigrationDefinitionId) {
        const record = yield* readRecordOptional(
          fs,
          paths.migrationContract(definitionId),
          MigrationContractRecord
        );

        return record?.state ?? null;
      });

      const upsertMigrationContract = Effect.fn(
        "FileMigrationStore.upsertMigrationContract"
      )((contract: MigrationContractType) =>
        writeRecordAtomic(
          fs,
          path,
          paths.migrationContract(contract.definitionId),
          MigrationContractRecord,
          {
            formatVersion,
            recordKind: "migration-contract",
            state: contract,
          }
        )
      );

      const listItemStates = Effect.fn("FileMigrationStore.listItemStates")(
        function* (definitionId: MigrationDefinitionId) {
          const itemStateFiles = yield* readDirectoryOptional(
            fs,
            paths.itemStatesDirectory(definitionId)
          );
          const itemStates: MigrationItemState[] = [];

          for (const itemStateFile of itemStateFiles) {
            if (!itemStateFile.endsWith(".json")) {
              continue;
            }

            const record = yield* readRecord(
              fs,
              path.join(paths.itemStatesDirectory(definitionId), itemStateFile),
              MigrationItemStateRecord
            );
            itemStates.push(record.state);
          }

          return itemStates;
        }
      );

      const getItemStateSummary = Effect.fn(
        "FileMigrationStore.getItemStateSummary"
      )(function* (definitionId: MigrationDefinitionId) {
        const itemStates = yield* listItemStates(definitionId);

        return summarizeMigrationItemStates(itemStates);
      });

      const deleteItemState = Effect.fn("FileMigrationStore.deleteItemState")(
        (
          definitionId: MigrationDefinitionId,
          identity: EncodedSourceIdentity
        ) => removeFileIfExists(fs, paths.itemState(definitionId, identity))
      );

      const upsertItemState = Effect.fn("FileMigrationStore.upsertItemState")(
        (state: MigrationItemState) =>
          writeRecordAtomic(
            fs,
            path,
            paths.itemState(state.definitionId, state.sourceIdentity.encoded),
            MigrationItemStateRecord,
            {
              formatVersion,
              recordKind: "migration-item-state",
              state,
            }
          )
      );

      const createRunId = Effect.sync(() =>
        MigrationRunIdSchema.make(`run-${randomUUID()}`)
      );

      const getLatestRunState = Effect.fn(
        "FileMigrationStore.getLatestRunState"
      )(function* (definitionId: MigrationDefinitionId) {
        const record = yield* readRecordOptional(
          fs,
          paths.latestRunState(definitionId),
          LatestRunStateRecord
        );

        return record?.state ?? null;
      });

      const beginRun = Effect.fn("FileMigrationStore.beginRun")(
        (
          runId: MigrationRunId,
          definitionIds: readonly MigrationDefinitionId[]
        ) =>
          Effect.gen(function* () {
            const runState: MigrationRunState = {
              runId,
              definitionIds,
              status: "running",
              startedAt: new Date(),
            };

            for (const definitionId of definitionIds) {
              yield* writeRecordAtomic(
                fs,
                path,
                paths.latestRunState(definitionId),
                LatestRunStateRecord,
                {
                  formatVersion,
                  recordKind: "latest-run-state",
                  state: runState,
                }
              );
            }

            return runState;
          })
      );

      const updateLatestRunState = (
        runId: MigrationRunId,
        definitionIds: readonly MigrationDefinitionId[],
        status: MigrationRunState["status"]
      ) =>
        Effect.gen(function* () {
          const records: LatestRunStateRecord[] = [];

          for (const definitionId of definitionIds) {
            const record = yield* readRecord(
              fs,
              paths.latestRunState(definitionId),
              LatestRunStateRecord
            );
            records.push(record);
          }

          const current = records[0];

          if (
            current === undefined ||
            records.some((record) => record.state.runId !== runId)
          ) {
            return yield* storeError("Migration run was not found", runId);
          }

          const updated: MigrationRunState = {
            ...current.state,
            status,
            finishedAt: new Date(),
          };

          for (const definitionId of definitionIds) {
            yield* writeRecordAtomic(
              fs,
              path,
              paths.latestRunState(definitionId),
              LatestRunStateRecord,
              {
                formatVersion,
                recordKind: "latest-run-state",
                state: updated,
              }
            );
          }

          return updated;
        });

      const completeRun = Effect.fn("FileMigrationStore.completeRun")(
        (
          runId: MigrationRunId,
          definitionIds: readonly MigrationDefinitionId[]
        ) => updateLatestRunState(runId, definitionIds, "succeeded")
      );

      const failRun = Effect.fn("FileMigrationStore.failRun")(
        (
          runId: MigrationRunId,
          definitionIds: readonly MigrationDefinitionId[]
        ) => updateLatestRunState(runId, definitionIds, "failed")
      );

      const acquireDefinitionLock = Effect.fn(
        "FileMigrationStore.acquireDefinitionLock"
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
        const lockPath = paths.lock(definitionId);
        const encodedLock = yield* encodeRecord(
          MigrationDefinitionLockRecord,
          {
            formatVersion,
            recordKind: "migration-definition-lock",
            state: lock,
          },
          lockPath
        );

        yield* writeNewFileString(
          fs,
          path,
          lockPath,
          encodedLock,
          storeError("Migration definition is already locked", definitionId)
        );

        return lock;
      });

      const releaseDefinitionLock = Effect.fn(
        "FileMigrationStore.releaseDefinitionLock"
      )(function* (lock: MigrationDefinitionLock) {
        const lockPath = paths.lock(lock.definitionId);
        const record = yield* readRecordOptional(
          fs,
          lockPath,
          MigrationDefinitionLockRecord
        );

        if (record === null) {
          return;
        }

        if (record.state.token !== lock.token) {
          return yield* lockOwnershipError(lock, record.state);
        }

        yield* removeFileIfExists(fs, lockPath);
      });

      return {
        getSourceCursor,
        setSourceCursor,
        getMigrationContract,
        upsertMigrationContract,
        getItemState,
        listItemStates,
        getItemStateSummary,
        deleteItemState,
        upsertItemState,
        createRunId,
        getLatestRunState,
        beginRun,
        completeRun,
        failRun,
        acquireDefinitionLock,
        releaseDefinitionLock,
      };
    })
  );

const makeLayer = (
  options: FileMigrationStoreOptions
): Layer.Layer<MigrationStore, MigrationStoreError> =>
  makeLayerWithoutPlatform(options).pipe(
    Layer.provide(options.platform ?? FileMigrationStorePlatform.node)
  );

export const FileMigrationStore = {
  layer: makeLayer,
  layerWithoutPlatform: makeLayerWithoutPlatform,
  platform: FileMigrationStorePlatform,
} as const;
