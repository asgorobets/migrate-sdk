import {
  toSourceIdentity,
  type SourceIdentity,
  type SourceIdentityInput,
} from "./ids.ts";

export type RunMode =
  | { readonly kind: "normal" }
  | { readonly kind: "failed" }
  | { readonly kind: "skipped" }
  | { readonly kind: "item"; readonly sourceIdentity: SourceIdentity };

export type RunModeInput =
  | { readonly kind: "normal" }
  | { readonly kind: "failed" }
  | { readonly kind: "skipped" }
  | { readonly kind: "item"; readonly sourceIdentity: SourceIdentityInput };

export const normalRunMode: RunMode = { kind: "normal" };

export const makeRunMode = (mode: RunModeInput): RunMode => {
  if (mode.kind === "item") {
    return {
      kind: "item",
      sourceIdentity: toSourceIdentity(mode.sourceIdentity),
    };
  }

  return mode;
};
