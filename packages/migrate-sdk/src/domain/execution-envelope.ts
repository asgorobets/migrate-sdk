import { Effect, Schema } from "effect";
import {
  MigrationDefinitionRegistryCatalog,
  type MigrationDefinitionRegistryCatalogLookupError,
} from "../services/migration-definition-registry-catalog.ts";
import {
  executeMigrationRollbackPlanInline,
  executeMigrationRunPlanInline,
  type MigrationExecutableRollbackError,
  type MigrationExecutableRunError,
} from "../services/migration-executable.ts";
import {
  MigrationDefinitionId,
  MigrationDefinitionRegistryId,
  MigrationRunId,
  type MigrationRunIdInput,
  toMigrationRunId,
} from "./ids.ts";
import type {
  MigrationDefinitionExecutableRollbackPlan,
  MigrationDefinitionExecutableRunPlan,
  MigrationDefinitionRegistryExecutableError,
  MigrationDefinitionRegistryPlanningError,
  MigrationDefinitionRegistryRollbackInput,
  MigrationDefinitionRegistryRunInput,
} from "./registry.ts";
import type { RollbackRunSummary } from "./rollback.ts";
import type { MigrationRunSummary } from "./run.ts";

export interface MigrationExecutionEnvelopeBase {
  readonly definitionIds: readonly MigrationDefinitionId[];
  readonly plannedOrder: readonly MigrationDefinitionId[];
  readonly registryId: MigrationDefinitionRegistryId;
  readonly runId: MigrationRunId;
}

export interface MigrationRunExecutionEnvelope
  extends MigrationExecutionEnvelopeBase {
  readonly kind: "run";
  readonly request: MigrationDefinitionRegistryRunInput;
}

export interface MigrationRollbackExecutionEnvelope
  extends MigrationExecutionEnvelopeBase {
  readonly kind: "rollback";
  readonly request: MigrationDefinitionRegistryRollbackInput;
}

export type MigrationExecutionEnvelope =
  | MigrationRunExecutionEnvelope
  | MigrationRollbackExecutionEnvelope;

export const MigrationRunExecutionEnvelope = Schema.Struct({
  definitionIds: Schema.Array(MigrationDefinitionId),
  kind: Schema.Literal("run"),
  plannedOrder: Schema.Array(MigrationDefinitionId),
  registryId: MigrationDefinitionRegistryId,
  request: Schema.Unknown,
  runId: MigrationRunId,
});

export const MigrationRollbackExecutionEnvelope = Schema.Struct({
  definitionIds: Schema.Array(MigrationDefinitionId),
  kind: Schema.Literal("rollback"),
  plannedOrder: Schema.Array(MigrationDefinitionId),
  registryId: MigrationDefinitionRegistryId,
  request: Schema.Unknown,
  runId: MigrationRunId,
});

export const MigrationExecutionEnvelope = Schema.Union([
  MigrationRunExecutionEnvelope,
  MigrationRollbackExecutionEnvelope,
]);

export class MigrationExecutionEnvelopeMissingRegistryIdError extends Schema.TaggedErrorClass<MigrationExecutionEnvelopeMissingRegistryIdError>()(
  "MigrationExecutionEnvelopeMissingRegistryIdError",
  {
    kind: Schema.Literals(["run", "rollback"]),
    message: Schema.String,
    runId: MigrationRunId,
  }
) {}

export interface MigrationExecutionEnvelopeInput {
  readonly runId: MigrationRunIdInput;
}

const requireRegistryId = (
  kind: "run" | "rollback",
  runId: MigrationRunId,
  registryId: MigrationDefinitionRegistryId | undefined
): Effect.Effect<
  MigrationDefinitionRegistryId,
  MigrationExecutionEnvelopeMissingRegistryIdError
> =>
  registryId === undefined
    ? Effect.fail(
        new MigrationExecutionEnvelopeMissingRegistryIdError({
          kind,
          runId,
          message:
            "Migration Execution Envelope requires a registry-backed executable plan",
        })
      )
    : Effect.succeed(registryId);

export const makeMigrationRunExecutionEnvelope = (
  plan: MigrationDefinitionExecutableRunPlan,
  input: MigrationExecutionEnvelopeInput
): Effect.Effect<
  MigrationRunExecutionEnvelope,
  MigrationExecutionEnvelopeMissingRegistryIdError
> => {
  const runId = toMigrationRunId(input.runId);

  return Effect.map(
    requireRegistryId("run", runId, plan.registryId),
    (registryId) => ({
      definitionIds: plan.includedDefinitionIds,
      kind: "run" as const,
      plannedOrder: plan.executionDefinitionIds,
      registryId,
      request: plan.request,
      runId,
    })
  );
};

export const makeMigrationRollbackExecutionEnvelope = (
  plan: MigrationDefinitionExecutableRollbackPlan,
  input: MigrationExecutionEnvelopeInput
): Effect.Effect<
  MigrationRollbackExecutionEnvelope,
  MigrationExecutionEnvelopeMissingRegistryIdError
> => {
  const runId = toMigrationRunId(input.runId);

  return Effect.map(
    requireRegistryId("rollback", runId, plan.registryId),
    (registryId) => ({
      definitionIds: plan.includedDefinitionIds,
      kind: "rollback" as const,
      plannedOrder: plan.executionDefinitionIds,
      registryId,
      request: plan.request,
      runId,
    })
  );
};

export type MigrationExecutionEnvelopeExecutionError =
  | MigrationDefinitionRegistryCatalogLookupError
  | MigrationDefinitionRegistryPlanningError
  | MigrationDefinitionRegistryExecutableError
  | MigrationExecutableRunError
  | MigrationExecutableRollbackError;

export const executeMigrationExecutionEnvelope = (
  envelope: MigrationExecutionEnvelope
): Effect.Effect<
  MigrationRunSummary | RollbackRunSummary,
  MigrationExecutionEnvelopeExecutionError,
  MigrationDefinitionRegistryCatalog
> =>
  Effect.gen(function* () {
    const registry = yield* MigrationDefinitionRegistryCatalog.get(
      envelope.registryId
    );

    if (envelope.kind === "run") {
      const plan = yield* registry.executable().planRun(envelope.request);

      return yield* executeMigrationRunPlanInline(plan, {
        runId: envelope.runId,
      });
    }

    const plan = yield* registry.executable().planRollback(envelope.request);

    return yield* executeMigrationRollbackPlanInline(plan, {
      runId: envelope.runId,
    });
  });
