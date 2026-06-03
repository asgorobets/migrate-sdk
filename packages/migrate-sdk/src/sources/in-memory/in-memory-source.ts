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
  type AnySourcePlugin,
  SourcePlugin,
} from "../../services/source-plugin.ts";

export const InMemorySourceCursor = Schema.Struct({
  offset: Schema.Int,
});

export type InMemorySourceCursor = typeof InMemorySourceCursor.Type;

const decodeInMemorySourceCursor =
  Schema.decodeUnknownEffect(InMemorySourceCursor);

export interface InMemorySourceOptions<A> {
  readonly batchSize?: number;
  readonly items: readonly SourceItemInput<A>[];
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

const invalidBatchSizeError = (batchSize: number): SourcePluginError =>
  new SourcePluginError({
    message: "In-memory source batchSize must be a positive integer",
    cause: { batchSize },
  });

const makeLayer = <A>(
  options: InMemorySourceOptions<A>
): Layer.Layer<AnySourcePlugin> =>
  Layer.sync(SourcePlugin, (): SourcePlugin<A> => {
    const items: readonly SourceItem<A>[] = options.items.map(makeSourceItem);
    const batchSize = options.batchSize ?? items.length;
    const lookupStrategy = options.lookupStrategy ?? "direct";

    const read = Effect.fn("InMemorySource.read")(function* (
      cursor: SourceCursor | null
    ) {
      if (
        options.batchSize !== undefined &&
        (!Number.isInteger(options.batchSize) || options.batchSize <= 0)
      ) {
        return yield* invalidBatchSizeError(options.batchSize);
      }

      const offset =
        cursor === null
          ? 0
          : yield* decodeInMemorySourceCursor(cursor).pipe(
              Effect.map((decodedCursor) => decodedCursor.offset),
              Effect.mapError((error) => invalidCursorError(cursor, error))
            );

      return yield* Effect.sync(() => {
        const nextOffset = offset + batchSize;
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

    const readByIdentity = Effect.fn("InMemorySource.readByIdentity")(
      (
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
