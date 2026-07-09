import { Effect, Schema } from "effect";
import { SourceError } from "./errors.ts";
import {
  type EncodedSourceIdentity,
  SourceIdentity,
  type SourceIdentityDefinition,
  type SourceIdentitySnapshotKey,
  type SourceVersion,
  type SourceVersionInput,
  toSourceVersion,
} from "./ids.ts";

export interface SourceItem<
  Payload,
  Key extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> {
  readonly identity: SourceIdentity<Key>;
  readonly item: Payload;
  readonly version: SourceVersion;
}

export interface SourceItemInput<
  Payload,
  Key extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> {
  readonly identityKey: Key;
  readonly item: Payload;
  readonly version: SourceVersionInput;
}

export const makeSourceItem = <Payload, Key extends SourceIdentitySnapshotKey>(
  input: SourceItemInput<Payload, Key>,
  identity: SourceIdentityDefinition<Key>
): SourceItem<Payload, Key> => ({
  identity: SourceIdentity.fromKey(identity, input.identityKey),
  version: toSourceVersion(input.version),
  item: input.item,
});

export const encodeSourceIdentityKey = <Key extends SourceIdentitySnapshotKey>(
  identity: SourceIdentityDefinition<Key>,
  key: Key
): Effect.Effect<EncodedSourceIdentity, SourceError> =>
  Effect.try({
    try: () => SourceIdentity.fromKey(identity, key).encoded,
    catch: (cause) =>
      new SourceError({
        message: "Source identity key did not match Source Identity Schema",
        cause,
      }),
  });

export const makeSourceItemEffect = <
  Payload,
  Key extends SourceIdentitySnapshotKey,
>(
  input: SourceItemInput<Payload, Key>,
  identity: SourceIdentityDefinition<Key>
): Effect.Effect<SourceItem<Payload, Key>, SourceError> =>
  Effect.try({
    try: () => makeSourceItem(input, identity),
    catch: (cause) =>
      new SourceError({
        message:
          "Source item metadata did not match Source Identity or Source Version schema",
        cause,
      }),
  });

export interface SourceReadResult<
  Payload,
  Cursor,
  Key extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> {
  readonly items: readonly SourceItem<Payload, Key>[];
  readonly nextCursor?: Cursor;
}

export type SourceLookupStrategy = "direct" | "scan";

export type SourceItemTotalUnknownReason =
  | "disabled"
  | "failed"
  | "too-expensive"
  | "unsupported";

export type SourceItemTotalLowerBoundReason = "capped";

export type SourceItemTotal =
  | {
      readonly count: number;
      readonly kind: "known";
    }
  | {
      readonly kind: "lower-bound";
      readonly message?: string;
      readonly minimum: number;
      readonly reason: SourceItemTotalLowerBoundReason;
    }
  | {
      readonly cause?: unknown;
      readonly kind: "unknown";
      readonly message?: string;
      readonly reason: SourceItemTotalUnknownReason;
    };

export type SourceItemTotalInput = number | SourceItemTotal;

const sourceItemTotalCountError = (count: number) =>
  new SourceError({
    message: "Source Item total must be a non-negative integer",
    cause: { count },
  });

const makeKnownSourceItemTotal = (
  count: number
): Extract<SourceItemTotal, { readonly kind: "known" }> => {
  if (!Number.isInteger(count) || count < 0) {
    throw sourceItemTotalCountError(count);
  }

  return {
    count,
    kind: "known",
  };
};

const makeLowerBoundSourceItemTotal = (
  minimum: number,
  input: Omit<
    Extract<SourceItemTotal, { readonly kind: "lower-bound" }>,
    "kind" | "minimum"
  >
): Extract<SourceItemTotal, { readonly kind: "lower-bound" }> => {
  if (!Number.isInteger(minimum) || minimum < 0) {
    throw sourceItemTotalCountError(minimum);
  }

  return {
    kind: "lower-bound",
    minimum,
    ...input,
  };
};

const makeUnknownSourceItemTotal = (
  input: Omit<Extract<SourceItemTotal, { readonly kind: "unknown" }>, "kind">
): SourceItemTotal => ({
  kind: "unknown",
  ...input,
});

export const SourceItemTotal = {
  known: makeKnownSourceItemTotal,
  lowerBound: makeLowerBoundSourceItemTotal,
  unknown: makeUnknownSourceItemTotal,
} as const;

export const normalizeSourceItemTotalCount = (
  count: number
): Effect.Effect<number, SourceError> =>
  Effect.try({
    try: () => SourceItemTotal.known(count).count,
    catch: (cause) =>
      Schema.is(SourceError)(cause) ? cause : sourceItemTotalCountError(count),
  });

export const sourceItemTotalFromCount = (
  count: number
): Effect.Effect<SourceItemTotal, SourceError> =>
  normalizeSourceItemTotalCount(count).pipe(
    Effect.map((normalizedCount) => SourceItemTotal.known(normalizedCount))
  );

export const normalizeSourceItemTotal = (
  total: SourceItemTotal
): Effect.Effect<SourceItemTotal, SourceError> => {
  switch (total.kind) {
    case "known":
      return sourceItemTotalFromCount(total.count);
    case "lower-bound":
      return normalizeSourceItemTotalCount(total.minimum).pipe(
        Effect.map((minimum) =>
          SourceItemTotal.lowerBound(minimum, {
            ...(total.message === undefined ? {} : { message: total.message }),
            reason: total.reason,
          })
        )
      );
    case "unknown":
      return Effect.succeed(SourceItemTotal.unknown(total));
    default: {
      const exhaustive: never = total;
      return exhaustive;
    }
  }
};

export const normalizeSourceItemTotalInput = (
  total: SourceItemTotalInput
): Effect.Effect<SourceItemTotal, SourceError> =>
  typeof total === "number"
    ? sourceItemTotalFromCount(total)
    : normalizeSourceItemTotal(total);

export const capSourceItemTotal = (
  total: SourceItemTotal,
  itemLimit: number | undefined
): SourceItemTotal => {
  if (itemLimit === undefined) {
    return total;
  }

  if (total.kind === "known") {
    return SourceItemTotal.known(Math.min(total.count, itemLimit));
  }

  if (total.kind === "lower-bound" && total.minimum >= itemLimit) {
    return SourceItemTotal.known(itemLimit);
  }

  return total;
};
