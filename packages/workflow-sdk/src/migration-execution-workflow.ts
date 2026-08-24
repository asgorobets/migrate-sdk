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
    readonly definitions: WorkflowSdkMigrationRunSummary["definitions"];
    readonly envelope: WorkflowSdkMigrationRunEnvelope;
    readonly error: unknown;
    readonly failedDefinitionId?: string;
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

const executeWorkflowRollbackOrphans = async ({
  completedDefinitions,
  definitions,
  envelope,
  onActiveDefinition,
  steps,
}: {
  readonly completedDefinitions: WorkflowSdkMigrationDefinitionRunSummary[];
  readonly definitions: WorkflowSdkMigrationDefinitionRunSummary[];
  readonly envelope: WorkflowSdkMigrationRunEnvelope;
  readonly onActiveDefinition: (definitionId: string | undefined) => void;
  readonly steps: WorkflowSdkMigrationRunSteps;
}): Promise<void> => {
  for (const definitionId of [...envelope.executionDefinitionIds].reverse()) {
    onActiveDefinition(definitionId);
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
      const completed = mergeRollbackOrphansCounts(scan, rollbackState);
      definitions[index] = completed;
      completedDefinitions.push(completed);
    }
    onActiveDefinition(undefined);
  }
};

export const runMigrationExecutionWorkflow = async (
  envelope: WorkflowSdkMigrationRunEnvelope,
  steps: WorkflowSdkMigrationRunSteps
): Promise<WorkflowSdkMigrationRunSummary> => {
  const definitions: WorkflowSdkMigrationDefinitionRunSummary[] = [];
  const completedDefinitions: WorkflowSdkMigrationDefinitionRunSummary[] = [];
  let activeDefinitionId: string | undefined;
  let rollbackOrphans = false;

  try {
    const execution = await steps.begin(envelope);
    rollbackOrphans = execution.rollbackOrphans;

    for (const definitionId of envelope.executionDefinitionIds) {
      activeDefinitionId = definitionId;
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
          if (!rollbackOrphans) {
            completedDefinitions.push(result.summary);
          }
          activeDefinitionId = undefined;
          break;
        }
      }
    }

    if (rollbackOrphans) {
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
      rollbackOrphans &&
      definitions.every((definition) => definition.status === "succeeded")
    ) {
      await executeWorkflowRollbackOrphans({
        completedDefinitions,
        definitions,
        envelope,
        onActiveDefinition: (definitionId) => {
          activeDefinitionId = definitionId;
        },
        steps,
      });
    }
  } catch (error) {
    await steps.fail({
      definitions: completedDefinitions,
      envelope,
      error: serializeWorkflowError(error),
      ...(activeDefinitionId === undefined
        ? {}
        : { failedDefinitionId: activeDefinitionId }),
    });
    throw error;
  }

  return await steps.complete({
    definitions,
    envelope,
  });
};

import { mergeRollbackOrphansCounts } from "migrate-sdk/core";
