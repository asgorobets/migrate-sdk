import { Context, type Effect, type Layer } from "effect";
import type {
  AnyMigrationDefinition,
  MigrationDefinitionSource as ConfiguredMigrationDefinitionSource,
  ConfiguredSourceCursor,
  ConfiguredSourceEncodedPayload,
  ConfiguredSourceIdentityKey,
  ConfiguredSourcePayload,
  MigrationDefinition,
  MigrationDefinitionSourceImplementationError,
  MigrationDefinitionSourceRequirements,
} from "../domain/definition.ts";
import { makeConfiguredSourceLayer } from "../domain/definition.ts";
import type { SourceIdentitySnapshotKey } from "../domain/ids.ts";
import type { TrackingRecordContract } from "../domain/tracking.ts";
import type { SourceRuntime } from "./source.ts";

declare const migrationDefinitionSourceTypeId: unique symbol;

export interface MigrationDefinitionSourceService<
  Definition extends AnyMigrationDefinition,
> {
  readonly [migrationDefinitionSourceTypeId]: Definition;
}

type DefinitionConfiguredSource<Definition extends AnyMigrationDefinition> =
  ConfiguredMigrationDefinitionSource<Definition>;

export type MigrationDefinitionSourceRuntime<
  Definition extends AnyMigrationDefinition,
> = SourceRuntime<
  ConfiguredSourcePayload<DefinitionConfiguredSource<Definition>>,
  ConfiguredSourceCursor<DefinitionConfiguredSource<Definition>>,
  ConfiguredSourceEncodedPayload<DefinitionConfiguredSource<Definition>>,
  ConfiguredSourceIdentityKey<DefinitionConfiguredSource<Definition>>
>;

const sourceRuntimeService = <Definition extends AnyMigrationDefinition>(
  definition: Definition
) =>
  Context.Service<
    MigrationDefinitionSourceService<Definition>,
    MigrationDefinitionSourceRuntime<Definition>
  >(`@migrate-sdk/MigrationDefinitionSource/${definition.id}`);

const sourceRuntimeLayer = <Definition extends AnyMigrationDefinition>(
  definition: Definition
): Layer.Layer<
  MigrationDefinitionSourceService<Definition>,
  MigrationDefinitionSourceImplementationError<Definition>,
  MigrationDefinitionSourceRequirements<Definition>
> =>
  makeConfiguredSourceLayer(
    definition.source,
    sourceRuntimeService(definition)
  );

function getDefinitionSource<
  Payload,
  PipelineError,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  RollbackPipelineError,
  EncodedPayload,
  SourceImplementationError,
  SourceRequirements,
  TrackingContract extends TrackingRecordContract | undefined,
>(
  definition: MigrationDefinition<
    Payload,
    PipelineError,
    Cursor,
    IdentityKey,
    RollbackPipelineError,
    EncodedPayload,
    SourceImplementationError,
    SourceRequirements,
    TrackingContract
  >
): Effect.Effect<
  SourceRuntime<Payload, Cursor, EncodedPayload, IdentityKey>,
  never,
  MigrationDefinitionSourceService<
    MigrationDefinition<
      Payload,
      PipelineError,
      Cursor,
      IdentityKey,
      RollbackPipelineError,
      EncodedPayload,
      SourceImplementationError,
      SourceRequirements,
      TrackingContract
    >
  >
>;
function getDefinitionSource<Definition extends AnyMigrationDefinition>(
  definition: Definition
): Effect.Effect<
  MigrationDefinitionSourceRuntime<Definition>,
  never,
  MigrationDefinitionSourceService<Definition>
>;
function getDefinitionSource<Definition extends AnyMigrationDefinition>(
  definition: Definition
) {
  return sourceRuntimeService(definition);
}

export const MigrationDefinitionSource = {
  get: getDefinitionSource,
  layer: sourceRuntimeLayer,
} as const;
