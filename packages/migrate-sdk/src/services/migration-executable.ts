import { Effect, Layer } from "effect";
import { Service } from "effect/Context";
import type {
  MigrationDefinitionExecutableRollbackPlan,
  MigrationDefinitionExecutableRunPlan,
} from "../domain/registry.ts";
import type { RollbackRunSummary } from "../domain/rollback.ts";
import type {
  AnyMigrationDefinition,
  ExecutionStartResult,
  MigrationRunSummary,
  RunRequestSourceLayerError,
  RunRequestSourceRequirements,
} from "../domain/run.ts";
import {
  type MigrationRuntimeExecutionOptions,
  type RollbackMigrationError,
  type RunMigrationError,
  rollbackMigrationsWithEncodedSourceIdentities,
  runMigrationsWithEncodedRunMode,
} from "../runtime/run-migrations.ts";

export type MigrationExecutableRunError<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> = RunMigrationError | RunRequestSourceLayerError<Definitions>;

export type MigrationExecutableRollbackError = RollbackMigrationError;

export interface MigrationExecutableService {
  readonly startRollback: (
    plan: MigrationDefinitionExecutableRollbackPlan
  ) => Effect.Effect<
    ExecutionStartResult<RollbackRunSummary>,
    MigrationExecutableRollbackError
  >;
  readonly startRun: <Definitions extends readonly AnyMigrationDefinition[]>(
    plan: MigrationDefinitionExecutableRunPlan<Definitions>
  ) => Effect.Effect<
    ExecutionStartResult<MigrationRunSummary>,
    MigrationExecutableRunError<Definitions>,
    RunRequestSourceRequirements<Definitions>
  >;
}

export const executeMigrationRunPlanInline = <
  Definitions extends readonly AnyMigrationDefinition[],
>(
  plan: MigrationDefinitionExecutableRunPlan<Definitions>,
  options: MigrationRuntimeExecutionOptions = {}
): Effect.Effect<
  MigrationRunSummary,
  MigrationExecutableRunError<Definitions>,
  RunRequestSourceRequirements<Definitions>
> =>
  runMigrationsWithEncodedRunMode<Definitions>(
    plan.target === undefined
      ? {
          definitions: plan.definitions,
          ...(plan.execution === undefined
            ? {}
            : { execution: plan.execution }),
          ...(plan.mode === undefined ? {} : { mode: plan.mode }),
          ...(plan.update === undefined ? {} : { update: plan.update }),
        }
      : {
          definitions: plan.definitions,
          ...(plan.execution === undefined
            ? {}
            : { execution: plan.execution }),
          mode: {
            kind: "item" as const,
            encodedSourceIdentity: plan.target.sourceIdentities[0],
          },
        },
    options
  );

const startInlineRun = <Definitions extends readonly AnyMigrationDefinition[]>(
  plan: MigrationDefinitionExecutableRunPlan<Definitions>
): Effect.Effect<
  ExecutionStartResult<MigrationRunSummary>,
  MigrationExecutableRunError<Definitions>,
  RunRequestSourceRequirements<Definitions>
> =>
  executeMigrationRunPlanInline(plan).pipe(
    Effect.map((summary) => ({
      kind: "completed" as const,
      runId: summary.runId,
      summary,
    }))
  );

export const executeMigrationRollbackPlanInline = (
  plan: MigrationDefinitionExecutableRollbackPlan,
  options: MigrationRuntimeExecutionOptions = {}
): Effect.Effect<RollbackRunSummary, MigrationExecutableRollbackError> =>
  rollbackMigrationsWithEncodedSourceIdentities(
    {
      definitions: plan.registryDefinitions,
      definitionIds: [...plan.executionDefinitionIds].reverse(),
      ...(plan.execution === undefined ? {} : { execution: plan.execution }),
      ...(plan.target === undefined
        ? {}
        : { encodedSourceIdentities: plan.target.sourceIdentities }),
    },
    options
  );

const startInlineRollback = (
  plan: MigrationDefinitionExecutableRollbackPlan
): Effect.Effect<
  ExecutionStartResult<RollbackRunSummary>,
  MigrationExecutableRollbackError
> =>
  executeMigrationRollbackPlanInline(plan).pipe(
    Effect.map((summary) => ({
      kind: "completed" as const,
      runId: summary.runId,
      summary,
    }))
  );

const inlineMigrationExecutable: MigrationExecutableService = {
  startRollback: startInlineRollback,
  startRun: startInlineRun,
};

export class MigrationExecutable extends Service<
  MigrationExecutable,
  MigrationExecutableService
>()("@migrate-sdk/MigrationExecutable") {
  static readonly startRun = <
    Definitions extends readonly AnyMigrationDefinition[],
  >(
    plan: MigrationDefinitionExecutableRunPlan<Definitions>
  ) =>
    Effect.flatMap(MigrationExecutable, (executable) =>
      executable.startRun(plan)
    );

  static readonly startRollback = (
    plan: MigrationDefinitionExecutableRollbackPlan
  ) =>
    Effect.flatMap(MigrationExecutable, (executable) =>
      executable.startRollback(plan)
    );

  static readonly inline = Layer.succeed(
    MigrationExecutable,
    inlineMigrationExecutable
  );
}
