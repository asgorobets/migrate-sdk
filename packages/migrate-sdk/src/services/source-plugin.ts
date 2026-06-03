import { Effect } from "effect";
import * as Context from "effect/Context";
import type { SourcePluginError } from "../domain/errors.ts";
import type { SourceCursor, SourceIdentity } from "../domain/ids.ts";
import type {
  SourceItem,
  SourceLookupStrategy,
  SourceReadResult,
} from "../domain/source.ts";

export interface SourcePlugin<A> {
  readonly lookupStrategy: SourceLookupStrategy;
  readonly read: (
    cursor: SourceCursor | null
  ) => Effect.Effect<SourceReadResult<A>, SourcePluginError>;
  readonly readByIdentity: (
    identity: SourceIdentity
  ) => Effect.Effect<SourceItem<A> | null, SourcePluginError>;
}

export type AnySourcePlugin = SourcePlugin<unknown>;

export const SourcePlugin =
  Context.Service<AnySourcePlugin>("@migrate-sdk/SourcePlugin");

export const getSourcePlugin = <A>() =>
  Effect.map(SourcePlugin, (source) => source as SourcePlugin<A>);
