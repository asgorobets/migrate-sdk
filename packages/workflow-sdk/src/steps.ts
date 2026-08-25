import { Effect } from "effect";
import {
  isRollbackMigrationDefinition,
  type MigrationDefinitionId,
  type MigrationDefinitionRegistryCatalog,
  type MigrationDefinitionRegistryCatalogLookupError,
  MigrationDefinitionRegistryExecutableError,
  type MigrationDefinitionRegistryPlanningError,
  type MigrationExecutableRollbackError,
  type MigrationExecutableRunError,
  type MigrationExecutionEnvelopeType,
  MigrationExecutionJob,
  type MigrationExecutionJobType,
  type MigrationRollbackExecutionEnvelopeType,
  MigrationRollbackExecutor,
  type MigrationRunCursorWindowResult,
  type MigrationRunCursorWindowState,
  type MigrationRunExecutionEnvelopeType,
  type MigrationRunExecutionLease,
  type MigrationRunRollbackOrphansPageResult,
  type MigrationRunRollbackOrphansState,
  MigrationRunStepExecutor,
  type MigrationRunSummary,
  type RollbackRunSummary,
  toMigrationDefinitionId,
} from "migrate-sdk/core";

export type WorkflowSdkMigrationRunStepError =
  | MigrationDefinitionRegistryCatalogLookupError
  | MigrationDefinitionRegistryPlanningError
  | MigrationDefinitionRegistryExecutableError
  | MigrationExecutableRunError;

export type WorkflowSdkMigrationRollbackStepError =
  | MigrationDefinitionRegistryCatalogLookupError
  | MigrationDefinitionRegistryPlanningError
  | MigrationDefinitionRegistryExecutableError
  | MigrationExecutableRollbackError;

export type WorkflowSdkMigrationRunStepRequirements =
  | MigrationDefinitionRegistryCatalog
  | MigrationRunStepExecutor;

const fallbackDefinitionId = (kind: "run" | "rollback") =>
  toMigrationDefinitionId(`migration-${kind}`);

const firstScopeDefinitionId = (
  envelope: MigrationExecutionEnvelopeType
): MigrationDefinitionId =>
  envelope.scopeDefinitionIds[0] ?? fallbackDefinitionId(envelope.kind);

const missingLocksError = (envelope: MigrationExecutionEnvelopeType) =>
  new MigrationDefinitionRegistryExecutableError({
    definitionId: firstScopeDefinitionId(envelope),
    message: `Workflow SDK ${envelope.kind} execution requires acquired locks`,
    missingRequirements: [
      {
        key: "workflow-sdk-lock-lease",
        label: "Acquired Migration Definition locks",
        owner: "store",
      },
    ],
  });

const unsupportedRunPlanError = (envelope: MigrationRunExecutionEnvelopeType) =>
  new MigrationDefinitionRegistryExecutableError({
    definitionId: firstScopeDefinitionId(envelope),
    message:
      "Workflow SDK cursor-window execution currently supports only normal run plans without update or source identity targets",
    missingRequirements: [
      {
        key: "workflow-sdk-normal-cursor-run",
        label: "Normal cursor-discovery run",
        owner: "definition",
      },
    ],
  });

const requireExecutionLease = (
  envelope: MigrationExecutionEnvelopeType,
  job: MigrationExecutionJobType
): Effect.Effect<
  MigrationRunExecutionLease,
  MigrationDefinitionRegistryExecutableError
> =>
  job.options.lease === undefined
    ? Effect.fail(missingLocksError(envelope))
    : Effect.succeed(job.options.lease);

const resolveRunJob = (envelope: MigrationRunExecutionEnvelopeType) =>
  Effect.gen(function* () {
    const job = yield* MigrationExecutionJob.fromEnvelope(envelope);

    if (
      job.plan.target !== undefined ||
      job.plan.update === true ||
      (job.plan.mode !== undefined && job.plan.mode.kind !== "normal")
    ) {
      return yield* unsupportedRunPlanError(envelope);
    }

    const lease = yield* requireExecutionLease(envelope, job);

    return { job, lease };
  });

export const beginMigrationRunExecutionEnvelope = (
  envelope: MigrationRunExecutionEnvelopeType
): Effect.Effect<
  { readonly rollbackOrphans: boolean },
  WorkflowSdkMigrationRunStepError,
  WorkflowSdkMigrationRunStepRequirements
> =>
  Effect.gen(function* () {
    const { job, lease } = yield* resolveRunJob(envelope);
    yield* MigrationRunStepExecutor.begin({
      definitions: job.plan.definitions,
      lease,
      ...(job.plan.rollbackOrphans === undefined
        ? {}
        : { rollbackOrphans: job.plan.rollbackOrphans }),
      ...(job.plan.rescan === undefined ? {} : { rescan: job.plan.rescan }),
    });

    return { rollbackOrphans: job.plan.rollbackOrphans === true };
  });

