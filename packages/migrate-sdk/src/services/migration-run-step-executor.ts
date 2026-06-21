import { Effect, Layer } from "effect";
import { Service } from "effect/Context";
import type { MigrationDefinition } from "../domain/definition.ts";
import type { PipelineExecutionOptions } from "../domain/execution.ts";
import type { SourceIdentitySnapshotKey } from "../domain/ids.ts";
import type { MigrationRunState, MigrationRunSummary } from "../domain/run.ts";
import {
  MigrationRunExecutor,
  type MigrationRunBeginInput,
  type MigrationRunCompletionInput,
  type MigrationRunCursorWindowResult,
  type MigrationRunDefinitionCursorWindowInput,
  type MigrationRunExecutorService,
  type MigrationRunFailureInput,
  type RunMigrationError,
} from "./migration-run-executor.ts";

export interface MigrationRunStepExecutorService {
  readonly begin: (
    input: MigrationRunBeginInput
  ) => Effect.Effect<MigrationRunState, RunMigrationError>;

  readonly complete: (
    input: MigrationRunCompletionInput
  ) => Effect.Effect<MigrationRunSummary, RunMigrationError>;

  readonly executeCursorWindow: <
    Source,
    PipelineError,
    Cursor,
    IdentityKey extends SourceIdentitySnapshotKey,
    SourceInput,
    SourceLayerError,
    SourceRequirements,
  >(
    definition: MigrationDefinition<
      Source,
      PipelineError,
      Cursor,
      IdentityKey,
      unknown,
      SourceInput,
      SourceLayerError,
      SourceRequirements
    >,
    input: MigrationRunDefinitionCursorWindowInput,
    processExecution?: PipelineExecutionOptions
  ) => Effect.Effect<
    MigrationRunCursorWindowResult,
    RunMigrationError | SourceLayerError,
    SourceRequirements
  >;

  readonly fail: (
    input: MigrationRunFailureInput
  ) => Effect.Effect<void, RunMigrationError>;
}

const makeMigrationRunStepExecutor = (
  executor: MigrationRunExecutorService
): MigrationRunStepExecutorService => ({
  begin: executor.begin,
  complete: executor.complete,
  executeCursorWindow: executor.executeCursorWindow,
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

  static readonly complete = (input: MigrationRunCompletionInput) =>
    Effect.flatMap(MigrationRunStepExecutor, (executor) =>
      executor.complete(input)
    );

  static readonly executeCursorWindow = <
    Source,
    PipelineError,
    Cursor,
    IdentityKey extends SourceIdentitySnapshotKey,
    SourceInput,
    SourceLayerError,
    SourceRequirements,
  >(
    definition: MigrationDefinition<
      Source,
      PipelineError,
      Cursor,
      IdentityKey,
      unknown,
      SourceInput,
      SourceLayerError,
      SourceRequirements
    >,
    input: MigrationRunDefinitionCursorWindowInput,
    processExecution?: PipelineExecutionOptions
  ): Effect.Effect<
    MigrationRunCursorWindowResult,
    RunMigrationError | SourceLayerError,
    SourceRequirements | MigrationRunStepExecutor
  > =>
    Effect.flatMap(MigrationRunStepExecutor, (executor) =>
      executor.executeCursorWindow(definition, input, processExecution)
    );

  static readonly fail = (input: MigrationRunFailureInput) =>
    Effect.flatMap(MigrationRunStepExecutor, (executor) =>
      executor.fail(input)
    );

  static readonly layer = Layer.effect(
    MigrationRunStepExecutor,
    Effect.map(MigrationRunExecutor, makeMigrationRunStepExecutor)
  );

  static readonly defaultLayer = MigrationRunStepExecutor.layer.pipe(
    Layer.provide(MigrationRunExecutor.layer)
  );
}
