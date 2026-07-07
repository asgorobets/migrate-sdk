import { Effect } from "effect";
import type {
  MigrationExecutionEnvelope,
  MigrationRollbackExecutionEnvelope,
  MigrationRunExecutionEnvelope,
} from "../domain/execution-envelope.ts";
import type {
  MigrationDefinitionExecutableRollbackPlan,
  MigrationDefinitionExecutableRunPlan,
  MigrationDefinitionRegistryExecutableError,
  MigrationDefinitionRegistryPlanningError,
} from "../domain/registry.ts";
import type { RollbackRunSummary } from "../domain/rollback.ts";
import type {
  AnyMigrationDefinition,
  MigrationRunSummary,
  RunRequestSourceRequirements,
} from "../domain/run.ts";
import {
  MigrationDefinitionRegistryCatalog,
  type MigrationDefinitionRegistryCatalogLookupError,
} from "./migration-definition-registry-catalog.ts";
import type {
  MigrationExecutableRollbackError,
  MigrationExecutableRunError,
} from "./migration-executable.ts";
import {
  MigrationRollbackExecutor,
  MigrationRunExecutor,
  type MigrationRuntimeExecutionOptions,
} from "./migration-run-executor.ts";

export interface MigrationRunExecutionJob<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> {
  readonly kind: "run";
  readonly options: MigrationRuntimeExecutionOptions;
  readonly plan: MigrationDefinitionExecutableRunPlan<Definitions>;
}

export interface MigrationRollbackExecutionJob {
  readonly kind: "rollback";
  readonly options: MigrationRuntimeExecutionOptions;
  readonly plan: MigrationDefinitionExecutableRollbackPlan;
}

export type MigrationExecutionJob<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> = MigrationRunExecutionJob<Definitions> | MigrationRollbackExecutionJob;

export type MigrationExecutionJobResolutionError =
  | MigrationDefinitionRegistryCatalogLookupError
  | MigrationDefinitionRegistryPlanningError
  | MigrationDefinitionRegistryExecutableError;

export type MigrationExecutionJobExecutionError<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> =
  | MigrationExecutableRunError<Definitions>
  | MigrationExecutableRollbackError;

export type MigrationExecutionJobExecutionRequirements<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> =
  | MigrationRunExecutor
  | MigrationRollbackExecutor
  | RunRequestSourceRequirements<Definitions>;

const makeMigrationExecutionJobOptions = (
  envelope: MigrationExecutionEnvelope
): MigrationRuntimeExecutionOptions => ({
  runId: envelope.runId,
  ...(envelope.locks === undefined
    ? {}
    : {
        lease: {
          locks: envelope.locks,
          runId: envelope.runId,
          scopeDefinitionIds: envelope.scopeDefinitionIds,
        },
      }),
});

const resolveMigrationExecutionJobEffect = Effect.fn(
  "MigrationExecutionJob.fromEnvelope"
)(function* (envelope: MigrationExecutionEnvelope) {
  const registry = yield* MigrationDefinitionRegistryCatalog.get(
    envelope.registryId
  );
  const options = makeMigrationExecutionJobOptions(envelope);

  if (envelope.kind === "run") {
    const plan = yield* registry.executable().planRun(envelope.request);

    return {
      kind: "run",
      options,
      plan,
    };
  }

  const plan = yield* registry.executable().planRollback(envelope.request);

  return {
    kind: "rollback",
    options,
    plan,
  };
});

function resolveMigrationExecutionJob(
  envelope: MigrationRunExecutionEnvelope
): Effect.Effect<
  MigrationRunExecutionJob,
  MigrationExecutionJobResolutionError,
  MigrationDefinitionRegistryCatalog
>;
function resolveMigrationExecutionJob(
  envelope: MigrationRollbackExecutionEnvelope
): Effect.Effect<
  MigrationRollbackExecutionJob,
  MigrationExecutionJobResolutionError,
  MigrationDefinitionRegistryCatalog
>;
function resolveMigrationExecutionJob(
  envelope: MigrationExecutionEnvelope
): Effect.Effect<
  MigrationExecutionJob,
  MigrationExecutionJobResolutionError,
  MigrationDefinitionRegistryCatalog
>;
function resolveMigrationExecutionJob(
  envelope: MigrationExecutionEnvelope
) {
  return resolveMigrationExecutionJobEffect(envelope);
}

function executeMigrationExecutionJob<
  Definitions extends readonly AnyMigrationDefinition[],
>(
  job: MigrationRunExecutionJob<Definitions>
): Effect.Effect<
  MigrationRunSummary,
  MigrationExecutableRunError<Definitions>,
  MigrationRunExecutor | RunRequestSourceRequirements<Definitions>
>;
function executeMigrationExecutionJob(
  job: MigrationRollbackExecutionJob
): Effect.Effect<
  RollbackRunSummary,
  MigrationExecutableRollbackError,
  MigrationRollbackExecutor
>;
function executeMigrationExecutionJob<
  Definitions extends readonly AnyMigrationDefinition[],
>(
  job: MigrationExecutionJob<Definitions>
): Effect.Effect<
  MigrationRunSummary | RollbackRunSummary,
  MigrationExecutionJobExecutionError<Definitions>,
  MigrationExecutionJobExecutionRequirements<Definitions>
>;
function executeMigrationExecutionJob<
  Definitions extends readonly AnyMigrationDefinition[],
>(job: MigrationExecutionJob<Definitions>) {
  if (job.kind === "run") {
    return MigrationRunExecutor.executePlan(job.plan, job.options);
  }

  return MigrationRollbackExecutor.executePlan(job.plan, job.options);
}

export const MigrationExecutionJob = {
  execute: executeMigrationExecutionJob,
  fromEnvelope: resolveMigrationExecutionJob,
};
