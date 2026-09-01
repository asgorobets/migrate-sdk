import { layer as nodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { layer as nodePathLayer } from "@effect/platform-node/NodePath";
import { DateTime, Effect, Layer, Random, Schema, Stream } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { lock } from "proper-lockfile";
import { MigrationStoreError } from "../../domain/errors.ts";
import {
  EncodedSourceCursor,
  type EncodedSourceCursor as EncodedSourceCursorType,
  type EncodedSourceIdentity,
  type MigrationDefinitionId,
  MigrationDefinitionId as MigrationDefinitionIdSchema,
  MigrationDefinitionLockToken as MigrationDefinitionLockTokenSchema,
  type MigrationRunId,
  MigrationRunId as MigrationRunIdSchema,
  toMigrationDefinitionLockToken,
} from "../../domain/ids.ts";
import type { MigrationDefinitionLock } from "../../domain/lock.ts";
import {
  MigrationContract,
  type MigrationContract as MigrationContractType,
} from "../../domain/migration-contract.ts";
import type {
  MigrationDefinitionRunOutcome,
  MigrationExecutionHandle,
  MigrationRunState,
} from "../../domain/run.ts";
import {
  MigrationDefinitionRunStatus,
  makeMigrationDefinitionRunState,
} from "../../domain/run.ts";
import type { MigrationItemState } from "../../domain/state.ts";
import {
  addMigrationItemStateToSummary,
  emptyMigrationItemStateSummary,
} from "../../domain/status.ts";
import {
  canReplaceLatestMigrationDefinitionRun,
  isActiveMigrationRunStatus,
  type MigrationDefinitionRunOutcomeMap,
  MigrationStore,
  migrationDefinitionRunStatus,
  resolveMigrationRunTransition,
  validateMigrationDefinitionRunOutcomes,
  validateMigrationRunDefinitionIds,
} from "../../services/migration-store.ts";
import { PersistedMigrationItemState } from "../internal/persisted-state.ts";
import { FileMigrationStoreDirectoryEntries } from "./file-migration-store-directory-entries.ts";
import { nodeFileMigrationStoreDirectoryEntriesLayer } from "./node-file-migration-store-directory-entries.ts";

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
  definitionStatus: Schema.optional(MigrationDefinitionRunStatus),
  execution: Schema.optional(
    Schema.Struct({
      adapter: Schema.String,
      executionId: Schema.optional(Schema.String),
    })
  ),
  finishedAt: Schema.optional(Schema.DateFromString),
  runId: MigrationRunIdSchema,
  startedAt: Schema.DateFromString,
  status: Schema.Literals([
    "queued",
    "running",
    "cancelling",
    "cancelled",
    "succeeded",
    "failed",
    "start-failed",
  ]),
});

const LatestRunStateRecord = Schema.Struct({
  formatVersion: Schema.Literal(formatVersion),
  recordKind: Schema.Literal("latest-run-state"),
  state: PersistedMigrationRunState,
});

const MigrationRunProjectionPredecessor = Schema.Struct({
  definitionId: MigrationDefinitionIdSchema,
  runId: Schema.optional(MigrationRunIdSchema),
});
type MigrationRunProjectionPredecessor =
  typeof MigrationRunProjectionPredecessor.Type;

const MigrationRunStateRecord = Schema.Struct({
  formatVersion: Schema.Literal(formatVersion),
  projectionPredecessors: Schema.optional(
    Schema.Array(MigrationRunProjectionPredecessor)
  ),
  recordKind: Schema.Literal("migration-run-state"),
  state: PersistedMigrationRunState,
});

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
const randomIdentifier = Effect.all([
  Random.nextInt,
  Random.nextInt,
  Random.nextInt,
  Random.nextInt,
]).pipe(
  Effect.map((parts) =>
    parts.map((part) => Math.abs(part).toString(36)).join("-")
  )
);

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

