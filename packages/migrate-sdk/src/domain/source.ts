import {
  toSourceIdentity,
  toSourceVersion,
  type SourceCursor,
  type SourceIdentity,
  type SourceIdentityInput,
  type SourceVersion,
  type SourceVersionInput,
} from "./ids.ts";

export interface SourceItem<A> {
  readonly identity: SourceIdentity;
  readonly version?: SourceVersion;
  readonly item: A;
}

export interface SourceItemInput<A> {
  readonly identity: SourceIdentityInput;
  readonly version?: SourceVersionInput;
  readonly item: A;
}

export const makeSourceItem = <A>(
  input: SourceItemInput<A>
): SourceItem<A> => ({
  identity: toSourceIdentity(input.identity),
  ...(input.version === undefined
    ? {}
    : { version: toSourceVersion(input.version) }),
  item: input.item,
});

export interface SourceReadResult<A> {
  readonly items: ReadonlyArray<SourceItem<A>>;
  readonly nextCursor?: SourceCursor;
}

export type SourceLookupStrategy = "direct" | "scan";
