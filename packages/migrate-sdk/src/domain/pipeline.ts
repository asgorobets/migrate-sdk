import type { MigrationDefinitionId, MigrationRunId } from "./ids.ts";
import type { MigrationItemState } from "./state.ts";

export interface ProcessContext {
  readonly definitionId: MigrationDefinitionId;
  readonly previousState?: MigrationItemState;
  readonly runId: MigrationRunId;
}
