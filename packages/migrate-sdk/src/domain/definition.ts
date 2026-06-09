import { Effect, Layer, type Schema } from "effect";
import type { DestinationPlugin } from "../services/destination-plugin.ts";
import type { MigrationReferenceLookup } from "../services/migration-reference-lookup.ts";
import type { MigrationStore } from "../services/migration-store.ts";
import {
  type AnySourcePlugin,
  type SourcePlugin,
  SourcePlugin as SourcePluginService,
} from "../services/source-plugin.ts";
import type {
  DefinedDestinationCommands,
  DestinationCommand,
  DestinationCommandPlan,
} from "./destination.ts";
import type {
  DestinationPluginError,
  MigrationStoreError,
  SkipItem,
  SourcePluginError,
} from "./errors.ts";
import {
  type MigrationDefinitionId,
  type MigrationDefinitionIdInput,
  type MigrationRunId,
  type SourceIdentity,
  type SourceIdentityInput,
  toMigrationDefinitionId,
} from "./ids.ts";
import type { PipelineContext } from "./pipeline.ts";
import type { RollbackPipeline } from "./rollback.ts";
import type {
  SourceItem,
  SourceItemInput,
  SourceLookupStrategy,
  SourceReadResult,
} from "./source.ts";
import { makeSourceItem } from "./source.ts";

const configuredSourcePluginTypeId: unique symbol = Symbol.for(
  "@migrate-sdk/ConfiguredSourcePlugin"
);

export type SourcePayloadSchema<Source, SourceInput = unknown> = Schema.Codec<
  Source,
  SourceInput,
  never,
  never
>;

export interface ConfiguredSourcePlugin<
  Source,
  Cursor,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
> {
  readonly layer: Layer.Layer<
    AnySourcePlugin,
    SourceLayerError,
    SourceRequirements
  >;
  readonly provide: <
    ProvidedRequirements,
    ProvidedError,
    RemainingRequirements,
  >(
    layer: Layer.Layer<
      ProvidedRequirements,
      ProvidedError,
      RemainingRequirements
    >
  ) => ConfiguredSourcePlugin<
    Source,
    Cursor,
    SourceInput,
    SourceLayerError | ProvidedError,
    RemainingRequirements | Exclude<SourceRequirements, ProvidedRequirements>
  >;
  readonly sourceSchema: SourcePayloadSchema<Source, SourceInput>;
  readonly [configuredSourcePluginTypeId]: {
    readonly cursor: Cursor;
    readonly source: Source;
    readonly sourceLayerError: SourceLayerError;
    readonly sourceRequirements: SourceRequirements;
    readonly sourceInput: SourceInput;
  };
}

export interface SourcePluginImplementation<
  Source,
  Cursor,
  SourceInput = Source,
> {
  readonly lookupStrategy: SourceLookupStrategy;
  readonly read: (
    cursor: Cursor | null
  ) => Effect.Effect<
    SourceReadResultInput<SourceInput, Cursor>,
    SourcePluginError
  >;
  readonly readByIdentity: (
    identity: SourceIdentityInput
  ) => Effect.Effect<SourceItemInput<SourceInput> | null, SourcePluginError>;
}

export interface SourcePluginInput<Source, Cursor, SourceInput = Source>
  extends SourcePluginImplementation<Source, Cursor, SourceInput> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly sourceSchema: SourcePayloadSchema<Source, SourceInput>;
}

export interface SourcePluginFactoryInput<
  Source,
  Cursor,
  SourceInput = Source,
> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly make: () => SourcePluginImplementation<Source, Cursor, SourceInput>;
  readonly sourceSchema: SourcePayloadSchema<Source, SourceInput>;
}

export interface SourcePluginLayerInput<
  Source,
  _Cursor,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
> {
  readonly layer: Layer.Layer<
    AnySourcePlugin,
    SourceLayerError,
    SourceRequirements
  >;
  readonly sourceSchema: SourcePayloadSchema<Source, SourceInput>;
}

