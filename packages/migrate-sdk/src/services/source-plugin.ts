import { Effect, type Schema } from "effect";
import { Service } from "effect/Context";
import type { SourcePayloadSchema } from "../domain/definition.ts";
import type { SourcePluginError } from "../domain/errors.ts";
import type {
  SourceIdentityDefinition,
  SourceIdentitySnapshotKey,
  SourceIdentityTarget,
} from "../domain/ids.ts";
import type {
  SourceItem,
  SourceItemTotal,
  SourceLookupStrategy,
  SourceReadResult,
} from "../domain/source.ts";

export interface SourcePlugin<
  A,
  Cursor,
  SourceInput = A,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> {
  readonly countTotal?: () => Effect.Effect<SourceItemTotal, SourcePluginError>;
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly identity: SourceIdentityDefinition<IdentityKey>;
  readonly lookupStrategy: SourceLookupStrategy;
  readonly read: (
    cursor: Cursor | null
  ) => Effect.Effect<
    SourceReadResult<SourceInput, Cursor, IdentityKey>,
    SourcePluginError
  >;
  readonly readByIdentity: (
    identity: SourceIdentityTarget<IdentityKey>
  ) => Effect.Effect<
    SourceItem<SourceInput, IdentityKey> | null,
    SourcePluginError
  >;
  readonly sourceSchema: SourcePayloadSchema<A, SourceInput>;
}

// biome-ignore lint/suspicious/noExplicitAny: Source, cursor, source input, and identity key are existential at the service boundary.
export type AnySourcePlugin = SourcePlugin<any, any, any, any>;

export const SourcePlugin = Service<AnySourcePlugin>(
  "@migrate-sdk/SourcePlugin"
);

export const getSourcePlugin = <
  A,
  Cursor,
  SourceInput = A,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
>() =>
  Effect.map(
    SourcePlugin,
    (source) => source as SourcePlugin<A, Cursor, SourceInput, IdentityKey>
  );
