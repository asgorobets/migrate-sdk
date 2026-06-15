import { Effect, Layer, type Schema } from "effect";
import { SqlClient, type Statement } from "effect/unstable/sql";
import {
  type ConfiguredSourcePlugin,
  defineSourcePlugin,
  defineSourcePluginLayer,
  type SourcePayloadSchema,
  type SourcePluginImplementation,
  type SourceReadResultInput,
} from "../../domain/definition.ts";
import type { SourcePluginError } from "../../domain/errors.ts";
import type {
  SourceIdentity,
  SourceIdentityDefinition,
  SourceIdentitySnapshotKey,
  SourceIdentityTarget,
  SourceVersionInput,
} from "../../domain/ids.ts";
import {
  encodeSourceIdentityKey,
  type SourceItemInput,
} from "../../domain/source.ts";
import {
  type AnySourcePlugin,
  SourcePlugin as SourcePluginService,
} from "../../services/source-plugin.ts";
import {
  makeSqlSourceBatchSizeError,
  makeSqlSourceExecutionError,
  makeSqlSourceLookupIdentityMismatchError,
  makeSqlSourceLookupMultipleRowsError,
  makeSqlSourceMetadataError,
} from "./internal/errors.ts";

export const SqlSourcePluginName = "sql";

export interface SqlSourceMetadataContext {
  readonly rowIndex: number;
}

export interface SqlSourceMetadataSuccess<
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = string,
> {
  readonly cursor: Cursor;
  readonly identityKey: IdentityKey;
  readonly kind: "success";
  readonly version: SourceVersionInput;
}

export interface SqlSourceMetadataFailure {
  readonly cause?: unknown;
  readonly kind: "failure";
  readonly message: string;
}

export type SqlSourceMetadataResult<
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = string,
> = SqlSourceMetadataFailure | SqlSourceMetadataSuccess<Cursor, IdentityKey>;

export type SqlSourceRead<Row, Cursor> = (
  sql: SqlClient.SqlClient,
  cursor: Cursor | null,
  limit: number
) => Statement.Statement<Row>;

export type SqlSourceLookup<
  Row,
  IdentityKey extends SourceIdentitySnapshotKey = string,
> = (
  sql: SqlClient.SqlClient,
  identity: SourceIdentityTarget<IdentityKey>
) => Statement.Statement<Row>;

export type SqlSourceMetadata<
  Row,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = string,
> = (
  row: Readonly<Row>,
  context: SqlSourceMetadataContext
) => SqlSourceMetadataResult<Cursor, IdentityKey>;

interface SqlSourceBaseOptions<Source, Cursor, SourceInput = unknown> {
  readonly batchSize: number;
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly read: SqlSourceRead<SourceInput, Cursor>;
  readonly sourceSchema: SourcePayloadSchema<Source, SourceInput>;
}

export interface SqlSourceOptions<
  Source,
  Cursor,
  SourceInput = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> extends SqlSourceBaseOptions<Source, Cursor, SourceInput> {
  readonly getSourceMetadata: SqlSourceMetadata<
    SourceInput,
    Cursor,
    IdentityKey
  >;
  readonly identity: SourceIdentityDefinition<IdentityKey>;
  readonly lookup: SqlSourceLookup<SourceInput, IdentityKey>;
}

const executeStatement = <Row>(
  operation: "read" | "readByIdentity",
  statement: Statement.Statement<Row>
): Effect.Effect<readonly Row[], SourcePluginError> =>
  statement.pipe(
    Effect.mapError((cause) => makeSqlSourceExecutionError(operation, cause))
  );

const extractMetadata = <
  Source,
  Cursor,
  SourceInput,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  options: SqlSourceOptions<Source, Cursor, SourceInput, IdentityKey>,
  operation: "read" | "readByIdentity",
  row: SourceInput,
  rowIndex: number
): Effect.Effect<
  SqlSourceMetadataResult<Cursor, IdentityKey>,
  SourcePluginError
> =>
  Effect.try({
    try: () => options.getSourceMetadata(row, { rowIndex }),
    catch: (cause) =>
      makeSqlSourceMetadataError(
        operation,
        rowIndex,
        "metadata extractor threw",
        cause
      ),
  });

const sourceItemFromRow = <
  Source,
  Cursor,
  SourceInput,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  options: SqlSourceOptions<Source, Cursor, SourceInput, IdentityKey>,
  operation: "read" | "readByIdentity",
  row: SourceInput,
  rowIndex: number
): Effect.Effect<
  SourceItemInput<SourceInput, IdentityKey>,
  SourcePluginError
> =>
  extractMetadata(options, operation, row, rowIndex).pipe(
    Effect.flatMap((metadata) =>
      metadata.kind === "failure"
        ? Effect.fail(
            makeSqlSourceMetadataError(
              operation,
              rowIndex,
              metadata.message,
              metadata.cause
            )
          )
        : Effect.succeed({
            identityKey: metadata.identityKey,
            item: row,
            version: metadata.version,
          })
    )
  );

