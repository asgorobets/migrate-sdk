import { Effect, type Schema } from "effect";
import { Service } from "effect/Context";
import type { SourcePayloadSchema } from "../domain/definition.ts";
import type { SourceError } from "../domain/errors.ts";
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

export interface Source<
  A,
  Cursor,
  SourceInput = A,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> {
  readonly countTotal?: () => Effect.Effect<SourceItemTotal, SourceError>;
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly identity: SourceIdentityDefinition<IdentityKey>;
  readonly lookupStrategy: SourceLookupStrategy;
  readonly read: (
    cursor: Cursor | null
  ) => Effect.Effect<
    SourceReadResult<SourceInput, Cursor, IdentityKey>,
    SourceError
  >;
  readonly readByIdentity: (
    identity: SourceIdentityTarget<IdentityKey>
  ) => Effect.Effect<SourceItem<SourceInput, IdentityKey> | null, SourceError>;
  readonly sourceSchema: SourcePayloadSchema<A, SourceInput>;
}

// biome-ignore lint/suspicious/noExplicitAny: Source, cursor, source input, and identity key are existential at the service boundary.
export type AnySource = Source<any, any, any, any>;

export const Source = Service<AnySource>("@migrate-sdk/Source");

export const getSource = <
  A,
  Cursor,
  SourceInput = A,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
>() =>
  Effect.map(
    Source,
    (source) => source as Source<A, Cursor, SourceInput, IdentityKey>
  );
