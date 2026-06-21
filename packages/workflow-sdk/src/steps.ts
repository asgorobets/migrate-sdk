import { Effect } from "effect";
import {
  MigrationDefinitionRegistryCatalog,
  MigrationDefinitionRegistryExecutableError,
  MigrationRollbackExecutor,
  MigrationRunStepExecutor,
  toMigrationDefinitionId,
  type MigrationDefinitionId,
  type MigrationDefinitionRegistryCatalogLookupError,
  type MigrationDefinitionRegistryPlanningError,
  type MigrationExecutableRollbackError,
  type MigrationExecutableRunError,
  type MigrationExecutionEnvelopeType,
  type MigrationRollbackExecutionEnvelopeType,
  type MigrationRunCursorWindowResult,
  type MigrationRunCursorWindowState,
  type MigrationRunExecutionEnvelopeType,
  type MigrationRunExecutionLease,
  type MigrationRunSummary,
  type RollbackRunSummary,
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
      "Workflow SDK cursor-window execution currently supports only normal run plans without source identity targets",
    missingRequirements: [
      {
        key: "workflow-sdk-normal-cursor-run",
        label: "Normal cursor-discovery run",
        owner: "definition",
      },
    ],
  });

const makeLease = (
  envelope: MigrationExecutionEnvelopeType
): Effect.Effect<
  MigrationRunExecutionLease,
  MigrationDefinitionRegistryExecutableError
> =>
  envelope.locks === undefined
    ? Effect.fail(missingLocksError(envelope))
    : Effect.succeed({
        locks: envelope.locks,
        runId: envelope.runId,
        scopeDefinitionIds: envelope.scopeDefinitionIds,
      });

const resolveRunPlan = (envelope: MigrationRunExecutionEnvelopeType) =>
  Effect.gen(function* () {
    const registry = yield* MigrationDefinitionRegistryCatalog.get(
      envelope.registryId
    );
    const plan = yield* registry.executable().planRun(envelope.request);

    if (
      plan.target !== undefined ||
      plan.update === true ||
      (plan.mode !== undefined && plan.mode.kind !== "normal")
    ) {
      return yield* unsupportedRunPlanError(envelope);
    }

    return plan;
  });

export const beginMigrationRunExecutionEnvelope = (
  envelope: MigrationRunExecutionEnvelopeType
) =>
  Effect.gen(function* () {
    const plan = yield* resolveRunPlan(envelope);
    const lease = yield* makeLease(envelope);
    const runState = yield* MigrationRunStepExecutor.begin({
      definitions: plan.definitions,
      lease,
    });

    return runState.runId;
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
    const plan = yield* resolveRunPlan(input.envelope);
    const lease = yield* makeLease(input.envelope);
    const definition = plan.definitions.find(
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
      definitionIds: plan.executionDefinitionIds,
      lease,
      runId: input.runId,
      state: input.state,
    });
  });

export const completeMigrationRunExecutionEnvelope = (input: {
  readonly definitions: MigrationRunSummary["definitions"];
  readonly envelope: MigrationRunExecutionEnvelopeType;
}) =>
  Effect.gen(function* () {
    const plan = yield* resolveRunPlan(input.envelope);
    const lease = yield* makeLease(input.envelope);
    const firstDefinition = plan.definitions[0];

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
}) =>
  Effect.gen(function* () {
    const plan = yield* resolveRunPlan(input.envelope);
    const lease = yield* makeLease(input.envelope);
    const firstDefinition = plan.definitions[0];

    if (firstDefinition === undefined) {
      return yield* unsupportedRunPlanError(input.envelope);
    }

    return yield* MigrationRunStepExecutor.fail({
      definitionIds: plan.executionDefinitionIds,
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
    const registry = yield* MigrationDefinitionRegistryCatalog.get(
      envelope.registryId
    );
    const plan = yield* registry.executable().planRollback(envelope.request);
    const lease = yield* makeLease(envelope);

    return yield* MigrationRollbackExecutor.executePlan(plan, { lease });
  });
