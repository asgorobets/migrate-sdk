import { Effect, Schema } from "effect";
import {
  MigrationDefinitionRegistryCatalog,
  type MigrationDefinitionRegistryCatalogLookupError,
} from "../services/migration-definition-registry-catalog.ts";
import type {
  MigrationExecutableRollbackError,
  MigrationExecutableRunError,
} from "../services/migration-executable.ts";
import {
  MigrationRollbackExecutor,
  MigrationRunExecutor,
} from "../services/migration-run-executor.ts";
import {
  MigrationDefinitionId,
  MigrationDefinitionRegistryId,
  MigrationRunId,
  type MigrationRunIdInput,
  toMigrationRunId,
} from "./ids.ts";
import { MigrationDefinitionLock } from "./lock.ts";
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
  readonly executionDefinitionIds: readonly MigrationDefinitionId[];
  readonly registryId: MigrationDefinitionRegistryId;
  readonly runId: MigrationRunId;
  readonly scopeDefinitionIds: readonly MigrationDefinitionId[];
}

export interface MigrationRunExecutionEnvelope
  extends MigrationExecutionEnvelopeBase {
  readonly kind: "run";
  readonly locks?: readonly MigrationDefinitionLock[];
  readonly request: MigrationDefinitionRegistryRunInput;
}

export interface MigrationRollbackExecutionEnvelope
  extends MigrationExecutionEnvelopeBase {
  readonly kind: "rollback";
  readonly locks?: readonly MigrationDefinitionLock[];
  readonly request: MigrationDefinitionRegistryRollbackInput;
}

export type MigrationExecutionEnvelope =
  | MigrationRunExecutionEnvelope
  | MigrationRollbackExecutionEnvelope;

export const MigrationRunExecutionEnvelope = Schema.Struct({
  executionDefinitionIds: Schema.Array(MigrationDefinitionId),
  kind: Schema.Literal("run"),
  locks: Schema.optional(Schema.Array(MigrationDefinitionLock)),
  registryId: MigrationDefinitionRegistryId,
  request: Schema.Unknown,
  runId: MigrationRunId,
  scopeDefinitionIds: Schema.Array(MigrationDefinitionId),
});

export const MigrationRollbackExecutionEnvelope = Schema.Struct({
  executionDefinitionIds: Schema.Array(MigrationDefinitionId),
  kind: Schema.Literal("rollback"),
  locks: Schema.optional(Schema.Array(MigrationDefinitionLock)),
  registryId: MigrationDefinitionRegistryId,
  request: Schema.Unknown,
  runId: MigrationRunId,
  scopeDefinitionIds: Schema.Array(MigrationDefinitionId),
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
  readonly locks?: readonly MigrationDefinitionLock[];
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
      executionDefinitionIds: plan.executionDefinitionIds,
      kind: "run" as const,
      registryId,
      request: plan.request,
      runId,
      scopeDefinitionIds: plan.includedDefinitionIds,
      ...(input.locks === undefined ? {} : { locks: input.locks }),
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
      executionDefinitionIds: plan.executionDefinitionIds,
      kind: "rollback" as const,
      ...(input.locks === undefined ? {} : { locks: input.locks }),
      registryId,
      request: plan.request,
      runId,
      scopeDefinitionIds: plan.includedDefinitionIds,
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
  | MigrationDefinitionRegistryCatalog
  | MigrationRollbackExecutor
  | MigrationRunExecutor
> =>
  Effect.gen(function* () {
    const registry = yield* MigrationDefinitionRegistryCatalog.get(
      envelope.registryId
    );
    const executionOptions = {
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
    };

    if (envelope.kind === "run") {
      const plan = yield* registry.executable().planRun(envelope.request);

      return yield* MigrationRunExecutor.executePlan(plan, executionOptions);
    }

    const plan = yield* registry.executable().planRollback(envelope.request);

    return yield* MigrationRollbackExecutor.executePlan(plan, executionOptions);
  });
