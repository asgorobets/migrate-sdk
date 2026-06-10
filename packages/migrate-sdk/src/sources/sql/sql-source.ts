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
  SourceIdentityInput,
  SourceVersionInput,
} from "../../domain/ids.ts";
import { toSourceIdentity } from "../../domain/ids.ts";
import type { SourceItemInput } from "../../domain/source.ts";
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

export interface SqlSourceMetadataSuccess<Cursor> {
  readonly cursor: Cursor;
  readonly identity: SourceIdentityInput;
  readonly kind: "success";
  readonly version: SourceVersionInput;
}

export interface SqlSourceMetadataFailure {
  readonly cause?: unknown;
  readonly kind: "failure";
  readonly message: string;
}

export type SqlSourceMetadataResult<Cursor> =
  | SqlSourceMetadataFailure
  | SqlSourceMetadataSuccess<Cursor>;

export type SqlSourceRead<Row, Cursor> = (
  sql: SqlClient.SqlClient,
  cursor: Cursor | null,
  limit: number
) => Statement.Statement<Row>;

export type SqlSourceLookup<Row> = (
  sql: SqlClient.SqlClient,
  identity: SourceIdentityInput
) => Statement.Statement<Row>;

export type SqlSourceMetadata<Row, Cursor> = (
  row: Readonly<Row>,
  context: SqlSourceMetadataContext
) => SqlSourceMetadataResult<Cursor>;

export interface SqlSourceOptions<Source, Cursor, SourceInput = unknown> {
  readonly batchSize: number;
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly getSourceMetadata: SqlSourceMetadata<SourceInput, Cursor>;
  readonly lookup: SqlSourceLookup<SourceInput>;
  readonly read: SqlSourceRead<SourceInput, Cursor>;
  readonly sourceSchema: SourcePayloadSchema<Source, SourceInput>;
}

const executeStatement = <Row>(
  operation: "read" | "readByIdentity",
  statement: Statement.Statement<Row>
): Effect.Effect<readonly Row[], SourcePluginError> =>
  statement.pipe(
    Effect.mapError((cause) => makeSqlSourceExecutionError(operation, cause))
  );

const extractMetadata = <Source, Cursor, SourceInput>(
  options: SqlSourceOptions<Source, Cursor, SourceInput>,
  operation: "read" | "readByIdentity",
  row: SourceInput,
  rowIndex: number
): Effect.Effect<SqlSourceMetadataResult<Cursor>, SourcePluginError> =>
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

const sourceItemFromRow = <Source, Cursor, SourceInput>(
  options: SqlSourceOptions<Source, Cursor, SourceInput>,
  operation: "read" | "readByIdentity",
  row: SourceInput,
  rowIndex: number
): Effect.Effect<SourceItemInput<SourceInput>, SourcePluginError> =>
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
            identity: metadata.identity,
            item: row,
            version: metadata.version,
          })
    )
  );

const readRows = <Source, Cursor, SourceInput>(
  options: SqlSourceOptions<Source, Cursor, SourceInput>,
  sql: SqlClient.SqlClient,
  cursor: Cursor | null
): Effect.Effect<
  SourceReadResultInput<SourceInput, Cursor>,
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
    const items: SourceItemInput<SourceInput>[] = [];
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

      const sourceIdentity = toSourceIdentity(metadata.identity);
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
        identity: metadata.identity,
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

const makeImplementation = <Source, Cursor, SourceInput>(
  options: SqlSourceOptions<Source, Cursor, SourceInput>,
  sql: SqlClient.SqlClient
): SourcePluginImplementation<Source, Cursor, SourceInput> => {
  const read = Effect.fn("SqlSource.read")((cursor: Cursor | null) =>
    readRows(options, sql, cursor)
  );

  const readByIdentity = Effect.fn("SqlSource.readByIdentity")(function* (
    identity: SourceIdentityInput
  ) {
    const rows = yield* executeStatement(
      "readByIdentity",
      options.lookup(sql, identity)
    );

    if (rows.length === 0) {
      return null;
    }

    if (rows.length > 1) {
      return yield* makeSqlSourceLookupMultipleRowsError(identity, rows.length);
    }

    const sourceItem = yield* sourceItemFromRow(
      options,
      "readByIdentity",
      rows[0] as SourceInput,
      0
    );
    const requestedIdentity = toSourceIdentity(identity);
    const returnedIdentity = toSourceIdentity(sourceItem.identity);

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

const make = <Source, Cursor, SourceInput>(
  options: SqlSourceOptions<Source, Cursor, SourceInput>
): ConfiguredSourcePlugin<
  Source,
  Cursor,
  SourceInput,
  never,
  SqlClient.SqlClient
> =>
  defineSourcePluginLayer({
    layer: Layer.effect(
      SourcePluginService,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const source = defineSourcePlugin({
          cursorSchema: options.cursorSchema,
          make: () => makeImplementation(options, sql),
          sourceSchema: options.sourceSchema,
        });

        return yield* SourcePluginService.pipe(Effect.provide(source.layer));
      })
    ),
    sourceSchema: options.sourceSchema,
  });

const makeLayer = <Source, Cursor, SourceInput>(
  options: SqlSourceOptions<Source, Cursor, SourceInput>
): Layer.Layer<AnySourcePlugin, never, SqlClient.SqlClient> =>
  make(options).layer;

export const SqlSourcePlugin = {
  make,
  layer: makeLayer,
  name: SqlSourcePluginName,
} as const;
