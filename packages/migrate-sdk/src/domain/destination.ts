import {
  toDestinationIdentity,
  toDestinationVersion,
  type DestinationIdentity,
  type DestinationIdentityInput,
  type DestinationVersion,
  type DestinationVersionInput,
  type MigrationDefinitionId,
  type MigrationRunId,
  type SourceIdentity,
  type SourceVersion,
} from "./ids.ts";
import type { MigrationItemState } from "./state.ts";

export interface DestinationCommand {
  readonly kind: string;
}

export interface DestinationCommandResult {
  readonly destinationIdentity: DestinationIdentity;
  readonly destinationVersion?: DestinationVersion;
  readonly metadata?: Record<string, unknown>;
}

export interface DestinationCommandResultInput {
  readonly destinationIdentity: DestinationIdentityInput;
  readonly destinationVersion?: DestinationVersionInput;
  readonly metadata?: Record<string, unknown>;
}

export const makeDestinationCommandResult = (
  input: DestinationCommandResultInput
): DestinationCommandResult => ({
  destinationIdentity: toDestinationIdentity(input.destinationIdentity),
  ...(input.destinationVersion === undefined
    ? {}
    : { destinationVersion: toDestinationVersion(input.destinationVersion) }),
  ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
});

export interface DestinationCommandContext {
  readonly definitionId: MigrationDefinitionId;
  readonly runId: MigrationRunId;
  readonly sourceIdentity: SourceIdentity;
  readonly sourceVersion?: SourceVersion;
  readonly previousState?: MigrationItemState;
}