export interface SourceReadResultInput<SourceInput, Cursor> {
  readonly items: readonly SourceItemInput<SourceInput>[];
  readonly nextCursor?: Cursor | undefined;
}

const makeConfiguredSourcePlugin = <
  Source,
  Cursor,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
>(
  input: SourcePluginLayerInput<
    Source,
    Cursor,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >
): ConfiguredSourcePlugin<
  Source,
  Cursor,
  SourceInput,
  SourceLayerError,
  SourceRequirements
> => ({
  [configuredSourcePluginTypeId]: undefined as never,
  layer: input.layer,
  provide: <ProvidedRequirements, ProvidedError, RemainingRequirements>(
    layer: Layer.Layer<
      ProvidedRequirements,
      ProvidedError,
      RemainingRequirements
    >
  ) =>
    makeConfiguredSourcePlugin<
      Source,
      Cursor,
      SourceInput,
      SourceLayerError | ProvidedError,
      RemainingRequirements | Exclude<SourceRequirements, ProvidedRequirements>
    >({
      layer: input.layer.pipe(Layer.provide(layer)),
      sourceSchema: input.sourceSchema,
    }),
  sourceSchema: input.sourceSchema,
});

export const defineSourcePlugin = <Source, Cursor, SourceInput = Source>(
  input:
    | SourcePluginFactoryInput<Source, Cursor, SourceInput>
    | SourcePluginInput<Source, Cursor, SourceInput>
): ConfiguredSourcePlugin<Source, Cursor, SourceInput> => {
  const makeImplementation =
    "make" in input
      ? input.make
      : () => ({
          lookupStrategy: input.lookupStrategy,
          read: input.read,
          readByIdentity: input.readByIdentity,
        });

  return makeConfiguredSourcePlugin({
    layer: Layer.sync(
      SourcePluginService,
      (): SourcePlugin<Source, Cursor, SourceInput> => {
        const implementation = makeImplementation();

        return {
          cursorSchema: input.cursorSchema,
          lookupStrategy: implementation.lookupStrategy,
          read: (cursor) =>
            implementation
              .read(cursor)
              .pipe(Effect.map((result) => normalizeSourceReadResult(result))),
          readByIdentity: (identity) =>
            implementation
              .readByIdentity(identity)
              .pipe(
                Effect.map((sourceItem) =>
                  sourceItem === null ? null : makeSourceItem(sourceItem)
                )
              ),
          sourceSchema: input.sourceSchema,
        };
      }
    ),
    sourceSchema: input.sourceSchema,
  });
};

export const defineSourcePluginLayer = <
  Source,
  Cursor,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
>(
  input: SourcePluginLayerInput<
    Source,
    Cursor,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >
): ConfiguredSourcePlugin<
  Source,
  Cursor,
  SourceInput,
  SourceLayerError,
  SourceRequirements
> => makeConfiguredSourcePlugin(input);

const normalizeSourceReadResult = <SourceInput, Cursor>(
  result: SourceReadResultInput<SourceInput, Cursor>
): SourceReadResult<SourceInput, Cursor> => ({
  items: result.items.map(makeSourceItem),
  ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
});

export interface ConfiguredDestinationPlugin<
  Command extends DestinationCommand,
> {
  readonly commandDefinitions: DefinedDestinationCommands<Command>;
  readonly layer: Layer.Layer<DestinationPlugin, DestinationPluginError>;
}

export type DestinationRetryStrategy = <A>(
  effect: Effect.Effect<A, DestinationPluginError>
) => Effect.Effect<A, DestinationPluginError>;

export type SourceRetryStrategy = <A>(
  effect: Effect.Effect<A, SourcePluginError>
) => Effect.Effect<A, SourcePluginError>;

export interface DestinationStubInput {
  readonly sourceIdentity: SourceIdentity;
}

export interface DestinationStubContext {
  readonly definitionId: MigrationDefinitionId;
  readonly runId: MigrationRunId;
}

export interface MigrationDefinition<
  Source,
  Command extends DestinationCommand,
  PipelineError = never,
  Cursor = unknown,
  RollbackPipelineError = PipelineError,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
