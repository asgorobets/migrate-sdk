import { Effect, type Schema } from "effect";
import { Service } from "effect/Context";
import type { SourcePluginError } from "../domain/errors.ts";
import type { SourceIdentity } from "../domain/ids.ts";
import type {
  SourceItem,
  SourceLookupStrategy,
  SourceReadResult,
} from "../domain/source.ts";

export interface SourcePlugin<A, Cursor> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly lookupStrategy: SourceLookupStrategy;
  readonly sourceSchema: Schema.Codec<A, unknown, never, never>;
  readonly read: (
    cursor: Cursor | null
  ) => Effect.Effect<SourceReadResult<A, Cursor>, SourcePluginError>;
  readonly readByIdentity: (
    identity: SourceIdentity
  ) => Effect.Effect<SourceItem<A> | null, SourcePluginError>;
}

// biome-ignore lint/suspicious/noExplicitAny: Source and cursor are existential at the service boundary.
export type AnySourcePlugin = SourcePlugin<any, any>;

export const SourcePlugin = Service<AnySourcePlugin>(
  "@migrate-sdk/SourcePlugin"
);

export const getSourcePlugin = <A, Cursor>() =>
  Effect.map(SourcePlugin, (source) => source as SourcePlugin<A, Cursor>);
