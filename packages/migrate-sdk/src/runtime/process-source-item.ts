import { Effect, Predicate } from "effect";
import type { MigrationDefinition } from "../domain/definition.ts";
import type {
  DestinationCommand,
  DestinationCommandContext,
  DestinationCommandResult,
} from "../domain/destination.ts";
import type { MigrationStoreError, SkipItem } from "../domain/errors.ts";
import type { MigrationDefinitionId, MigrationRunId } from "../domain/ids.ts";
import type { PipelineContext } from "../domain/pipeline.ts";
import type { SourceItem } from "../domain/source.ts";
import type {
  FailedItemState,
  MigratedItemState,
  MigrationItemError,
  MigrationItemOutcome,
  MigrationItemState,
  MigrationItemStateBase,
  SkippedItemState,
} from "../domain/state.ts";
import { DestinationPlugin } from "../services/destination-plugin.ts";
import { MigrationStore } from "../services/migration-store.ts";
import { normalizeItemError } from "./item-error.ts";

export interface ProcessSourceItemOptions<
  Source,
  Command extends DestinationCommand,
  PipelineError,
> {
  readonly definition: MigrationDefinition<Source, Command, PipelineError>;
  readonly reprocessUnchangedTerminal?: boolean;
  readonly runId: MigrationRunId;
  readonly sourceItem: SourceItem<Source>;
}

export type ProcessSourceItemError = MigrationStoreError;

type PipelineOutcome<Command extends DestinationCommand> =
  | {
      readonly kind: "command";
      readonly command: Command;
    }
  | {
      readonly kind: "skipped";
      readonly reason: string;
    }
  | {
      readonly kind: "failed";
      readonly error: MigrationItemError;
    };

type DestinationOutcome =
  | {
      readonly kind: "succeeded";
      readonly result: DestinationCommandResult;
    }
  | {
      readonly kind: "failed";
      readonly error: MigrationItemError;
    };

const isSkipItem = (error: unknown): error is SkipItem =>
  Predicate.isTagged(error, "SkipItem") &&
  "reason" in error &&
  typeof error.reason === "string";

const makeItemStateBase = <Source>(
  definitionId: MigrationDefinitionId,
  runId: MigrationRunId,
  sourceItem: SourceItem<Source>
): MigrationItemStateBase => ({
  definitionId,
  sourceIdentity: sourceItem.identity,
  ...(sourceItem.version === undefined
    ? {}
    : { sourceVersion: sourceItem.version }),
  lastRunId: runId,
  updatedAt: new Date(),
});

const makeSkippedItemState = <Source>(
  definitionId: MigrationDefinitionId,
  runId: MigrationRunId,
  sourceItem: SourceItem<Source>,
  reason: string
): SkippedItemState => ({
  ...makeItemStateBase(definitionId, runId, sourceItem),
  status: "skipped",
  skipReason: reason,
});

const makeFailedItemState = <Source>(
  definitionId: MigrationDefinitionId,
  runId: MigrationRunId,
  sourceItem: SourceItem<Source>,
  error: MigrationItemError
): FailedItemState => ({
  ...makeItemStateBase(definitionId, runId, sourceItem),
  status: "failed",
  error,
});

const makeMigratedItemState = <Source>(
  definitionId: MigrationDefinitionId,
  runId: MigrationRunId,
  sourceItem: SourceItem<Source>,
  result: DestinationCommandResult
): MigratedItemState => ({
  ...makeItemStateBase(definitionId, runId, sourceItem),
  status: "migrated",
  destinationIdentity: result.destinationIdentity,
  ...(result.destinationVersion === undefined
    ? {}
    : { destinationVersion: result.destinationVersion }),
});

const isUnchangedTerminalState = <Source>(
  previousState: MigrationItemState | null,
  sourceItem: SourceItem<Source>
): boolean =>
  (previousState?.status === "migrated" ||
    previousState?.status === "skipped") &&
  previousState.sourceVersion === sourceItem.version;

export const processSourceItem = <
  Source,
  Command extends DestinationCommand,
  PipelineError,
>({
  definition,
  reprocessUnchangedTerminal = false,
  runId,
  sourceItem,
}: ProcessSourceItemOptions<Source, Command, PipelineError>): Effect.Effect<
  MigrationItemOutcome,
  ProcessSourceItemError,
  DestinationPlugin | MigrationStore
> =>
  Effect.gen(function* () {
    const destination = yield* DestinationPlugin;
    const store = yield* MigrationStore;
    const previousState = yield* store.getItemState(
      definition.id,
      sourceItem.identity
    );

    if (
      !reprocessUnchangedTerminal &&
      isUnchangedTerminalState(previousState, sourceItem)
    ) {
      return "unchanged" as const;
    }

    const pipelineContext: PipelineContext = {
      definitionId: definition.id,
      runId,
      ...(previousState === null ? {} : { previousState }),
    };

    const pipelineOutcome: PipelineOutcome<Command> = yield* definition
      .pipeline(sourceItem, pipelineContext)
      .pipe(
        Effect.map(
          (command): PipelineOutcome<Command> => ({
            kind: "command",
            command,
          })
        ),
        Effect.catchIf(isSkipItem, (skip) =>
          Effect.succeed({
            kind: "skipped",
            reason: skip.reason,
          } satisfies PipelineOutcome<Command>)
        ),
        Effect.catch((error) =>
          Effect.succeed({
            kind: "failed",
            error: normalizeItemError("pipeline", error),
          } satisfies PipelineOutcome<Command>)
        )
      );

    if (pipelineOutcome.kind === "skipped") {
      yield* store.upsertItemState(
        makeSkippedItemState(
          definition.id,
          runId,
          sourceItem,
          pipelineOutcome.reason
        )
      );

      return "skipped" as const;
    }

    if (pipelineOutcome.kind === "failed") {
      yield* store.upsertItemState(
        makeFailedItemState(
          definition.id,
          runId,
          sourceItem,
          pipelineOutcome.error
        )
      );

      return "failed" as const;
    }

    const command = pipelineOutcome.command;

    const destinationContext: DestinationCommandContext = {
      definitionId: definition.id,
      runId,
      sourceIdentity: sourceItem.identity,
      ...(sourceItem.version === undefined
        ? {}
        : { sourceVersion: sourceItem.version }),
      ...(previousState === null ? {} : { previousState }),
    };

    const executeDestination = destination.execute(command, destinationContext);
    const executeDestinationWithRetry =
      definition.destinationRetry === undefined
        ? executeDestination
        : definition.destinationRetry(executeDestination);

    const destinationOutcome: DestinationOutcome =
      yield* executeDestinationWithRetry.pipe(
        Effect.map(
          (result): DestinationOutcome => ({
            kind: "succeeded",
            result,
          })
        ),
        Effect.catch((error) =>
          Effect.succeed({
            kind: "failed",
            error: normalizeItemError("destination", error),
          } satisfies DestinationOutcome)
        )
      );

    if (destinationOutcome.kind === "failed") {
      yield* store.upsertItemState(
        makeFailedItemState(
          definition.id,
          runId,
          sourceItem,
          destinationOutcome.error
        )
      );

      return "failed" as const;
    }

    const { result } = destinationOutcome;

    yield* store.upsertItemState(
      makeMigratedItemState(definition.id, runId, sourceItem, result)
    );

    return "migrated" as const;
  });
