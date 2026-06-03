import type { Effect, Layer, Schema } from "effect";
import type { DestinationPlugin } from "../services/destination-plugin.ts";
import type { MigrationStore } from "../services/migration-store.ts";
import type { AnySourcePlugin } from "../services/source-plugin.ts";
import type { DestinationCommand } from "./destination.ts";
import type { DestinationPluginError } from "./errors.ts";
import {
  type MigrationDefinitionId,
  type MigrationDefinitionIdInput,
  toMigrationDefinitionId,
} from "./ids.ts";
import type { PipelineContext } from "./pipeline.ts";
import type { SourceItem } from "./source.ts";

export interface ConfiguredSourcePlugin<Source> {
  readonly layer: Layer.Layer<AnySourcePlugin>;
  readonly sourceSchema?: Schema.Schema<Source>;
}

export interface ConfiguredDestinationPlugin<
  Command extends DestinationCommand,
> {
  readonly commandSchema: Schema.Schema<Command>;
  readonly layer: Layer.Layer<DestinationPlugin>;
}

export interface MigrationDefinition<
  Source,
  Command extends DestinationCommand,
  PipelineError = never,
> {
  readonly dependsOn?: readonly MigrationDefinitionId[];
  readonly destination: ConfiguredDestinationPlugin<Command>;
  readonly destinationRetry?: <A>(
    effect: Effect.Effect<A, DestinationPluginError>
  ) => Effect.Effect<A, DestinationPluginError>;
  readonly id: MigrationDefinitionId;
  readonly pipeline: (
    source: SourceItem<Source>,
    context: PipelineContext
  ) => Effect.Effect<Command, PipelineError>;
  readonly source: ConfiguredSourcePlugin<Source>;
  readonly store: Layer.Layer<MigrationStore>;
}

export interface MigrationDefinitionInput<
  Source,
  Command extends DestinationCommand,
  PipelineError = never,
> extends Omit<
    MigrationDefinition<Source, Command, PipelineError>,
    "id" | "dependsOn"
  > {
  readonly dependsOn?: readonly MigrationDefinitionIdInput[];
  readonly id: MigrationDefinitionIdInput;
}

export const defineMigration = <
  Source,
  Command extends DestinationCommand,
  PipelineError = never,
>(
  definition: MigrationDefinitionInput<Source, Command, PipelineError>
): MigrationDefinition<Source, Command, PipelineError> => {
  const { id, dependsOn, ...rest } = definition;

  return {
    ...rest,
    id: toMigrationDefinitionId(id),
    ...(dependsOn === undefined
      ? {}
      : { dependsOn: dependsOn.map(toMigrationDefinitionId) }),
  };
};
