import { Effect, Layer } from "effect";
import { Service } from "effect/Context";
import type { MigrationDefinitionId, MigrationRunId } from "../domain/ids.ts";
import type { MigrationProgressCounts } from "../domain/progress.ts";
import type {
  MigrationDefinitionExecutableRollbackPlan,
  MigrationDefinitionExecutableRunPlan,
} from "../domain/registry.ts";
import type { RollbackRunSummary } from "../domain/rollback.ts";
import type {
  AnyMigrationDefinition,
  ExecutionStartResult,
  MigrationExecutionHandle,
  MigrationRunSummary,
  RunRequestSourceImplementationError,
  RunRequestSourceRequirements,
} from "../domain/run.ts";
import {
  MigrationRollbackExecutor,
  type MigrationRollbackExecutorService,
  MigrationRunExecutor,
  type MigrationRunExecutorService,
  type RollbackMigrationError,
  type RunMigrationError,
  startMigrationRollbackPlanSupervised,
  startMigrationRunPlanSupervised,
} from "./migration-run-executor.ts";

export type MigrationExecutableRunError<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> = RunMigrationError | RunRequestSourceImplementationError<Definitions>;

export type MigrationExecutableRollbackError = RollbackMigrationError;

export interface MigrationExecutableAdapterError {
  readonly _tag: string;
}

export type MigrationExecutableRunStartError<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> = MigrationExecutableRunError<Definitions> | MigrationExecutableAdapterError;

export type MigrationExecutableRollbackStartError =
  | MigrationExecutableRollbackError
  | MigrationExecutableAdapterError;

export type MigrationExecutableInlineRunStartError<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> = MigrationExecutableRunError<Definitions>;

export type MigrationExecutableInlineRollbackStartError =
  MigrationExecutableRollbackError;

export interface MigrationExecutableProgressCheckpoint {
  readonly counts: MigrationProgressCounts;
  readonly definitionId: MigrationDefinitionId;
  readonly kind: "source-cursor-window-completed";
  readonly runId: MigrationRunId;
}

export interface MigrationExecutableObservationOptions {
  readonly onProgressCheckpoint?: (
    checkpoint: MigrationExecutableProgressCheckpoint
  ) => Effect.Effect<void>;
}

export type MigrationExecutableObservationResult =
  | {
      readonly kind: "cancelled";
    }
  | {
      readonly cause?: unknown;
      readonly kind: "failed";
    }
  | {
      readonly kind: "succeeded";
    };

export interface MigrationExecutableService {
  readonly startRollback: (
    plan: MigrationDefinitionExecutableRollbackPlan
  ) => Effect.Effect<
    ExecutionStartResult<RollbackRunSummary>,
    MigrationExecutableRollbackStartError
  >;
  readonly startRun: <Definitions extends readonly AnyMigrationDefinition[]>(
    plan: MigrationDefinitionExecutableRunPlan<Definitions>
  ) => Effect.Effect<
    ExecutionStartResult<MigrationRunSummary>,
    MigrationExecutableRunStartError<Definitions>,
    RunRequestSourceRequirements<Definitions>
  >;
  /**
   * Waits on the execution provider's native lifecycle when the adapter can
   * reattach by execution identity. Durable migration state remains the source
   * of truth for migration status and item progress.
   */
  readonly waitForExecution?: (
    execution: MigrationExecutionHandle & { readonly executionId: string },
    options?: MigrationExecutableObservationOptions
  ) => Effect.Effect<
    MigrationExecutableObservationResult,
    MigrationExecutableAdapterError
  >;
}

const makeInlineMigrationExecutable = (
  runExecutor: MigrationRunExecutorService,
  rollbackExecutor: MigrationRollbackExecutorService
): MigrationExecutableService => ({
  startRollback: (plan) => rollbackExecutor.startPlan(plan),
  startRun: (plan) => runExecutor.startPlan(plan),
});

export class MigrationExecutable extends Service<
  MigrationExecutable,
  MigrationExecutableService
>()("@migrate-sdk/MigrationExecutable") {
  static readonly inlineService: MigrationExecutableService = {
    startRollback: (plan) => startMigrationRollbackPlanSupervised(plan),
    startRun: (plan) => startMigrationRunPlanSupervised(plan),
  };

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

  static readonly inline = Layer.effect(
    MigrationExecutable,
    Effect.gen(function* () {
      const runExecutor = yield* MigrationRunExecutor;
      const rollbackExecutor = yield* MigrationRollbackExecutor;

      return makeInlineMigrationExecutable(runExecutor, rollbackExecutor);
    })
  );

  static readonly inlineDefault = MigrationExecutable.inline.pipe(
    Layer.provide(
      Layer.mergeAll(
        MigrationRunExecutor.layer,
        MigrationRollbackExecutor.layer
      )
    )
  );
}
