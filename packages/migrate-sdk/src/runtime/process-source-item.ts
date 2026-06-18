import { Effect, Layer, Predicate, Schema } from "effect";
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
  SourceIdentitySnapshotKey,
  SourceVersion,
} from "../domain/ids.ts";
import type { SourceVersionContractFingerprint } from "../domain/migration-contract.ts";
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
import type {
  DestinationJournalSegment,
  TrackingRecord,
  TrackingRecordContract,
  TrackingRecordValue,
} from "../domain/tracking.ts";
import { TrackingRecord as TrackingRecordSchema } from "../domain/tracking.ts";
import { DestinationPlugin } from "../services/destination-plugin.ts";
import type { MigrationReferenceLookup } from "../services/migration-reference-lookup.ts";
import { MigrationStore } from "../services/migration-store.ts";
import {
  makeProcessScope,
  Tracking,
  type TrackingService,
} from "../services/tracking.ts";
import { executeDestinationCommandPlan } from "./destination-command-plan.ts";
import {
  normalizeItemError,
  normalizeSourcePayloadSchemaError,
  normalizeTrackingRecordCountError,
  normalizeTrackingRecordSchemaError,
  normalizeUnexpectedTrackingRecordError,
} from "./item-error.ts";

export interface ProcessSourceItemOptions<
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  SourceInput = unknown,
  SourceLayerError = never,
  SourceRequirements = never,
