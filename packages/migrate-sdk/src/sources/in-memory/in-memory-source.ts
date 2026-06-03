import { Effect, Layer, Schema } from "effect";
import type { ConfiguredSourcePlugin } from "../../domain/definition.ts";
import { SourcePluginError } from "../../domain/errors.ts";
import type { SourceCursor, SourceIdentity } from "../../domain/ids.ts";
import type {
  SourceItem,
  SourceItemInput,
  SourceLookupStrategy,
} from "../../domain/source.ts";
import { makeSourceItem } from "../../domain/source.ts";
import {
  SourcePlugin,
  type AnySourcePlugin,
} from "../../services/source-plugin.ts";

export const InMemorySourceCursor = Schema.Struct({
  offset: Schema.Int,
});

export type InMemorySourceCursor = typeof InMemorySourceCursor.Type;

const decodeInMemorySourceCursor = Schema.decodeUnknownEffect(
  InMemorySourceCursor
);

export interface InMemorySourceOptions<A> {
  readonly items: ReadonlyArray<SourceItemInput<A>>;
  readonly windowSize?: number;
  readonly lookupStrategy?: SourceLookupStrategy;
  readonly sourceSchema?: Schema.Schema<A>;
}

const invalidCursorError = (
  cursor: SourceCursor,
  cause: unknown
): SourcePluginError =>
  new SourcePluginError({
    message: "Invalid in-memory source cursor",
    cause: { cursor, error: cause },
  });

const makeLayer = <A>(
  options: InMemorySourceOptions<A>
): Layer.Layer<AnySourcePlugin> =>
  Layer.sync(SourcePlugin, (): SourcePlugin<A> => {
    const items: ReadonlyArray<SourceItem<A>> = options.items.map(makeSourceItem);
    const windowSize = options.windowSize ?? items.length;
    const lookupStrategy = options.lookupStrategy ?? "direct";

    const read = Effect.fn("InMemorySource.read")(function* (
      cursor: SourceCursor | null
    ) {
      const offset =
        cursor === null
          ? 0
          : yield* decodeInMemorySourceCursor(cursor).pipe(
              Effect.map((decodedCursor) => decodedCursor.offset),
              Effect.mapError((error) => invalidCursorError(cursor, error))
            );

      return yield* Effect.sync(() => {
        const nextOffset = offset + windowSize;
        const windowItems = items.slice(offset, nextOffset);

        return {
          items: windowItems,
          ...(nextOffset < items.length
            ? {
                nextCursor: {
                  offset: nextOffset,
                } satisfies InMemorySourceCursor,
              }
            : {}),
        };
      });
    });

    const readByIdentity = Effect.fn("InMemorySource.readByIdentity")((
      identity: SourceIdentity
    ): Effect.Effect<SourceItem<A> | null, SourcePluginError> =>
      Effect.sync(
        () => items.find((item) => item.identity === identity) ?? null
      )
    );

    return {
      lookupStrategy,
      read,
      readByIdentity,
    };
  });

const make = <A>(
  options: InMemorySourceOptions<A>
): ConfiguredSourcePlugin<A> => ({
  layer: makeLayer(options),
  ...(options.sourceSchema === undefined
    ? {}
    : { sourceSchema: options.sourceSchema }),
});

export const InMemorySourcePlugin = {
  layer: makeLayer,
  make,
} as const;
