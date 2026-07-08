import { Effect, type Schema } from "effect";
import type {
  SourcePayloadSchema,
  SourceReadResultInput,
} from "../domain/definition.ts";
import { SourceError } from "../domain/errors.ts";
import type {
  SourceIdentityDefinition,
  SourceIdentitySnapshotKey,
  SourceIdentityTarget,
} from "../domain/ids.ts";
import type {
  SourceItem,
  SourceItemTotal,
  SourceLookupStrategy,
  SourceReadResult,
} from "../domain/source.ts";
import {
  makeSourceItemEffect,
  normalizeSourceItemTotalInput,
  type SourceItemInput,
  type SourceItemTotalInput,
} from "../domain/source.ts";

export interface SourceRuntime<
  Payload,
  Cursor,
  EncodedPayload = Payload,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> {
  readonly countTotal?: () => Effect.Effect<SourceItemTotal, SourceError>;
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly identity: SourceIdentityDefinition<IdentityKey>;
  readonly lookupStrategy: SourceLookupStrategy;
  readonly read: (
    cursor: Cursor | null
  ) => Effect.Effect<
    SourceReadResult<EncodedPayload, Cursor, IdentityKey>,
    SourceError
  >;
  readonly readByIdentity: (
    identity: SourceIdentityTarget<IdentityKey>
  ) => Effect.Effect<
    SourceItem<EncodedPayload, IdentityKey> | null,
    SourceError
  >;
  readonly sourceSchema: SourcePayloadSchema<Payload, EncodedPayload>;
}

export type Source<
  Payload,
  Cursor,
  EncodedPayload = Payload,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> = SourceRuntime<Payload, Cursor, EncodedPayload, IdentityKey>;

export interface SourceRuntimeImplementation<
  EncodedPayload,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> {
  readonly countTotal?: () => Effect.Effect<SourceItemTotalInput, SourceError>;
  readonly lookupStrategy: SourceLookupStrategy;
  readonly read: (
    cursor: Cursor | null
  ) => Effect.Effect<
    SourceReadResultInput<EncodedPayload, Cursor, IdentityKey>,
    SourceError
  >;
  readonly readByIdentity: (
    identity: SourceIdentityTarget<IdentityKey>
  ) => Effect.Effect<
    SourceItemInput<EncodedPayload, IdentityKey> | null,
    SourceError
  >;
}

export interface SourceRuntimeInput<
  Payload,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  EncodedPayload = Payload,
> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly identity: SourceIdentityDefinition<IdentityKey>;
  readonly implementation: SourceRuntimeImplementation<
    EncodedPayload,
    Cursor,
    IdentityKey
  >;
  readonly sourceSchema: SourcePayloadSchema<Payload, EncodedPayload>;
}

export const makeSourceRuntime = <
  Payload,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  EncodedPayload = Payload,
>(
  input: SourceRuntimeInput<Payload, Cursor, IdentityKey, EncodedPayload>
): SourceRuntime<Payload, Cursor, EncodedPayload, IdentityKey> => {
  const implementation = input.implementation;
  const countTotal = implementation.countTotal;

  return {
    cursorSchema: input.cursorSchema,
    identity: input.identity,
    lookupStrategy: implementation.lookupStrategy,
    read: (cursor) =>
      implementation
        .read(cursor)
        .pipe(
          Effect.flatMap((result) =>
            normalizeSourceReadResult(result, input.identity)
          )
        ),
    readByIdentity: (identity) =>
      implementation
        .readByIdentity(identity)
        .pipe(
          Effect.flatMap((sourceItem) =>
            sourceItem === null
              ? Effect.succeed(null)
              : normalizeSourceLookupResult(
                  sourceItem,
                  input.identity,
                  identity
                )
          )
        ),
    ...(countTotal === undefined
      ? {}
      : {
          countTotal: () =>
            countTotal().pipe(Effect.flatMap(normalizeSourceItemTotalInput)),
        }),
    sourceSchema: input.sourceSchema,
  };
};

const normalizeSourceReadResult = <
  EncodedPayload,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  result: SourceReadResultInput<EncodedPayload, Cursor, IdentityKey>,
  identity: SourceIdentityDefinition<IdentityKey>
): Effect.Effect<
  SourceReadResult<EncodedPayload, Cursor, IdentityKey>,
  SourceError
> =>
  Effect.forEach(result.items, (item) =>
    normalizeSourceItemInput(item, identity)
  ).pipe(
    Effect.map((items) => ({
      items,
      ...(result.nextCursor === undefined
        ? {}
        : { nextCursor: result.nextCursor }),
    }))
  );

const normalizeSourceLookupResult = <
  EncodedPayload,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  item: SourceItemInput<EncodedPayload, IdentityKey>,
  identity: SourceIdentityDefinition<IdentityKey>,
  expectedIdentity: SourceIdentityTarget<IdentityKey>
): Effect.Effect<SourceItem<EncodedPayload, IdentityKey>, SourceError> =>
  normalizeSourceItemInput(item, identity).pipe(
    Effect.flatMap((sourceItem) =>
      sourceItem.identity.encoded === expectedIdentity.encoded
        ? Effect.succeed(sourceItem)
        : Effect.fail(
            new SourceError({
              message:
                "Source identity lookup returned a different Source Identity",
              cause: {
                requestedSourceIdentity: expectedIdentity.encoded,
                returnedSourceIdentity: sourceItem.identity.encoded,
              },
            })
          )
    )
  );

const normalizeSourceItemInput = <
  EncodedPayload,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  item: SourceItemInput<EncodedPayload, IdentityKey>,
  identity: SourceIdentityDefinition<IdentityKey>
): Effect.Effect<SourceItem<EncodedPayload, IdentityKey>, SourceError> =>
  makeSourceItemEffect(item, identity);
