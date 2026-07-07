import { Effect, Layer, Predicate, Schema } from "effect";
import type {
  MigrationDefinition,
  SourcePayloadSchema,
} from "../domain/definition.ts";
import type { MigrationStoreError, SkipItem } from "../domain/errors.ts";
import type {
  MigrationDefinitionId,
  MigrationRunId,
  SourceIdentitySnapshotKey,
  SourceVersion,
} from "../domain/ids.ts";
import type { SourceVersionContractFingerprint } from "../domain/migration-contract.ts";
import type { ProcessContext } from "../domain/pipeline.ts";
import type { SourceItem } from "../domain/source.ts";
import type {
  FailedItemState,
  MigratedItemState,
  MigrationItemError,
  MigrationItemOutcome,
  MigrationItemState,
  MigrationItemStateBase,
  MigrationItemStateForTrackingContract,
  SkippedItemState,
} from "../domain/state.ts";
import type {
  DestinationJournalSegment,
  TrackingRecord,
  TrackingRecordContract,
  TrackingRecordValue,
} from "../domain/tracking.ts";
import { TrackingRecord as TrackingRecordSchema } from "../domain/tracking.ts";
import type { MigrationReferenceLookup } from "../services/migration-reference-lookup.ts";
import { MigrationStore } from "../services/migration-store.ts";
import {
  makeProcessScope,
  Tracking,
  type TrackingService,
} from "../services/tracking.ts";
import {
  normalizeItemError,
  normalizeSourcePayloadSchemaError,
  normalizeTrackingRecordCountError,
  normalizeTrackingRecordSchemaError,
  normalizeUnexpectedTrackingRecordError,
} from "./item-error.ts";
import { decodeStoredItemStateForTrackingContract } from "./stored-item-state-decode.ts";

export interface ProcessSourceItemOptions<
  Source,
  PipelineError,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  SourceInput = unknown,
  SourceLayerError = never,
  SourceRequirements = never,
  TrackingContract extends TrackingRecordContract | undefined = undefined,
> {
  readonly definition: MigrationDefinition<
    Source,
    PipelineError,
    Cursor,
    IdentityKey,
    unknown,
    SourceInput,
    SourceLayerError,
    SourceRequirements,
    TrackingContract
  >;
  readonly reprocessUnchangedTerminal?: boolean;
  readonly runId: MigrationRunId;
  readonly sourceItem: SourceItem<SourceInput, IdentityKey>;
  readonly sourceSchema: SourcePayloadSchema<Source, SourceInput>;
}

export type ProcessSourceItemError = MigrationStoreError;

type ProcessOutcome =
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

const previousTrackingRecord = (
  previousState: MigrationItemState | null
): TrackingRecord | undefined =>
  previousState !== null && "trackingRecord" in previousState
    ? previousState.trackingRecord
    : undefined;

const makeSkippedItemState = <Source>(
  sourceVersionContractContext: SourceVersionContractContext,
  runId: MigrationRunId,
  sourceItem: SourceItem<Source>,
  reason: string,
  previousState: MigrationItemState | null = null,
  journal?: SkippedItemState["journal"]
): SkippedItemState => {
  const preservedJournal = previousState?.journal ?? journal;
  const trackingRecord = previousTrackingRecord(previousState);

  return {
    ...makeItemStateBase(sourceVersionContractContext, runId, sourceItem),
    ...(preservedJournal === undefined ? {} : { journal: preservedJournal }),
    status: "skipped",
    skipReason: reason,
    ...(trackingRecord === undefined ? {} : { trackingRecord }),
  };
};

const makeFailedItemState = <Source>(
  sourceVersionContractContext: SourceVersionContractContext,
  runId: MigrationRunId,
  sourceItem: SourceItem<Source>,
  error: MigrationItemError,
  previousState: MigrationItemState | null = null,
  journal?: FailedItemState["journal"]
): FailedItemState => {
  const preservedJournal = previousState?.journal ?? journal;
  const trackingRecord = previousTrackingRecord(previousState);

  return {
    ...makeItemStateBase(sourceVersionContractContext, runId, sourceItem),
    ...(preservedJournal === undefined ? {} : { journal: preservedJournal }),
    status: "failed",
    error,
    ...(trackingRecord === undefined ? {} : { trackingRecord }),
  };
};

