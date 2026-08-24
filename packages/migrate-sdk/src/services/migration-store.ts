import { Effect } from "effect";
import { Service } from "effect/Context";
import { MigrationStoreError } from "../domain/errors.ts";
import type {
  EncodedSourceCursor,
  EncodedSourceIdentity,
  MigrationDefinitionId,
  MigrationRunId,
} from "../domain/ids.ts";
import type { MigrationDefinitionLock } from "../domain/lock.ts";
import type { MigrationContract } from "../domain/migration-contract.ts";
import type {
  MigrationDefinitionRunOutcome,
  MigrationDefinitionRunState,
  MigrationExecutionHandle,
  MigrationRunState,
} from "../domain/run.ts";
import type { MigrationItemState } from "../domain/state.ts";
import type { MigrationItemStateSummary } from "../domain/status.ts";

export interface OrphanItemStatePage {
  readonly items: readonly MigrationItemState[];
  readonly nextAfterIdentity?: EncodedSourceIdentity;
}

export interface OrphanItemStatePageInput {
  readonly afterIdentity?: EncodedSourceIdentity;
  readonly limit: number;
}

export type MigrationDefinitionRunOutcomeMap = ReadonlyMap<
  MigrationDefinitionId,
  MigrationDefinitionRunOutcome["status"]
>;

export const validateMigrationDefinitionRunOutcomes = (
  definitionIds: readonly MigrationDefinitionId[],
  outcomes: readonly MigrationDefinitionRunOutcome[]
): Effect.Effect<MigrationDefinitionRunOutcomeMap, MigrationStoreError> =>
  Effect.gen(function* () {
    const expectedDefinitionIds = new Set(definitionIds);
    const outcomeByDefinitionId = new Map<
      MigrationDefinitionId,
      MigrationDefinitionRunOutcome["status"]
    >();
    const duplicateDefinitionIds: MigrationDefinitionId[] = [];
    const unexpectedDefinitionIds: MigrationDefinitionId[] = [];

    for (const outcome of outcomes) {
      if (!expectedDefinitionIds.has(outcome.definitionId)) {
        unexpectedDefinitionIds.push(outcome.definitionId);
        continue;
      }

      if (outcomeByDefinitionId.has(outcome.definitionId)) {
        duplicateDefinitionIds.push(outcome.definitionId);
        continue;
      }

      outcomeByDefinitionId.set(outcome.definitionId, outcome.status);
    }

    const missingDefinitionIds = definitionIds.filter(
      (definitionId) => !outcomeByDefinitionId.has(definitionId)
    );

    if (
      missingDefinitionIds.length > 0 ||
      duplicateDefinitionIds.length > 0 ||
      unexpectedDefinitionIds.length > 0
    ) {
      return yield* new MigrationStoreError({
        message:
          "Migration Definition Run outcomes must match the Migration Run definitions",
        cause: {
          duplicateDefinitionIds,
          missingDefinitionIds,
          unexpectedDefinitionIds,
        },
      });
    }

    return outcomeByDefinitionId;
  });

export const migrationDefinitionRunStatus = (
  definitionId: MigrationDefinitionId,
  runStatus: MigrationRunState["status"],
  outcomes?: MigrationDefinitionRunOutcomeMap
): MigrationDefinitionRunState["status"] =>
  outcomes?.get(definitionId) ?? runStatus;

interface MigrationStoreOrphanMethods {
  /**
   * Lists states not observed by `sourceInventoryRunId` in a stable order
   * derived from Encoded Source Identity. `afterIdentity` is an exclusive
   * keyset cursor.
   */
  readonly listOrphanItemStates: (
    definitionId: MigrationDefinitionId,
    sourceInventoryRunId: MigrationRunId,
    page: OrphanItemStatePageInput
  ) => Effect.Effect<OrphanItemStatePage, MigrationStoreError>;

  /** Marks an existing state as observed without inserting a missing state. */
  readonly observeItemState: (
    definitionId: MigrationDefinitionId,
    identity: EncodedSourceIdentity,
    sourceInventoryRunId: MigrationRunId
  ) => Effect.Effect<void, MigrationStoreError>;
}

