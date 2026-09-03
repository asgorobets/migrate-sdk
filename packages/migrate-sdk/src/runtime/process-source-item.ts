import { DateTime, Effect, Layer, Predicate, Schema } from "effect";
import type {
  MigrationDefinition,
  ProcessBatchItem,
  ProcessBatchPipeline,
  ProcessBatchSettlement,
  ProcessPipeline,
  SourcePayloadSchema,
} from "../domain/definition.ts";
import {
  type MigrationStoreError,
  ProcessBatchContractError,
  type SkipItem,
} from "../domain/errors.ts";
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
  DestinationJournalExtensions,
  DestinationJournalSegment,
  TrackingRecord,
  TrackingRecordContract,
  TrackingRecordValue,
} from "../domain/tracking.ts";
import { TrackingRecord as TrackingRecordSchema } from "../domain/tracking.ts";
import type { MigrationReferenceLookup } from "../services/migration-reference-lookup.ts";
import { MigrationStore } from "../services/migration-store.ts";
import {
  applyJournalExtensions,
  makeProcessScope,
  Tracking,
  type TrackingProcessScope,
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
  Payload,
  PipelineError,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  EncodedPayload = unknown,
  SourceImplementationError = never,
  SourceRequirements = never,
  TrackingContract extends TrackingRecordContract | undefined = undefined,
> {
  readonly definition: MigrationDefinition<
    Payload,
    PipelineError,
    Cursor,
    IdentityKey,
    unknown,
    EncodedPayload,
    SourceImplementationError,
    SourceRequirements,
    TrackingContract
  >;
  readonly reprocessUnchangedTerminal?: boolean;
  readonly runId: MigrationRunId;
  readonly sourceInventoryRunId?: MigrationRunId;
  readonly sourceItem: SourceItem<EncodedPayload, IdentityKey>;
  readonly sourceSchema: SourcePayloadSchema<Payload, EncodedPayload>;
}

export interface ProcessSourceItemsBatchOptions<
  Payload,
  PipelineError,
  Cursor = unknown,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  EncodedPayload = unknown,
  SourceImplementationError = never,
  SourceRequirements = never,
  TrackingContract extends TrackingRecordContract | undefined = undefined,
> extends Omit<
    ProcessSourceItemOptions<
      Payload,
      PipelineError,
      Cursor,
      IdentityKey,
      EncodedPayload,
      SourceImplementationError,
      SourceRequirements,
      TrackingContract
    >,
    "sourceItem"
  > {
  readonly concurrency: number | "unbounded";
  readonly sourceItems: readonly SourceItem<EncodedPayload, IdentityKey>[];
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

const isProcessBatchContractError = (
  error: unknown
): error is ProcessBatchContractError =>
  Predicate.isTagged(error, "ProcessBatchContractError");

const recoverProcessError = (
  error: unknown,
  allowSkip: boolean
): Effect.Effect<ProcessOutcome, MigrationStoreError> => {
  if (allowSkip && isSkipItem(error)) {
    return Effect.succeed({
      kind: "skipped",
      reason: error.reason,
    });
  }
  if (isMigrationStoreError(error)) {
    return Effect.fail(error);
  }
  return Effect.succeed({
    kind: "failed",
    error: normalizeItemError("process", error),
  });
};

interface ItemStateContractContext {
  readonly definitionId: MigrationDefinitionId;
  readonly lastSourceInventoryRunId?: MigrationRunId;
  readonly sourceVersionContractFingerprint: SourceVersionContractFingerprint;
}

interface AdmittedSourceItem<
  Payload,
  TrackingContract extends TrackingRecordContract | undefined,
  IdentityKey extends SourceIdentitySnapshotKey,
> {
  readonly decodedSourceItem: SourceItem<Payload, IdentityKey>;
  readonly previousState: MigrationItemState | null;
  readonly processContext: ProcessContext<TrackingContract>;
  readonly runId: MigrationRunId;
  readonly sourceVersionContractContext: ItemStateContractContext;
}

type SourceItemAdmission<
  Payload,
  TrackingContract extends TrackingRecordContract | undefined,
  IdentityKey extends SourceIdentitySnapshotKey,
> =
  | {
      readonly kind: "admitted";
      readonly item: AdmittedSourceItem<Payload, TrackingContract, IdentityKey>;
    }
  | {
      readonly kind: "completed";
      readonly outcome: MigrationItemOutcome;
    };

const makeItemStateBase = <Payload>(
  sourceVersionContractContext: ItemStateContractContext,
  runId: MigrationRunId,
  sourceItem: SourceItem<Payload>,
  updatedAt: Date
): MigrationItemStateBase & { readonly sourceVersion: SourceVersion } => ({
  definitionId: sourceVersionContractContext.definitionId,
  ...(sourceVersionContractContext.lastSourceInventoryRunId === undefined
    ? {}
    : {
        lastSourceInventoryRunId:
          sourceVersionContractContext.lastSourceInventoryRunId,
      }),
  sourceIdentity: sourceItem.identity,
  sourceVersionContractFingerprint:
    sourceVersionContractContext.sourceVersionContractFingerprint,
  sourceVersion: sourceItem.version,
  lastRunId: runId,
  updatedAt,
});

const previousTrackingRecord = (
  previousState: MigrationItemState | null
): TrackingRecord | undefined =>
  previousState !== null && "trackingRecord" in previousState
    ? previousState.trackingRecord
    : undefined;

const makeSkippedItemState = <Payload>(
  sourceVersionContractContext: ItemStateContractContext,
  runId: MigrationRunId,
  sourceItem: SourceItem<Payload>,
  updatedAt: Date,
  reason: string,
  previousState: MigrationItemState | null = null,
  journal?: SkippedItemState["journal"],
  journalExtensions?: DestinationJournalExtensions
): SkippedItemState => {
  const preservedJournal =
    journalExtensions === undefined
      ? (previousState?.journal ?? journal)
      : applyJournalExtensions(
          previousState?.journal ?? journal,
          journalExtensions,
          runId
        );
  const trackingRecord = previousTrackingRecord(previousState);

  return {
    ...makeItemStateBase(
      sourceVersionContractContext,
      runId,
      sourceItem,
      updatedAt
    ),
    ...(preservedJournal === undefined ? {} : { journal: preservedJournal }),
    status: "skipped",
    skipReason: reason,
    ...(trackingRecord === undefined ? {} : { trackingRecord }),
  };
};

const makeFailedItemState = <Payload>(
  sourceVersionContractContext: ItemStateContractContext,
  runId: MigrationRunId,
  sourceItem: SourceItem<Payload>,
  updatedAt: Date,
  error: MigrationItemError,
  previousState: MigrationItemState | null = null,
  journal?: FailedItemState["journal"],
  journalExtensions?: DestinationJournalExtensions
): FailedItemState => {
  const preservedJournal =
    journalExtensions === undefined
      ? (previousState?.journal ?? journal)
      : applyJournalExtensions(
          previousState?.journal ?? journal,
          journalExtensions,
          runId
        );
  const trackingRecord = previousTrackingRecord(previousState);

  return {
    ...makeItemStateBase(
      sourceVersionContractContext,
      runId,
      sourceItem,
      updatedAt
    ),
    ...(preservedJournal === undefined ? {} : { journal: preservedJournal }),
    status: "failed",
    error,
    ...(trackingRecord === undefined ? {} : { trackingRecord }),
  };
};

const makeMigratedItemState = <Payload>(
  sourceVersionContractContext: ItemStateContractContext,
  runId: MigrationRunId,
  sourceItem: SourceItem<Payload>,
  updatedAt: Date,
  result: {
    readonly journal?: MigratedItemState["journal"];
    readonly trackingRecord?: MigratedItemState["trackingRecord"];
  }
): MigratedItemState => ({
  ...makeItemStateBase(
    sourceVersionContractContext,
    runId,
    sourceItem,
    updatedAt
  ),
  status: "migrated",
  ...(result.journal === undefined ? {} : { journal: result.journal }),
  ...(result.trackingRecord === undefined
    ? {}
    : { trackingRecord: result.trackingRecord }),
});

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

const resolveProcessTrackingRecord = <Payload>({
  decodedSourceItem,
  definition,
  previousState,
  processJournal,
  processJournalExtensions,
  runId,
  sourceVersionContractContext,
  store,
  tracking,
}: {
  readonly decodedSourceItem: SourceItem<Payload>;
  readonly definition: {
    readonly tracking?: TrackingRecordContract | undefined;
  };
  readonly previousState: MigrationItemState | null;
  readonly processJournal?: FailedItemState["journal"];
  readonly processJournalExtensions: DestinationJournalExtensions;
  readonly runId: MigrationRunId;
  readonly sourceVersionContractContext: ItemStateContractContext;
  readonly store: typeof MigrationStore.Service;
  readonly tracking: TrackingProcessScope;
}) =>
  Effect.gen(function* () {
    const trackingRecords = yield* tracking.records;

    return yield* validateStagedTrackingRecord(
      definition.tracking,
      trackingRecords
    ).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const updatedAt = yield* DateTime.nowAsDate;
          yield* store.upsertItemState(
            makeFailedItemState(
              sourceVersionContractContext,
              runId,
              decodedSourceItem,
              updatedAt,
              error,
              previousState,
              processJournal,
              processJournalExtensions
            )
          );
          return null;
        })
      )
    );
  });

