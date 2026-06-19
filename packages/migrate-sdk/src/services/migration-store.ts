import type { Effect } from "effect";
import { Service } from "effect/Context";
import type { MigrationStoreError } from "../domain/errors.ts";
import type {
  EncodedSourceCursor,
  EncodedSourceIdentity,
  MigrationDefinitionId,
  MigrationRunId,
} from "../domain/ids.ts";
import type { MigrationDefinitionLock } from "../domain/lock.ts";
import type { MigrationContract } from "../domain/migration-contract.ts";
import type { MigrationRunState } from "../domain/run.ts";
import type { MigrationItemState } from "../domain/state.ts";
import type { MigrationItemStateSummary } from "../domain/status.ts";

export class MigrationStore extends Service<
  MigrationStore,
  {
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
    ) => Effect.Effect<MigrationRunState | null, MigrationStoreError>;

    readonly beginRun: (
      runId: MigrationRunId,
      definitionIds: readonly MigrationDefinitionId[]
    ) => Effect.Effect<MigrationRunState, MigrationStoreError>;

    readonly completeRun: (
      runId: MigrationRunId,
      definitionIds: readonly MigrationDefinitionId[]
    ) => Effect.Effect<MigrationRunState, MigrationStoreError>;

    readonly failRun: (
      runId: MigrationRunId,
      definitionIds: readonly MigrationDefinitionId[]
    ) => Effect.Effect<MigrationRunState, MigrationStoreError>;

    readonly acquireDefinitionLock: (
      definitionId: MigrationDefinitionId,
      ownerRunId: MigrationRunId
    ) => Effect.Effect<MigrationDefinitionLock, MigrationStoreError>;

    readonly releaseDefinitionLock: (
      lock: MigrationDefinitionLock
    ) => Effect.Effect<void, MigrationStoreError>;
  }
>()("@migrate-sdk/MigrationStore") {}
