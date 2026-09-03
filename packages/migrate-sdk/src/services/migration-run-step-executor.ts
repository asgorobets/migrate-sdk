import { Effect, Layer } from "effect";
import { Service } from "effect/Context";
import type {
  AnyMigrationDefinition,
  MigrationDefinitionSourceImplementationError,
  MigrationDefinitionSourceRequirements,
} from "../domain/definition.ts";
import type { PipelineExecutionOptions } from "../domain/execution.ts";
import type { AnyRollbackMigrationDefinition } from "../domain/rollback.ts";
import type { MigrationRunState, MigrationRunSummary } from "../domain/run.ts";
import {
  type MigrationRunBeginInput,
  type MigrationRunCancellationInput,
  type MigrationRunCompletionInput,
  type MigrationRunCursorWindowResult,
  type MigrationRunDefinitionCursorWindowInput,
  MigrationRunExecutor,
  type MigrationRunExecutorService,
  type MigrationRunFailureInput,
  type MigrationRunRollbackOrphansPageInput,
  type MigrationRunRollbackOrphansPageResult,
  type RunMigrationError,
} from "./migration-run-executor.ts";

export interface MigrationRunStepExecutorService {
  readonly begin: (
    input: MigrationRunBeginInput
  ) => Effect.Effect<MigrationRunState, RunMigrationError>;

  readonly cancel: (
    input: MigrationRunCancellationInput
  ) => Effect.Effect<MigrationRunSummary, RunMigrationError>;

  readonly complete: (
    input: MigrationRunCompletionInput
  ) => Effect.Effect<MigrationRunSummary, RunMigrationError>;

  readonly executeCursorWindow: <Definition extends AnyMigrationDefinition>(
    definition: Definition,
    input: MigrationRunDefinitionCursorWindowInput,
    processExecution?: PipelineExecutionOptions
  ) => Effect.Effect<
    MigrationRunCursorWindowResult,
    | RunMigrationError
    | MigrationDefinitionSourceImplementationError<Definition>,
    MigrationDefinitionSourceRequirements<Definition>
  >;

  readonly executeRollbackOrphansPage: (
    definition: AnyRollbackMigrationDefinition & {
      readonly rollback: NonNullable<
        AnyRollbackMigrationDefinition["rollback"]
      >;
    },
    input: MigrationRunRollbackOrphansPageInput,
    rollbackExecution?: PipelineExecutionOptions
  ) => Effect.Effect<MigrationRunRollbackOrphansPageResult, RunMigrationError>;

  readonly fail: (
    input: MigrationRunFailureInput
  ) => Effect.Effect<void, RunMigrationError>;
}

const makeMigrationRunStepExecutor = (
  executor: MigrationRunExecutorService
): MigrationRunStepExecutorService => ({
  begin: executor.begin,
  cancel: executor.cancel,
  complete: executor.complete,
  executeCursorWindow: executor.executeCursorWindow,
  executeRollbackOrphansPage: executor.executeRollbackOrphansPage,
  fail: executor.fail,
});

export class MigrationRunStepExecutor extends Service<
  MigrationRunStepExecutor,
  MigrationRunStepExecutorService
>()("@migrate-sdk/MigrationRunStepExecutor") {
  static readonly begin = (input: MigrationRunBeginInput) =>
    Effect.flatMap(MigrationRunStepExecutor, (executor) =>
      executor.begin(input)
    );

  static readonly cancel = (input: MigrationRunCancellationInput) =>
    Effect.flatMap(MigrationRunStepExecutor, (executor) =>
      executor.cancel(input)
    );

  static readonly complete = (input: MigrationRunCompletionInput) =>
    Effect.flatMap(MigrationRunStepExecutor, (executor) =>
      executor.complete(input)
    );

  static readonly executeCursorWindow = <
    Definition extends AnyMigrationDefinition,
  >(
    definition: Definition,
    input: MigrationRunDefinitionCursorWindowInput,
    processExecution?: PipelineExecutionOptions
  ): Effect.Effect<
    MigrationRunCursorWindowResult,
    | RunMigrationError
    | MigrationDefinitionSourceImplementationError<Definition>,
    MigrationDefinitionSourceRequirements<Definition> | MigrationRunStepExecutor
  > =>
    Effect.flatMap(MigrationRunStepExecutor, (executor) =>
      executor.executeCursorWindow(definition, input, processExecution)
    );

  static readonly fail = (input: MigrationRunFailureInput) =>
    Effect.flatMap(MigrationRunStepExecutor, (executor) =>
      executor.fail(input)
    );

  static readonly executeRollbackOrphansPage = (
    definition: AnyRollbackMigrationDefinition & {
      readonly rollback: NonNullable<
        AnyRollbackMigrationDefinition["rollback"]
      >;
    },
    input: MigrationRunRollbackOrphansPageInput,
    rollbackExecution?: PipelineExecutionOptions
  ) =>
    Effect.flatMap(MigrationRunStepExecutor, (executor) =>
      executor.executeRollbackOrphansPage(definition, input, rollbackExecution)
    );

  static readonly layer = Layer.effect(
    MigrationRunStepExecutor,
    Effect.map(MigrationRunExecutor, makeMigrationRunStepExecutor)
  );

  static readonly defaultLayer = MigrationRunStepExecutor.layer.pipe(
    Layer.provide(MigrationRunExecutor.layer)
  );
}
