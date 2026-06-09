import { Effect, type Layer, type Schema } from "effect";
import {
  type ConfiguredSourcePlugin,
  defineSourcePlugin,
  type SourcePluginImplementation,
} from "../../domain/definition.ts";
import type { SourceIdentityInput } from "../../domain/ids.ts";
import type { AnySourcePlugin } from "../../services/source-plugin.ts";
import { makeSqlSourceNotImplementedError } from "./internal/errors.ts";

export const SqlSourcePluginName = "sql";

export interface SqlSourceOptions<Source, Cursor> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly sourceSchema: Schema.Codec<Source, unknown, never, never>;
}

const makeImplementation = <Source, Cursor>(): SourcePluginImplementation<
  Source,
  Cursor
> => {
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

const make = <Source, Cursor>(
  options: SqlSourceOptions<Source, Cursor>
): ConfiguredSourcePlugin<Source, Cursor> =>
  defineSourcePlugin({
    cursorSchema: options.cursorSchema,
    make: () => makeImplementation<Source, Cursor>(),
    sourceSchema: options.sourceSchema,
  });

const makeLayer = <Source, Cursor>(
  options: SqlSourceOptions<Source, Cursor>
): Layer.Layer<AnySourcePlugin> => make(options).layer;

export const SqlSourcePlugin = {
  make,
  layer: makeLayer,
  name: SqlSourcePluginName,
} as const;
