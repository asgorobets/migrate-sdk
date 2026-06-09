import { Effect, type Layer, type Schema } from "effect";
import type { SqlClient, Statement } from "effect/unstable/sql";
import {
  type ConfiguredSourcePlugin,
  defineSourcePlugin,
  type SourcePayloadSchema,
  type SourcePluginImplementation,
} from "../../domain/definition.ts";
import type {
  SourceIdentityInput,
  SourceVersionInput,
} from "../../domain/ids.ts";
import type { AnySourcePlugin } from "../../services/source-plugin.ts";
import { makeSqlSourceNotImplementedError } from "./internal/errors.ts";

export const SqlSourcePluginName = "sql";

export type SqlSourceClientLayer = Layer.Layer<SqlClient.SqlClient>;

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
  readonly clientLayer: SqlSourceClientLayer;
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly getSourceMetadata: SqlSourceMetadata<SourceInput, Cursor>;
  readonly lookup: SqlSourceLookup<SourceInput>;
  readonly read: SqlSourceRead<SourceInput, Cursor>;
  readonly sourceSchema: SourcePayloadSchema<Source, SourceInput>;
}

const makeImplementation = <Source, Cursor, SourceInput>(
  _options: SqlSourceOptions<Source, Cursor, SourceInput>
): SourcePluginImplementation<Source, Cursor, SourceInput> => {
  const read = Effect.fn("SqlSource.read")(function* (_cursor: Cursor | null) {
    return yield* Effect.fail(makeSqlSourceNotImplementedError("read"));
  });

  const readByIdentity = Effect.fn("SqlSource.readByIdentity")(function* (
    _identity: SourceIdentityInput
  ) {
    return yield* Effect.fail(
      makeSqlSourceNotImplementedError("readByIdentity")
    );
  });

  return {
    lookupStrategy: "direct",
    read,
    readByIdentity,
  };
};

const make = <Source, Cursor, SourceInput>(
  options: SqlSourceOptions<Source, Cursor, SourceInput>
): ConfiguredSourcePlugin<Source, Cursor, SourceInput> =>
  defineSourcePlugin({
    cursorSchema: options.cursorSchema,
    make: () => makeImplementation(options),
    sourceSchema: options.sourceSchema,
  });

const makeLayer = <Source, Cursor, SourceInput>(
  options: SqlSourceOptions<Source, Cursor, SourceInput>
): Layer.Layer<AnySourcePlugin> => make(options).layer;

export const SqlSourcePlugin = {
  make,
  layer: makeLayer,
  name: SqlSourcePluginName,
} as const;