> {
  readonly dependencies?: MigrationDefinitionDependencies;
  readonly dependsOn?: readonly MigrationDefinitionId[];
  readonly destination: ConfiguredDestinationPlugin<Command>;
  readonly destinationRetry?: DestinationRetryStrategy;
  readonly id: MigrationDefinitionId;
  readonly pipeline: (
    source: SourceItem<Source>,
    context: PipelineContext
  ) =>
    | DestinationCommandPlan<Command>
    | Effect.Effect<
        DestinationCommandPlan<Command>,
        PipelineError | SkipItem,
        MigrationReferenceLookup
      >;
  readonly rollback?: RollbackPipeline<Command, RollbackPipelineError>;
  readonly source: ConfiguredSourcePlugin<
    Source,
    Cursor,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >;
  readonly sourceCursorRetry?: SourceRetryStrategy;
  readonly sourceLookupRetry?: SourceRetryStrategy;
  readonly store: Layer.Layer<MigrationStore, MigrationStoreError>;
  readonly stub?: (
    input: DestinationStubInput,
    context: DestinationStubContext
  ) =>
    | DestinationCommandPlan<Command>
    | Effect.Effect<DestinationCommandPlan<Command>, PipelineError | SkipItem>;
}

export interface MigrationDefinitionDependencies {
  readonly optional: readonly MigrationDefinitionId[];
  readonly required: readonly MigrationDefinitionId[];
}

export interface MigrationDefinitionDependenciesInput {
  readonly optional?: readonly MigrationDefinitionIdInput[];
  readonly required?: readonly MigrationDefinitionIdInput[];
}

export interface MigrationDefinitionInput<
  Source,
  Command extends DestinationCommand,
  PipelineError = never,
  Cursor = unknown,
  RollbackPipelineError = PipelineError,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
> extends Omit<
    MigrationDefinition<
      Source,
      Command,
      PipelineError,
      Cursor,
      RollbackPipelineError,
      SourceInput,
      SourceLayerError,
      SourceRequirements
    >,
    "dependencies" | "dependsOn" | "id"
  > {
  readonly dependencies?: MigrationDefinitionDependenciesInput;
  readonly dependsOn?: readonly MigrationDefinitionIdInput[];
  readonly id: MigrationDefinitionIdInput;
}

const normalizeMigrationDefinitionIds = (
  values: readonly MigrationDefinitionIdInput[]
): readonly MigrationDefinitionId[] => {
  const ids: MigrationDefinitionId[] = [];
  const seenIds = new Set<MigrationDefinitionId>();

  for (const value of values) {
    const id = toMigrationDefinitionId(value);

    if (seenIds.has(id)) {
      continue;
    }

    seenIds.add(id);
    ids.push(id);
  }

  return ids;
};

export const defineMigration = <
  Source,
  Command extends DestinationCommand,
  PipelineError = never,
  Cursor = unknown,
  RollbackPipelineError = PipelineError,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
>(
  definition: MigrationDefinitionInput<
    Source,
    Command,
    PipelineError,
    Cursor,
    RollbackPipelineError,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >
): MigrationDefinition<
  Source,
  Command,
  PipelineError,
  Cursor,
  RollbackPipelineError,
  SourceInput,
  SourceLayerError,
  SourceRequirements
> => {
  const { dependencies, dependsOn, id, ...rest } = definition;
  const requiredDependencies = normalizeMigrationDefinitionIds([
    ...(dependencies?.required ?? []),
    ...(dependsOn ?? []),
  ]);
  const optionalDependencies = normalizeMigrationDefinitionIds(
    dependencies?.optional ?? []
  );
  const hasDependencies =
    requiredDependencies.length > 0 || optionalDependencies.length > 0;

  return {
    ...rest,
    id: toMigrationDefinitionId(id),
    ...(hasDependencies
      ? {
          dependencies: {
            optional: optionalDependencies,
            required: requiredDependencies,
          },
        }
      : {}),
    ...(requiredDependencies.length === 0
      ? {}
      : { dependsOn: requiredDependencies }),
  };
};
