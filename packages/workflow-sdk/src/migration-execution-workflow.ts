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
}

export type WorkflowSdkMigrationRunCursorWindowResult =
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
  ) => Promise<unknown>;
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
    await steps.begin(envelope);

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

        if (result.kind === "definition-completed") {
          definitions.push(result.summary);
          break;
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
