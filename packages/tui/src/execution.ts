import type { MigrationDefinitionId, MigrationRunId } from "migrate-sdk";

export type MigrationTuiExecutionState =
  | {
      readonly definitionId: MigrationDefinitionId;
      readonly kind: "starting";
    }
  | {
      readonly adapter: string;
      readonly definitionId: MigrationDefinitionId;
      readonly kind: "running";
      readonly runId: MigrationRunId;
    }
  | {
      readonly adapter: string;
      readonly definitionId: MigrationDefinitionId;
      readonly executionId: string;
      readonly kind: "observing";
      readonly runId: MigrationRunId;
    }
  | {
      readonly definitionId: MigrationDefinitionId;
      readonly kind: "cancelling";
      readonly runId?: MigrationRunId;
    };

export type MigrationTuiCancellationResult =
  | {
      readonly kind: "idle";
    }
  | {
      readonly kind: "requested";
      readonly message: string;
    }
  | {
      readonly kind: "detached";
      readonly message: string;
    };

export interface MigrationTuiExecutionResult {
  readonly message: string;
  readonly outcome: "cancelled" | "completed" | "detached";
  readonly runId: MigrationRunId;
}
