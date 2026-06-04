import type { Effect } from "effect";
import { Service } from "effect/Context";
import type { MigrationStoreError } from "../domain/errors.ts";
import type {
  EncodedSourceCursor,
  MigrationDefinitionId,
  MigrationRunId,
  SourceIdentity,
} from "../domain/ids.ts";
import type { MigrationDefinitionLock } from "../domain/lock.ts";
import type { MigrationRunState } from "../domain/run.ts";
import type { MigrationItemState } from "../domain/state.ts";

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

    readonly getItemState: (
      definitionId: MigrationDefinitionId,
      identity: SourceIdentity
    ) => Effect.Effect<MigrationItemState | null, MigrationStoreError>;

    readonly listItemStates: (
      definitionId: MigrationDefinitionId
    ) => Effect.Effect<readonly MigrationItemState[], MigrationStoreError>;

    readonly upsertItemState: (
      state: MigrationItemState
    ) => Effect.Effect<void, MigrationStoreError>;

    readonly createRunId: Effect.Effect<MigrationRunId, MigrationStoreError>;

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
