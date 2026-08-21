import { createHash, randomUUID } from "node:crypto";
import { DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlError } from "effect/unstable/sql";
import { MigrationStoreError } from "../../domain/errors.ts";
import {
  EncodedSourceCursor,
  type EncodedSourceCursor as EncodedSourceCursorType,
  type EncodedSourceIdentity,
  MigrationDefinitionId,
  type MigrationDefinitionId as MigrationDefinitionIdType,
  MigrationDefinitionLockToken,
  MigrationRunId,
  type MigrationRunId as MigrationRunIdType,
  SourceIdentityContractFingerprint,
  toMigrationDefinitionLockToken,
} from "../../domain/ids.ts";
import type { MigrationDefinitionLock } from "../../domain/lock.ts";
import {
  type MigrationContract as MigrationContractType,
  SourceVersionContractFingerprint,
  TrackingRecordContractFingerprint,
  TrackingRecordContractId,
} from "../../domain/migration-contract.ts";
import type {
  MigrationExecutionHandle,
  MigrationRunState,
} from "../../domain/run.ts";
import type { MigrationItemState } from "../../domain/state.ts";
import { emptyMigrationItemStateSummary } from "../../domain/status.ts";
import {
  MigrationStore,
  makeUnimplementedOrphanStoreMethods,
} from "../../services/migration-store.ts";
import { PersistedMigrationItemState } from "../internal/persisted-state.ts";
import {
  makeSqlMigrationStoreDialect,
  type SqlMigrationStoreTableNames,
} from "./sql-migration-store-dialect.ts";

export interface SqlMigrationStoreOptions {
  /** Creates the SDK-owned tables and indexes when the layer is built. */
  readonly initialize?: boolean;
  /** Prefix for SDK-owned tables. Defaults to `migrate_sdk`. */
  readonly tablePrefix?: string;
}

const defaultTablePrefix = "migrate_sdk";
const tablePrefixPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const SqlCursorRow = Schema.Struct({
  cursor_value: EncodedSourceCursor,
});

const SqlContractRow = Schema.Struct({
  definition_id: MigrationDefinitionId,
  source_identity_contract_fingerprint: SourceIdentityContractFingerprint,
  source_version_contract_fingerprint: SourceVersionContractFingerprint,
  tracking_record_contract_fingerprint: Schema.NullOr(
    TrackingRecordContractFingerprint
  ),
  tracking_record_contract_id: Schema.NullOr(TrackingRecordContractId),
});

const SqlItemStateRow = Schema.Struct({
  payload_json: Schema.String,
});

const SqlRunRow = Schema.Struct({
  execution_adapter: Schema.NullOr(Schema.String),
  execution_id: Schema.NullOr(Schema.String),
  finished_at: Schema.NullOr(Schema.DateFromString),
  run_definition_id: Schema.NullOr(MigrationDefinitionId),
  run_id: MigrationRunId,
  started_at: Schema.DateFromString,
  status: Schema.Literals([
    "queued",
    "running",
    "cancelled",
    "succeeded",
    "failed",
    "start-failed",
  ]),
});

const SqlLockRow = Schema.Struct({
  created_at: Schema.DateFromString,
  definition_id: MigrationDefinitionId,
  owner_run_id: MigrationRunId,
  token: MigrationDefinitionLockToken,
});

interface SqlSummaryRow {
  readonly count: bigint | number | string;
  readonly status: string;
}

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

const tableNames = (prefix: string): SqlMigrationStoreTableNames => ({
  contracts: `${prefix}_contracts`,
  cursors: `${prefix}_cursors`,
  itemStates: `${prefix}_item_states`,
  latestRuns: `${prefix}_latest_runs`,
  locks: `${prefix}_locks`,
  runDefinitions: `${prefix}_run_definitions`,
  runs: `${prefix}_runs`,
});

const sqlKey = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const encodeJson = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
  value: A,
  description: string
): Effect.Effect<string, MigrationStoreError> =>
  Schema.encodeEffect(Schema.fromJsonString(schema))(value).pipe(
    Effect.mapError((cause) =>
      storeError(`Unable to encode SQL migration store ${description}`, cause)
    )
  );