const persistProcessOutcome = <Payload>({
  decodedSourceItem,
  outcome,
  previousState,
  processJournal,
  processJournalExtensions,
  runId,
  sourceVersionContractContext,
  store,
}: {
  readonly decodedSourceItem: SourceItem<Payload>;
  readonly outcome: ProcessOutcome;
  readonly previousState: MigrationItemState | null;
  readonly processJournal?: FailedItemState["journal"];
  readonly processJournalExtensions: DestinationJournalExtensions;
  readonly runId: MigrationRunId;
  readonly sourceVersionContractContext: ItemStateContractContext;
  readonly store: typeof MigrationStore.Service;
}) =>
  Effect.gen(function* () {
    const updatedAt = yield* DateTime.nowAsDate;

    if (outcome.kind === "skipped") {
      yield* store.upsertItemState(
        makeSkippedItemState(
          sourceVersionContractContext,
          runId,
          decodedSourceItem,
          updatedAt,
          outcome.reason,
          previousState,
          processJournal,
          processJournalExtensions
        )
      );
      return "skipped" as const;
    }

    yield* store.upsertItemState(
      makeFailedItemState(
        sourceVersionContractContext,
        runId,
        decodedSourceItem,
        updatedAt,
        outcome.error,
        previousState,
        processJournal,
        processJournalExtensions
      )
    );
    return "failed" as const;
  });

