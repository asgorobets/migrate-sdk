import { Schema } from "effect";
import {
  type DestinationIdentity,
  type DestinationIdentityInput,
  type DestinationVersion,
  type DestinationVersionInput,
  type EncodedSourceIdentity,
  type MigrationDefinitionId,
  type MigrationRunId,
  type SourceVersion,
  toDestinationIdentity,
  toDestinationVersion,
} from "./ids.ts";
import type { MigrationItemState } from "./state.ts";

export interface DestinationCommand {
  readonly kind: string;
}

export type DestinationCommandSchema<Command extends DestinationCommand> =
  Schema.Codec<Command, Command, never, never>;

export interface DestinationCommandDefinition<
  Command extends DestinationCommand,
> {
  readonly identity?: boolean;
  readonly schema: DestinationCommandSchema<Command>;
}

export interface DefinedDestinationCommands<
  Command extends DestinationCommand,
> {
  readonly commandSchema: DestinationCommandSchema<Command>;
  readonly definitions: Readonly<
    Record<string, DestinationCommandDefinition<DestinationCommand>>
  >;
}

type CommandFromDefinition<Definition> =
  Definition extends DestinationCommandDefinition<infer Command>
    ? Command
    : never;

type DestinationCommandDefinitionsInput = Record<
  string,
  DestinationCommandDefinition<DestinationCommand>
>;

type CommandDefinitionsMatchKeys<
  Definitions extends DestinationCommandDefinitionsInput,
> = {
  readonly [Kind in keyof Definitions]: Kind extends string
    ? CommandFromDefinition<Definitions[Kind]>["kind"] extends Kind
      ? unknown
      : {
          readonly schema: DestinationCommandSchema<
            DestinationCommand & { readonly kind: Kind }
          >;
        }
    : unknown;
};

type CommandFromDefinitions<
  Definitions extends DestinationCommandDefinitionsInput,
> = CommandFromDefinition<Definitions[keyof Definitions]>;

export const makeDefinedDestinationCommands = <
  const Definitions extends DestinationCommandDefinitionsInput,
>(
  definitions: Definitions & CommandDefinitionsMatchKeys<Definitions>
): DefinedDestinationCommands<CommandFromDefinitions<Definitions>> => {
  const schemaDefinitions = Object.values(definitions);
  const schemas = schemaDefinitions.map(
    (definition) => definition.schema
  ) as unknown as readonly DestinationCommandSchema<
    CommandFromDefinitions<Definitions>
  >[];
  const [firstSchema, ...remainingSchemas] = schemas;

  if (firstSchema === undefined) {
    throw new Error("Destination commands must define at least one command");
  }

  const commandSchema =
    remainingSchemas.length === 0
      ? firstSchema
      : Schema.Union([firstSchema, ...remainingSchemas]);
  return {
    commandSchema: commandSchema as Schema.Schema<
      CommandFromDefinitions<Definitions>
    > as DestinationCommandSchema<CommandFromDefinitions<Definitions>>,
    definitions,
  };
};

/**
 * @deprecated New destination work should use process-scoped destination
 * helpers instead of returning command plans.
 */
export type DestinationCommandPlan<Command extends DestinationCommand> =
  | Command
  | readonly Command[];

export interface DestinationCommandResult {
  readonly destinationIdentity?: DestinationIdentity;
  readonly destinationVersion?: DestinationVersion;
  readonly metadata?: Record<string, unknown>;
}

export interface DestinationCommandResultInput {
  readonly destinationIdentity?: DestinationIdentityInput;
  readonly destinationVersion?: DestinationVersionInput;
  readonly metadata?: Record<string, unknown>;
}

export const makeDestinationCommandResult = (
  input: DestinationCommandResultInput
): DestinationCommandResult => ({
  ...(input.destinationIdentity === undefined
    ? {}
    : {
        destinationIdentity: toDestinationIdentity(input.destinationIdentity),
      }),
  ...(input.destinationVersion === undefined
    ? {}
    : { destinationVersion: toDestinationVersion(input.destinationVersion) }),
  ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
});

export interface DestinationCommandContext {
  readonly definitionId: MigrationDefinitionId;
  readonly previousState?: MigrationItemState;
  readonly runId: MigrationRunId;
  readonly sourceIdentity: EncodedSourceIdentity;
  readonly sourceVersion?: SourceVersion;
}
