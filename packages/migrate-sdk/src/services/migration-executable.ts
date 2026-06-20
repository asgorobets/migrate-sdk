import { Effect, Layer } from "effect";
import { Service } from "effect/Context";
import type { MigrationDefinitionExecutableRunPlan } from "../domain/registry.ts";
import type {
  AnyMigrationDefinition,
  ExecutionStartResult,
  MigrationRunSummary,
  RunRequestSourceLayerError,
  RunRequestSourceRequirements,
} from "../domain/run.ts";
import {
  type RunMigrationError,
  runMigrationsWithEncodedRunMode,
} from "../runtime/run-migrations.ts";

export type MigrationExecutableRunError<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> = RunMigrationError | RunRequestSourceLayerError<Definitions>;

export interface MigrationExecutableService {
  readonly startRun: <Definitions extends readonly AnyMigrationDefinition[]>(
    plan: MigrationDefinitionExecutableRunPlan<Definitions>
  ) => Effect.Effect<
    ExecutionStartResult<MigrationRunSummary>,
    MigrationExecutableRunError<Definitions>,
    RunRequestSourceRequirements<Definitions>
  >;
}

const startInlineRun = <Definitions extends readonly AnyMigrationDefinition[]>(
  plan: MigrationDefinitionExecutableRunPlan<Definitions>
): Effect.Effect<
  ExecutionStartResult<MigrationRunSummary>,
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
        }
  ).pipe(
    Effect.map((summary) => ({
      kind: "completed" as const,
      runId: summary.runId,
      summary,
    }))
  );

const inlineMigrationExecutable: MigrationExecutableService = {
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

  static readonly inline = Layer.succeed(
    MigrationExecutable,
    inlineMigrationExecutable
  );
}