const isUnchangedTerminalState = <
  Payload,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  sourceVersionContractFingerprint: SourceVersionContractFingerprint,
  previousState: MigrationItemState | null,
  sourceItem: SourceItem<Payload, IdentityKey>
): boolean =>
  previousState?.status === "migrated" &&
  previousState.sourceVersionContractFingerprint ===
    sourceVersionContractFingerprint &&
  previousState.sourceVersion === sourceItem.version;

const decodeSourceItem = <
  Payload,
  EncodedPayload,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  sourceSchema: SourcePayloadSchema<Payload, EncodedPayload>,
  sourceItem: SourceItem<EncodedPayload, IdentityKey>
) =>
  Schema.decodeUnknownEffect(sourceSchema, { errors: "all" })(
    sourceItem.item
  ).pipe(
    Effect.map(
      (item): SourceItem<Payload, IdentityKey> => ({
        ...sourceItem,
        item,
      })
    )
  );

const decodeSourceItemOrPersistFailure = <
  Payload,
  EncodedPayload,
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
  readonly sourceItem: SourceItem<EncodedPayload, IdentityKey>;
  readonly sourceSchema: SourcePayloadSchema<Payload, EncodedPayload>;
  readonly sourceVersionContractContext: ItemStateContractContext;
  readonly store: typeof MigrationStore.Service;
}): Effect.Effect<
  SourceItem<Payload, IdentityKey> | null,
  MigrationStoreError
