import type { MigrationDefinitionId, MigrationRunId } from "./ids.ts";
import type { MigrationItemStateForTrackingContract } from "./state.ts";
import type { TrackingRecordContract } from "./tracking.ts";

export interface ProcessContext<
  TrackingContract extends TrackingRecordContract | undefined = undefined,
> {
  readonly definitionId: MigrationDefinitionId;
  readonly previousState?: MigrationItemStateForTrackingContract<TrackingContract>;
  readonly runId: MigrationRunId;
}
