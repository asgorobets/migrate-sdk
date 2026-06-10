import { Effect, type Layer, Schema } from "effect";
import {
  type ConfiguredSourcePlugin,
  defineSourcePlugin,
  type SourcePluginImplementation,
} from "../../domain/definition.ts";
import { SourcePluginError } from "../../domain/errors.ts";
import type { SourceIdentityInput } from "../../domain/ids.ts";
import type {
  SourceItemInput,
  SourceLookupStrategy,
} from "../../domain/source.ts";
import type { AnySourcePlugin } from "../../services/source-plugin.ts";

export const InMemorySourceCursor = Schema.Struct({
  offset: Schema.Int,
});

export type InMemorySourceCursor = typeof InMemorySourceCursor.Type;

export interface InMemorySourceOptions<A> {
  readonly batchSize?: number;
  readonly items: readonly SourceItemInput<A>[];
  readonly lookupStrategy?: SourceLookupStrategy;
  readonly sourceSchema: Schema.Codec<A, unknown, never, never>;
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

const invalidBatchSizeError = (batchSize: number): SourcePluginError =>
  new SourcePluginError({
    message: "In-memory source batchSize must be a positive integer",
    cause: { batchSize },
  });

const transientSourceError = (operation: string): SourcePluginError =>
  new SourcePluginError({
    message: `In-memory source ${operation} failed transiently`,
  });

const makeImplementation = <A>(
  options: InMemorySourceOptions<A>
): SourcePluginImplementation<A, InMemorySourceCursor> => {
  const items = options.items;
  const batchSize = options.batchSize ?? items.length;
  const lookupStrategy = options.lookupStrategy ?? "direct";
  const state = options.state ?? makeState();
  let remainingReadFailures = options.transientFailures?.read ?? 0;
  let remainingReadByIdentityFailures =
    options.transientFailures?.readByIdentity ?? 0;

  const read = Effect.fn("InMemorySource.read")(function* (
    cursor: InMemorySourceCursor | null
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

    const offset = cursor === null ? 0 : cursor.offset;

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

  const readByIdentity = Effect.fn("InMemorySource.readByIdentity")(function* (
    identity: SourceIdentityInput
  ) {
    state.readByIdentityAttempts += 1;

    if (remainingReadByIdentityFailures > 0) {
      remainingReadByIdentityFailures -= 1;
      return yield* transientSourceError("readByIdentity");
    }

    return yield* Effect.sync(
      () => items.find((item) => item.identity === identity) ?? null
    );
  });

  return {
    lookupStrategy,
    read,
    readByIdentity,
  };
};

const makeLayer = <A>(
  options: InMemorySourceOptions<A>
): Layer.Layer<AnySourcePlugin> => make(options).layer;

const make = <A>(
  options: InMemorySourceOptions<A>
): ConfiguredSourcePlugin<A, InMemorySourceCursor, unknown> =>
  defineSourcePlugin({
    cursorSchema: InMemorySourceCursor,
    make: () => makeImplementation(options),
    sourceSchema: options.sourceSchema,
  });

export const InMemorySourcePlugin = {
  layer: makeLayer,
  make,
  makeState,
} as const;