> =>
  decodeSourceItem(sourceSchema, sourceItem).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const updatedAt = yield* DateTime.nowAsDate;
        yield* store.upsertItemState(
          makeFailedItemState(
            sourceVersionContractContext,
            runId,
            sourceItem,
            updatedAt,
            normalizeSourcePayloadSchemaError(error),
            previousState
          )
        );
        return null;
      })
    )
  );

const runProcess = <
  Payload,
  PipelineError,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  TrackingContract extends TrackingRecordContract | undefined = undefined,
>(
  process: ProcessPipeline<
    Payload,
    PipelineError,
    IdentityKey,
    TrackingContract
  >,
  sourceItem: SourceItem<Payload, IdentityKey>,
  context: ProcessContext<TrackingContract>
) =>
  Effect.try({
    try: () => process(sourceItem, context),
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

const settleAdmittedSourceItem = <
  Payload,
  PipelineError,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  EncodedPayload,
  SourceImplementationError,
  SourceRequirements,
  TrackingContract extends TrackingRecordContract | undefined,
>({
  admitted,
  allowSkip = true,
  definition,
  effect,
}: {
  readonly admitted: AdmittedSourceItem<Payload, TrackingContract, IdentityKey>;
  readonly allowSkip?: boolean;
  readonly definition: MigrationDefinition<
    Payload,
    PipelineError,
    Cursor,
    IdentityKey,
    unknown,
    EncodedPayload,
    SourceImplementationError,
    SourceRequirements,
    TrackingContract
  >;
  readonly effect: Effect.Effect<
    void,
    PipelineError | SkipItem,
    MigrationReferenceLookup | Tracking
  >;
}): Effect.Effect<
  MigrationItemOutcome,
  ProcessSourceItemError,
  MigrationReferenceLookup | MigrationStore
> =>
  Effect.gen(function* () {
    const {
      decodedSourceItem,
      previousState,
      runId,
      sourceVersionContractContext,
    } = admitted;
    const store = yield* MigrationStore;
    const tracking = yield* makeProcessScope({
      ...(previousState?.journal?.extensions === undefined
        ? {}
        : { extensions: previousState.journal.extensions }),
      runId,
      sourceIdentity: decodedSourceItem.identity.encoded,
    });
    const processOutcome = yield* effect.pipe(
      Effect.provide(Layer.succeed(Tracking, tracking.service)),
      Effect.as({ kind: "migrated" as const }),
      Effect.catch((error) => recoverProcessError(error, allowSkip))
    );
    const processJournalSegment = yield* tracking.snapshot;
    const processJournal = makeProcessJournal(processJournalSegment);
    const processJournalExtensions = yield* tracking.extensions;

    if (processOutcome.kind !== "migrated") {
      return yield* persistProcessOutcome({
        decodedSourceItem,
        outcome: processOutcome,
        previousState,
        processJournal,
        processJournalExtensions,
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
      processJournalExtensions,
      runId,
      sourceVersionContractContext,
      store,
      tracking,
    });

    if (trackingRecord === null) {
      return "failed" as const;
    }

    const updatedAt = yield* DateTime.nowAsDate;
    const migratedJournal = applyJournalExtensions(
      processJournal,
      processJournalExtensions,
      runId
    );
    yield* store.upsertItemState(
      makeMigratedItemState(
        sourceVersionContractContext,
        runId,
        decodedSourceItem,
        updatedAt,
        {
          ...(migratedJournal === undefined
            ? {}
            : { journal: migratedJournal }),
          ...(trackingRecord === undefined ? {} : { trackingRecord }),
        }
      )
    );

    return "migrated" as const;
  });

const admitSourceItem = <
  Payload,
  PipelineError,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  EncodedPayload,
  SourceImplementationError,
  SourceRequirements,
  TrackingContract extends TrackingRecordContract | undefined,
>({
  definition,
  reprocessUnchangedTerminal = false,
  runId,
  sourceInventoryRunId,
  sourceSchema,
  sourceItem,
}: ProcessSourceItemOptions<
  Payload,
  PipelineError,
  Cursor,
  IdentityKey,
  EncodedPayload,
  SourceImplementationError,
  SourceRequirements,
  TrackingContract
>): Effect.Effect<
  SourceItemAdmission<Payload, TrackingContract, IdentityKey>,
  ProcessSourceItemError,
  MigrationStore
> =>
  Effect.gen(function* () {
    const store = yield* MigrationStore;
    const previousState = yield* store.getItemState(
      definition.id,
      sourceItem.identity.encoded
    );
    const lastSourceInventoryRunId =
      sourceInventoryRunId ?? previousState?.lastSourceInventoryRunId;
    const sourceVersionContractContext = {
      definitionId: definition.id,
      ...(lastSourceInventoryRunId === undefined
        ? {}
        : { lastSourceInventoryRunId }),
      sourceVersionContractFingerprint:
        definition.source.sourceVersionContractFingerprint,
    };
    const decodedSourceItem = yield* decodeSourceItemOrPersistFailure({
      previousState,
      runId,
      sourceItem,
      sourceSchema,
      sourceVersionContractContext,
      store,
    });

    if (decodedSourceItem === null) {
      return { kind: "completed" as const, outcome: "failed" as const };
    }

    const typedPreviousState: MigrationItemStateForTrackingContract<TrackingContract> | null =
      previousState === null
        ? null
        : yield* decodeStoredItemStateForTrackingContract<TrackingContract>(
            previousState,
            definition.tracking
          ).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                const updatedAt = yield* DateTime.nowAsDate;
                yield* store.upsertItemState(
                  makeFailedItemState(
                    sourceVersionContractContext,
                    runId,
                    decodedSourceItem,
                    updatedAt,
                    error,
                    previousState
                  )
                );
                return null;
              })
            )
          );

    if (previousState !== null && typedPreviousState === null) {
      return { kind: "completed" as const, outcome: "failed" as const };
    }

    if (
      !reprocessUnchangedTerminal &&
      isUnchangedTerminalState(
        sourceVersionContractContext.sourceVersionContractFingerprint,
        previousState,
        decodedSourceItem
      )
    ) {
      return { kind: "completed" as const, outcome: "unchanged" as const };
    }

    const processContext: ProcessContext<TrackingContract> = {
      definitionId: definition.id,
      runId,
      ...(typedPreviousState === null
        ? {}
        : { previousState: typedPreviousState }),
    };

    return {
      kind: "admitted" as const,
      item: {
        decodedSourceItem,
        previousState,
        processContext,
        runId,
        sourceVersionContractContext,
      },
    };
  });

