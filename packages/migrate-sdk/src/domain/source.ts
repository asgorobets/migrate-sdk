import {
  type SourceIdentity,
  type SourceIdentityInput,
  type SourceVersion,
  type SourceVersionInput,
  toSourceIdentity,
  toSourceVersion,
} from "./ids.ts";

export interface SourceItem<A> {
  readonly identity: SourceIdentity;
  readonly item: A;
  readonly version?: SourceVersion;
}

export interface SourceItemInput<A> {
  readonly identity: SourceIdentityInput;
  readonly item: A;
  readonly version?: SourceVersionInput;
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

export interface SourceReadResult<A, Cursor> {
  readonly items: readonly SourceItem<A>[];
  readonly nextCursor?: Cursor;
}

export type SourceLookupStrategy = "direct" | "scan";
