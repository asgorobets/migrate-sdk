import type { Effect, Layer, Schema } from "effect";
import type { DestinationCommand } from "./destination.ts";
import type { DestinationPluginError } from "./errors.ts";
import {
  toMigrationDefinitionId,
  type MigrationDefinitionId,
  type MigrationDefinitionIdInput,
} from "./ids.ts";
import type { SourceItem } from "./source.ts";
import type { DestinationPlugin } from "../services/destination-plugin.ts";
import type { MigrationStore } from "../services/migration-store.ts";
import type { AnySourcePlugin } from "../services/source-plugin.ts";
import type { PipelineContext } from "./pipeline.ts";

export interface ConfiguredSourcePlugin<Source> {
  readonly layer: Layer.Layer<AnySourcePlugin>;
  readonly sourceSchema?: Schema.Schema<Source>;
}

export interface ConfiguredDestinationPlugin<Command extends DestinationCommand> {
  readonly layer: Layer.Layer<DestinationPlugin>;
  readonly commandSchema: Schema.Schema<Command>;
}

export interface MigrationDefinition<Source, Command extends DestinationCommand> {
  readonly id: MigrationDefinitionId;
  readonly source: ConfiguredSourcePlugin<Source>;
  readonly destination: ConfiguredDestinationPlugin<Command>;
  readonly store: Layer.Layer<MigrationStore>;
  readonly pipeline: (
    source: SourceItem<Source>,
    context: PipelineContext
  ) => Effect.Effect<Command, unknown>;
  readonly dependsOn?: ReadonlyArray<MigrationDefinitionId>;
  readonly destinationRetry?: <A>(
    effect: Effect.Effect<A, DestinationPluginError>
  ) => Effect.Effect<A, DestinationPluginError>;
}

export interface MigrationDefinitionInput<
  Source,
  Command extends DestinationCommand,
> extends Omit<MigrationDefinition<Source, Command>, "id" | "dependsOn"> {
  readonly id: MigrationDefinitionIdInput;
  readonly dependsOn?: ReadonlyArray<MigrationDefinitionIdInput>;
}

export const defineMigration = <Source, Command extends DestinationCommand>(
  definition: MigrationDefinitionInput<Source, Command>
): MigrationDefinition<Source, Command> => {
  const { id, dependsOn, ...rest } = definition;

  return {
    ...rest,
    id: toMigrationDefinitionId(id),
    ...(dependsOn === undefined
      ? {}
      : { dependsOn: dependsOn.map(toMigrationDefinitionId) }),
  };
};