export const processSourceItem = <
  Payload,
  PipelineError,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  EncodedPayload,
  SourceImplementationError,
  SourceRequirements,
  TrackingContract extends TrackingRecordContract | undefined,
>({
  definition,
  reprocessUnchangedTerminal = false,
  runId,
  sourceInventoryRunId,
  sourceSchema,
  sourceItem,
}: ProcessSourceItemOptions<
  Payload,
  PipelineError,
  Cursor,
  IdentityKey,
  EncodedPayload,
  SourceImplementationError,
  SourceRequirements,
  TrackingContract
>): Effect.Effect<
  MigrationItemOutcome,
  ProcessSourceItemError,
  MigrationReferenceLookup | MigrationStore
> =>
  Effect.gen(function* () {
    const admission = yield* admitSourceItem({
      definition,
      reprocessUnchangedTerminal,
      runId,
      ...(sourceInventoryRunId === undefined ? {} : { sourceInventoryRunId }),
      sourceItem,
      sourceSchema,
    });

    if (admission.kind === "completed") {
      return admission.outcome;
    }

    const process = definition.process;

    if (process === undefined) {
      return yield* Effect.die(
        "processSourceItem requires a Process Pipeline definition"
      );
    }

    return yield* settleAdmittedSourceItem({
      admitted: admission.item,
      definition,
      effect: runProcess(
        process,
        admission.item.decodedSourceItem,
        admission.item.processContext
      ),
    });
  });

