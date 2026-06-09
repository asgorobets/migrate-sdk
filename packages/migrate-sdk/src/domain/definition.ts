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

export interface ConfiguredSourcePlugin<Source, Cursor> {
  readonly layer: Layer.Layer<AnySourcePlugin>;
  readonly sourceSchema: Schema.Codec<Source, unknown, never, never>;
  readonly [configuredSourcePluginTypeId]: {
    readonly cursor: Cursor;
    readonly source: Source;
  };
}

export interface SourcePluginImplementation<Source, Cursor> {
  readonly lookupStrategy: SourceLookupStrategy;
  readonly read: (
    cursor: Cursor | null
  ) => Effect.Effect<SourceReadResultInput<Source, Cursor>, SourcePluginError>;
  readonly readByIdentity: (
    identity: SourceIdentityInput
  ) => Effect.Effect<SourceItemInput<Source> | null, SourcePluginError>;
}

export interface SourcePluginInput<Source, Cursor>
  extends SourcePluginImplementation<Source, Cursor> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly sourceSchema: Schema.Codec<Source, unknown, never, never>;
}

export interface SourcePluginFactoryInput<Source, Cursor> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly make: () => SourcePluginImplementation<Source, Cursor>;
  readonly sourceSchema: Schema.Codec<Source, unknown, never, never>;
}

export interface SourceReadResultInput<Source, Cursor> {
  readonly items: readonly SourceItemInput<Source>[];
  readonly nextCursor?: Cursor | undefined;
}

export const defineSourcePlugin = <Source, Cursor>(
  input:
    | SourcePluginFactoryInput<Source, Cursor>
    | SourcePluginInput<Source, Cursor>
): ConfiguredSourcePlugin<Source, Cursor> => {
  const makeImplementation =
    "make" in input
      ? input.make
      : () => ({
          lookupStrategy: input.lookupStrategy,
          read: input.read,
          readByIdentity: input.readByIdentity,
        });

  return {
    [configuredSourcePluginTypeId]: undefined as never,
    layer: Layer.sync(SourcePluginService, (): SourcePlugin<Source, Cursor> => {
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
    }),
    sourceSchema: input.sourceSchema,
  };
};

const normalizeSourceReadResult = <Source, Cursor>(
  result: SourceReadResultInput<Source, Cursor>
): SourceReadResult<Source, Cursor> => ({
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
  readonly source: ConfiguredSourcePlugin<Source, Cursor>;
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
> extends Omit<
    MigrationDefinition<
      Source,
      Command,
      PipelineError,
      Cursor,
      RollbackPipelineError
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
>(
  definition: MigrationDefinitionInput<
    Source,
    Command,
    PipelineError,
    Cursor,
    RollbackPipelineError
  >
): MigrationDefinition<
  Source,
  Command,
  PipelineError,
  Cursor,
  RollbackPipelineError
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