const lockNotFoundError = (
  lock: MigrationDefinitionLock
): MigrationStoreError =>
  storeError("Migration definition lock was not found", {
    definitionId: lock.definitionId,
    ownerRunId: lock.ownerRunId,
    token: lock.token,
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
    const temporaryId = yield* randomIdentifier;
    const temporaryPath = path.join(
      parentDirectory,
      `.${path.basename(filePath)}.${temporaryId}.tmp`
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
    projectionLockTarget: (definitionId: MigrationDefinitionId) =>
      definitionDirectory(definitionId),
    runState: (runId: MigrationRunId) =>
      path.join(directory, "runs", `${encodePathSegment(runId)}.json`),
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

const projectionLockOptions = {
  realpath: false,
  retries: {
    factor: 1.2,
    maxTimeout: 100,
    minTimeout: 10,
    retries: 200,
  },
  stale: 30_000,
  update: 10_000,
} as const;

const makeManifestRecord = (createdAt: Date): ManifestRecord => ({
  formatVersion,
  recordKind: "manifest",
  state: {
    createdAt,
    storeKind: "file",
  },
});

const ensureManifest = (
  fs: FileSystem,
  path: Path,
  filePath: string
): Effect.Effect<void, MigrationStoreError> =>
  Effect.gen(function* () {
    const manifest = yield* readRecordOptional(fs, filePath, ManifestRecord);

    if (manifest !== null) {
      return;
    }

    const createdAt = yield* DateTime.nowAsDate;
    yield* writeRecordAtomic(
      fs,
      path,
      filePath,
      ManifestRecord,
      makeManifestRecord(createdAt)
    );
  });

export type FileMigrationStorePlatform<E = never, R = never> = Layer.Layer<
  FileMigrationStoreDirectoryEntries | FileSystem | Path,
  E,
  R
>;

export const FileMigrationStorePlatform = {
  directoryEntries: {
    node: nodeFileMigrationStoreDirectoryEntriesLayer,
  },
  node: Layer.mergeAll(
    nodeFileSystemLayer,
    nodePathLayer,
    nodeFileMigrationStoreDirectoryEntriesLayer
  ),
} as const;

const makeLayerWithoutPlatform = (
  options: Pick<FileMigrationStoreOptions, "directory">
): Layer.Layer<
  MigrationStore,
  MigrationStoreError,
  FileMigrationStoreDirectoryEntries | FileSystem | Path
> =>
  Layer.effect(
    MigrationStore,
    Effect.gen(function* () {
      const directoryEntries = yield* FileMigrationStoreDirectoryEntries;
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

      const deleteSourceCursor = Effect.fn(
        "FileMigrationStore.deleteSourceCursor"
      )((definitionId: MigrationDefinitionId) =>
        removeFileIfExists(fs, paths.sourceCursor(definitionId))
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
        let summary = emptyMigrationItemStateSummary();
        const itemStateDirectory = paths.itemStatesDirectory(definitionId);

        yield* directoryEntries.stream(itemStateDirectory).pipe(
          Stream.runForEach((itemStateFile) =>
            Effect.gen(function* () {
              if (!itemStateFile.endsWith(".json")) {
                return;
              }

              const record = yield* readRecord(
                fs,
                path.join(itemStateDirectory, itemStateFile),
                MigrationItemStateRecord
              );

              summary = addMigrationItemStateToSummary(summary, record.state);
            })
          )
        );

        return summary;
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

      const observeItemState: (typeof MigrationStore)["Service"]["observeItemState"] =
        Effect.fn("FileMigrationStore.observeItemState")(function* (
          definitionId: MigrationDefinitionId,
          identity: EncodedSourceIdentity,
          sourceInventoryRunId: MigrationRunId
        ) {
          const itemState = yield* getItemState(definitionId, identity);

          if (
            itemState === null ||
            itemState.lastSourceInventoryRunId === sourceInventoryRunId
          ) {
            return;
          }

          yield* upsertItemState({
            ...itemState,
            lastSourceInventoryRunId: sourceInventoryRunId,
          });
        });

      const listOrphanItemStates: (typeof MigrationStore)["Service"]["listOrphanItemStates"] =
        Effect.fn("FileMigrationStore.listOrphanItemStates")(
          function* (definitionId, sourceInventoryRunId, page) {
            const limit = Math.max(0, Math.floor(page.limit));

            if (limit === 0) {
              return { items: [] };
            }

            const itemStateDirectory = paths.itemStatesDirectory(definitionId);
            const candidates: MigrationItemState[] = [];

            yield* directoryEntries.stream(itemStateDirectory).pipe(
              Stream.runForEach((itemStateFile) =>
                Effect.gen(function* () {
                  if (!itemStateFile.endsWith(".json")) {
                    return;
                  }

                  const record = yield* readRecord(
                    fs,
                    path.join(itemStateDirectory, itemStateFile),
                    MigrationItemStateRecord
                  );
                  const itemState = record.state;

                  if (
                    itemState.lastSourceInventoryRunId ===
                      sourceInventoryRunId ||
                    (page.afterIdentity !== undefined &&
                      itemState.sourceIdentity.encoded <= page.afterIdentity)
                  ) {
                    return;
                  }

                  const insertionIndex = candidates.findIndex(
                    (candidate) =>
                      candidate.sourceIdentity.encoded >
                      itemState.sourceIdentity.encoded
                  );

                  if (insertionIndex === -1) {
                    candidates.push(itemState);
                  } else {
                    candidates.splice(insertionIndex, 0, itemState);
                  }

                  if (candidates.length > limit + 1) {
                    candidates.pop();
                  }
                })
              )
            );

            const items = candidates.slice(0, limit);
            const lastItem = items.at(-1);

            return {
              items,
              ...(lastItem !== undefined && candidates.length > items.length
                ? { nextAfterIdentity: lastItem.sourceIdentity.encoded }
                : {}),
            };
          }
        );

      const createRunId = randomIdentifier.pipe(
        Effect.map((id) => MigrationRunIdSchema.make(`run-${id}`))
      );

      const getLatestRunState = Effect.fn(
        "FileMigrationStore.getLatestRunState"
      )(function* (definitionId: MigrationDefinitionId) {
        const record = yield* readRecordOptional(
          fs,
          paths.latestRunState(definitionId),
          LatestRunStateRecord
        );

        if (record === null) {
          return null;
        }

        const { definitionStatus: storedDefinitionStatus, ...runState } =
          record.state;

        return makeMigrationDefinitionRunState(
          definitionId,
          runState,
          storedDefinitionStatus ?? runState.status
        );
      });

      const getRunState = Effect.fn("FileMigrationStore.getRunState")(
        function* (runId: MigrationRunId) {
          const record = yield* readRecordOptional(
            fs,
            paths.runState(runId),
            MigrationRunStateRecord
          );

          if (record === null) {
            return null;
          }

          const { definitionStatus: _definitionStatus, ...runState } =
            record.state;
          return runState;
        }
      );

      const writeRunRecord = (
        runState: MigrationRunState,
        projectionPredecessors?: readonly MigrationRunProjectionPredecessor[]
      ) =>
        writeRecordAtomic(
          fs,
          path,
          paths.runState(runState.runId),
          MigrationRunStateRecord,
          {
            formatVersion,
            ...(projectionPredecessors === undefined
              ? {}
              : { projectionPredecessors }),
            recordKind: "migration-run-state",
            state: runState,
          }
        );

      const acquireProjectionLock = (definitionId: MigrationDefinitionId) => {
        const target = paths.projectionLockTarget(definitionId);

        return fs.makeDirectory(target, { recursive: true }).pipe(
          Effect.mapError((cause) =>
            storeError(
              `Unable to create Migration Definition projection directory ${target}`,
              cause
            )
          ),
          Effect.andThen(
            Effect.tryPromise({
              try: () => lock(target, projectionLockOptions),
              catch: (cause) =>
                storeError(
                  `Unable to acquire Migration Definition projection lock ${definitionId}`,
                  cause
                ),
            })
          )
        );
      };

      const withProjectionLocks = <A, E, R>(
        definitionIds: readonly MigrationDefinitionId[],
        effect: Effect.Effect<A, E, R>
      ): Effect.Effect<A, E | MigrationStoreError, R> => {
        const orderedDefinitionIds = Array.from(new Set(definitionIds)).sort(
          (left, right) => left.localeCompare(right)
        );
        const acquireAt = (
          index: number
        ): Effect.Effect<A, E | MigrationStoreError, R> => {
          const definitionId = orderedDefinitionIds[index];

          if (definitionId === undefined) {
            return effect;
          }

          return Effect.acquireUseRelease(
            acquireProjectionLock(definitionId),
            () => acquireAt(index + 1),
            (release) =>
              Effect.tryPromise({
                try: () => release(),
                catch: (cause) =>
                  storeError(
                    `Unable to release Migration Definition projection lock ${definitionId}`,
                    cause
                  ),
              })
          );
        };

        return acquireAt(0);
      };

      const transitionedRunState = (input: {
        readonly current: MigrationRunState | undefined;
        readonly definitionIds: readonly MigrationDefinitionId[];
        readonly requestedStatus: MigrationRunState["status"];
        readonly runId: MigrationRunId;
        readonly startedAt: Date;
      }): MigrationRunState => {
        const transition = resolveMigrationRunTransition(
          input.current?.status,
          input.requestedStatus
        );

        return input.current !== undefined && !transition.accepted
          ? input.current
          : {
              ...(input.current ?? {}),
              runId: input.runId,
              definitionIds: input.definitionIds,
              status: transition.status ?? input.requestedStatus,
              startedAt: input.current?.startedAt ?? input.startedAt,
            };
      };

      const writeRunState = (
        runId: MigrationRunId,
        definitionIds: readonly MigrationDefinitionId[],
        status: MigrationRunState["status"]
      ) =>
        withProjectionLocks(
          definitionIds,
          Effect.gen(function* () {
            const currentRecord = yield* readRecordOptional(
              fs,
              paths.runState(runId),
              MigrationRunStateRecord
            );
            const currentRunState =
              currentRecord === null
                ? undefined
                : (({ definitionStatus: _definitionStatus, ...runState }) =>
                    runState)(currentRecord.state);

            if (currentRunState !== undefined) {
              yield* validateMigrationRunDefinitionIds(
                currentRunState,
                definitionIds
              );
            }

            const projectionPredecessors =
              currentRecord?.projectionPredecessors ??
              (currentRecord === null
                ? yield* Effect.forEach(definitionIds, (definitionId) =>
                    Effect.gen(function* () {
                      const latest = yield* readRecordOptional(
                        fs,
                        paths.latestRunState(definitionId),
                        LatestRunStateRecord
                      );

                      return {
                        definitionId,
                        ...(latest === null
                          ? {}
                          : { runId: latest.state.runId }),
                      } satisfies MigrationRunProjectionPredecessor;
                    })
                  )
                : undefined);

            const runState = transitionedRunState({
              current: currentRunState,
              runId,
              definitionIds,
              requestedStatus: status,
              startedAt: yield* DateTime.nowAsDate,
            });

            yield* writeRunRecord(runState, projectionPredecessors);

            const predecessorByDefinitionId = new Map(
              projectionPredecessors?.map((predecessor) => [
                predecessor.definitionId,
                predecessor.runId,
              ])
            );

            for (const definitionId of definitionIds) {
              const latest = yield* readRecordOptional(
                fs,
                paths.latestRunState(definitionId),
                LatestRunStateRecord
              );
              const predecessorRunId =
                predecessorByDefinitionId.get(definitionId);
              const canUpdateProjection =
                canReplaceLatestMigrationDefinitionRun({
                  currentRunId: latest?.state.runId ?? null,
                  ...(predecessorByDefinitionId.has(definitionId)
                    ? { predecessorRunId: predecessorRunId ?? null }
                    : {}),
                  runId,
                });

              if (!canUpdateProjection) {
                continue;
              }

              yield* writeRecordAtomic(
                fs,
                path,
                paths.latestRunState(definitionId),
                LatestRunStateRecord,
                {
                  formatVersion,
                  recordKind: "latest-run-state",
                  state: {
                    ...runState,
                    definitionStatus: runState.status,
                  },
                }
              );
            }

            return runState;
          })
        );

      const beginRun = Effect.fn("FileMigrationStore.beginRun")(
        (
          runId: MigrationRunId,
          definitionIds: readonly MigrationDefinitionId[]
        ) => writeRunState(runId, definitionIds, "running")
      );

      const queueRun = Effect.fn("FileMigrationStore.queueRun")(
        (
          runId: MigrationRunId,
          definitionIds: readonly MigrationDefinitionId[]
        ) => writeRunState(runId, definitionIds, "queued")
      );

      const updateCurrentLatestRunProjections = (
        runId: MigrationRunId,
        definitionIds: readonly MigrationDefinitionId[],
        updated: MigrationRunState,
        definitionOutcomes?: MigrationDefinitionRunOutcomeMap
      ) =>
        Effect.forEach(
          definitionIds,
          (definitionId) =>
            Effect.gen(function* () {
              const latest = yield* readRecordOptional(
                fs,
                paths.latestRunState(definitionId),
                LatestRunStateRecord
              );

              if (latest?.state.runId !== runId) {
                return;
              }

              yield* writeRecordAtomic(
                fs,
                path,
                paths.latestRunState(definitionId),
                LatestRunStateRecord,
                {
                  formatVersion,
                  recordKind: "latest-run-state",
                  state: {
                    ...updated,
                    definitionStatus: migrationDefinitionRunStatus(
                      definitionId,
                      updated.status,
                      definitionOutcomes
                    ),
                  },
                }
              );
            }),
          { discard: true }
        );

      const updateLatestRunState = (
        runId: MigrationRunId,
        definitionIds: readonly MigrationDefinitionId[],
        input: {
          readonly execution?: MigrationExecutionHandle;
          readonly definitionOutcomes?: MigrationDefinitionRunOutcomeMap;
          readonly finish?: boolean;
          readonly cancelIfRequested?: boolean;
          readonly onlyIfActive?: boolean;
          readonly status?: MigrationRunState["status"];
        }
      ) =>
        withProjectionLocks(
          definitionIds,
          Effect.gen(function* () {
            const currentRecord = yield* readRecordOptional(
              fs,
              paths.runState(runId),
              MigrationRunStateRecord
            );

            if (currentRecord === null) {
              return yield* storeError("Migration run was not found", runId);
            }

            const { definitionStatus: _definitionStatus, ...current } =
              currentRecord.state;
            yield* validateMigrationRunDefinitionIds(current, definitionIds);

            if (
              input.onlyIfActive === true &&
              !isActiveMigrationRunStatus(current.status)
            ) {
              return current;
            }

            const finishedAt =
              input.finish === true
                ? (current.finishedAt ?? (yield* DateTime.nowAsDate))
                : undefined;
            const transition = resolveMigrationRunTransition(
              current.status,
              input.status,
              { cancelIfRequested: input.cancelIfRequested }
            );

            if (!transition.accepted) {
              return current;
            }

            const status = transition.status;
            const updated: MigrationRunState = {
              ...current,
              ...(status === undefined ? {} : { status }),
              ...(input.execution === undefined
                ? {}
                : { execution: input.execution }),
              ...(finishedAt === undefined ? {} : { finishedAt }),
            };
            yield* writeRunRecord(
              updated,
              currentRecord.projectionPredecessors
            );
            yield* updateCurrentLatestRunProjections(
              runId,
              definitionIds,
              updated,
              input.definitionOutcomes
            );

            return updated;
          })
        );

      const completeRun = Effect.fn("FileMigrationStore.completeRun")(
        function* (
          runId: MigrationRunId,
          definitionIds: readonly MigrationDefinitionId[],
          definitionOutcomes: readonly MigrationDefinitionRunOutcome[]
        ) {
          const outcomeByDefinitionId =
            yield* validateMigrationDefinitionRunOutcomes(
              definitionIds,
              definitionOutcomes
            );

          return yield* updateLatestRunState(runId, definitionIds, {
            cancelIfRequested: true,
            definitionOutcomes: outcomeByDefinitionId,
            finish: true,
            status: "succeeded",
          });
        }
      );

      const failRun = Effect.fn("FileMigrationStore.failRun")(function* (
        runId: MigrationRunId,
        definitionIds: readonly MigrationDefinitionId[],
        definitionOutcomes: readonly MigrationDefinitionRunOutcome[]
      ) {
        const outcomeByDefinitionId =
          yield* validateMigrationDefinitionRunOutcomes(
            definitionIds,
            definitionOutcomes
          );

        return yield* updateLatestRunState(runId, definitionIds, {
          definitionOutcomes: outcomeByDefinitionId,
          finish: true,
          status: "failed",
        });
      });

      const markRunCancelled = Effect.fn("FileMigrationStore.markRunCancelled")(
        (
          runId: MigrationRunId,
          definitionIds: readonly MigrationDefinitionId[]
        ) =>
          updateLatestRunState(runId, definitionIds, {
            finish: true,
            status: "cancelled",
          })
      );

      const requestRunCancellation = Effect.fn(
        "FileMigrationStore.requestRunCancellation"
      )(
        (
          runId: MigrationRunId,
          definitionIds: readonly MigrationDefinitionId[]
        ) =>
          updateLatestRunState(runId, definitionIds, {
            onlyIfActive: true,
            status: "cancelling",
          })
      );

      const attachRunExecution = Effect.fn(
        "FileMigrationStore.attachRunExecution"
      )(
        (
          runId: MigrationRunId,
          definitionIds: readonly MigrationDefinitionId[],
          execution: MigrationExecutionHandle
        ) => updateLatestRunState(runId, definitionIds, { execution })
      );

      const markRunStartFailed = Effect.fn(
        "FileMigrationStore.markRunStartFailed"
      )(
        (
          runId: MigrationRunId,
          definitionIds: readonly MigrationDefinitionId[]
        ) =>
          updateLatestRunState(runId, definitionIds, {
            finish: true,
            status: "start-failed",
          })
      );

      const acquireDefinitionLock = Effect.fn(
        "FileMigrationStore.acquireDefinitionLock"
      )(function* (
        definitionId: MigrationDefinitionId,
        ownerRunId: MigrationRunId
      ) {
        const createdAt = yield* DateTime.nowAsDate;
        const lockId = yield* randomIdentifier;
        const lock: MigrationDefinitionLock = {
          createdAt,
          definitionId,
          ownerRunId,
          token: toMigrationDefinitionLockToken(`lock-${lockId}`),
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

      const getDefinitionLock = Effect.fn(
        "FileMigrationStore.getDefinitionLock"
      )(function* (definitionId: MigrationDefinitionId) {
        const record = yield* readRecordOptional(
          fs,
          paths.lock(definitionId),
          MigrationDefinitionLockRecord
        );

        return record?.state ?? null;
      });

      const assertDefinitionLocks = Effect.fn(
        "FileMigrationStore.assertDefinitionLocks"
      )(function* (locks: readonly MigrationDefinitionLock[]) {
        for (const lock of locks) {
          const lockPath = paths.lock(lock.definitionId);
          const record = yield* readRecordOptional(
            fs,
            lockPath,
            MigrationDefinitionLockRecord
          );

          if (record === null) {
            return yield* lockNotFoundError(lock);
          }

          if (
            record.state.ownerRunId !== lock.ownerRunId ||
            record.state.token !== lock.token
          ) {
            return yield* lockOwnershipError(lock, record.state);
          }
        }
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

      const breakDefinitionLock = Effect.fn(
        "FileMigrationStore.breakDefinitionLock"
      )(function* (definitionId: MigrationDefinitionId) {
        const lockPath = paths.lock(definitionId);
        const lock = yield* getDefinitionLock(definitionId);

        if (lock === null) {
          return null;
        }

        yield* removeFileIfExists(fs, lockPath);

        return lock;
      });

      return {
        listOrphanItemStates,
        observeItemState,
        getSourceCursor,
        setSourceCursor,
        deleteSourceCursor,
        getMigrationContract,
        upsertMigrationContract,
        getItemState,
        listItemStates,
        getItemStateSummary,
        deleteItemState,
        upsertItemState,
        createRunId,
        getRunState,
        getLatestRunState,
        beginRun,
        queueRun,
        attachRunExecution,
        markRunStartFailed,
        markRunCancelled,
        requestRunCancellation,
        completeRun,
        failRun,
        acquireDefinitionLock,
        getDefinitionLock,
        assertDefinitionLocks,
        releaseDefinitionLock,
        breakDefinitionLock,
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
