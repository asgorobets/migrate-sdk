import { Effect, Layer, Option } from "effect";
import { MigrationStore } from "migrate-sdk";
import {
  isRollbackMigrationDefinition,
  type MigrationDefinitionId,
  MigrationDefinitionRegistryCatalog,
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
  migrationRunModeForDefinition,
  type RollbackRunSummary,
  toMigrationDefinitionId,
} from "migrate-sdk/core";
import { workflowSdkMigrationProgressLayer } from "./migration-progress.ts";

export interface WorkflowStepRetryMetadata {
  readonly maxRetries: number;
}

/**
 * Disables Workflow SDK's automatic retries for a step whose durable work
 * cannot be atomically committed with Workflow SDK's step result.
 *
 * Apply this to cursor-window and orphan-reconciliation page steps. Keep
 * lifecycle and finalization steps retryable.
 */
export const disableWorkflowStepRetries = <Step extends object>(
  step: Step
): Step & WorkflowStepRetryMetadata => Object.assign(step, { maxRetries: 0 });

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

const missingFinalizationStoreError = (
  envelope: MigrationRunExecutionEnvelopeType
) =>
  new MigrationDefinitionRegistryExecutableError({
    definitionId: firstScopeDefinitionId(envelope),
    message:
      "Workflow SDK finalization requires the original MigrationStore; provide it to the step runtime when the registry has no unambiguous store",
    missingRequirements: [
      {
        key: "workflow-sdk-finalization-store",
        label: "Original Migration Store for run finalization",
        owner: "store",
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

    const lease = yield* requireExecutionLease(envelope, job);

    return { job, lease };
  });

const resolveRunFinalizationStore = (
  envelope: MigrationRunExecutionEnvelopeType
) =>
  Effect.gen(function* () {
    const store = yield* Effect.serviceOption(MigrationStore);
    if (Option.isSome(store)) {
      return Layer.succeed(MigrationStore, store.value);
    }
    const registry = yield* MigrationDefinitionRegistryCatalog.get(
      envelope.registryId
    );
    const definitions = registry.definitions();
    const scopedDefinitions = definitions.filter((definition) =>
      envelope.scopeDefinitionIds.includes(definition.id)
    );
    const stores = new Set(
      (scopedDefinitions.length === 0 ? definitions : scopedDefinitions).map(
        (definition) => definition.store
      )
    );
    const [storeLayer] = stores;
    if (stores.size !== 1 || storeLayer === undefined) {
      return yield* missingFinalizationStoreError(envelope);
    }
    return storeLayer;
  });

// Cleanup must survive definition removal or registry replacement. The store
// validates the original lease before any run transition or lock release.
const resolveRunFinalization = (envelope: MigrationRunExecutionEnvelopeType) =>
  Effect.gen(function* () {
    if (envelope.locks === undefined) {
      return yield* missingLocksError(envelope);
    }
    return {
      lease: {
        locks: envelope.locks,
        runId: envelope.runId,
        scopeDefinitionIds: envelope.scopeDefinitionIds,
      },
      storeLayer: yield* resolveRunFinalizationStore(envelope),
    };
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

    return yield* MigrationRunStepExecutor.executeCursorWindow(
      definition,
      {
        definitionId: input.definitionId,
        definitionIds: job.plan.executionDefinitionIds,
        lease,
        mode: migrationRunModeForDefinition(job.plan, definition.id),
        ...(job.plan.update === undefined ? {} : { update: job.plan.update }),
        ...(job.plan.limit === undefined ? {} : { limit: job.plan.limit }),
        ...(job.plan.rollbackOrphans === true ? { rollbackOrphans: true } : {}),
        runId: input.runId,
        state: input.state,
      },
      job.plan.execution?.process
    ).pipe(Effect.provide(workflowSdkMigrationProgressLayer));
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
    const { lease, storeLayer } = yield* resolveRunFinalization(input.envelope);

    return yield* MigrationRunStepExecutor.complete({
      definitions: input.definitions,
      lease,
      storeLayer,
    });
  });

export const cancelMigrationRunExecutionEnvelope = (input: {
  readonly definitions: MigrationRunSummary["definitions"];
  readonly envelope: MigrationRunExecutionEnvelopeType;
}): Effect.Effect<
  MigrationRunSummary,
  WorkflowSdkMigrationRunStepError,
  WorkflowSdkMigrationRunStepRequirements
> =>
  Effect.gen(function* () {
    const { lease, storeLayer } = yield* resolveRunFinalization(input.envelope);

    return yield* MigrationRunStepExecutor.cancel({
      definitions: input.definitions,
      lease,
      storeLayer,
    });
  });

export const failMigrationRunExecutionEnvelope = (input: {
  readonly definitions: MigrationRunSummary["definitions"];
  readonly envelope: MigrationRunExecutionEnvelopeType;
  readonly error: unknown;
  readonly failedDefinitionId?: MigrationDefinitionId;
}): Effect.Effect<
  void,
  WorkflowSdkMigrationRunStepError,
  WorkflowSdkMigrationRunStepRequirements
> =>
  Effect.gen(function* () {
    const { lease, storeLayer } = yield* resolveRunFinalization(input.envelope);

    return yield* MigrationRunStepExecutor.fail({
      definitionOutcomes: input.envelope.executionDefinitionIds.map(
        (definitionId) => {
          const completed = input.definitions.find(
            (definition) => definition.definitionId === definitionId
          );

          return {
            definitionId,
            status:
              definitionId === input.failedDefinitionId
                ? ("failed" as const)
                : (completed?.status ?? ("skipped" as const)),
          };
        }
      ),
      definitionIds: input.envelope.executionDefinitionIds,
      error: input.error,
      lease,
      storeLayer,
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
