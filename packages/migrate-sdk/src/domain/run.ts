import { Schema } from "effect";
import type {
  AnyMigrationDefinition as AnyMigrationDefinitionShape,
  MigrationDefinitionProcessError,
  MigrationDefinitionSourceImplementationError,
  MigrationDefinitionSourceIdentityKey,
  MigrationDefinitionSourceRequirements,
  MigrationDefinitionTrackingContract,
} from "./definition.ts";
import type {
  MigrationExecutionOptions,
  NormalizedMigrationExecutionOptions,
} from "./execution.ts";
import { normalizeMigrationExecutionOptions } from "./execution.ts";
import type {
  MigrationDefinitionId,
  MigrationDefinitionIdInput,
} from "./ids.ts";
import {
  MigrationDefinitionId as MigrationDefinitionIdSchema,
  MigrationRunId,
  toMigrationDefinitionId,
} from "./ids.ts";
import type { RunModeInput } from "./run-mode.ts";
import type { TrackingRecordContract } from "./tracking.ts";

export type {
  MigrationDefinitionSourceImplementationError,
  MigrationDefinitionSourceIdentityKey,
  MigrationDefinitionSourceRequirements,
  MigrationDefinitionTrackingContract,
} from "./definition.ts";

export type AnyMigrationDefinition = AnyMigrationDefinitionShape;

export type MigrationDefinitionPipelineError<
  Definition extends AnyMigrationDefinition,
> = MigrationDefinitionProcessError<Definition>;

export type MigrationDefinitionTrackingRecord<
  Definition extends AnyMigrationDefinition,
> =
  MigrationDefinitionTrackingContract<Definition> extends TrackingRecordContract<
    infer Value,
    infer _Encoded
  >
    ? Value
    : never;

export type RunRequestSourceImplementationError<
  Definitions extends readonly AnyMigrationDefinition[],
> = MigrationDefinitionSourceImplementationError<Definitions[number]>;

export type RunRequestSourceRequirements<
  Definitions extends readonly AnyMigrationDefinition[],
> = MigrationDefinitionSourceRequirements<Definitions[number]>;

export interface RunRequest<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> {
  readonly definitionIds?: readonly MigrationDefinitionId[];
  readonly definitions: Definitions;
  readonly execution?: NormalizedMigrationExecutionOptions;
  readonly mode?: RunModeInput<
    MigrationDefinitionSourceIdentityKey<Definitions[number]>
  >;
  readonly update?: boolean;
}

export interface RunRequestInput<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> {
  readonly definitionIds?: readonly MigrationDefinitionIdInput[];
  readonly definitions: Definitions;
  readonly execution?: MigrationExecutionOptions;
  readonly mode?: RunModeInput<
    MigrationDefinitionSourceIdentityKey<Definitions[number]>
  >;
  readonly update?: boolean;
}

export const makeRunRequest = <
  Definitions extends readonly AnyMigrationDefinition[],
>(
  input: RunRequestInput<Definitions>
): RunRequest<Definitions> => ({
  definitions: input.definitions,
  ...(input.execution === undefined
    ? {}
    : { execution: normalizeMigrationExecutionOptions(input.execution) }),
  ...(input.mode === undefined ? {} : { mode: input.mode }),
  ...(input.update === undefined ? {} : { update: input.update }),
  ...(input.definitionIds === undefined
    ? {}
    : { definitionIds: input.definitionIds.map(toMigrationDefinitionId) }),
});

export const MigrationRunState = Schema.Struct({
  definitionIds: Schema.Array(MigrationDefinitionIdSchema),
  execution: Schema.optional(
    Schema.Struct({
      adapter: Schema.String,
      executionId: Schema.optional(Schema.String),
    })
  ),
  finishedAt: Schema.optional(Schema.Date),
  runId: MigrationRunId,
  startedAt: Schema.Date,
  status: Schema.Literals([
    "queued",
    "running",
    "succeeded",
    "failed",
    "start-failed",
  ]),
});
export type MigrationRunState = typeof MigrationRunState.Type;

export interface MigrationRunSummary {
  readonly definitions: readonly MigrationDefinitionRunSummary[];
  readonly finishedAt: Date;
  readonly runId: MigrationRunId;
  readonly startedAt: Date;
  readonly status: "succeeded" | "failed";
}

export interface MigrationDefinitionRunSummary {
  readonly counts: {
    readonly migrated: number;
    readonly skipped: number;
    readonly failed: number;
    readonly unchanged: number;
    readonly needsUpdate: number;
  };
  readonly definitionId: MigrationDefinitionId;
  readonly status: "succeeded" | "failed" | "skipped";
}

export interface MigrationExecutionHandle {
  readonly adapter: string;
  readonly executionId?: string;
}

export type ExecutionStartResult<Summary = MigrationRunSummary> =
  | {
      readonly kind: "completed";
      readonly runId: MigrationRunId;
      readonly summary: Summary;
    }
  | {
      readonly execution: MigrationExecutionHandle;
      readonly kind: "started";
      readonly runId: MigrationRunId;
    };