const readRows = <
  Source,
  Cursor,
  SourceInput,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  options: SqlSourceOptions<Source, Cursor, SourceInput, IdentityKey>,
  identityDefinition: SourceIdentityDefinition<IdentityKey>,
  sql: SqlClient.SqlClient,
  cursor: Cursor | null
): Effect.Effect<
  SourceReadResultInput<SourceInput, Cursor, IdentityKey>,
  SourcePluginError
> =>
  Effect.gen(function* () {
    if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
      return yield* makeSqlSourceBatchSizeError(options.batchSize);
    }

    const rows = yield* executeStatement(
      "read",
      options.read(sql, cursor, options.batchSize)
    );
    const items: SourceItemInput<SourceInput, IdentityKey>[] = [];
    const sourceIdentityRows = new Map<string, number>();
    let nextCursor: Cursor | undefined;

    for (const [rowIndex, row] of rows.entries()) {
      const metadata = yield* extractMetadata(options, "read", row, rowIndex);

      if (metadata.kind === "failure") {
        return yield* makeSqlSourceMetadataError(
          "read",
          rowIndex,
          metadata.message,
          metadata.cause
        );
      }

      if (metadata.cursor === undefined) {
        return yield* makeSqlSourceMetadataError(
          "read",
          rowIndex,
          "source cursor is required",
          {
            rowIndex,
            sourceCursor: metadata.cursor,
          }
        );
      }

      const sourceIdentity = yield* encodeSourceIdentityKey(
        identityDefinition,
        metadata.identityKey
      );
      const existingRowIndex = sourceIdentityRows.get(sourceIdentity);

      if (existingRowIndex !== undefined) {
        return yield* makeSqlSourceMetadataError(
          "read",
          rowIndex,
          "duplicate Source Identity in read window",
          {
            duplicateRowIndex: rowIndex,
            firstRowIndex: existingRowIndex,
            sourceIdentity,
          }
        );
      }

      sourceIdentityRows.set(sourceIdentity, rowIndex);
      items.push({
        identityKey: metadata.identityKey,
        item: row,
        version: metadata.version,
      });
      nextCursor = metadata.cursor;
    }

    return {
      items,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  });

const makeImplementation = <
  Source,
  Cursor,
  SourceInput,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  options: SqlSourceOptions<Source, Cursor, SourceInput, IdentityKey>,
  sql: SqlClient.SqlClient,
  identityDefinition: SourceIdentityDefinition<IdentityKey>
): SourcePluginImplementation<Source, Cursor, IdentityKey, SourceInput> => {
  const read = Effect.fn("SqlSource.read")((cursor: Cursor | null) =>
    readRows(options, identityDefinition, sql, cursor)
  );

  const readByIdentity = Effect.fn("SqlSource.readByIdentity")(function* (
    identity: SourceIdentity<IdentityKey>
  ) {
    const rows = yield* executeStatement(
      "readByIdentity",
      options.lookup(sql, identity)
    );

    if (rows.length === 0) {
      return null;
    }

    if (rows.length > 1) {
      return yield* makeSqlSourceLookupMultipleRowsError(
        identity.encoded,
        rows.length
      );
    }

    const [row] = rows;

    if (row === undefined) {
      return null;
    }

    const sourceItem = yield* sourceItemFromRow(
      options,
      "readByIdentity",
      row,
      0
    );
    const requestedIdentity = identity.encoded;
    const returnedIdentity = yield* encodeSourceIdentityKey(
      identityDefinition,
      sourceItem.identityKey
    );

    if (returnedIdentity !== requestedIdentity) {
      return yield* makeSqlSourceLookupIdentityMismatchError(
        requestedIdentity,
        returnedIdentity
      );
    }

    return sourceItem;
  });

  return {
    lookupStrategy: "direct",
    read,
    readByIdentity,
  };
};

const make = <
  Source,
  Cursor,
  SourceInput,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  options: SqlSourceOptions<Source, Cursor, SourceInput, IdentityKey>
): ConfiguredSourcePlugin<
  Source,
  Cursor,
  IdentityKey,
  SourceInput,
  never,
  SqlClient.SqlClient
> => {
  return defineSourcePluginLayer({
    layer: Layer.effect(
      SourcePluginService,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const source = defineSourcePlugin({
          cursorSchema: options.cursorSchema,
          identity: options.identity,
          make: () => makeImplementation(options, sql, options.identity),
          sourceSchema: options.sourceSchema,
        });

        return yield* SourcePluginService.pipe(Effect.provide(source.layer));
      })
    ),
    identity: options.identity,
    sourceSchema: options.sourceSchema,
  });
};

const makeLayer = <
  Source,
  Cursor,
  SourceInput,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  options: SqlSourceOptions<Source, Cursor, SourceInput, IdentityKey>
): Layer.Layer<AnySourcePlugin, never, SqlClient.SqlClient> =>
  make(options).layer;

export const SqlSourcePlugin = {
  make,
  layer: makeLayer,
  name: SqlSourcePluginName,
} as const;
