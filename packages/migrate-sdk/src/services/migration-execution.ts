import { Effect, Layer } from "effect";
import { Service } from "effect/Context";
import type { MigrationDefinitionRegistryIdInput } from "../domain/ids.ts";
import type {
  MigrationDefinitionExecutableRollbackPlan,
  MigrationDefinitionExecutableRunPlan,
  MigrationDefinitionRegistry,
  MigrationDefinitionRegistryExecutableError,
  MigrationDefinitionRegistryPlanningError,
  MigrationDefinitionRegistryRollbackInput,
  MigrationDefinitionRegistryRunInput,
} from "../domain/registry.ts";
import type { RollbackRunSummary } from "../domain/rollback.ts";
import type {
  AnyMigrationDefinition,
  ExecutionStartResult,
  MigrationRunSummary,
  RunRequestSourceRequirements,
} from "../domain/run.ts";
import {
  MigrationDefinitionRegistryCatalog,
  type MigrationDefinitionRegistryCatalogLookupError,
} from "./migration-definition-registry-catalog.ts";
import {
  MigrationExecutable,
  type MigrationExecutableRollbackStartError,
  type MigrationExecutableRunStartError,
  type MigrationExecutableService,
} from "./migration-executable.ts";

export type MigrationExecutionRunInput = MigrationDefinitionRegistryRunInput & {
  readonly registryId: MigrationDefinitionRegistryIdInput;
};

export type MigrationExecutionRollbackInput =
  MigrationDefinitionRegistryRollbackInput & {
    readonly registryId: MigrationDefinitionRegistryIdInput;
  };

export type MigrationExecutionRunError =
  | MigrationDefinitionRegistryCatalogLookupError
  | MigrationDefinitionRegistryPlanningError
  | MigrationDefinitionRegistryExecutableError
  | MigrationExecutableRunStartError;

export type MigrationExecutionRollbackError =
  | MigrationDefinitionRegistryCatalogLookupError
  | MigrationDefinitionRegistryPlanningError
  | MigrationDefinitionRegistryExecutableError
  | MigrationExecutableRollbackStartError;

export interface MigrationExecutionService {
  readonly rollback: (
    input: MigrationExecutionRollbackInput
  ) => Effect.Effect<
    ExecutionStartResult<RollbackRunSummary>,
    MigrationExecutionRollbackError
  >;

  readonly run: (
    input: MigrationExecutionRunInput
  ) => Effect.Effect<
    ExecutionStartResult<MigrationRunSummary>,
    MigrationExecutionRunError,
    RunRequestSourceRequirements<readonly AnyMigrationDefinition[]>
  >;
}

export interface BoundMigrationExecutionService<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> {
  readonly rollback: (
    input: MigrationDefinitionRegistryRollbackInput
  ) => Effect.Effect<
    ExecutionStartResult<RollbackRunSummary>,
    | MigrationDefinitionRegistryPlanningError
    | MigrationDefinitionRegistryExecutableError
    | MigrationExecutableRollbackStartError
  >;

  readonly run: (
    input: MigrationDefinitionRegistryRunInput
  ) => Effect.Effect<
    ExecutionStartResult<MigrationRunSummary>,
    | MigrationDefinitionRegistryPlanningError
    | MigrationDefinitionRegistryExecutableError
    | MigrationExecutableRunStartError<Definitions>,
    RunRequestSourceRequirements<Definitions>
  >;
}

export interface MigrationExecutionMakeInput<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> {
  readonly executable: MigrationExecutableService;
  readonly registry: MigrationDefinitionRegistry<Definitions>;
}

export const makeMigrationExecution = <
  Definitions extends readonly AnyMigrationDefinition[],
>(
  input: MigrationExecutionMakeInput<Definitions>
): BoundMigrationExecutionService<Definitions> => ({
  rollback: (request) =>
    Effect.flatMap(input.registry.executable().planRollback(request), (plan) =>
      input.executable.startRollback(plan)
    ),
  run: (request) =>
    Effect.flatMap(
      input.registry.executable().planRun(request),
      (plan: MigrationDefinitionExecutableRunPlan<Definitions>) =>
        input.executable.startRun(plan)
    ),
});

const makeCatalogExecution = (
  catalog: typeof MigrationDefinitionRegistryCatalog.Service,
  executable: MigrationExecutableService
): MigrationExecutionService => ({
  rollback: Effect.fn("MigrationExecution.rollback")((input) =>
    Effect.gen(function* () {
      const registry = yield* catalog.get(input.registryId);
      const plan = yield* registry.executable().planRollback(input);

      return yield* executable.startRollback(
        plan as MigrationDefinitionExecutableRollbackPlan
      );
    })
  ),
  run: Effect.fn("MigrationExecution.run")((input) =>
    Effect.gen(function* () {
      const registry = yield* catalog.get(input.registryId);
      const plan = yield* registry.executable().planRun(input);

      return yield* executable.startRun(plan);
    })
  ),
});

export class MigrationExecution extends Service<
  MigrationExecution,
  MigrationExecutionService
>()("@migrate-sdk/MigrationExecution") {
  static readonly make = makeMigrationExecution;

  static readonly rollback = (input: MigrationExecutionRollbackInput) =>
    Effect.flatMap(MigrationExecution, (execution) =>
      execution.rollback(input)
    );

  static readonly run = (input: MigrationExecutionRunInput) =>
    Effect.flatMap(MigrationExecution, (execution) => execution.run(input));

  static readonly layer = Layer.effect(
    MigrationExecution,
    Effect.gen(function* () {
      const catalog = yield* MigrationDefinitionRegistryCatalog;
      const executable = yield* MigrationExecutable;

      return makeCatalogExecution(catalog, executable);
    })
  );
}
