export type PipelineExecutionConcurrency = number | "unbounded";

export interface PipelineExecutionOptions {
  readonly concurrency?: PipelineExecutionConcurrency;
}

export interface MigrationExecutionOptions {
  readonly process?: PipelineExecutionOptions;
  readonly rollback?: PipelineExecutionOptions;
}

export interface NormalizedPipelineExecutionOptions {
  readonly concurrency: PipelineExecutionConcurrency;
}

export interface NormalizedMigrationExecutionOptions {
  readonly process?: NormalizedPipelineExecutionOptions;
  readonly rollback?: NormalizedPipelineExecutionOptions;
}

const defaultPipelineConcurrency = 1;

export const defaultPipelineExecutionOptions: NormalizedPipelineExecutionOptions =
  {
    concurrency: defaultPipelineConcurrency,
  };

export const defaultMigrationExecutionOptions: NormalizedMigrationExecutionOptions =
  {
    process: defaultPipelineExecutionOptions,
    rollback: defaultPipelineExecutionOptions,
  };

const invalidConcurrencyError = (
  label: string,
  concurrency: PipelineExecutionConcurrency
) =>
  new Error(`${label} concurrency must be a positive integer or "unbounded"`, {
    cause: { concurrency },
  });

export const normalizePipelineExecutionOptions = (
  input: PipelineExecutionOptions | undefined,
  label = "Pipeline Execution"
): NormalizedPipelineExecutionOptions => {
  const concurrency = input?.concurrency ?? defaultPipelineConcurrency;

  if (concurrency === "unbounded") {
    return { concurrency };
  }

  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw invalidConcurrencyError(label, concurrency);
  }

  return { concurrency };
};

export const normalizeMigrationExecutionOptions = (
  input: MigrationExecutionOptions | undefined
): NormalizedMigrationExecutionOptions => ({
  ...(input?.process === undefined
    ? {}
    : {
        process: normalizePipelineExecutionOptions(
          input.process,
          "Process Pipeline Execution"
        ),
      }),
  ...(input?.rollback === undefined
    ? {}
    : {
        rollback: normalizePipelineExecutionOptions(
          input.rollback,
          "Rollback Pipeline Execution"
        ),
      }),
});

export const resolvePipelineExecutionOptions = (
  request: PipelineExecutionOptions | undefined,
  definition: PipelineExecutionOptions | undefined,
  label: string
): NormalizedPipelineExecutionOptions =>
  normalizePipelineExecutionOptions(request ?? definition, label);
