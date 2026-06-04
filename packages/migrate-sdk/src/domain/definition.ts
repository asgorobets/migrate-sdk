import { type Effect, Layer, type Schema } from "effect";
import type { DestinationPlugin } from "../services/destination-plugin.ts";
import type { MigrationStore } from "../services/migration-store.ts";
import {
  type AnySourcePlugin,
  type SourcePlugin,
  SourcePlugin as SourcePluginService,
} from "../services/source-plugin.ts";
import type { DestinationCommand } from "./destination.ts";
import type {
  DestinationPluginError,
  MigrationStoreError,
  SkipItem,
  SourcePluginError,
} from "./errors.ts";
import {
  type MigrationDefinitionId,
  type MigrationDefinitionIdInput,
  toMigrationDefinitionId,
} from "./ids.ts";
import type { PipelineContext } from "./pipeline.ts";
import type {
  SourceItem,
  SourceLookupStrategy,
  SourceReadResult,
} from "./source.ts";

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
  ) => Effect.Effect<SourceReadResult<Source, Cursor>, SourcePluginError>;
  readonly readByIdentity: (
    identity: SourceItem<Source>["identity"]
  ) => Effect.Effect<SourceItem<Source> | null, SourcePluginError>;
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
    layer: Layer.sync(
      SourcePluginService,
      (): SourcePlugin<Source, Cursor> => ({
        ...makeImplementation(),
        cursorSchema: input.cursorSchema,
        sourceSchema: input.sourceSchema,
      })
    ),
    sourceSchema: input.sourceSchema,
  };
};

export interface ConfiguredDestinationPlugin<
  Command extends DestinationCommand,
> {
  readonly commandSchema: Schema.Schema<Command>;
  readonly layer: Layer.Layer<DestinationPlugin>;
}

export type DestinationRetryStrategy = <A>(
  effect: Effect.Effect<A, DestinationPluginError>
) => Effect.Effect<A, DestinationPluginError>;

export type SourceRetryStrategy = <A>(
  effect: Effect.Effect<A, SourcePluginError>
) => Effect.Effect<A, SourcePluginError>;

export interface MigrationDefinition<
  Source,
  Command extends DestinationCommand,
  PipelineError = never,
  Cursor = unknown,
> {
  readonly dependsOn?: readonly MigrationDefinitionId[];
  readonly destination: ConfiguredDestinationPlugin<Command>;
  readonly destinationRetry?: DestinationRetryStrategy;
  readonly id: MigrationDefinitionId;
  readonly pipeline: (
    source: SourceItem<Source>,
    context: PipelineContext
  ) => Effect.Effect<Command, PipelineError | SkipItem>;
  readonly source: ConfiguredSourcePlugin<Source, Cursor>;
  readonly sourceCursorRetry?: SourceRetryStrategy;
  readonly sourceLookupRetry?: SourceRetryStrategy;
  readonly store: Layer.Layer<MigrationStore, MigrationStoreError>;
}

export interface MigrationDefinitionInput<
  Source,
  Command extends DestinationCommand,
  PipelineError = never,
  Cursor = unknown,
> extends Omit<
    MigrationDefinition<Source, Command, PipelineError, Cursor>,
    "id" | "dependsOn"
  > {
  readonly dependsOn?: readonly MigrationDefinitionIdInput[];
  readonly id: MigrationDefinitionIdInput;
}

export const defineMigration = <
  Source,
  Command extends DestinationCommand,
  PipelineError = never,
  Cursor = unknown,
>(
  definition: MigrationDefinitionInput<Source, Command, PipelineError, Cursor>
): MigrationDefinition<Source, Command, PipelineError, Cursor> => {
  const { id, dependsOn, ...rest } = definition;

  return {
    ...rest,
    id: toMigrationDefinitionId(id),
    ...(dependsOn === undefined
      ? {}
      : { dependsOn: dependsOn.map(toMigrationDefinitionId) }),
  };
};
