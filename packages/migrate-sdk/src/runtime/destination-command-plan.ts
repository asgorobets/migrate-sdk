import { Effect } from "effect";
import type { DestinationRetryStrategy } from "../domain/definition.ts";
import type {
  DefinedDestinationCommands,
  DestinationCommand,
  DestinationCommandContext,
  DestinationCommandPlan,
  DestinationCommandResult,
} from "../domain/destination.ts";
import type { DestinationIdentity, DestinationVersion } from "../domain/ids.ts";
import type { MigrationItemError } from "../domain/state.ts";
import type { DestinationPlugin } from "../services/destination-plugin.ts";
import { normalizeItemError } from "./item-error.ts";

export interface DestinationCommandPlanSuccess {
  readonly destinationIdentity?: DestinationIdentity;
  readonly destinationVersion?: DestinationVersion;
  readonly kind: "succeeded";
}

export interface DestinationCommandPlanFailure {
  readonly destinationIdentity?: DestinationIdentity;
  readonly destinationVersion?: DestinationVersion;
  readonly error: MigrationItemError;
  readonly kind: "failed";
}

export type DestinationCommandPlanOutcome =
  | DestinationCommandPlanSuccess
  | DestinationCommandPlanFailure;

interface LatestDestinationResult {
  readonly destinationIdentity?: DestinationIdentity;
  readonly destinationVersion?: DestinationVersion;
}

interface DestinationCommandPlanErrorInput {
  readonly details?: MigrationItemError["details"];
  readonly message: string;
}

type DestinationCommandExecutionOutcome =
  | {
      readonly kind: "succeeded";
      readonly result: DestinationCommandResult;
    }
  | {
      readonly error: MigrationItemError;
      readonly kind: "failed";
    };

export const normalizeDestinationCommandPlan = <
  Command extends DestinationCommand,
>(
  plan: DestinationCommandPlan<Command>
): readonly Command[] => (Array.isArray(plan) ? plan : [plan as Command]);

const destinationCommandPlanError = ({
  details,
  message,
}: DestinationCommandPlanErrorInput): MigrationItemError => ({
  errorTag: "DestinationCommandPlanError",
  kind: "destination",
  message,
  ...(details === undefined ? {} : { details }),
});

const multipleIdentityResultsError = (): MigrationItemError =>
  destinationCommandPlanError({
    message:
      "Destination Command Plan produced more than one Destination Identity",
  });

const emptyDestinationCommandPlanError = (): MigrationItemError =>
  destinationCommandPlanError({
    message:
      "Destination Command Plan must contain at least one Destination Command",
  });

const multipleIdentityCommandsError = (
  commandKinds: readonly string[]
): MigrationItemError =>
  destinationCommandPlanError({
    details: commandKinds.map((kind) => ({
      message: `Identity-bearing command: ${kind}`,
    })),
    message:
      "Destination Command Plan contains more than one identity-bearing Destination Command",
  });

const validateNonEmptyCommandPlan = (
  commands: readonly DestinationCommand[]
): DestinationCommandPlanFailure | null =>
  commands.length === 0
    ? {
        error: emptyDestinationCommandPlanError(),
        kind: "failed",
      }
    : null;

const validateIdentityCommandDefinitions = <Command extends DestinationCommand>(
  commands: readonly Command[],
  commandDefinitions: DefinedDestinationCommands<Command>
): DestinationCommandPlanFailure | null => {
  const planIdentityKinds = commands
    .map((command) => command.kind)
    .filter((kind) => commandDefinitions.definitions[kind]?.identity === true);

  return planIdentityKinds.length > 1
    ? {
        error: multipleIdentityCommandsError(planIdentityKinds),
        kind: "failed",
      }
    : null;
};