interface ProcessBatchSettlementMetadata {
  readonly batchToken: object;
  readonly itemToken: object;
}

const processBatchSettlementMetadata = new WeakMap<
  object,
  ProcessBatchSettlementMetadata
>();

interface PreparedProcessBatchItem<
  Payload,
  TrackingContract extends TrackingRecordContract | undefined,
  IdentityKey extends SourceIdentitySnapshotKey,
> {
  readonly admitted: AdmittedSourceItem<Payload, TrackingContract, IdentityKey>;
  readonly itemToken: object;
}

interface ValidatedProcessBatchSettlement<
  Payload,
  PipelineError,
  TrackingContract extends TrackingRecordContract | undefined,
  IdentityKey extends SourceIdentitySnapshotKey,
> {
  readonly admitted: AdmittedSourceItem<Payload, TrackingContract, IdentityKey>;
  readonly effect: Effect.Effect<
    void,
    PipelineError | SkipItem,
    MigrationReferenceLookup | Tracking
  >;
}

const makeProcessBatchItems = <
  Payload,
  PipelineError,
  TrackingContract extends TrackingRecordContract | undefined,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  admittedItems: readonly AdmittedSourceItem<
    Payload,
    TrackingContract,
    IdentityKey
  >[]
) => {
  const batchToken = {};
  const effectsBySettlement = new Map<
    ProcessBatchSettlement,
    Effect.Effect<
      void,
      PipelineError | SkipItem,
      MigrationReferenceLookup | Tracking
    >
  >();
  const prepared = admittedItems.map(
    (
      admitted
    ): PreparedProcessBatchItem<Payload, TrackingContract, IdentityKey> => ({
      admitted,
      itemToken: {},
    })
  );
  const items = prepared.map(
    ({
      admitted,
      itemToken,
    }): ProcessBatchItem<
      Payload,
      PipelineError,
      IdentityKey,
      TrackingContract
    > => ({
      context: admitted.processContext,
      settle: (effect) => {
        const settlement = {} as ProcessBatchSettlement;
        processBatchSettlementMetadata.set(settlement, {
          batchToken,
          itemToken,
        });
        effectsBySettlement.set(settlement, effect);
        return Object.freeze(settlement);
      },
      source: admitted.decodedSourceItem,
    })
  ) as unknown as readonly [
    ProcessBatchItem<Payload, PipelineError, IdentityKey, TrackingContract>,
    ...ProcessBatchItem<
      Payload,
      PipelineError,
      IdentityKey,
      TrackingContract
    >[],
  ];

  return { batchToken, effectsBySettlement, items, prepared };
};

const processBatchContractError = (
  definitionId: MigrationDefinitionId,
  cause: unknown
) =>
  new ProcessBatchContractError({
    message: "Process Batch settlements did not match admitted Source Items",
    cause: { definitionId, contract: cause },
  });

const validateProcessBatchSettlements = <
  Payload,
  PipelineError,
  TrackingContract extends TrackingRecordContract | undefined,
  IdentityKey extends SourceIdentitySnapshotKey,
