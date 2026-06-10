import { Effect, Predicate, Schema } from "effect";
import type {
  MigrationDefinition,
  SourcePayloadSchema,
} from "../domain/definition.ts";
import type {
  DestinationCommand,
  DestinationCommandContext,
  DestinationCommandPlan,
} from "../domain/destination.ts";
import type { DestinationPluginError, SkipItem } from "../domain/errors.ts";
import {
  DestinationPluginError as DestinationPluginErrorClass,
  type MigrationStoreError,
} from "../domain/errors.ts";
import type {
  MigrationDefinitionId,
  MigrationRunId,
  SourceVersion,
} from "../domain/ids.ts";
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
import type { MigrationReferenceLookup } from "../services/migration-reference-lookup.ts";
import { MigrationStore } from "../services/migration-store.ts";
import { executeDestinationCommandPlan } from "./destination-command-plan.ts";
import {
  normalizeItemError,
  normalizeSourcePayloadSchemaError,
} from "./item-error.ts";

export interface ProcessSourceItemOptions<
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor = unknown,
  SourceInput = unknown,
  SourceLayerError = never,
  SourceRequirements = never,
> {
  readonly definition: MigrationDefinition<
    Source,
    Command,
    PipelineError,
    Cursor,
    unknown,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >;
  readonly reprocessUnchangedTerminal?: boolean;
  readonly runId: MigrationRunId;
  readonly sourceItem: SourceItem<SourceInput>;
  readonly sourceSchema: SourcePayloadSchema<Source, SourceInput>;
}

export type ProcessSourceItemError = MigrationStoreError;

type PipelineOutcome<Command extends DestinationCommand> =
  | {
      readonly kind: "command";
      readonly plan: DestinationCommandPlan<Command>;
    }
  | {
      readonly kind: "skipped";
      readonly reason: string;
    }
  | {
      readonly kind: "failed";
      readonly error: MigrationItemError;
    };

const isSkipItem = (error: unknown): error is SkipItem =>
  Predicate.isTagged(error, "SkipItem") &&
  "reason" in error &&
  typeof error.reason === "string";

const isMigrationStoreError = (error: unknown): error is MigrationStoreError =>
  Predicate.isTagged(error, "MigrationStoreError");

