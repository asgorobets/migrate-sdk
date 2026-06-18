import { Schema } from "effect";
import type { MigrationDefinition } from "./definition.ts";
import type { DestinationCommand } from "./destination.ts";
import type {
  MigrationDefinitionId,
  MigrationDefinitionIdInput,
} from "./ids.ts";
import {
  MigrationDefinitionId as MigrationDefinitionIdSchema,
  MigrationRunId,
  toMigrationDefinitionId,
} from "./ids.ts";
import type { EncodedRunModeInput, RunMode, RunModeInput } from "./run-mode.ts";
import { makeEncodedRunMode } from "./run-mode.ts";
import type { TrackingRecordContract } from "./tracking.ts";

export type AnyMigrationDefinition = MigrationDefinition<
  // biome-ignore lint/suspicious/noExplicitAny: Source is existential across heterogeneous run requests.
  any,
  DestinationCommand,
  // biome-ignore lint/suspicious/noExplicitAny: Pipeline error is re-extracted by MigrationDefinitionPipelineError.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Cursor is existential across heterogeneous run requests.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Source identity key is existential across heterogeneous run requests.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Rollback pipeline error is not relevant to forward run requests.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Source input is existential across heterogeneous run requests.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Source layer error is re-extracted by MigrationDefinitionSourceLayerError.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Source requirements are re-extracted by MigrationDefinitionSourceRequirements.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Tracking contract is existential across heterogeneous run requests.
  any
>;

export type MigrationDefinitionPipelineError<Definition> =
  Definition extends MigrationDefinition<
    infer _Source,
    infer _Command,
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
    infer _Command,
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
    infer _Command,
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
    infer _Command,
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
    infer _Command,
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
  readonly mode?: RunModeInput<
    MigrationDefinitionSourceIdentityKey<Definitions[number]>
  >;
}

export interface RunRequestInput<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> {
  readonly definitionIds?: readonly MigrationDefinitionIdInput[];
  readonly definitions: Definitions;
  readonly mode?: RunModeInput<
    MigrationDefinitionSourceIdentityKey<Definitions[number]>
  >;
}

export const makeRunRequest = <
  Definitions extends readonly AnyMigrationDefinition[],
>(
  input: RunRequestInput<Definitions>
): RunRequest<Definitions> => ({
  definitions: input.definitions,
  ...(input.mode === undefined ? {} : { mode: input.mode }),
  ...(input.definitionIds === undefined
    ? {}
    : { definitionIds: input.definitionIds.map(toMigrationDefinitionId) }),
});

export interface EncodedRunRequest<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> {
  readonly definitionIds?: readonly MigrationDefinitionId[];
  readonly definitions: Definitions;
  readonly mode?: RunMode;
}

export interface EncodedRunRequestInput<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> {
  readonly definitionIds?: readonly MigrationDefinitionIdInput[];
  readonly definitions: Definitions;
  readonly mode?: EncodedRunModeInput;
}

export const makeEncodedRunRequest = <
  Definitions extends readonly AnyMigrationDefinition[],
>(
  input: EncodedRunRequestInput<Definitions>
): EncodedRunRequest<Definitions> => ({
  definitions: input.definitions,
  ...(input.mode === undefined ? {} : { mode: makeEncodedRunMode(input.mode) }),
  ...(input.definitionIds === undefined
    ? {}
    : { definitionIds: input.definitionIds.map(toMigrationDefinitionId) }),
});

export const MigrationRunState = Schema.Struct({
  definitionIds: Schema.Array(MigrationDefinitionIdSchema),
  finishedAt: Schema.optional(Schema.Date),
  runId: MigrationRunId,
  startedAt: Schema.Date,
  status: Schema.Literals(["running", "succeeded", "failed"]),
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

export type ExecutionStartResult =
  | { readonly kind: "Completed"; readonly summary: MigrationRunSummary }
  | { readonly kind: "Started"; readonly runId: MigrationRunId };
