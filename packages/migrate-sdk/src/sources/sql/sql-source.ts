import { Effect, Layer, type Schema } from "effect";
import { SqlClient, type Statement } from "effect/unstable/sql";
import {
  type ConfiguredSource,
  Source,
  type SourceImplementation,
  type SourcePayloadSchema,
  type SourceReadResultInput,
} from "../../domain/definition.ts";
import { SourceError } from "../../domain/errors.ts";
import {
  SourceIdentity,
  type SourceIdentityContractIdInput,
  type SourceIdentityDefinition,
  type SourceIdentityKeyScalar,
  type SourceIdentityPart,
  type SourceIdentityScalar,
  type SourceIdentitySchema,
  type SourceIdentitySnapshotKey,
  type SourceIdentityTarget,
  type SourceVersionInput,
} from "../../domain/ids.ts";
import {
  makeSourceIdentityContractFingerprint,
  type SourceVersionContractFingerprint,
} from "../../domain/migration-contract.ts";
import {
  encodeSourceIdentityKey,
  type SourceItemInput,
} from "../../domain/source.ts";
import type { AnySource } from "../../services/source.ts";
import {
  makeSqlSourceBatchSizeError,
  makeSqlSourceExecutionError,
  makeSqlSourceLookupIdentityMismatchError,
  makeSqlSourceLookupMultipleRowsError,
  makeSqlSourceMetadataError,
} from "./internal/errors.ts";

export const SqlSourceName = "sql";

export interface SqlSourceMetadataContext {
  readonly rowIndex: number;
}