const executeDestinationCommand = ({
  command,
  context,
  destination,
  destinationRetry,
}: {
  readonly command: DestinationCommand;
  readonly context: DestinationCommandContext;
  readonly destination: DestinationPlugin;
  readonly destinationRetry?: DestinationRetryStrategy | undefined;
}): Effect.Effect<DestinationCommandExecutionOutcome> => {
  const execute = destination.execute(command, context);
  const executeWithRetry =
    destinationRetry === undefined ? execute : destinationRetry(execute);

  return executeWithRetry.pipe(
    Effect.map((result) => ({
      kind: "succeeded" as const,
      result,
    })),
    Effect.catch((error) =>
      Effect.succeed({
        error: normalizeItemError("destination", error),
        kind: "failed" as const,
      })
    )
  );
};

const updateLatestDestinationResult = (
  latest: LatestDestinationResult,
  result: DestinationCommandResult
):
  | {
      readonly kind: "succeeded";
      readonly latest: LatestDestinationResult;
    }
  | {
      readonly error: MigrationItemError;
      readonly kind: "failed";
    } => {
  if (
    result.destinationIdentity !== undefined &&
    latest.destinationIdentity !== undefined
  ) {
    return {
      error: multipleIdentityResultsError(),
      kind: "failed",
    };
  }

  const destinationIdentity =
    result.destinationIdentity ?? latest.destinationIdentity;
  const destinationVersion =
    result.destinationVersion ?? latest.destinationVersion;

  return {
    kind: "succeeded",
    latest: {
      ...(destinationIdentity === undefined ? {} : { destinationIdentity }),
      ...(destinationVersion === undefined ? {} : { destinationVersion }),
    },
  };
};

const commandPlanFailure = (
  outcome: Extract<
    DestinationCommandExecutionOutcome,
    { readonly kind: "failed" }
  >,
  latest: LatestDestinationResult
): DestinationCommandPlanFailure => ({
  ...outcome,
  ...(latest.destinationIdentity === undefined
    ? {}
    : { destinationIdentity: latest.destinationIdentity }),
  ...(latest.destinationVersion === undefined
    ? {}
    : { destinationVersion: latest.destinationVersion }),
});

const commandPlanSuccess = (
  latest: LatestDestinationResult
): DestinationCommandPlanSuccess => ({
  kind: "succeeded",
  ...(latest.destinationIdentity === undefined
    ? {}
    : { destinationIdentity: latest.destinationIdentity }),
  ...(latest.destinationVersion === undefined
    ? {}
    : { destinationVersion: latest.destinationVersion }),
});

export const executeDestinationCommandPlan = <
  Command extends DestinationCommand,
>({
  commandDefinitions,
  context,
  destination,
  destinationRetry,
  plan,
}: {
  readonly commandDefinitions: DefinedDestinationCommands<Command>;
  readonly context: DestinationCommandContext;
  readonly destination: DestinationPlugin;
  readonly destinationRetry?: DestinationRetryStrategy | undefined;
  readonly plan: DestinationCommandPlan<Command>;
}): Effect.Effect<DestinationCommandPlanOutcome> =>
  Effect.gen(function* () {
    let latest: LatestDestinationResult = {};
    const commands = normalizeDestinationCommandPlan(plan);
    const emptyPlanValidationFailure = validateNonEmptyCommandPlan(commands);

    if (emptyPlanValidationFailure !== null) {
      return emptyPlanValidationFailure;
    }

    const staticValidationFailure = validateIdentityCommandDefinitions(
      commands,
      commandDefinitions
    );

    if (staticValidationFailure !== null) {
      return staticValidationFailure;
    }

    for (const command of commands) {
      const outcome = yield* executeDestinationCommand({
        command,
        context,
        destination,
        destinationRetry,
      });

      if (outcome.kind === "failed") {
        return commandPlanFailure(outcome, latest);
      }

      const update = updateLatestDestinationResult(latest, outcome.result);

      if (update.kind === "failed") {
        return commandPlanFailure(update, latest);
      }

      latest = update.latest;
    }

    return commandPlanSuccess(latest);
  });
