import type {
  MigrationDefinitionRunSummary,
  MigrationRunCursorWindowResult,
  MigrationRunCursorWindowState,
  MigrationRunRollbackOrphansPageResult,
  MigrationRunRollbackOrphansState,
  MigrationRunSummary,
} from "migrate-sdk/core";
import type { WorkflowSdkMigrationRunEnvelope } from "./migration-envelope.ts";

export type { WorkflowSdkMigrationRunEnvelope } from "./migration-envelope.ts";

type WorkflowSdkMigrationDefinitionId =
  WorkflowSdkMigrationRunEnvelope["executionDefinitionIds"][number];

export type WorkflowSdkMigrationDefinitionRunCounts =
  MigrationDefinitionRunSummary["counts"];

export type WorkflowSdkMigrationDefinitionRunSummary =
  MigrationDefinitionRunSummary;

export type WorkflowSdkMigrationRunSummary = MigrationRunSummary;

export type WorkflowSdkMigrationRunCursorWindowState =
  MigrationRunCursorWindowState;

export type WorkflowSdkMigrationRunRollbackOrphansState =
  MigrationRunRollbackOrphansState;

export type WorkflowSdkMigrationRunRollbackOrphansPageResult =
  MigrationRunRollbackOrphansPageResult;

export type WorkflowSdkMigrationRunCursorWindowResult =
  MigrationRunCursorWindowResult;

export interface WorkflowSdkMigrationRunSteps {
  readonly begin: (
    envelope: WorkflowSdkMigrationRunEnvelope
  ) => Promise<{ readonly rollbackOrphans: boolean }>;
  readonly cancel: (input: {
    readonly definitions: WorkflowSdkMigrationRunSummary["definitions"];
    readonly envelope: WorkflowSdkMigrationRunEnvelope;
  }) => Promise<WorkflowSdkMigrationRunSummary>;
  readonly complete: (input: {
    readonly definitions: WorkflowSdkMigrationRunSummary["definitions"];
    readonly envelope: WorkflowSdkMigrationRunEnvelope;
  }) => Promise<WorkflowSdkMigrationRunSummary>;
  readonly executeCursorWindow: (input: {
    readonly definitionId: WorkflowSdkMigrationRunEnvelope["executionDefinitionIds"][number];
    readonly envelope: WorkflowSdkMigrationRunEnvelope;
    readonly runId: WorkflowSdkMigrationRunEnvelope["runId"];
    readonly state: WorkflowSdkMigrationRunCursorWindowState;
  }) => Promise<WorkflowSdkMigrationRunCursorWindowResult>;
  readonly executeRollbackOrphansPage: (input: {
    readonly definitionId: WorkflowSdkMigrationRunEnvelope["executionDefinitionIds"][number];
    readonly envelope: WorkflowSdkMigrationRunEnvelope;
    readonly runId: WorkflowSdkMigrationRunEnvelope["runId"];
    readonly state: WorkflowSdkMigrationRunRollbackOrphansState;
  }) => Promise<WorkflowSdkMigrationRunRollbackOrphansPageResult>;
  readonly fail: (input: {
    readonly definitions: WorkflowSdkMigrationRunSummary["definitions"];
    readonly envelope: WorkflowSdkMigrationRunEnvelope;
    readonly error: unknown;
    readonly failedDefinitionId?: WorkflowSdkMigrationRunEnvelope["executionDefinitionIds"][number];
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
  readonly onActiveDefinition: (
    definitionId: WorkflowSdkMigrationDefinitionId | undefined
  ) => void;
  readonly steps: WorkflowSdkMigrationRunSteps;
}): Promise<boolean> => {
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
        return true;
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

  return false;
};

export const runMigrationExecutionWorkflow = async (
  envelope: WorkflowSdkMigrationRunEnvelope,
  steps: WorkflowSdkMigrationRunSteps
): Promise<WorkflowSdkMigrationRunSummary> => {
  const definitions: WorkflowSdkMigrationDefinitionRunSummary[] = [];
  const completedDefinitions: WorkflowSdkMigrationDefinitionRunSummary[] = [];
  let activeDefinitionId: WorkflowSdkMigrationDefinitionId | undefined;
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
          return await steps.cancel({
            definitions: completedDefinitions,
            envelope,
          });
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
      const cancelled = await executeWorkflowRollbackOrphans({
        completedDefinitions,
        definitions,
        envelope,
        onActiveDefinition: (definitionId) => {
          activeDefinitionId = definitionId;
        },
        steps,
      });

      if (cancelled) {
        return await steps.cancel({
          definitions: completedDefinitions,
          envelope,
        });
      }
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