> {
  readonly definition: MigrationDefinition<
    Source,
    Command,
    PipelineError,
    Cursor,
    IdentityKey,
    unknown,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >;
  readonly reprocessUnchangedTerminal?: boolean;
  readonly runId: MigrationRunId;
  readonly sourceItem: SourceItem<SourceInput, IdentityKey>;
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

interface SourceVersionContractContext {
  readonly definitionId: MigrationDefinitionId;
  readonly sourceVersionContractFingerprint: SourceVersionContractFingerprint;
}

const makeItemStateBase = <Source>(
  sourceVersionContractContext: SourceVersionContractContext,
  runId: MigrationRunId,
  sourceItem: SourceItem<Source>
): MigrationItemStateBase & { readonly sourceVersion: SourceVersion } => ({
  definitionId: sourceVersionContractContext.definitionId,
  sourceIdentity: sourceItem.identity,
  sourceVersionContractFingerprint:
    sourceVersionContractContext.sourceVersionContractFingerprint,
  sourceVersion: sourceItem.version,
  lastRunId: runId,
  updatedAt: new Date(),
});

const makeSkippedItemState = <Source>(
  sourceVersionContractContext: SourceVersionContractContext,
  runId: MigrationRunId,
  sourceItem: SourceItem<Source>,
  reason: string,
  journal?: SkippedItemState["journal"]
): SkippedItemState => ({
  ...makeItemStateBase(sourceVersionContractContext, runId, sourceItem),
  ...(journal === undefined ? {} : { journal }),
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
  sourceVersionContractContext: SourceVersionContractContext,
  runId: MigrationRunId,
  sourceItem: SourceItem<Source>,
  error: MigrationItemError,
  previousState: MigrationItemState | null = null,
  latestDestination?: {
    readonly destinationIdentity?: FailedItemState["destinationIdentity"];
    readonly destinationVersion?: FailedItemState["destinationVersion"];
  },
  journal?: FailedItemState["journal"]
): FailedItemState => {
  const destinationIdentity =
    latestDestination?.destinationIdentity ??
    previousDestinationIdentity(previousState);
  const destinationVersion =
    latestDestination?.destinationVersion ??
    previousDestinationVersion(previousState);

  return {
    ...makeItemStateBase(sourceVersionContractContext, runId, sourceItem),
    ...(destinationIdentity === undefined ? {} : { destinationIdentity }),
    ...(destinationVersion === undefined ? {} : { destinationVersion }),
    ...(journal === undefined ? {} : { journal }),
    status: "failed",
    error,
  };
};

const makeMigratedItemState = <Source>(
  sourceVersionContractContext: SourceVersionContractContext,
  runId: MigrationRunId,
  sourceItem: SourceItem<Source>,
  result: {
    readonly destinationIdentity?: MigratedItemState["destinationIdentity"];
    readonly destinationVersion?: MigratedItemState["destinationVersion"];
    readonly journal?: MigratedItemState["journal"];
    readonly trackingRecord?: MigratedItemState["trackingRecord"];
  }
): MigratedItemState => {
  return {
    ...makeItemStateBase(sourceVersionContractContext, runId, sourceItem),
    status: "migrated",
    ...(result.destinationIdentity === undefined
      ? {}
      : { destinationIdentity: result.destinationIdentity }),
    ...(result.destinationVersion === undefined
      ? {}
      : { destinationVersion: result.destinationVersion }),
    ...(result.journal === undefined ? {} : { journal: result.journal }),
    ...(result.trackingRecord === undefined
      ? {}
      : { trackingRecord: result.trackingRecord }),
  };
};

export const makeProcessJournal = (
  process: DestinationJournalSegment | null
): FailedItemState["journal"] | undefined =>
  process === null
    ? undefined
    : {
        process,
        rollbackAttempts: [],
      };

export const validateStagedTrackingRecord = (
  contract: TrackingRecordContract | undefined,
  records: readonly TrackingRecordValue[]
): Effect.Effect<TrackingRecord | undefined, MigrationItemError, never> => {
  if (contract === undefined) {
    return records.length === 0
      ? Effect.as(Effect.void, undefined as TrackingRecord | undefined)
      : Effect.fail(normalizeUnexpectedTrackingRecordError(records.length));
  }

  if (records.length !== 1) {
    return Effect.fail(
      normalizeTrackingRecordCountError(contract, records.length)
    );
  }

  const record = records[0] as TrackingRecordValue;

  return Schema.encodeEffect(contract.schema, { errors: "all" })(record).pipe(
    Effect.flatMap((encoded) =>
      Schema.decodeUnknownEffect(TrackingRecordSchema, { errors: "all" })(
        encoded
      )
    ),
    Effect.tap((encodedRecord) =>
      Schema.decodeUnknownEffect(contract.schema, { errors: "all" })(
        encodedRecord
      )
    ),
    Effect.mapError((error) =>
      normalizeTrackingRecordSchemaError(contract, error)
    )
  );
};

const resolveProcessTrackingRecord = <Source>({
  decodedSourceItem,
  definition,
  previousState,
  processJournal,
  runId,
  sourceVersionContractContext,
  store,
  tracking,
}: {
  readonly decodedSourceItem: SourceItem<Source>;
  readonly definition: {
    readonly tracking?: TrackingRecordContract | undefined;
  };
  readonly previousState: MigrationItemState | null;
  readonly processJournal?: FailedItemState["journal"];
  readonly runId: MigrationRunId;
  readonly sourceVersionContractContext: SourceVersionContractContext;
  readonly store: typeof MigrationStore.Service;
  readonly tracking: TrackingService;
}) =>
  Effect.gen(function* () {
    const trackingRecords = yield* tracking.records;

    return yield* validateStagedTrackingRecord(
      definition.tracking,
      trackingRecords
    ).pipe(
      Effect.catch((error) =>
        store
          .upsertItemState(
            makeFailedItemState(
              sourceVersionContractContext,
              runId,
              decodedSourceItem,
              error,
              previousState,
              undefined,
              processJournal
            )
          )
          .pipe(Effect.as(null))
      )
    );
  });

const missingDestinationIdentityError = (): DestinationPluginError =>
  new DestinationPluginErrorClass({
    message: "Destination Command Plan did not produce a Destination Identity",
  });

const persistMissingDestinationIdentityFailure = <Source>({
  decodedSourceItem,
  previousState,
  runId,
  sourceVersionContractContext,
  store,
}: {
  readonly decodedSourceItem: SourceItem<Source>;
  readonly previousState: MigrationItemState | null;
  readonly runId: MigrationRunId;
  readonly sourceVersionContractContext: SourceVersionContractContext;
  readonly store: typeof MigrationStore.Service;
}) =>
  store.upsertItemState(
    makeFailedItemState(
      sourceVersionContractContext,
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
  outcome,
  previousState,
  processJournal,
  runId,
  sourceVersionContractContext,
  store,
}: {
  readonly decodedSourceItem: SourceItem<Source>;
  readonly outcome: Exclude<
    PipelineOutcome<Command>,
    { readonly kind: "command" }
  >;
  readonly previousState: MigrationItemState | null;
  readonly processJournal?: FailedItemState["journal"];
  readonly runId: MigrationRunId;
  readonly sourceVersionContractContext: SourceVersionContractContext;
  readonly store: typeof MigrationStore.Service;
}) => {
  if (outcome.kind === "skipped") {
    return store
      .upsertItemState(
        makeSkippedItemState(
          sourceVersionContractContext,
          runId,
          decodedSourceItem,
          outcome.reason,
          processJournal
        )
      )
      .pipe(Effect.as("skipped" as const));
  }

  return store
    .upsertItemState(
      makeFailedItemState(
        sourceVersionContractContext,
        runId,
        decodedSourceItem,
        outcome.error,
        previousState,
        undefined,
        processJournal
      )
    )
    .pipe(Effect.as("failed" as const));
};

const isUnchangedTerminalState = <
  Source,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  sourceVersionContractFingerprint: SourceVersionContractFingerprint,
  previousState: MigrationItemState | null,
  sourceItem: SourceItem<Source, IdentityKey>
): boolean =>
  previousState?.status === "migrated" &&
  previousState.sourceVersionContractFingerprint ===
    sourceVersionContractFingerprint &&
  previousState.sourceVersion === sourceItem.version;

const decodeSourceItem = <
  Source,
  SourceInput,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  sourceSchema: SourcePayloadSchema<Source, SourceInput>,
  sourceItem: SourceItem<SourceInput, IdentityKey>
) =>
  Schema.decodeUnknownEffect(sourceSchema, { errors: "all" })(
    sourceItem.item
  ).pipe(
    Effect.map(
      (item): SourceItem<Source, IdentityKey> => ({
        ...sourceItem,
        item,
      })
    )
  );

