import { Effect, type Layer, Schema } from "effect";
import {
  type ConfiguredSource,
  Source,
  type SourceImplementation,
} from "../../domain/definition.ts";
import { SourceError } from "../../domain/errors.ts";
import type {
  SourceIdentity,
  SourceIdentityContractFingerprint,
  SourceIdentityDefinition,
  SourceIdentitySnapshotKey,
} from "../../domain/ids.ts";
import type { SourceVersionContractFingerprint } from "../../domain/migration-contract.ts";
import {
  encodeSourceIdentityKey,
  type SourceItemInput,
  type SourceLookupStrategy,
} from "../../domain/source.ts";
import type { AnySource } from "../../services/source.ts";

export const InMemorySourceCursor = Schema.Struct({
  offset: Schema.Int,
});

export type InMemorySourceCursor = typeof InMemorySourceCursor.Type;

interface InMemorySourceBaseOptions<
  A,
  IdentityKey extends SourceIdentitySnapshotKey,
> {
  readonly batchSize?: number;
  readonly identity: SourceIdentityDefinition<IdentityKey>;
  readonly items: readonly SourceItemInput<A, IdentityKey>[];
  readonly lookupStrategy?: SourceLookupStrategy;
  readonly sourceIdentityContractFingerprint?: SourceIdentityContractFingerprint;
  readonly sourceSchema: Schema.Codec<A, unknown, never, never>;
  readonly sourceVersionContractFingerprint?: SourceVersionContractFingerprint;
  readonly state?: InMemorySourceState;
  readonly transientFailures?: InMemorySourceTransientFailures;
}

export interface InMemorySourceOptions<
  A,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> extends InMemorySourceBaseOptions<A, IdentityKey> {}

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

const invalidBatchSizeError = (batchSize: number): SourceError =>
  new SourceError({
    message: "In-memory source batchSize must be a positive integer",
    cause: { batchSize },
  });

const transientSourceError = (operation: string): SourceError =>
  new SourceError({
    message: `In-memory source ${operation} failed transiently`,
  });

const makeImplementation = <A, IdentityKey extends SourceIdentitySnapshotKey>(
  options: InMemorySourceBaseOptions<A, IdentityKey>,
  identityDefinition: SourceIdentityDefinition<IdentityKey>
): SourceImplementation<A, InMemorySourceCursor, IdentityKey, A> => {
  const items = options.items;
  const batchSize = options.batchSize ?? items.length;
  const lookupStrategy = options.lookupStrategy ?? "direct";
  const state = options.state ?? makeState();
  let remainingReadFailures = options.transientFailures?.read ?? 0;
  let remainingReadByIdentityFailures =
    options.transientFailures?.readByIdentity ?? 0;

  const countTotal = Effect.fn("InMemorySource.countTotal")(() =>
    Effect.succeed(items.length)
  );

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
    identity: SourceIdentity<IdentityKey>
  ) {
    state.readByIdentityAttempts += 1;

    if (remainingReadByIdentityFailures > 0) {
      remainingReadByIdentityFailures -= 1;
      return yield* transientSourceError("readByIdentity");
    }

    for (const item of items) {
      const encodedIdentity = yield* encodeSourceIdentityKey(
        identityDefinition,
        item.identityKey
      );

      if (encodedIdentity === identity.encoded) {
        return item;
      }
    }

    return null;
  });

  return {
    countTotal,
    lookupStrategy,
    read,
    readByIdentity,
  };
};

const make = <A, IdentityKey extends SourceIdentitySnapshotKey>(
  options: InMemorySourceOptions<A, IdentityKey>
): ConfiguredSource<A, InMemorySourceCursor, IdentityKey, unknown> => {
  return Source.make({
    cursorSchema: InMemorySourceCursor,
    identity: options.identity,
    make: () => makeImplementation(options, options.identity),
    sourceSchema: options.sourceSchema,
    ...(options.sourceIdentityContractFingerprint === undefined
      ? {}
      : {
          sourceIdentityContractFingerprint:
            options.sourceIdentityContractFingerprint,
        }),
    ...(options.sourceVersionContractFingerprint === undefined
      ? {}
      : {
          sourceVersionContractFingerprint:
            options.sourceVersionContractFingerprint,
        }),
  });
};

const makeLayer = <A, IdentityKey extends SourceIdentitySnapshotKey>(
  options: InMemorySourceOptions<A, IdentityKey>
): Layer.Layer<AnySource> => make(options).layer;

export const InMemorySource = {
  layer: makeLayer,
  make,
  makeState,
} as const;
