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
  readonly state?: InMemorySourceState;
  readonly transientFailures?: InMemorySourceTransientFailures;
}

export interface InMemorySourceState {
  readAttempts: number;
  readByIdentityAttempts: number;
}

export interface InMemorySourceTransientFailures {
  readonly read?: number;
  readonly readByIdentity?: number;
}

const makeState = (): InMemorySourceState => ({
  readAttempts: 0,
  readByIdentityAttempts: 0,
});

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

const transientSourceError = (operation: string): SourcePluginError =>
  new SourcePluginError({
    message: `In-memory source ${operation} failed transiently`,
  });

const makeLayer = <A>(
  options: InMemorySourceOptions<A>
): Layer.Layer<AnySourcePlugin> =>
  Layer.sync(SourcePlugin, (): SourcePlugin<A> => {
    const items: readonly SourceItem<A>[] = options.items.map(makeSourceItem);
    const batchSize = options.batchSize ?? items.length;
    const lookupStrategy = options.lookupStrategy ?? "direct";
    const state = options.state ?? makeState();
    let remainingReadFailures = options.transientFailures?.read ?? 0;
    let remainingReadByIdentityFailures =
      options.transientFailures?.readByIdentity ?? 0;

    const read = Effect.fn("InMemorySource.read")(function* (
      cursor: SourceCursor | null
    ) {
      state.readAttempts += 1;

      if (remainingReadFailures > 0) {
        remainingReadFailures -= 1;
        return yield* transientSourceError("read");
      }

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
      function* (identity: SourceIdentity) {
        state.readByIdentityAttempts += 1;

        if (remainingReadByIdentityFailures > 0) {
          remainingReadByIdentityFailures -= 1;
          return yield* transientSourceError("readByIdentity");
        }

        return yield* Effect.sync(
          () => items.find((item) => item.identity === identity) ?? null
        );
      }
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
  makeState,
} as const;
