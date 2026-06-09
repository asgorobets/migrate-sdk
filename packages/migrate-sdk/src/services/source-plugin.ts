import { Effect, type Schema } from "effect";
import { Service } from "effect/Context";
import type { SourcePayloadSchema } from "../domain/definition.ts";
import type { SourcePluginError } from "../domain/errors.ts";
import type { SourceIdentity } from "../domain/ids.ts";
import type {
  SourceItem,
  SourceLookupStrategy,
  SourceReadResult,
} from "../domain/source.ts";

export interface SourcePlugin<A, Cursor, SourceInput = A> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly lookupStrategy: SourceLookupStrategy;
  readonly read: (
    cursor: Cursor | null
  ) => Effect.Effect<SourceReadResult<SourceInput, Cursor>, SourcePluginError>;
  readonly readByIdentity: (
    identity: SourceIdentity
  ) => Effect.Effect<SourceItem<SourceInput> | null, SourcePluginError>;
  readonly sourceSchema: SourcePayloadSchema<A, SourceInput>;
}

// biome-ignore lint/suspicious/noExplicitAny: Source and cursor are existential at the service boundary.
export type AnySourcePlugin = SourcePlugin<any, any, any>;

export const SourcePlugin = Service<AnySourcePlugin>(
  "@migrate-sdk/SourcePlugin"
);

export const getSourcePlugin = <A, Cursor, SourceInput = A>() =>
  Effect.map(
    SourcePlugin,
    (source) => source as SourcePlugin<A, Cursor, SourceInput>
  );