const decodeSourceItemOrPersistFailure = <
  Source,
  SourceInput,
  IdentityKey extends SourceIdentitySnapshotKey,
>({
  previousState,
  runId,
  sourceItem,
  sourceSchema,
  sourceVersionContractContext,
  store,
}: {
  readonly previousState: MigrationItemState | null;
  readonly runId: MigrationRunId;
  readonly sourceItem: SourceItem<SourceInput, IdentityKey>;
  readonly sourceSchema: SourcePayloadSchema<Source, SourceInput>;
  readonly sourceVersionContractContext: SourceVersionContractContext;
  readonly store: typeof MigrationStore.Service;
}): Effect.Effect<
  SourceItem<Source, IdentityKey> | null,
  MigrationStoreError
> =>
  decodeSourceItem(sourceSchema, sourceItem).pipe(
    Effect.catch((error) =>
      store
        .upsertItemState(
          makeFailedItemState(
            sourceVersionContractContext,
            runId,
            sourceItem,
            normalizeSourcePayloadSchemaError(error),
            previousState
          )
        )
        .pipe(Effect.as(null))
    )
  );

const runPipeline = <
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
>(
  definition: MigrationDefinition<
    Source,
    Command,
    PipelineError,
    Cursor,
    IdentityKey,
    unknown,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >,
  sourceItem: SourceItem<Source, IdentityKey>,
  context: PipelineContext
) =>
  Effect.try({
    try: () => {
      const pipeline = definition.pipeline;

      if (pipeline === undefined) {
        throw new Error("Migration Definition must declare a pipeline");
      }

      return pipeline(sourceItem, context);
    },
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

const runProcess = <
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
>(
  definition: MigrationDefinition<
    Source,
    Command,
    PipelineError,
    Cursor,
    IdentityKey,
    unknown,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >,
  sourceItem: SourceItem<Source, IdentityKey>,
  context: PipelineContext
) =>
  Effect.try({
    try: () => definition.process?.(sourceItem, context),
    catch: (error) => error as PipelineError | SkipItem,
  }).pipe(
    Effect.flatMap((voidOrEffect) =>
      Effect.isEffect(voidOrEffect)
        ? (voidOrEffect as Effect.Effect<
            void,
            PipelineError | SkipItem,
            MigrationReferenceLookup | Tracking
          >)
        : Effect.void
    )
  );

const processWithProcessPipeline = <
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  SourceInput,
  SourceLayerError,
  SourceRequirements,
>({
  decodedSourceItem,
  definition,
  pipelineContext,
  previousState,
  runId,
  sourceVersionContractContext,
  store,
}: {
  readonly decodedSourceItem: SourceItem<Source, IdentityKey>;
  readonly definition: MigrationDefinition<
    Source,
    Command,
    PipelineError,
    Cursor,
    IdentityKey,
    unknown,
    SourceInput,
    SourceLayerError,
    SourceRequirements
  >;
  readonly pipelineContext: PipelineContext;
  readonly previousState: MigrationItemState | null;
  readonly runId: MigrationRunId;
  readonly sourceVersionContractContext: SourceVersionContractContext;
  readonly store: typeof MigrationStore.Service;
}): Effect.Effect<
  MigrationItemOutcome,
  ProcessSourceItemError,
  MigrationReferenceLookup
> =>
  Effect.gen(function* () {
    const tracking = yield* makeProcessScope({
      definitionId: definition.id,
      runId,
      sourceIdentity: decodedSourceItem.identity.encoded,
      sourceVersion: decodedSourceItem.version,
      ...(previousState === null ? {} : { previousState }),
    });
    const processOutcome = yield* runProcess(
      definition,
      decodedSourceItem,
      pipelineContext
    ).pipe(
      Effect.provide(Layer.succeed(Tracking, tracking)),
      Effect.as({ kind: "migrated" as const }),
      Effect.catchIf(isSkipItem, (skip) =>
        Effect.succeed({
          kind: "skipped",
          reason: skip.reason,
        } satisfies Exclude<
          PipelineOutcome<Command>,
          { readonly kind: "command" }
        >)
      ),
      Effect.catchIf(isMigrationStoreError, (error) => Effect.fail(error)),
      Effect.catch((error) =>
        Effect.succeed({
          kind: "failed",
          error: normalizeItemError("process", error),
        } satisfies Exclude<
          PipelineOutcome<Command>,
          { readonly kind: "command" }
        >)
      )
    );
    const processJournalSegment = yield* tracking.snapshot;
    const processJournal = makeProcessJournal(processJournalSegment);

    if (processOutcome.kind !== "migrated") {
      return yield* persistNonCommandPipelineOutcome({
        decodedSourceItem,
        outcome: processOutcome,
        previousState,
        processJournal,
        runId,
        sourceVersionContractContext,
        store,
      });
    }

    const trackingRecord = yield* resolveProcessTrackingRecord({
      decodedSourceItem,
      definition,
      previousState,
      processJournal,
      runId,
      sourceVersionContractContext,
      store,
      tracking,
    });

    if (trackingRecord === null) {
      return "failed" as const;
    }

    yield* store.upsertItemState(
      makeMigratedItemState(
        sourceVersionContractContext,
        runId,
        decodedSourceItem,
        {
          ...(processJournal === undefined ? {} : { journal: processJournal }),
          ...(trackingRecord === undefined ? {} : { trackingRecord }),
        }
      )
    );

    return "migrated" as const;
  });

export const processSourceItem = <
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
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
  IdentityKey,
  SourceInput,
  SourceLayerError,
  SourceRequirements
>): Effect.Effect<
  MigrationItemOutcome,
  ProcessSourceItemError,
  DestinationPlugin | MigrationReferenceLookup | MigrationStore
> =>
  Effect.gen(function* () {
    const store = yield* MigrationStore;
    const sourceVersionContractContext = {
      definitionId: definition.id,
      sourceVersionContractFingerprint:
        definition.source.sourceVersionContractFingerprint,
    };
    const previousState = yield* store.getItemState(
      definition.id,
      sourceItem.identity.encoded
    );
    const decodedSourceItem = yield* decodeSourceItemOrPersistFailure({
      previousState,
      runId,
      sourceItem,
      sourceSchema,
      sourceVersionContractContext,
      store,
    });

    if (decodedSourceItem === null) {
      return "failed" as const;
    }

    if (
      !reprocessUnchangedTerminal &&
      isUnchangedTerminalState(
        sourceVersionContractContext.sourceVersionContractFingerprint,
        previousState,
        decodedSourceItem
      )
    ) {
      return "unchanged" as const;
    }

    const pipelineContext: PipelineContext = {
      definitionId: definition.id,
      runId,
      ...(previousState === null ? {} : { previousState }),
    };

    if (definition.process !== undefined) {
      return yield* processWithProcessPipeline({
        decodedSourceItem,
        definition,
        pipelineContext,
        previousState,
        runId,
        sourceVersionContractContext,
        store,
      });
    }

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
        outcome: pipelineOutcome,
        previousState,
        runId,
        sourceVersionContractContext,
        store,
      });
    }

    const destinationDefinition = definition.destination;

    if (destinationDefinition === undefined) {
      throw new Error(
        "Migration Definition command-plan pipeline requires a destination"
      );
    }

    const destination = yield* DestinationPlugin;
    const destinationContext: DestinationCommandContext = {
      definitionId: definition.id,
      runId,
      sourceIdentity: decodedSourceItem.identity.encoded,
      sourceVersion: decodedSourceItem.version,
      ...(previousState === null ? {} : { previousState }),
    };

    const destinationOutcome = yield* executeDestinationCommandPlan({
      commandDefinitions: destinationDefinition.commandDefinitions,
      context: destinationContext,
      destination,
      destinationRetry: definition.destinationRetry,
      plan: pipelineOutcome.plan,
    });

    if (destinationOutcome.kind === "failed") {
      yield* store.upsertItemState(
        makeFailedItemState(
          sourceVersionContractContext,
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
        previousState,
        runId,
        sourceVersionContractContext,
        store,
      });

      return "failed" as const;
    }

    yield* store.upsertItemState(
      makeMigratedItemState(
        sourceVersionContractContext,
        runId,
        decodedSourceItem,
        {
          destinationIdentity,
          ...(destinationVersion === undefined ? {} : { destinationVersion }),
        }
      )
    );

    return "migrated" as const;
  });
