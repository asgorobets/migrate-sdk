import {
  type EncodedSourceIdentity,
  type EncodedSourceIdentityInput,
  SourceIdentity,
  type SourceIdentityDefinition,
  type SourceIdentitySnapshotKey,
  toEncodedSourceIdentity,
} from "./ids.ts";

export type RunMode =
  | { readonly kind: "normal" }
  | { readonly kind: "failed" }
  | { readonly kind: "skipped" }
  | {
      readonly kind: "item";
      readonly encodedSourceIdentity: EncodedSourceIdentity;
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

export type EncodedRunModeInput =
  | { readonly kind: "normal" }
  | { readonly kind: "failed" }
  | { readonly kind: "skipped" }
  | {
      readonly kind: "item";
      readonly encodedSourceIdentity: EncodedSourceIdentityInput;
    };

export const normalRunMode: RunMode = { kind: "normal" };

export const makeRunMode = <IdentityKey extends SourceIdentitySnapshotKey>(
  identity: SourceIdentityDefinition<IdentityKey>,
  mode: RunModeInput<IdentityKey>
): RunMode => {
  if (mode.kind === "item") {
    return {
      kind: "item",
      encodedSourceIdentity: SourceIdentity.fromKey(
        identity,
        mode.sourceIdentityKey
      ).encoded,
    };
  }

  return mode;
};

export const makeEncodedRunMode = (mode: EncodedRunModeInput): RunMode => {
  if (mode.kind === "item") {
    return {
      kind: "item",
      encodedSourceIdentity: toEncodedSourceIdentity(
        mode.encodedSourceIdentity
      ),
    };
  }

  return mode;
};
