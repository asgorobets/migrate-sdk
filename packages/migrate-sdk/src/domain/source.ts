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
