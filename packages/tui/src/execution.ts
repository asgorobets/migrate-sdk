import type { MigrationRunId } from "migrate-sdk";

export interface MigrationTuiExecutionResult {
  readonly message: string;
  readonly outcome: "cancelled" | "completed" | "detached";
  readonly runId: MigrationRunId;
}