export const executeMigrationRunCursorWindow = (input: {
  readonly definitionId: MigrationDefinitionId;
  readonly envelope: MigrationRunExecutionEnvelopeType;
  readonly runId: MigrationRunExecutionEnvelopeType["runId"];
  readonly state: MigrationRunCursorWindowState;
}): Effect.Effect<
  MigrationRunCursorWindowResult,
  WorkflowSdkMigrationRunStepError,
  WorkflowSdkMigrationRunStepRequirements
> =>
  Effect.gen(function* () {
    const { job, lease } = yield* resolveRunJob(input.envelope);
    const definition = job.plan.definitions.find(
      (candidate) => candidate.id === input.definitionId
    );

    if (definition === undefined) {
      return yield* new MigrationDefinitionRegistryExecutableError({
        definitionId: input.definitionId,
        message: "Migration Definition was not found in the Workflow SDK plan",
        missingRequirements: [
          {
            key: "workflow-sdk-planned-definition",
            label: "Planned Migration Definition",
            owner: "definition",
          },
        ],
      });
    }

    return yield* MigrationRunStepExecutor.executeCursorWindow(definition, {
      definitionId: input.definitionId,
      definitionIds: job.plan.executionDefinitionIds,
      lease,
      ...(job.plan.rollbackOrphans === true ? { rollbackOrphans: true } : {}),
      runId: input.runId,
      state: input.state,
    });
  });

export const executeMigrationRunRollbackOrphansPage = (input: {
  readonly definitionId: MigrationDefinitionId;
  readonly envelope: MigrationRunExecutionEnvelopeType;
  readonly runId: MigrationRunExecutionEnvelopeType["runId"];
  readonly state: MigrationRunRollbackOrphansState;
}): Effect.Effect<
  MigrationRunRollbackOrphansPageResult,
  WorkflowSdkMigrationRunStepError,
  WorkflowSdkMigrationRunStepRequirements
> =>
  Effect.gen(function* () {
    const { job, lease } = yield* resolveRunJob(input.envelope);
    const definition = job.plan.definitions.find(
      (candidate) => candidate.id === input.definitionId
    );

    if (definition === undefined) {
      return yield* new MigrationDefinitionRegistryExecutableError({
        definitionId: input.definitionId,
        message: "Migration Definition was not found in the Workflow SDK plan",
        missingRequirements: [
          {
            key: "workflow-sdk-planned-definition",
            label: "Planned Migration Definition",
            owner: "definition",
          },
        ],
      });
    }

    if (!isRollbackMigrationDefinition(definition)) {
      return yield* new MigrationDefinitionRegistryExecutableError({
        definitionId: input.definitionId,
        message: "Rollback Orphans requires a Rollback Pipeline",
        missingRequirements: [
          {
            key: "rollback-pipeline",
            label: "Rollback Pipeline",
            owner: "definition",
          },
        ],
      });
    }

    return yield* MigrationRunStepExecutor.executeRollbackOrphansPage(
      definition,
      {
        definitionIds: job.plan.executionDefinitionIds,
        lease,
        runId: input.runId,
        state: input.state,
      },
      job.plan.execution?.rollback
    );
  });

export const completeMigrationRunExecutionEnvelope = (input: {
  readonly definitions: MigrationRunSummary["definitions"];
  readonly envelope: MigrationRunExecutionEnvelopeType;
}): Effect.Effect<
  MigrationRunSummary,
  WorkflowSdkMigrationRunStepError,
  WorkflowSdkMigrationRunStepRequirements
> =>
  Effect.gen(function* () {
    const { job, lease } = yield* resolveRunJob(input.envelope);
    const firstDefinition = job.plan.definitions[0];

    if (firstDefinition === undefined) {
      return yield* unsupportedRunPlanError(input.envelope);
    }

    return yield* MigrationRunStepExecutor.complete({
      definitions: input.definitions,
      lease,
      storeLayer: firstDefinition.store,
    });
  });

export const failMigrationRunExecutionEnvelope = (input: {
  readonly envelope: MigrationRunExecutionEnvelopeType;
  readonly error: unknown;
}): Effect.Effect<
  void,
  WorkflowSdkMigrationRunStepError,
  WorkflowSdkMigrationRunStepRequirements
> =>
  Effect.gen(function* () {
    const { job, lease } = yield* resolveRunJob(input.envelope);
    const firstDefinition = job.plan.definitions[0];

    if (firstDefinition === undefined) {
      return yield* unsupportedRunPlanError(input.envelope);
    }

    return yield* MigrationRunStepExecutor.fail({
      definitionIds: job.plan.executionDefinitionIds,
      error: input.error,
      lease,
      storeLayer: firstDefinition.store,
    });
  });

export const executeMigrationRollbackExecutionEnvelope = (
  envelope: MigrationRollbackExecutionEnvelopeType
): Effect.Effect<
  RollbackRunSummary,
  WorkflowSdkMigrationRollbackStepError,
  MigrationDefinitionRegistryCatalog | MigrationRollbackExecutor
> =>
  Effect.gen(function* () {
    const job = yield* MigrationExecutionJob.fromEnvelope(envelope);
    const lease = yield* requireExecutionLease(envelope, job);

    return yield* MigrationRollbackExecutor.executePlan(job.plan, {
      ...job.options,
      lease,
    });
  });