export class MigrationStore extends Service<
  MigrationStore,
  {
    readonly listOrphanItemStates: MigrationStoreOrphanMethods["listOrphanItemStates"];

    readonly observeItemState: MigrationStoreOrphanMethods["observeItemState"];

    readonly getSourceCursor: (
      definitionId: MigrationDefinitionId
    ) => Effect.Effect<EncodedSourceCursor | null, MigrationStoreError>;

    readonly setSourceCursor: (
      definitionId: MigrationDefinitionId,
      cursor: EncodedSourceCursor
    ) => Effect.Effect<void, MigrationStoreError>;

    readonly deleteSourceCursor: (
      definitionId: MigrationDefinitionId
    ) => Effect.Effect<void, MigrationStoreError>;

    readonly getMigrationContract: (
      definitionId: MigrationDefinitionId
    ) => Effect.Effect<MigrationContract | null, MigrationStoreError>;

    readonly upsertMigrationContract: (
      contract: MigrationContract
    ) => Effect.Effect<void, MigrationStoreError>;

    readonly getItemState: (
      definitionId: MigrationDefinitionId,
      identity: EncodedSourceIdentity
    ) => Effect.Effect<MigrationItemState | null, MigrationStoreError>;

    readonly listItemStates: (
      definitionId: MigrationDefinitionId
    ) => Effect.Effect<readonly MigrationItemState[], MigrationStoreError>;

    readonly getItemStateSummary: (
      definitionId: MigrationDefinitionId
    ) => Effect.Effect<MigrationItemStateSummary, MigrationStoreError>;

    readonly deleteItemState: (
      definitionId: MigrationDefinitionId,
      identity: EncodedSourceIdentity
    ) => Effect.Effect<void, MigrationStoreError>;

    readonly upsertItemState: (
      state: MigrationItemState
    ) => Effect.Effect<void, MigrationStoreError>;

    readonly createRunId: Effect.Effect<MigrationRunId, MigrationStoreError>;

    readonly getLatestRunState: (
      definitionId: MigrationDefinitionId
    ) => Effect.Effect<MigrationDefinitionRunState | null, MigrationStoreError>;

    readonly beginRun: (
      runId: MigrationRunId,
      definitionIds: readonly MigrationDefinitionId[]
    ) => Effect.Effect<MigrationRunState, MigrationStoreError>;

    readonly queueRun: (
      runId: MigrationRunId,
      definitionIds: readonly MigrationDefinitionId[]
    ) => Effect.Effect<MigrationRunState, MigrationStoreError>;

    readonly attachRunExecution: (
      runId: MigrationRunId,
      definitionIds: readonly MigrationDefinitionId[],
      execution: MigrationExecutionHandle
    ) => Effect.Effect<MigrationRunState, MigrationStoreError>;

    readonly markRunStartFailed: (
      runId: MigrationRunId,
      definitionIds: readonly MigrationDefinitionId[]
    ) => Effect.Effect<MigrationRunState, MigrationStoreError>;

    readonly markRunCancelled: (
      runId: MigrationRunId,
      definitionIds: readonly MigrationDefinitionId[]
    ) => Effect.Effect<MigrationRunState, MigrationStoreError>;

    readonly completeRun: (
      runId: MigrationRunId,
      definitionIds: readonly MigrationDefinitionId[],
      definitionOutcomes: readonly MigrationDefinitionRunOutcome[]
    ) => Effect.Effect<MigrationRunState, MigrationStoreError>;

    readonly failRun: (
      runId: MigrationRunId,
      definitionIds: readonly MigrationDefinitionId[],
      definitionOutcomes: readonly MigrationDefinitionRunOutcome[]
    ) => Effect.Effect<MigrationRunState, MigrationStoreError>;

    readonly acquireDefinitionLock: (
      definitionId: MigrationDefinitionId,
      ownerRunId: MigrationRunId
    ) => Effect.Effect<MigrationDefinitionLock, MigrationStoreError>;

    readonly getDefinitionLock: (
      definitionId: MigrationDefinitionId
    ) => Effect.Effect<MigrationDefinitionLock | null, MigrationStoreError>;

    readonly assertDefinitionLocks: (
      locks: readonly MigrationDefinitionLock[]
    ) => Effect.Effect<void, MigrationStoreError>;

    readonly releaseDefinitionLock: (
      lock: MigrationDefinitionLock
    ) => Effect.Effect<void, MigrationStoreError>;

    readonly breakDefinitionLock: (
      definitionId: MigrationDefinitionId
    ) => Effect.Effect<MigrationDefinitionLock | null, MigrationStoreError>;
  }
>()("@migrate-sdk/MigrationStore") {}
