export interface WorkflowSdkMigrationDefinitionLock {
  readonly definitionId: string;
  readonly ownerRunId: string;
  readonly token: string;
}

export interface WorkflowSdkMigrationRunEnvelope {
  readonly executionDefinitionIds: readonly string[];
  readonly kind: "run";
  readonly locks: readonly WorkflowSdkMigrationDefinitionLock[];
  readonly registryId: string;
  readonly request: unknown;
  readonly runId: string;
  readonly scopeDefinitionIds: readonly string[];
}

export interface WorkflowSdkMigrationDefinitionRunCounts {
  readonly failed: number;
  readonly migrated: number;
  readonly needsUpdate: number;
  readonly orphaned?: number;
  readonly rollbackFailed?: number;
  readonly rolledBack?: number;
  readonly skipped: number;
  readonly unchanged: number;
}

export interface WorkflowSdkMigrationDefinitionRunSummary {
  readonly counts: WorkflowSdkMigrationDefinitionRunCounts;
  readonly definitionId: string;
  readonly status: "failed" | "skipped" | "succeeded";
}

export interface WorkflowSdkMigrationRunSummary {
  readonly definitions: readonly WorkflowSdkMigrationDefinitionRunSummary[];
  readonly finishedAt: Date;
  readonly runId: string;
  readonly startedAt: Date;
  readonly status: "failed" | "succeeded";
}

export interface WorkflowSdkMigrationRunCursorWindowState {
  readonly counts: WorkflowSdkMigrationDefinitionRunCounts;
  readonly excludedSourceIdentities: readonly string[];
  readonly phase: "scan";
}

export interface WorkflowSdkMigrationRunRollbackOrphansState {
  readonly afterIdentity?: string;
  readonly orphaned: number;
  readonly phase: "rollback";
  readonly rollbackFailed: number;
  readonly rolledBack: number;
}

export type WorkflowSdkMigrationRunRollbackOrphansPageResult =
  | {
      readonly kind: "cancelled";
      readonly state: WorkflowSdkMigrationRunRollbackOrphansState;
    }
  | {
      readonly kind: "continue";
      readonly state: WorkflowSdkMigrationRunRollbackOrphansState;
    }
  | {
      readonly kind: "completed";
      readonly state: WorkflowSdkMigrationRunRollbackOrphansState;
    };

export type WorkflowSdkMigrationRunCursorWindowResult =
  | {
      readonly kind: "cancelled";
      readonly state: WorkflowSdkMigrationRunCursorWindowState;
    }
  | {
      readonly kind: "continue";
      readonly state: WorkflowSdkMigrationRunCursorWindowState;
    }
  | {
      readonly kind: "definition-completed";
      readonly state: WorkflowSdkMigrationRunCursorWindowState;
      readonly summary: WorkflowSdkMigrationDefinitionRunSummary;
    };

export interface WorkflowSdkMigrationRunSteps {
  readonly begin: (
    envelope: WorkflowSdkMigrationRunEnvelope
  ) => Promise<{ readonly rollbackOrphans: boolean }>;
  readonly complete: (input: {
    readonly definitions: WorkflowSdkMigrationRunSummary["definitions"];
    readonly envelope: WorkflowSdkMigrationRunEnvelope;
  }) => Promise<WorkflowSdkMigrationRunSummary>;
  readonly executeCursorWindow: (input: {
    readonly definitionId: string;
    readonly envelope: WorkflowSdkMigrationRunEnvelope;
    readonly runId: WorkflowSdkMigrationRunEnvelope["runId"];
    readonly state: WorkflowSdkMigrationRunCursorWindowState;
  }) => Promise<WorkflowSdkMigrationRunCursorWindowResult>;
  readonly executeRollbackOrphansPage: (input: {
    readonly definitionId: string;
    readonly envelope: WorkflowSdkMigrationRunEnvelope;
    readonly runId: WorkflowSdkMigrationRunEnvelope["runId"];
    readonly state: WorkflowSdkMigrationRunRollbackOrphansState;
  }) => Promise<WorkflowSdkMigrationRunRollbackOrphansPageResult>;
  readonly fail: (input: {
    readonly envelope: WorkflowSdkMigrationRunEnvelope;
    readonly error: unknown;
  }) => Promise<void>;
}

const emptyCursorWindowState: WorkflowSdkMigrationRunCursorWindowState = {
  counts: {
    failed: 0,
    migrated: 0,
    needsUpdate: 0,
    skipped: 0,
    unchanged: 0,
  },
  excludedSourceIdentities: [],
  phase: "scan",
};

const serializeWorkflowError = (error: unknown) => {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }

  return {
    message: String(error),
  };
};

export const runMigrationExecutionWorkflow = async (
  envelope: WorkflowSdkMigrationRunEnvelope,
  steps: WorkflowSdkMigrationRunSteps
): Promise<WorkflowSdkMigrationRunSummary> => {
  const definitions: WorkflowSdkMigrationDefinitionRunSummary[] = [];

  try {
    const execution = await steps.begin(envelope);

    for (const definitionId of envelope.executionDefinitionIds) {
      let state = emptyCursorWindowState;

      while (true) {
        const result = await steps.executeCursorWindow({
          definitionId,
          envelope,
          runId: envelope.runId,
          state,
        });

        state = result.state;

        if (result.kind === "cancelled") {
          throw new Error(
            `Migration run was cancelled while scanning ${definitionId}`
          );
        }

        if (result.kind === "definition-completed") {
          definitions.push(result.summary);
          break;
        }
      }
    }

    if (execution.rollbackOrphans) {
      for (let index = 0; index < definitions.length; index += 1) {
        const summary = definitions[index];
        if (summary !== undefined) {
          definitions[index] = mergeRollbackOrphansCounts(summary, {
            orphaned: 0,
            rollbackFailed: 0,
            rolledBack: 0,
          });
        }
      }
    }

    if (
      execution.rollbackOrphans &&
      definitions.every((definition) => definition.status === "succeeded")
    ) {
      for (const definitionId of [
        ...envelope.executionDefinitionIds,
      ].reverse()) {
        let rollbackState: WorkflowSdkMigrationRunRollbackOrphansState = {
          orphaned: 0,
          phase: "rollback",
          rollbackFailed: 0,
          rolledBack: 0,
        };

        while (true) {
          const rollback = await steps.executeRollbackOrphansPage({
            definitionId,
            envelope,
            runId: envelope.runId,
            state: rollbackState,
          });
          rollbackState = rollback.state;

          if (rollback.kind === "cancelled") {
            throw new Error(
              `Migration run was cancelled while rolling back orphans for ${definitionId}`
            );
          }
          if (rollback.kind === "completed") {
            break;
          }
        }

        const index = definitions.findIndex(
          (definition) => definition.definitionId === definitionId
        );
        const scan = definitions[index];

        if (scan !== undefined) {
          definitions[index] = mergeRollbackOrphansCounts(scan, rollbackState);
        }
      }
    }
  } catch (error) {
    await steps.fail({
      envelope,
      error: serializeWorkflowError(error),
    });
    throw error;
  }

  return await steps.complete({
    definitions,
    envelope,
  });
};

import { mergeRollbackOrphansCounts } from "migrate-sdk/core";
