import { Effect } from "effect";
import { SourcePluginError } from "./errors.ts";
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
  A,
  Key extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> {
  readonly identity: SourceIdentity<Key>;
  readonly item: A;
  readonly version: SourceVersion;
}

export interface SourceItemInput<
  A,
  Key extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> {
  readonly identityKey: Key;
  readonly item: A;
  readonly version: SourceVersionInput;
}

export const makeSourceItem = <A, Key extends SourceIdentitySnapshotKey>(
  input: SourceItemInput<A, Key>,
  identity: SourceIdentityDefinition<Key>
): SourceItem<A, Key> => ({
  identity: SourceIdentity.fromKey(identity, input.identityKey),
  version: toSourceVersion(input.version),
  item: input.item,
});

export const encodeSourceIdentityKey = <Key extends SourceIdentitySnapshotKey>(
  identity: SourceIdentityDefinition<Key>,
  key: Key
): Effect.Effect<EncodedSourceIdentity, SourcePluginError> =>
  Effect.try({
    try: () => SourceIdentity.fromKey(identity, key).encoded,
    catch: (cause) =>
      new SourcePluginError({
        message: "Source identity key did not match Source Identity Schema",
        cause,
      }),
  });

export const makeSourceItemEffect = <A, Key extends SourceIdentitySnapshotKey>(
  input: SourceItemInput<A, Key>,
  identity: SourceIdentityDefinition<Key>
): Effect.Effect<SourceItem<A, Key>, SourcePluginError> =>
  Effect.try({
    try: () => makeSourceItem(input, identity),
    catch: (cause) =>
      new SourcePluginError({
        message:
          "Source item metadata did not match Source Identity or Source Version schema",
        cause,
      }),
  });

export interface SourceReadResult<
  A,
  Cursor,
  Key extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> {
  readonly items: readonly SourceItem<A, Key>[];
  readonly nextCursor?: Cursor;
}

export type SourceLookupStrategy = "direct" | "scan";

export type SourceItemTotalUnknownReason =
  | "disabled"
  | "failed"
  | "too-expensive"
  | "unsupported";

export type SourceItemTotal =
  | {
      readonly count: number;
      readonly kind: "known";
    }
  | {
      readonly cause?: unknown;
      readonly kind: "unknown";
      readonly message?: string;
      readonly reason: SourceItemTotalUnknownReason;
    };

const sourceItemTotalCountError = (count: number) =>
  new SourcePluginError({
    message: "Source Item total must be a non-negative integer",
    cause: { count },
  });

const makeKnownSourceItemTotal = (count: number): SourceItemTotal => {
  if (!Number.isInteger(count) || count < 0) {
    throw sourceItemTotalCountError(count);
  }

  return {
    count,
    kind: "known",
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
  unknown: makeUnknownSourceItemTotal,
} as const;

export const normalizeSourceItemTotal = (
  total: SourceItemTotal
): Effect.Effect<SourceItemTotal, SourcePluginError> =>
  total.kind === "known"
    ? Effect.try({
        try: () => SourceItemTotal.known(total.count),
        catch: (cause) =>
          cause instanceof SourcePluginError
            ? cause
            : sourceItemTotalCountError(total.count),
      })
    : Effect.succeed(SourceItemTotal.unknown(total));

export const capSourceItemTotal = (
  total: SourceItemTotal,
  itemLimit: number | undefined
): SourceItemTotal => {
  if (total.kind !== "known" || itemLimit === undefined) {
    return total;
  }

  return SourceItemTotal.known(Math.min(total.count, itemLimit));
};
