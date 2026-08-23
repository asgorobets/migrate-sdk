import {
  type EncodedSourceIdentity,
  SourceIdentity,
  type SourceIdentityDefinition,
  type SourceIdentitySnapshotKey,
} from "./ids.ts";

export type RunMode =
  | { readonly kind: "normal" }
  | { readonly kind: "failed" }
  | { readonly kind: "skipped" }
  | {
      readonly kind: "item";
      readonly encodedSourceIdentities: readonly [
        EncodedSourceIdentity,
        ...EncodedSourceIdentity[],
      ];
    };

export type RunModeInput<
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> =
  | { readonly kind: "normal" }
  | { readonly kind: "failed" }
  | { readonly kind: "skipped" }
  | {
      readonly kind: "item";
      readonly sourceIdentityKey: IdentityKey;
    };

export const normalRunMode: RunMode = { kind: "normal" };

export const makeRunMode = <IdentityKey extends SourceIdentitySnapshotKey>(
  identity: SourceIdentityDefinition<IdentityKey>,
  mode: RunModeInput<IdentityKey>
): RunMode => {
  if (mode.kind === "item") {
    return {
      kind: "item",
      encodedSourceIdentities: [
        SourceIdentity.fromKey(identity, mode.sourceIdentityKey).encoded,
      ],
    };
  }

  return mode;
};
