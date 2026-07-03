import { Schema } from "effect";
import type { MigrationDefinition } from "./definition.ts";
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

type AnyMigrationDefinitionForTracking<
  TrackingContract extends TrackingRecordContract | undefined,
> = MigrationDefinition<
  // biome-ignore lint/suspicious/noExplicitAny: Source is existential across heterogeneous run requests.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Process error is re-extracted by MigrationDefinitionPipelineError.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Cursor is existential across heterogeneous run requests.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Source identity key is existential across heterogeneous run requests.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Rollback process error is not relevant to forward run requests.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Source input is existential across heterogeneous run requests.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Source layer error is re-extracted by MigrationDefinitionSourceLayerError.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Source requirements are re-extracted by MigrationDefinitionSourceRequirements.
  any,
  TrackingContract
>;

export type AnyMigrationDefinition =
  | AnyMigrationDefinitionForTracking<undefined>
  | AnyMigrationDefinitionForTracking<TrackingRecordContract>;

export type MigrationDefinitionPipelineError<Definition> =
  Definition extends MigrationDefinition<
    infer _Source,
    infer PipelineError,
    infer _Cursor,
    infer _IdentityKey,
    infer _RollbackPipelineError,
    infer _SourceInput,
    infer _SourceLayerError,
    infer _SourceRequirements,
    infer _TrackingContract
  >
    ? PipelineError
    : never;

export type MigrationDefinitionSourceLayerError<Definition> =
  Definition extends MigrationDefinition<
    infer _Source,
    infer _PipelineError,
    infer _Cursor,
    infer _IdentityKey,
    infer _RollbackPipelineError,
    infer _SourceInput,
    infer SourceLayerError,
    infer _SourceRequirements,
    infer _TrackingContract
  >
    ? SourceLayerError
    : never;

export type MigrationDefinitionSourceRequirements<Definition> =
  Definition extends MigrationDefinition<
    infer _Source,
    infer _PipelineError,
    infer _Cursor,
    infer _IdentityKey,
    infer _RollbackPipelineError,
    infer _SourceInput,
    infer _SourceLayerError,
    infer SourceRequirements,
    infer _TrackingContract
  >
    ? SourceRequirements
    : never;

export type MigrationDefinitionSourceIdentityKey<Definition> =
  Definition extends MigrationDefinition<
    infer _Source,
    infer _PipelineError,
    infer _Cursor,
    infer IdentityKey,
    infer _RollbackPipelineError,
    infer _SourceInput,
    infer _SourceLayerError,
    infer _SourceRequirements,
    infer _TrackingContract
  >
    ? IdentityKey
    : never;

export type MigrationDefinitionTrackingContract<Definition> =
  Definition extends MigrationDefinition<
    infer _Source,
    infer _PipelineError,
    infer _Cursor,
    infer _IdentityKey,
    infer _RollbackPipelineError,
    infer _SourceInput,
    infer _SourceLayerError,
    infer _SourceRequirements,
    infer TrackingContract
  >
    ? TrackingContract
    : never;

export type MigrationDefinitionTrackingRecord<Definition> =
  MigrationDefinitionTrackingContract<Definition> extends TrackingRecordContract<
    infer Value,
    infer _Encoded
  >
    ? Value
    : never;

export type RunRequestSourceLayerError<
  Definitions extends readonly AnyMigrationDefinition[],
> = MigrationDefinitionSourceLayerError<Definitions[number]>;

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