const makeItemStateBase = <Source>(
  definitionId: MigrationDefinitionId,
  runId: MigrationRunId,
  sourceItem: SourceItem<Source>
): MigrationItemStateBase & { readonly sourceVersion: SourceVersion } => ({
  definitionId,
  sourceIdentity: sourceItem.identity,
  sourceVersion: sourceItem.version,
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

const previousDestinationIdentity = (
  previousState: MigrationItemState | null
) =>
  previousState !== null &&
  (previousState.status === "migrated" ||
    previousState.status === "failed" ||
    previousState.status === "needs-update")
    ? previousState.destinationIdentity
    : undefined;

const previousDestinationVersion = (
  previousState: MigrationItemState | null
) =>
  previousState !== null &&
  (previousState.status === "migrated" ||
    previousState.status === "failed" ||
    previousState.status === "needs-update")
    ? previousState.destinationVersion
    : undefined;

const makeFailedItemState = <Source>(
  definitionId: MigrationDefinitionId,
  runId: MigrationRunId,
  sourceItem: SourceItem<Source>,
  error: MigrationItemError,
  previousState: MigrationItemState | null = null,
  latestDestination?: {
    readonly destinationIdentity?: FailedItemState["destinationIdentity"];
    readonly destinationVersion?: FailedItemState["destinationVersion"];
  }
): FailedItemState => ({
  ...makeItemStateBase(definitionId, runId, sourceItem),
  ...((latestDestination?.destinationIdentity ??
    previousDestinationIdentity(previousState)) === undefined
    ? {}
    : {
        destinationIdentity:
          latestDestination?.destinationIdentity ??
          previousDestinationIdentity(previousState),
      }),
  ...((latestDestination?.destinationVersion ??
    previousDestinationVersion(previousState)) === undefined
    ? {}
    : {
        destinationVersion:
          latestDestination?.destinationVersion ??
          previousDestinationVersion(previousState),
      }),
  status: "failed",
  error,
});

const makeMigratedItemState = <Source>(
  definitionId: MigrationDefinitionId,
  runId: MigrationRunId,
  sourceItem: SourceItem<Source>,
  result: {
    readonly destinationIdentity: MigratedItemState["destinationIdentity"];
    readonly destinationVersion?: MigratedItemState["destinationVersion"];
  }
): MigratedItemState => ({
  ...makeItemStateBase(definitionId, runId, sourceItem),
  status: "migrated",
  destinationIdentity: result.destinationIdentity,
  ...(result.destinationVersion === undefined
    ? {}
    : { destinationVersion: result.destinationVersion }),
});

const missingDestinationIdentityError = (): DestinationPluginError =>
  new DestinationPluginErrorClass({
    message: "Destination Command Plan did not produce a Destination Identity",
  });

const persistMissingDestinationIdentityFailure = <Source>({
  decodedSourceItem,
  definitionId,
  previousState,
  runId,
  store,
}: {
  readonly decodedSourceItem: SourceItem<Source>;
  readonly definitionId: MigrationDefinitionId;
  readonly previousState: MigrationItemState | null;
  readonly runId: MigrationRunId;
  readonly store: typeof MigrationStore.Service;
}) =>
  store.upsertItemState(
    makeFailedItemState(
      definitionId,
      runId,
      decodedSourceItem,
      normalizeItemError("destination", missingDestinationIdentityError()),
      previousState
    )
  );

const persistNonCommandPipelineOutcome = <
  Source,
  Command extends DestinationCommand,
>({
  decodedSourceItem,
  definitionId,
  outcome,
  previousState,
  runId,
  store,
}: {
  readonly decodedSourceItem: SourceItem<Source>;
  readonly definitionId: MigrationDefinitionId;
  readonly outcome: Exclude<
    PipelineOutcome<Command>,
    { readonly kind: "command" }
  >;
  readonly previousState: MigrationItemState | null;
  readonly runId: MigrationRunId;
  readonly store: typeof MigrationStore.Service;
}) => {
  if (outcome.kind === "skipped") {
    return store
      .upsertItemState(
        makeSkippedItemState(
          definitionId,
          runId,
          decodedSourceItem,
          outcome.reason
        )
      )
      .pipe(Effect.as("skipped" as const));
  }

  return store
    .upsertItemState(
      makeFailedItemState(
        definitionId,
        runId,
        decodedSourceItem,
        outcome.error,
        previousState
      )
    )
    .pipe(Effect.as("failed" as const));
};

const isUnchangedTerminalState = <Source>(
  previousState: MigrationItemState | null,
  sourceItem: SourceItem<Source>
): boolean =>
  previousState?.status === "migrated" &&
  previousState.sourceVersion === sourceItem.version;

const decodeSourceItem = <Source, SourceInput>(
  sourceSchema: SourcePayloadSchema<Source, SourceInput>,
  sourceItem: SourceItem<SourceInput>
) =>
  Schema.decodeUnknownEffect(sourceSchema, { errors: "all" })(
    sourceItem.item
  ).pipe(
    Effect.map(
      (item): SourceItem<Source> => ({
        ...sourceItem,
        item,
      })
    )
  );

const runPipeline = <
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor = unknown,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
>(
  definition: MigrationDefinition<
    Source,
    Command,
    PipelineError,
    Cursor,
    unknown,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >,
  sourceItem: SourceItem<Source>,
  context: PipelineContext
) =>
  Effect.try({
    try: () => definition.pipeline(sourceItem, context),
    catch: (error) => error as PipelineError | SkipItem,
  }).pipe(
    Effect.flatMap((planOrEffect) =>
      Effect.isEffect(planOrEffect)
        ? (planOrEffect as Effect.Effect<
            DestinationCommandPlan<Command>,
            PipelineError | SkipItem,
            MigrationReferenceLookup
          >)
        : Effect.succeed(planOrEffect)
    )
  );

export const processSourceItem = <
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor,
  SourceInput,
  SourceLayerError,
  SourceRequirements,
>({
  definition,
  reprocessUnchangedTerminal = false,
  runId,
  sourceSchema,
  sourceItem,
}: ProcessSourceItemOptions<
  Source,
  Command,
  PipelineError,
  Cursor,
  SourceInput,
  SourceLayerError,
  SourceRequirements
>): Effect.Effect<
  MigrationItemOutcome,
  ProcessSourceItemError,
  DestinationPlugin | MigrationReferenceLookup | MigrationStore
> =>
  Effect.gen(function* () {
    const destination = yield* DestinationPlugin;
    const store = yield* MigrationStore;
    const previousState = yield* store.getItemState(
      definition.id,
      sourceItem.identity
    );
    const decodedSourceItem = yield* decodeSourceItem(
      sourceSchema,
      sourceItem
    ).pipe(
      Effect.catch((error) =>
        store
          .upsertItemState(
            makeFailedItemState(
              definition.id,
              runId,
              sourceItem,
              normalizeSourcePayloadSchemaError(error),
              previousState
            )
          )
          .pipe(Effect.andThen(Effect.succeed(null)))
      )
    );

    if (decodedSourceItem === null) {
      return "failed" as const;
    }

    if (
      !reprocessUnchangedTerminal &&
      isUnchangedTerminalState(previousState, decodedSourceItem)
    ) {
      return "unchanged" as const;
    }

    const pipelineContext: PipelineContext = {
      definitionId: definition.id,
      runId,
      ...(previousState === null ? {} : { previousState }),
    };

    const pipelineOutcome: PipelineOutcome<Command> = yield* runPipeline(
      definition,
      decodedSourceItem,
      pipelineContext
    ).pipe(
      Effect.map(
        (plan): PipelineOutcome<Command> => ({
          kind: "command",
          plan,
        })
      ),
      Effect.catchIf(isSkipItem, (skip) =>
        Effect.succeed({
          kind: "skipped",
          reason: skip.reason,
        } satisfies PipelineOutcome<Command>)
      ),
      Effect.catchIf(isMigrationStoreError, (error) => Effect.fail(error)),
      Effect.catch((error) =>
        Effect.succeed({
          kind: "failed",
          error: normalizeItemError("pipeline", error),
        } satisfies PipelineOutcome<Command>)
      )
    );

    if (pipelineOutcome.kind !== "command") {
      return yield* persistNonCommandPipelineOutcome({
        decodedSourceItem,
        definitionId: definition.id,
        outcome: pipelineOutcome,
        previousState,
        runId,
        store,
      });
    }

    const destinationContext: DestinationCommandContext = {
      definitionId: definition.id,
      runId,
      sourceIdentity: decodedSourceItem.identity,
      sourceVersion: decodedSourceItem.version,
      ...(previousState === null ? {} : { previousState }),
    };

    const destinationOutcome = yield* executeDestinationCommandPlan({
      commandDefinitions: definition.destination.commandDefinitions,
      context: destinationContext,
      destination,
      destinationRetry: definition.destinationRetry,
      plan: pipelineOutcome.plan,
    });

    if (destinationOutcome.kind === "failed") {
      yield* store.upsertItemState(
        makeFailedItemState(
          definition.id,
          runId,
          decodedSourceItem,
          destinationOutcome.error,
          previousState,
          destinationOutcome
        )
      );

      return "failed" as const;
    }

    const destinationIdentity =
      destinationOutcome.destinationIdentity ??
      previousDestinationIdentity(previousState);
    const destinationVersion =
      destinationOutcome.destinationVersion ??
      previousDestinationVersion(previousState);

    if (destinationIdentity === undefined) {
      yield* persistMissingDestinationIdentityFailure({
        decodedSourceItem,
        definitionId: definition.id,
        previousState,
        runId,
        store,
      });

      return "failed" as const;
    }

    yield* store.upsertItemState(
      makeMigratedItemState(definition.id, runId, decodedSourceItem, {
        destinationIdentity,
        ...(destinationVersion === undefined ? {} : { destinationVersion }),
      })
    );

    return "migrated" as const;
  });