const makeMigratedItemState = <Source>(
  sourceVersionContractContext: SourceVersionContractContext,
  runId: MigrationRunId,
  sourceItem: SourceItem<Source>,
  result: {
    readonly journal?: MigratedItemState["journal"];
    readonly trackingRecord?: MigratedItemState["trackingRecord"];
  }
): MigratedItemState => {
  return {
    ...makeItemStateBase(sourceVersionContractContext, runId, sourceItem),
    status: "migrated",
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
              processJournal
            )
          )
          .pipe(Effect.as(null))
      )
    );
  });

const persistProcessOutcome = <Source>({
  decodedSourceItem,
  outcome,
  previousState,
  processJournal,
  runId,
  sourceVersionContractContext,
  store,
}: {
  readonly decodedSourceItem: SourceItem<Source>;
  readonly outcome: ProcessOutcome;
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
          previousState,
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

const runProcess = <
  Source,
  PipelineError,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  SourceInput = Source,
  SourceLayerError = never,
  SourceRequirements = never,
  TrackingContract extends TrackingRecordContract | undefined = undefined,
>(
  definition: MigrationDefinition<
    Source,
    PipelineError,
    Cursor,
    IdentityKey,
    unknown,
    SourceInput,
    SourceLayerError,
    SourceRequirements,
    TrackingContract
  >,
  sourceItem: SourceItem<Source, IdentityKey>,
  context: ProcessContext<TrackingContract>
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
  PipelineError,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  SourceInput,
  SourceLayerError,
  SourceRequirements,
  TrackingContract extends TrackingRecordContract | undefined,
>({
  decodedSourceItem,
  definition,
  processContext,
  previousState,
  runId,
  sourceVersionContractContext,
  store,
}: {
  readonly decodedSourceItem: SourceItem<Source, IdentityKey>;
  readonly definition: MigrationDefinition<
    Source,
    PipelineError,
    Cursor,
    IdentityKey,
    unknown,
    SourceInput,
    SourceLayerError,
    SourceRequirements,
    TrackingContract
  >;
  readonly processContext: ProcessContext<TrackingContract>;
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
    });
    const processOutcome = yield* runProcess(
      definition,
      decodedSourceItem,
      processContext
    ).pipe(
      Effect.provide(Layer.succeed(Tracking, tracking)),
      Effect.as({ kind: "migrated" as const }),
      Effect.catchIf(isSkipItem, (skip) =>
        Effect.succeed({
          kind: "skipped",
          reason: skip.reason,
        } satisfies ProcessOutcome)
      ),
      Effect.catchIf(isMigrationStoreError, (error) => Effect.fail(error)),
      Effect.catch((error) =>
        Effect.succeed({
          kind: "failed",
          error: normalizeItemError("process", error),
        } satisfies ProcessOutcome)
      )
    );
    const processJournalSegment = yield* tracking.snapshot;
    const processJournal = makeProcessJournal(processJournalSegment);

    if (processOutcome.kind !== "migrated") {
      return yield* persistProcessOutcome({
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
  PipelineError,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  SourceInput,
  SourceLayerError,
  SourceRequirements,
  TrackingContract extends TrackingRecordContract | undefined,
>({
  definition,
  reprocessUnchangedTerminal = false,
  runId,
  sourceSchema,
  sourceItem,
}: ProcessSourceItemOptions<
  Source,
  PipelineError,
  Cursor,
  IdentityKey,
  SourceInput,
  SourceLayerError,
  SourceRequirements,
  TrackingContract
>): Effect.Effect<
  MigrationItemOutcome,
  ProcessSourceItemError,
  MigrationReferenceLookup | MigrationStore
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

    const typedPreviousState: MigrationItemStateForTrackingContract<TrackingContract> | null =
      previousState === null
        ? null
        : yield* decodeStoredItemStateForTrackingContract<TrackingContract>(
            previousState,
            definition.tracking
          ).pipe(
            Effect.catch((error) =>
              store
                .upsertItemState(
                  makeFailedItemState(
                    sourceVersionContractContext,
                    runId,
                    decodedSourceItem,
                    error,
                    previousState
                  )
                )
                .pipe(Effect.as(null))
            )
          );

    if (previousState !== null && typedPreviousState === null) {
      return "failed" as const;
    }

    const processContext: ProcessContext<TrackingContract> = {
      definitionId: definition.id,
      runId,
      ...(typedPreviousState === null
        ? {}
        : { previousState: typedPreviousState }),
    };

    return yield* processWithProcessPipeline({
      decodedSourceItem,
      definition,
      processContext,
      previousState,
      runId,
      sourceVersionContractContext,
      store,
    });
  });