>({
  batchToken,
  definitionId,
  effectsBySettlement,
  prepared,
  settlements,
}: {
  readonly batchToken: object;
  readonly definitionId: MigrationDefinitionId;
  readonly effectsBySettlement: ReadonlyMap<
    ProcessBatchSettlement,
    Effect.Effect<
      void,
      PipelineError | SkipItem,
      MigrationReferenceLookup | Tracking
    >
  >;
  readonly prepared: readonly PreparedProcessBatchItem<
    Payload,
    TrackingContract,
    IdentityKey
  >[];
  readonly settlements: readonly ProcessBatchSettlement[];
}): Effect.Effect<
  readonly ValidatedProcessBatchSettlement<
    Payload,
    PipelineError,
    TrackingContract,
    IdentityKey
  >[],
  ProcessBatchContractError
> =>
  Effect.gen(function* () {
    if (!Array.isArray(settlements)) {
      return yield* processBatchContractError(definitionId, {
        reason: "settlements-not-array",
      });
    }

    const metadataByItemToken = new Map<
      object,
      ProcessBatchSettlementMetadata
    >();
    const settlementByItemToken = new Map<object, ProcessBatchSettlement>();
    let foreignCount = 0;
    const duplicateSourceIdentities: string[] = [];

    for (const settlement of settlements) {
      const metadata =
        typeof settlement === "object" && settlement !== null
          ? processBatchSettlementMetadata.get(settlement)
          : undefined;

      if (metadata === undefined || metadata.batchToken !== batchToken) {
        foreignCount += 1;
        continue;
      }

      if (metadataByItemToken.has(metadata.itemToken)) {
        const duplicate = prepared.find(
          (item) => item.itemToken === metadata.itemToken
        );
        if (duplicate !== undefined) {
          duplicateSourceIdentities.push(
            duplicate.admitted.decodedSourceItem.identity.encoded
          );
        }
        continue;
      }

      metadataByItemToken.set(metadata.itemToken, metadata);
      settlementByItemToken.set(metadata.itemToken, settlement);
    }

    const missingSourceIdentities = prepared
      .filter((item) => !metadataByItemToken.has(item.itemToken))
      .map((item) => item.admitted.decodedSourceItem.identity.encoded);

    if (
      foreignCount > 0 ||
      duplicateSourceIdentities.length > 0 ||
      missingSourceIdentities.length > 0
    ) {
      return yield* processBatchContractError(definitionId, {
        duplicateSourceIdentities,
        foreignCount,
        missingSourceIdentities,
      });
    }

    return prepared.map((item) => {
      const metadata = metadataByItemToken.get(item.itemToken);
      const settlement = settlementByItemToken.get(item.itemToken);
      const effect =
        settlement === undefined
          ? undefined
          : effectsBySettlement.get(settlement);

      if (metadata === undefined || effect === undefined) {
        throw new Error("Validated Process Batch settlement was missing");
      }

      return {
        admitted: item.admitted,
        effect,
      };
    });
  });

const runProcessBatch = <
  Payload,
  PipelineError,
  IdentityKey extends SourceIdentitySnapshotKey,
  TrackingContract extends TrackingRecordContract | undefined,
>(
  processBatch: ProcessBatchPipeline<
    Payload,
    PipelineError,
    IdentityKey,
    TrackingContract
  >,
  items: readonly [
    ProcessBatchItem<Payload, PipelineError, IdentityKey, TrackingContract>,
    ...ProcessBatchItem<
      Payload,
      PipelineError,
      IdentityKey,
      TrackingContract
    >[],
  ]
) =>
  Effect.try({
    try: () => processBatch(items),
    catch: (error) => error as PipelineError,
  }).pipe(
    Effect.flatMap((settlementsOrEffect) =>
      Effect.isEffect(settlementsOrEffect)
        ? settlementsOrEffect
        : Effect.succeed(settlementsOrEffect)
    )
  );

type ProcessBatchInvocationResult =
  | {
      readonly error: unknown;
      readonly kind: "failed";
    }
  | {
      readonly kind: "settlements";
      readonly settlements: readonly ProcessBatchSettlement[];
    };

const recoverProcessBatchError = (
  error: unknown
): Effect.Effect<
  ProcessBatchInvocationResult,
  MigrationStoreError | ProcessBatchContractError