export interface SqlSourceMetadataSuccess<Cursor> {
  readonly cursor: Cursor;
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

export type SqlSourceLookup<
  Row,
  IdentityKey extends SourceIdentitySnapshotKey = string,
> = (
  sql: SqlClient.SqlClient,
  identity: SourceIdentityTarget<IdentityKey>
) => Statement.Statement<Row>;

export type SqlSourceCountStatement<Row> = (
  sql: SqlClient.SqlClient
) => Statement.Statement<Row>;

export type SqlSourceCountEffect = (
  sql: SqlClient.SqlClient
) => Effect.Effect<number, SourceError>;

export interface SqlSourceStatementCount<Row = { readonly count: number }> {
  readonly getCount: (row: Readonly<Row>) => number;
  readonly kind: "statement";
  readonly statement: SqlSourceCountStatement<Row>;
}

export interface SqlSourceEffectCount {
  readonly effect: SqlSourceCountEffect;
  readonly kind: "effect";
}

export type SqlSourceCount<Row = { readonly count: number }> =
  | SqlSourceEffectCount
  | SqlSourceStatementCount<Row>;

export type SqlSourceMetadata<Row, Cursor> = (
  row: Readonly<Row>,
  context: SqlSourceMetadataContext
) => SqlSourceMetadataResult<Cursor>;

export interface SqlIdentityColumn<
  Name extends string = string,
  Value extends SourceIdentityScalar = SourceIdentityScalar,
  Encoded extends SourceIdentityKeyScalar = SourceIdentityKeyScalar,
> {
  readonly name: Name;
  readonly schema: SourceIdentityPart<Value, Encoded>;
}

export type SqlIdentityColumns = readonly [
  SqlIdentityColumn,
  ...SqlIdentityColumn[],
];

type SqlIdentityColumnValue<Column> =
  Column extends SqlIdentityColumn<string, infer Value, SourceIdentityKeyScalar>
    ? Value
    : never;

type SqlIdentityColumnsKey<Columns extends SqlIdentityColumns> =
  Columns extends readonly [infer Column]
    ? SqlIdentityColumnValue<Column>
    : {
        readonly [Index in keyof Columns]: SqlIdentityColumnValue<
          Columns[Index]
        >;
      };

export interface SqlIdentityDefinition<
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  Columns extends SqlIdentityColumns = SqlIdentityColumns,
> {
  readonly id: SourceIdentityContractIdInput;
  readonly key: {
    readonly columns: Columns;
    readonly kind: "columns";
  };
  readonly schema: SourceIdentitySchema<IdentityKey>;
}

export type AnySqlIdentityDefinition = SqlIdentityDefinition<
  SourceIdentitySnapshotKey,
  SqlIdentityColumns
>;

type SqlIdentityDefinitionKey<Identity extends AnySqlIdentityDefinition> =
  Identity extends SqlIdentityDefinition<infer IdentityKey, infer _Columns>
    ? IdentityKey
    : never;

type KnownStringKeyOf<T> = string extends keyof T
  ? never
  : Extract<keyof T, string>;

type SqlIdentityForSourceInput<
  SourceInput,
  Identity extends AnySqlIdentityDefinition,
> =
  Identity extends SqlIdentityDefinition<infer _IdentityKey, infer Columns>
    ? SqlIdentityColumnsCompatibleWithSourceInput<
        SourceInput,
        Columns
      > extends true
      ? Identity
      : never
    : never;

type SqlIdentityColumnCompatibleWithSourceInput<SourceInput, Column> =
  Column extends SqlIdentityColumn<
    infer Name,
    SourceIdentityScalar,
    infer Encoded
  >
    ? Name extends KnownStringKeyOf<SourceInput>
      ? SourceInput[Name] extends Encoded
        ? true
        : false
      : false
    : false;

type SqlIdentityColumnsCompatibleWithSourceInput<
  SourceInput,
  Columns extends readonly SqlIdentityColumn[],
> = Columns extends readonly []
  ? true
  : Columns extends readonly [infer Column, ...infer RemainingColumns]
    ? SqlIdentityColumnCompatibleWithSourceInput<
        SourceInput,
        Column
      > extends true
      ? RemainingColumns extends readonly SqlIdentityColumn[]
        ? SqlIdentityColumnsCompatibleWithSourceInput<
            SourceInput,
            RemainingColumns
          >
        : false
      : false
    : false;

type SqlSourceOptionsForIdentity<
  Source,
  Cursor,
  SourceInput,
  Identity extends AnySqlIdentityDefinition,
  CountRow = unknown,
> =
  SqlIdentityForSourceInput<SourceInput, Identity> extends never
    ? never
    : SqlSourceOptions<Source, Cursor, SourceInput, Identity, CountRow>;

const makeSqlIdentityColumn = <
  const Name extends string,
  Value extends SourceIdentityScalar,
  Encoded extends SourceIdentityKeyScalar,
>(
  name: Name,
  schema: Schema.Codec<Value, Encoded, never, never>
): SqlIdentityColumn<Name, Value, Encoded> => ({
  name,
  schema: SourceIdentity.part(name, schema),
});

function makeSqlColumnsIdentity<const Column extends SqlIdentityColumn>(input: {
  readonly columns: readonly [Column];
  readonly id: SourceIdentityContractIdInput;
}): SqlIdentityDefinition<SqlIdentityColumnValue<Column>, readonly [Column]>;
function makeSqlColumnsIdentity<
  const Columns extends SqlIdentityColumns,
>(input: {
  readonly columns: Columns;
  readonly id: SourceIdentityContractIdInput;
}): SqlIdentityDefinition<SqlIdentityColumnsKey<Columns>, Columns>;
function makeSqlColumnsIdentity(input: {
  readonly columns: SqlIdentityColumns;
  readonly id: SourceIdentityContractIdInput;
}): SqlIdentityDefinition {
  const [firstColumn, ...remainingColumns] = input.columns;
  const schema =
    remainingColumns.length === 0
      ? SourceIdentity.key(firstColumn.name, firstColumn.schema)
      : SourceIdentity.tuple([
          firstColumn.schema,
          ...remainingColumns.map((column) => column.schema),
        ]);

  return {
    id: input.id,
    key: {
      columns: input.columns,
      kind: "columns",
    },
    schema,
  };
}

export const SqlIdentity = {
  column: makeSqlIdentityColumn,
  columns: makeSqlColumnsIdentity,
} as const;

interface SqlSourceBaseOptions<
  Source,
  Cursor,
  SourceInput = unknown,
  CountRow = unknown,
> {
  readonly batchSize: number;
  readonly count?: SqlSourceCount<CountRow>;
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly read: SqlSourceRead<SourceInput, Cursor>;
  readonly sourceSchema: SourcePayloadSchema<Source, SourceInput>;
}

export interface SqlSourceOptions<
  Source,
  Cursor,
  SourceInput = unknown,
  Identity extends AnySqlIdentityDefinition = AnySqlIdentityDefinition,
  CountRow = unknown,
> extends SqlSourceBaseOptions<Source, Cursor, SourceInput, CountRow> {
  readonly getSourceMetadata: SqlSourceMetadata<SourceInput, Cursor>;
  readonly identity: Identity;
  readonly lookup: SqlSourceLookup<
    SourceInput,
    SqlIdentityDefinitionKey<Identity>
  >;
  readonly sourceVersionContractFingerprint?: SourceVersionContractFingerprint;
}

const executeStatement = <Row>(
  operation: "count" | "read" | "readByIdentity",
  statement: Statement.Statement<Row>
): Effect.Effect<readonly Row[], SourceError> =>
  statement.pipe(
    Effect.mapError((cause) => makeSqlSourceExecutionError(operation, cause))
  );

const makeSqlIdentityDefinition = <
  IdentityKey extends SourceIdentitySnapshotKey,
  Columns extends SqlIdentityColumns,
>(
  identity: SqlIdentityDefinition<IdentityKey, Columns>
): SourceIdentityDefinition<IdentityKey> =>
  SourceIdentity.make({
    id: identity.id,
    schema: identity.schema,
  });

const makeSqlSourceIdentityContractFingerprint = <
  Identity extends AnySqlIdentityDefinition,
>(
  identity: Identity,
  identityDefinition: SourceIdentityDefinition<
    SqlIdentityDefinitionKey<Identity>
  >
) =>
  makeSourceIdentityContractFingerprint({
    identity: identityDefinition.fingerprint,
    key: {
      columns: identity.key.columns.map((column) => column.name),
      kind: identity.key.kind,
    },
    source: "sql@v1",
  });

const readSqlIdentityColumnValue = (
  row: unknown,
  column: SqlIdentityColumn
): unknown =>
  typeof row === "object" && row !== null
    ? Reflect.get(row, column.name)
    : undefined;

const buildIdentityKey = <Identity extends AnySqlIdentityDefinition>(
  identity: Identity,
  identityDefinition: SourceIdentityDefinition<
    SqlIdentityDefinitionKey<Identity>
  >,
  operation: "read" | "readByIdentity",
  row: unknown,
  rowIndex: number
): Effect.Effect<SqlIdentityDefinitionKey<Identity>, SourceError> =>
  Effect.try({
    try: () => {
      const rawKeyParts = identity.key.columns.map((column) =>
        readSqlIdentityColumnValue(row, column)
      );
      const rawKey = rawKeyParts.length === 1 ? rawKeyParts[0] : rawKeyParts;

      return SourceIdentity.decode(identityDefinition, rawKey);
    },
    catch: (cause) =>
      makeSqlSourceMetadataError(
        operation,
        rowIndex,
        "source identity key did not match Source Identity Schema",
        cause
      ),
  });

const extractMetadata = <
  Source,
  Cursor,
  SourceInput,
  Identity extends AnySqlIdentityDefinition,
  CountRow = unknown,
>(
  options: SqlSourceOptions<Source, Cursor, SourceInput, Identity, CountRow>,
  operation: "read" | "readByIdentity",
  row: SourceInput,
  rowIndex: number
): Effect.Effect<SqlSourceMetadataResult<Cursor>, SourceError> =>
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
  Identity extends AnySqlIdentityDefinition,
  CountRow = unknown,
>(
  options: SqlSourceOptions<Source, Cursor, SourceInput, Identity, CountRow>,
  identityDefinition: SourceIdentityDefinition<
    SqlIdentityDefinitionKey<Identity>
  >,
  operation: "read" | "readByIdentity",
  row: SourceInput,
  rowIndex: number
): Effect.Effect<
  SourceItemInput<SourceInput, SqlIdentityDefinitionKey<Identity>>,
  SourceError
> =>
  extractMetadata(options, operation, row, rowIndex).pipe(
    Effect.flatMap((metadata) => {
      if (metadata.kind === "failure") {
        return Effect.fail(
          makeSqlSourceMetadataError(
            operation,
            rowIndex,
            metadata.message,
            metadata.cause
          )
        );
      }

      return buildIdentityKey(
        options.identity,
        identityDefinition,
        operation,
        row,
        rowIndex
      ).pipe(
        Effect.map((identityKey) => ({
          identityKey,
          item: row,
          version: metadata.version,
        }))
      );
    })
  );

const readRows = <
  Source,
  Cursor,
  SourceInput,
  Identity extends AnySqlIdentityDefinition,
  CountRow = unknown,
>(
  options: SqlSourceOptions<Source, Cursor, SourceInput, Identity, CountRow>,
  identityDefinition: SourceIdentityDefinition<
    SqlIdentityDefinitionKey<Identity>
  >,
  sql: SqlClient.SqlClient,
  cursor: Cursor | null
): Effect.Effect<
  SourceReadResultInput<
    SourceInput,
    Cursor,
    SqlIdentityDefinitionKey<Identity>
  >,
  SourceError
> =>
  Effect.gen(function* () {
    if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
      return yield* makeSqlSourceBatchSizeError(options.batchSize);
    }

    const rows = yield* executeStatement(
      "read",
      options.read(sql, cursor, options.batchSize)
    );
    const items: SourceItemInput<
      SourceInput,
      SqlIdentityDefinitionKey<Identity>
    >[] = [];
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

      const identityKey = yield* buildIdentityKey(
        options.identity,
        identityDefinition,
        "read",
        row,
        rowIndex
      );
      const sourceIdentity = yield* encodeSourceIdentityKey(
        identityDefinition,
        identityKey
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
        identityKey,
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

const makeSqlSourceCountRowError = (rowCount: number): SourceError =>
  new SourceError({
    cause: { rowCount },
    message: "SQL source count must return exactly one row",
  });

const readSqlSourceCount = <CountRow>(
  count: SqlSourceCount<CountRow>,
  sql: SqlClient.SqlClient
): Effect.Effect<number, SourceError> => {
  if (count.kind === "effect") {
    return count.effect(sql);
  }

  return Effect.gen(function* () {
    const rows = yield* executeStatement("count", count.statement(sql));

    if (rows.length !== 1) {
      return yield* makeSqlSourceCountRowError(rows.length);
    }

    const [row] = rows;

    if (row === undefined) {
      return yield* makeSqlSourceCountRowError(0);
    }

    return yield* Effect.try({
      try: () => count.getCount(row),
      catch: (cause) =>
        new SourceError({
          cause,
          message: "SQL source count extractor failed",
        }),
    });
  });
};

const makeImplementation = <
  Source,
  Cursor,
  SourceInput,
  Identity extends AnySqlIdentityDefinition,
  CountRow,
>(
  options: SqlSourceOptions<Source, Cursor, SourceInput, Identity, CountRow>,
  sql: SqlClient.SqlClient,
  identityDefinition: SourceIdentityDefinition<
    SqlIdentityDefinitionKey<Identity>
  >
): SourceImplementation<
  Source,
  Cursor,
  SqlIdentityDefinitionKey<Identity>,
  SourceInput
> => {
  const read = Effect.fn("SqlSource.read")((cursor: Cursor | null) =>
    readRows(options, identityDefinition, sql, cursor)
  );

  const configuredCount = options.count;
  const countTotal =
    configuredCount === undefined
      ? undefined
      : Effect.fn("SqlSource.countTotal")(() =>
          readSqlSourceCount(configuredCount, sql)
        );

  const readByIdentity = Effect.fn("SqlSource.readByIdentity")(function* (
    identity: SourceIdentity<SqlIdentityDefinitionKey<Identity>>
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
      identityDefinition,
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
    ...(countTotal === undefined ? {} : { countTotal }),
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
  Columns extends SqlIdentityColumns,
  CountRow = unknown,
>(
  options: SqlSourceOptionsForIdentity<
    Source,
    Cursor,
    SourceInput,
    SqlIdentityDefinition<IdentityKey, Columns>,
    CountRow
  >
): ConfiguredSource<
  Source,
  Cursor,
  IdentityKey,
  SourceInput,
  never,
  SqlClient.SqlClient
> => {
  const identityDefinition = makeSqlIdentityDefinition(options.identity);
  const sourceIdentityContractFingerprint =
    makeSqlSourceIdentityContractFingerprint(
      options.identity,
      identityDefinition
    );

  return Source.fromLayer<
    Source,
    Cursor,
    IdentityKey,
    SourceInput,
    never,
    SqlClient.SqlClient
  >({
    cursorSchema: options.cursorSchema,
    layer: Layer.effect(
      Source,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const source = Source.make<Source, Cursor, IdentityKey, SourceInput>({
          cursorSchema: options.cursorSchema,
          identity: identityDefinition,
          make: () =>
            makeImplementation<
              Source,
              Cursor,
              SourceInput,
              SqlIdentityDefinition<IdentityKey, Columns>,
              CountRow
            >(options, sql, identityDefinition),
          sourceIdentityContractFingerprint,
          sourceSchema: options.sourceSchema,
          ...(options.sourceVersionContractFingerprint === undefined
            ? {}
            : {
                sourceVersionContractFingerprint:
                  options.sourceVersionContractFingerprint,
              }),
        });

        return yield* Source.pipe(Effect.provide(source.layer));
      })
    ),
    identity: identityDefinition,
    sourceIdentityContractFingerprint,
    sourceSchema: options.sourceSchema,
    ...(options.sourceVersionContractFingerprint === undefined
      ? {}
      : {
          sourceVersionContractFingerprint:
            options.sourceVersionContractFingerprint,
        }),
  });
};

const makeLayer = <
  Source,
  Cursor,
  SourceInput,
  IdentityKey extends SourceIdentitySnapshotKey,
  Columns extends SqlIdentityColumns,
  CountRow = unknown,
>(
  options: SqlSourceOptionsForIdentity<
    Source,
    Cursor,
    SourceInput,
    SqlIdentityDefinition<IdentityKey, Columns>,
    CountRow
  >
): Layer.Layer<AnySource, never, SqlClient.SqlClient> =>
  make<Source, Cursor, SourceInput, IdentityKey, Columns, CountRow>(options)
    .layer;

export const SqlSource = {
  make,
  layer: makeLayer,
  name: SqlSourceName,
} as const;
