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
import { getStepMetadata } from "workflow";
import {
  WorkflowProgressStream,
  workflowSdkMigrationProgressLayer,
  writeWorkflowProgress,
} from "./migration-progress.ts";

const workflowProgressLayer = workflowSdkMigrationProgressLayer.pipe(
  Layer.provideMerge(WorkflowProgressStream.layer)
);

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

// Capture once under the execution locks, before any item work. Every later
// snapshot is relative to this baseline, including resumed clients.
const publishBaseline = (envelope: MigrationExecutionEnvelopeType) =>
  Effect.gen(function* () {
    const registry = yield* MigrationDefinitionRegistryCatalog.get(
      envelope.registryId
    );
    const [first, ...rest] = envelope.scopeDefinitionIds;
    if (first === undefined) {
      return;
    }
    const definition = registry
      .definitions()
      .find((candidate) => candidate.id === first);
    if (definition === undefined || envelope.locks === undefined) {
      return;
    }
    yield* MigrationStore.pipe(
      Effect.flatMap((store) =>
        store.assertDefinitionLocks(envelope.locks ?? [])
      ),
      Effect.provide(definition.store)
    );
    const report = yield* registry.status({
      definitionIds: [first, ...rest],
      scanSource: false,
    });
    yield* writeWorkflowProgress({
      kind: "baseline",
      runId: envelope.runId,
      definitions: report.definitions,
    }).pipe(Effect.retry({ times: 2 }));
  }).pipe(Effect.ignore);

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

    yield* publishBaseline(envelope);
    return { rollbackOrphans: job.plan.rollbackOrphans === true };
  }).pipe(Effect.provide(workflowProgressLayer));

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
    );
  }).pipe(Effect.provide(workflowProgressLayer));

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
  }).pipe(Effect.provide(workflowProgressLayer));

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
  }).pipe(Effect.provide(workflowProgressLayer));

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
  }).pipe(Effect.provide(workflowProgressLayer));

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
      error: input.error,
      lease,
      storeLayer,
    });
  }).pipe(Effect.provide(workflowProgressLayer));

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

    // A retry may already have removed items. Never anchor old snapshots
    // to a newer baseline; if the first publication failed, clients reconcile at exit.
    const metadata = yield* Effect.try(getStepMetadata).pipe(Effect.option);
    if (Option.isNone(metadata) || metadata.value.attempt === 1) {
      yield* publishBaseline(envelope);
    }
    return yield* MigrationRollbackExecutor.executePlan(job.plan, {
      ...job.options,
      lease,
    });
  }).pipe(Effect.provide(workflowProgressLayer));