> =>
  isMigrationStoreError(error) || isProcessBatchContractError(error)
    ? Effect.fail(error)
    : Effect.succeed({ kind: "failed", error });

export type ProcessSourceItemsBatchError =
  | MigrationStoreError
  | ProcessBatchContractError;

export const processSourceItemsBatch = <
  Payload,
  PipelineError,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  EncodedPayload,
  SourceImplementationError,
  SourceRequirements,
  TrackingContract extends TrackingRecordContract | undefined,
>({
  concurrency,
  definition,
  reprocessUnchangedTerminal = false,
  runId,
  sourceInventoryRunId,
  sourceItems,
  sourceSchema,
}: ProcessSourceItemsBatchOptions<
  Payload,
  PipelineError,
  Cursor,
  IdentityKey,
  EncodedPayload,
  SourceImplementationError,
  SourceRequirements,
  TrackingContract
>): Effect.Effect<
  readonly MigrationItemOutcome[],
  ProcessSourceItemsBatchError,
  MigrationReferenceLookup | MigrationStore
> =>
  Effect.gen(function* () {
    if (sourceItems.length === 0) {
      return [];
    }

    const admissions = yield* Effect.forEach(
      sourceItems,
      (sourceItem) =>
        admitSourceItem({
          definition,
          reprocessUnchangedTerminal,
          runId,
          ...(sourceInventoryRunId === undefined
            ? {}
            : { sourceInventoryRunId }),
          sourceItem,
          sourceSchema,
        }),
      { concurrency }
    );
    const admittedItems = admissions.flatMap((admission) =>
      admission.kind === "admitted" ? [admission.item] : []
    );

    if (admittedItems.length === 0) {
      return admissions.map((admission) => {
        if (admission.kind === "admitted") {
          throw new Error("Admitted Process Batch Item was not settled");
        }
        return admission.outcome;
      });
    }

    const processBatch = definition.processBatch;

    if (processBatch === undefined) {
      return yield* new ProcessBatchContractError({
        message: "Migration Definition does not declare processBatch",
        cause: { definitionId: definition.id },
      });
    }

    const preparedBatch = makeProcessBatchItems<
      Payload,
      PipelineError,
      TrackingContract,
      IdentityKey
    >(admittedItems);
    const invocation = yield* runProcessBatch(
      processBatch,
      preparedBatch.items
    ).pipe(
      Effect.map(
        (settlements): ProcessBatchInvocationResult => ({
          kind: "settlements",
          settlements,
        })
      ),
      Effect.catch(recoverProcessBatchError)
    );
    const settledOutcomes =
      invocation.kind === "failed"
        ? yield* Effect.forEach(
            admittedItems,
            (admitted) =>
              settleAdmittedSourceItem({
                admitted,
                allowSkip: false,
                definition,
                effect: Effect.fail(invocation.error),
              }),
            { concurrency }
          )
        : yield* validateProcessBatchSettlements<
            Payload,
            PipelineError,
            TrackingContract,
            IdentityKey
          >({
            batchToken: preparedBatch.batchToken,
            definitionId: definition.id,
            effectsBySettlement: preparedBatch.effectsBySettlement,
            prepared: preparedBatch.prepared,
            settlements: invocation.settlements,
          }).pipe(
            Effect.flatMap((settlements) =>
              Effect.forEach(
                settlements,
                (settlement) =>
                  settleAdmittedSourceItem({
                    admitted: settlement.admitted,
                    definition,
                    effect: settlement.effect,
                  }),
                { concurrency }
              )
            )
          );
    let settledIndex = 0;

    return admissions.map((admission) => {
      if (admission.kind === "completed") {
        return admission.outcome;
      }

      const outcome = settledOutcomes[settledIndex];
      settledIndex += 1;

      if (outcome === undefined) {
        throw new Error("Process Batch settlement outcome was missing");
      }

      return outcome;
    });
  });