const decodeJson = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
  valueJson: string,
  description: string
): Effect.Effect<A, MigrationStoreError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(valueJson).pipe(
    Effect.mapError((cause) =>
      storeError(`Unable to decode SQL migration store ${description}`, cause)
    )
  );

const decodeRow = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
  row: unknown,
  description: string
): Effect.Effect<A, MigrationStoreError> =>
  Schema.decodeUnknownEffect(schema)(row).pipe(
    Effect.mapError((cause) =>
      storeError(`Unable to decode SQL migration store ${description}`, cause)
    )
  );

const normalizeCount = (
  row: SqlSummaryRow
): Effect.Effect<number, MigrationStoreError> =>
  Effect.try({
    try: () => {
      const count = Number(row.count);

      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error(`Invalid SQL count ${String(row.count)}`);
      }

      return count;
    },
    catch: (cause) =>
      storeError("Unable to decode SQL migration item state summary", {
        cause,
        row,
      }),
  });

const makeLayer = (
  options: SqlMigrationStoreOptions = {}
): Layer.Layer<MigrationStore, MigrationStoreError, SqlClient.SqlClient> =>
  Layer.effect(
    MigrationStore,
    Effect.gen(function* () {
      const orphanStoreMethods =
        makeUnimplementedOrphanStoreMethods("SqlMigrationStore");
      const sql = (yield* SqlClient.SqlClient).withoutTransforms();
      const prefix = options.tablePrefix ?? defaultTablePrefix;

      if (!tablePrefixPattern.test(prefix)) {
        return yield* storeError(
          "SQL migration store table prefix must be a SQL identifier",
          prefix
        );
      }
      const names = tableNames(prefix);
      const dialect = makeSqlMigrationStoreDialect(sql, names, prefix);

      if (dialect === null) {
        return yield* storeError(
          "SQL Migration Store does not support the configured SQL dialect"
        );
      }

      yield* sql.withTransaction(Effect.void).pipe(
        Effect.mapError((cause) =>
          storeError("SQL migration store requires transaction support", cause)
        ),
        Effect.catchDefect((cause) =>
          Effect.fail(
            storeError(
              "SQL migration store requires transaction support",
              cause
            )
          )
        )
      );

      if (options.initialize !== false) {
        yield* dialect.initialize.pipe(
          Effect.mapError((cause) =>
            storeError("Unable to initialize SQL migration store", cause)
          )
        );
      }

      const contracts = sql(names.contracts);
      const cursors = sql(names.cursors);
      const itemStates = sql(names.itemStates);
      const latestRuns = sql(names.latestRuns);
      const locks = sql(names.locks);
      const runDefinitions = sql(names.runDefinitions);
      const runs = sql(names.runs);

      const runSql = <A>(
        operation: string,
        effect: Effect.Effect<A, SqlError.SqlError>
      ): Effect.Effect<A, MigrationStoreError> =>
        effect.pipe(
          Effect.mapError((cause) =>
            storeError(`Unable to ${operation} in SQL migration store`, cause)
          )
        );

      const withTransaction = <A>(
        operation: string,
        effect: Effect.Effect<A, MigrationStoreError>
      ): Effect.Effect<A, MigrationStoreError> =>
        sql
          .withTransaction(effect)
          .pipe(
            Effect.catchIf(SqlError.isSqlError, (cause) =>
              Effect.fail(
                storeError(
                  `Unable to ${operation} in SQL migration store transaction`,
                  cause
                )
              )
            )
          );

      const getSourceCursor = Effect.fn("SqlMigrationStore.getSourceCursor")(
        function* (definitionId: MigrationDefinitionIdType) {
          const definitionKey = sqlKey(definitionId);
          const rows = yield* runSql(
            "read Source Cursor",
            sql`
              SELECT cursor_value
              FROM ${cursors}
              WHERE definition_key = ${definitionKey}
                AND definition_id = ${definitionId}
            `
          );
          const row = rows[0];

          return row === undefined
            ? null
            : (yield* decodeRow(
                SqlCursorRow,
                row,
                `Source Cursor for ${definitionId}`
              )).cursor_value;
        }
      );

      const setSourceCursor = Effect.fn("SqlMigrationStore.setSourceCursor")(
        (
          definitionId: MigrationDefinitionIdType,
          cursor: EncodedSourceCursorType
        ) =>
          runSql(
            "upsert Source Cursor",
            dialect.upsertCursor({
              cursorValue: cursor,
              definitionId,
              definitionKey: sqlKey(definitionId),
            })
          )
      );

      const deleteSourceCursor = Effect.fn(
        "SqlMigrationStore.deleteSourceCursor"
      )((definitionId: MigrationDefinitionIdType) =>
        runSql(
          "delete Source Cursor",
          sql`
            DELETE FROM ${cursors}
            WHERE definition_key = ${sqlKey(definitionId)}
              AND definition_id = ${definitionId}
          `
        ).pipe(Effect.asVoid)
      );

      const getMigrationContract = Effect.fn(
        "SqlMigrationStore.getMigrationContract"
      )(function* (definitionId: MigrationDefinitionIdType) {
        const definitionKey = sqlKey(definitionId);
        const rows = yield* runSql(
          "read Migration Contract",
          sql`
            SELECT
              definition_id,
              source_identity_contract_fingerprint,
              source_version_contract_fingerprint,
              tracking_record_contract_id,
              tracking_record_contract_fingerprint
            FROM ${contracts}
            WHERE definition_key = ${definitionKey}
              AND definition_id = ${definitionId}
          `
        );
        const row = rows[0];

        if (row === undefined) {
          return null;
        }

        const decoded = yield* decodeRow(
          SqlContractRow,
          row,
          `Migration Contract for ${definitionId}`
        );

        return {
          definitionId: decoded.definition_id,
          sourceIdentityContractFingerprint:
            decoded.source_identity_contract_fingerprint,
          sourceVersionContractFingerprint:
            decoded.source_version_contract_fingerprint,
          ...(decoded.tracking_record_contract_id === null
            ? {}
            : {
                trackingRecordContractId: decoded.tracking_record_contract_id,
              }),
          ...(decoded.tracking_record_contract_fingerprint === null
            ? {}
            : {
                trackingRecordContractFingerprint:
                  decoded.tracking_record_contract_fingerprint,
              }),
        };
      });

      const upsertMigrationContract = Effect.fn(
        "SqlMigrationStore.upsertMigrationContract"
      )((contract: MigrationContractType) =>
        runSql(
          "upsert Migration Contract",
          dialect.upsertContract({
            definitionId: contract.definitionId,
            definitionKey: sqlKey(contract.definitionId),
            sourceIdentityContractFingerprint:
              contract.sourceIdentityContractFingerprint,
            sourceVersionContractFingerprint:
              contract.sourceVersionContractFingerprint,
            trackingRecordContractFingerprint:
              contract.trackingRecordContractFingerprint ?? null,
            trackingRecordContractId: contract.trackingRecordContractId ?? null,
          })
        )
      );

      const decodeItemStateRow = (
        row: unknown,
        description: string
      ): Effect.Effect<MigrationItemState, MigrationStoreError> =>
        Effect.flatMap(
          decodeRow(SqlItemStateRow, row, description),
          (decoded) =>
            decodeJson(
              PersistedMigrationItemState,
              decoded.payload_json,
              description
            )
        );

      const getItemState = Effect.fn("SqlMigrationStore.getItemState")(
        function* (
          definitionId: MigrationDefinitionIdType,
          identity: EncodedSourceIdentity
        ) {
          const definitionKey = sqlKey(definitionId);
          const sourceIdentityKey = sqlKey(identity);
          const rows = yield* runSql(
            "read Migration Item State",
            sql`
              SELECT payload_json
              FROM ${itemStates}
              WHERE definition_key = ${definitionKey}
                AND source_identity_key = ${sourceIdentityKey}
                AND definition_id = ${definitionId}
                AND source_identity = ${identity}
            `
          );
          const row = rows[0];

          return row === undefined
            ? null
            : yield* decodeItemStateRow(
                row,
                `Migration Item State for ${definitionId}:${identity}`
              );
        }
      );

      const listItemStates = Effect.fn("SqlMigrationStore.listItemStates")(
        function* (definitionId: MigrationDefinitionIdType) {
          const definitionKey = sqlKey(definitionId);
          const rows = yield* runSql(
            "list Migration Item States",
            sql`
              SELECT payload_json
              FROM ${itemStates}
              WHERE definition_key = ${definitionKey}
                AND definition_id = ${definitionId}
              ORDER BY source_identity
            `
          );

          return yield* Effect.forEach(rows, (row) =>
            decodeItemStateRow(row, `Migration Item State for ${definitionId}`)
          );
        }
      );

      const getItemStateSummary = Effect.fn(
        "SqlMigrationStore.getItemStateSummary"
      )(function* (definitionId: MigrationDefinitionIdType) {
        const definitionKey = sqlKey(definitionId);
        const rows = yield* runSql(
          "summarize Migration Item States",
          sql<SqlSummaryRow>`
            SELECT status, COUNT(*) AS count
            FROM ${itemStates}
            WHERE definition_key = ${definitionKey}
              AND definition_id = ${definitionId}
            GROUP BY status
          `
        );
        const summary = { ...emptyMigrationItemStateSummary() };

        for (const row of rows) {
          const count = yield* normalizeCount(row);

          switch (row.status) {
            case "migrated":
              summary.migrated = count;
              break;
            case "skipped":
              summary.skipped = count;
              break;
            case "failed":
              summary.failed = count;
              break;
            case "needs-update":
              summary.needsUpdate = count;
              break;
            default:
              return yield* storeError(
                "Unable to decode SQL migration item state summary",
                row
              );
          }
        }

        return summary;
      });

      const deleteItemState = Effect.fn("SqlMigrationStore.deleteItemState")(
        (
          definitionId: MigrationDefinitionIdType,
          identity: EncodedSourceIdentity
        ) =>
          runSql(
            "delete Migration Item State",
            sql`
            DELETE FROM ${itemStates}
            WHERE definition_key = ${sqlKey(definitionId)}
              AND source_identity_key = ${sqlKey(identity)}
              AND definition_id = ${definitionId}
              AND source_identity = ${identity}
            `
          ).pipe(Effect.asVoid)
      );

      const upsertItemState = Effect.fn("SqlMigrationStore.upsertItemState")(
        function* (state: MigrationItemState) {
          const payloadJson = yield* encodeJson(
            PersistedMigrationItemState,
            state,
            `Migration Item State for ${state.definitionId}:${state.sourceIdentity.encoded}`
          );
          const sourceVersion =
            "sourceVersion" in state ? state.sourceVersion : undefined;
          const sourceVersionContractFingerprint =
            "sourceVersionContractFingerprint" in state
              ? state.sourceVersionContractFingerprint
              : undefined;
          const errorTag =
            state.status === "failed" ? state.error.errorTag : null;

          yield* runSql(
            "upsert Migration Item State",
            dialect.upsertItemState({
              definitionId: state.definitionId,
              definitionKey: sqlKey(state.definitionId),
              errorTag,
              lastRunId: state.lastRunId,
              lastRunKey: sqlKey(state.lastRunId),
              payloadJson,
              sourceIdentity: state.sourceIdentity.encoded,
              sourceIdentityKey: sqlKey(state.sourceIdentity.encoded),
              sourceVersion: sourceVersion ?? null,
              sourceVersionContractFingerprint:
                sourceVersionContractFingerprint ?? null,
              status: state.status,
              updatedAt: state.updatedAt.toISOString(),
            })
          );
        }
      );

      const createRunId = Effect.sync(() =>
        MigrationRunId.make(`run-${randomUUID()}`)
      );

      const decodeRunRows = (
        rows: readonly unknown[],
        description: string
      ): Effect.Effect<MigrationRunState | null, MigrationStoreError> =>
        Effect.gen(function* () {
          if (rows.length === 0) {
            return null;
          }

          const decodedRows = yield* Effect.forEach(rows, (row) =>
            decodeRow(SqlRunRow, row, description)
          );
          const first = decodedRows[0];

          if (first === undefined) {
            return null;
          }

          if (first.execution_adapter === null && first.execution_id !== null) {
            return yield* storeError(
              "Unable to decode SQL migration run execution",
              first
            );
          }

          const definitionIds = decodedRows.flatMap((row) =>
            row.run_definition_id === null ? [] : [row.run_definition_id]
          );

          return {
            definitionIds,
            runId: first.run_id,
            startedAt: first.started_at,
            status: first.status,
            ...(first.finished_at === null
              ? {}
              : { finishedAt: first.finished_at }),
            ...(first.execution_adapter === null
              ? {}
              : {
                  execution: {
                    adapter: first.execution_adapter,
                    ...(first.execution_id === null
                      ? {}
                      : { executionId: first.execution_id }),
                  },
                }),
          };
        });

      const readRunState = (
        where: "latest-definition" | "run-id",
        id: MigrationDefinitionIdType | MigrationRunIdType
      ): Effect.Effect<MigrationRunState | null, MigrationStoreError> => {
        const key = sqlKey(id);
        const query =
          where === "latest-definition"
            ? sql`
                SELECT
                  r.run_id,
                  r.status,
                  r.started_at,
                  r.finished_at,
                  r.execution_adapter,
                  r.execution_id,
                  rd.definition_id AS run_definition_id
                FROM ${latestRuns} lr
                INNER JOIN ${runs} r ON r.run_key = lr.run_key
                LEFT JOIN ${runDefinitions} rd ON rd.run_key = r.run_key
                WHERE lr.definition_key = ${key}
                  AND lr.definition_id = ${id}
                ORDER BY rd.position
              `
            : sql`
                SELECT
                  r.run_id,
                  r.status,
                  r.started_at,
                  r.finished_at,
                  r.execution_adapter,
                  r.execution_id,
                  rd.definition_id AS run_definition_id
                FROM ${runs} r
                LEFT JOIN ${runDefinitions} rd ON rd.run_key = r.run_key
                WHERE r.run_key = ${key}
                  AND r.run_id = ${id}
                ORDER BY rd.position
              `;

        return runSql("read Migration Run State", query).pipe(
          Effect.flatMap((rows) =>
            decodeRunRows(rows, `Migration Run State for ${id}`)
          )
        );
      };

      const getLatestRunState = Effect.fn(
        "SqlMigrationStore.getLatestRunState"
      )((definitionId: MigrationDefinitionIdType) =>
        readRunState("latest-definition", definitionId)
      );

      const upsertRunRecord = (
        state: MigrationRunState
      ): Effect.Effect<void, MigrationStoreError> =>
        runSql(
          "upsert Migration Run State",
          dialect.upsertRun({
            executionAdapter: state.execution?.adapter ?? null,
            executionId: state.execution?.executionId ?? null,
            finishedAt: state.finishedAt?.toISOString() ?? null,
            runId: state.runId,
            runKey: sqlKey(state.runId),
            startedAt: state.startedAt.toISOString(),
            status: state.status,
          })
        );

      const writeRunState = (
        runId: MigrationRunIdType,
        definitionIds: readonly MigrationDefinitionIdType[],
        status: MigrationRunState["status"]
      ): Effect.Effect<MigrationRunState, MigrationStoreError> =>
        withTransaction(
          "write Migration Run State",
          Effect.gen(function* () {
            const current = yield* readRunState("run-id", runId);
            const runState: MigrationRunState = {
              ...(current ?? {}),
              definitionIds,
              runId,
              startedAt: current?.startedAt ?? (yield* DateTime.nowAsDate),
              status,
            };

            yield* upsertRunRecord(runState);
            yield* runSql(
              "replace Migration Run Definitions",
              sql`
                DELETE FROM ${runDefinitions}
                WHERE run_key = ${sqlKey(runId)}
              `
            );

            for (
              let position = 0;
              position < definitionIds.length;
              position++
            ) {
              const definitionId = definitionIds[position];

              if (definitionId === undefined) {
                continue;
              }

              yield* runSql(
                "insert Migration Run Definition",
                sql`
                  INSERT INTO ${runDefinitions} (
                    run_key,
                    run_id,
                    definition_key,
                    definition_id,
                    position
                  ) VALUES (
                    ${sqlKey(runId)},
                    ${runId},
                    ${sqlKey(definitionId)},
                    ${definitionId},
                    ${position}
                  )
                `
              );
              yield* runSql(
                "upsert latest Migration Run",
                dialect.upsertLatestRun({
                  definitionId,
                  definitionKey: sqlKey(definitionId),
                  runKey: sqlKey(runId),
                })
              );
            }

            return runState;
          })
        );

      const beginRun = Effect.fn("SqlMigrationStore.beginRun")(
        (
          runId: MigrationRunIdType,
          definitionIds: readonly MigrationDefinitionIdType[]
        ) => writeRunState(runId, definitionIds, "running")
      );

      const queueRun = Effect.fn("SqlMigrationStore.queueRun")(
        (
          runId: MigrationRunIdType,
          definitionIds: readonly MigrationDefinitionIdType[]
        ) => writeRunState(runId, definitionIds, "queued")
      );

      const updateRunState = (
        runId: MigrationRunIdType,
        definitionIds: readonly MigrationDefinitionIdType[],
        input: {
          readonly execution?: MigrationExecutionHandle;
          readonly finish?: boolean;
          readonly status?: MigrationRunState["status"];
        }
      ): Effect.Effect<MigrationRunState, MigrationStoreError> =>
        withTransaction(
          "update Migration Run State",
          Effect.gen(function* () {
            const states = yield* Effect.forEach(
              definitionIds,
              getLatestRunState
            );
            const current = states[0];

            if (
              current === undefined ||
              current === null ||
              states.some((state) => state?.runId !== runId)
            ) {
              return yield* storeError("Migration run was not found", runId);
            }

            const finishedAt =
              input.finish === true ? yield* DateTime.nowAsDate : undefined;
            const updated: MigrationRunState = {
              ...current,
              ...(input.execution === undefined
                ? {}
                : { execution: input.execution }),
              ...(finishedAt === undefined ? {} : { finishedAt }),
              ...(input.status === undefined ? {} : { status: input.status }),
            };

            yield* upsertRunRecord(updated);

            return updated;
          })
        );

      const attachRunExecution = Effect.fn(
        "SqlMigrationStore.attachRunExecution"
      )(
        (
          runId: MigrationRunIdType,
          definitionIds: readonly MigrationDefinitionIdType[],
          execution: MigrationExecutionHandle
        ) => updateRunState(runId, definitionIds, { execution })
      );

      const markRunStartFailed = Effect.fn(
        "SqlMigrationStore.markRunStartFailed"
      )(
        (
          runId: MigrationRunIdType,
          definitionIds: readonly MigrationDefinitionIdType[]
        ) =>
          updateRunState(runId, definitionIds, {
            finish: true,
            status: "start-failed",
          })
      );

      const markRunCancelled = Effect.fn("SqlMigrationStore.markRunCancelled")(
        (
          runId: MigrationRunIdType,
          definitionIds: readonly MigrationDefinitionIdType[]
        ) =>
          updateRunState(runId, definitionIds, {
            finish: true,
            status: "cancelled",
          })
      );

      const completeRun = Effect.fn("SqlMigrationStore.completeRun")(
        (
          runId: MigrationRunIdType,
          definitionIds: readonly MigrationDefinitionIdType[]
        ) =>
          updateRunState(runId, definitionIds, {
            finish: true,
            status: "succeeded",
          })
      );

      const failRun = Effect.fn("SqlMigrationStore.failRun")(
        (
          runId: MigrationRunIdType,
          definitionIds: readonly MigrationDefinitionIdType[]
        ) =>
          updateRunState(runId, definitionIds, {
            finish: true,
            status: "failed",
          })
      );

      const decodeLockRow = (
        row: unknown,
        description: string
      ): Effect.Effect<MigrationDefinitionLock, MigrationStoreError> =>
        Effect.map(decodeRow(SqlLockRow, row, description), (decoded) => ({
          createdAt: decoded.created_at,
          definitionId: decoded.definition_id,
          ownerRunId: decoded.owner_run_id,
          token: decoded.token,
        }));

      const getDefinitionLock = Effect.fn(
        "SqlMigrationStore.getDefinitionLock"
      )(function* (definitionId: MigrationDefinitionIdType) {
        const definitionKey = sqlKey(definitionId);
        const rows = yield* runSql(
          "read Migration Definition Lock",
          sql`
            SELECT definition_id, owner_run_id, token, created_at
            FROM ${locks}
            WHERE definition_key = ${definitionKey}
              AND definition_id = ${definitionId}
          `
        );
        const row = rows[0];

        return row === undefined
          ? null
          : yield* decodeLockRow(
              row,
              `Migration Definition Lock for ${definitionId}`
            );
      });

      const acquireDefinitionLock = Effect.fn(
        "SqlMigrationStore.acquireDefinitionLock"
      )(function* (
        definitionId: MigrationDefinitionIdType,
        ownerRunId: MigrationRunIdType
      ) {
        const lock: MigrationDefinitionLock = {
          createdAt: yield* DateTime.nowAsDate,
          definitionId,
          ownerRunId,
          token: toMigrationDefinitionLockToken(`lock-${randomUUID()}`),
        };
        const acquired = yield* runSql(
          "acquire Migration Definition Lock",
          dialect.tryAcquireLock({
            createdAt: lock.createdAt.toISOString(),
            definitionId: lock.definitionId,
            definitionKey: sqlKey(lock.definitionId),
            ownerRunId: lock.ownerRunId,
            ownerRunKey: sqlKey(lock.ownerRunId),
            token: lock.token,
          })
        );

        if (!acquired) {
          return yield* storeError(
            "Migration definition is already locked",
            definitionId
          );
        }

        return lock;
      });

      const assertDefinitionLocks = Effect.fn(
        "SqlMigrationStore.assertDefinitionLocks"
      )(function* (definitionLocks: readonly MigrationDefinitionLock[]) {
        for (const lock of definitionLocks) {
          const current = yield* getDefinitionLock(lock.definitionId);

          if (current === null) {
            return yield* lockNotFoundError(lock);
          }

          if (
            current.ownerRunId !== lock.ownerRunId ||
            current.token !== lock.token
          ) {
            return yield* lockOwnershipError(lock, current);
          }
        }
      });

      const releaseDefinitionLock = Effect.fn(
        "SqlMigrationStore.releaseDefinitionLock"
      )(function* (lock: MigrationDefinitionLock) {
        const deleted = yield* runSql(
          "release Migration Definition Lock",
          dialect.deleteOwnedLock({
            definitionKey: sqlKey(lock.definitionId),
            ownerRunId: lock.ownerRunId,
            token: lock.token,
          })
        );

        if (deleted) {
          return;
        }

        const current = yield* getDefinitionLock(lock.definitionId);

        if (current !== null) {
          return yield* lockOwnershipError(lock, current);
        }
      });

      const breakDefinitionLock = Effect.fn(
        "SqlMigrationStore.breakDefinitionLock"
      )(function* (definitionId: MigrationDefinitionIdType) {
        const row = yield* runSql(
          "break Migration Definition Lock",
          dialect.breakLock(sqlKey(definitionId))
        );

        return row === null
          ? null
          : yield* decodeLockRow(
              row,
              `Migration Definition Lock for ${definitionId}`
            );
      });

      return {
        ...orphanStoreMethods,
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
        getLatestRunState,
        beginRun,
        queueRun,
        attachRunExecution,
        markRunStartFailed,
        markRunCancelled,
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

const makeLayerFromClient = <ClientError, Requirements>(
  clientLayer: Layer.Layer<SqlClient.SqlClient, ClientError, Requirements>,
  options: SqlMigrationStoreOptions = {}
): Layer.Layer<MigrationStore, MigrationStoreError, Requirements> => {
  const mappedClientLayer = clientLayer.pipe(
    Layer.catch((cause) =>
      Layer.effect(
        SqlClient.SqlClient,
        Effect.fail(storeError("Unable to initialize SQL client", cause))
      )
    )
  );

  return makeLayer(options).pipe(Layer.provide(mappedClientLayer));
};

export const SqlMigrationStore = {
  layer: makeLayer,
  layerFromClient: makeLayerFromClient,
} as const;
