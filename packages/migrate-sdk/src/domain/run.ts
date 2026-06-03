import type { MigrationDefinition } from "./definition.ts";
import type { DestinationCommand } from "./destination.ts";
import type {
  MigrationDefinitionId,
  MigrationDefinitionIdInput,
  MigrationRunId,
  SourceCursor,
} from "./ids.ts";
import { toMigrationDefinitionId } from "./ids.ts";
import type { RunMode, RunModeInput } from "./run-mode.ts";
import { makeRunMode } from "./run-mode.ts";

export type AnyMigrationDefinition = MigrationDefinition<
  // biome-ignore lint/suspicious/noExplicitAny: Source is existential across heterogeneous run requests.
  any,
  DestinationCommand,
  // biome-ignore lint/suspicious/noExplicitAny: Pipeline error is re-extracted by MigrationDefinitionPipelineError.
  any
>;

export type MigrationDefinitionPipelineError<Definition> =
  Definition extends MigrationDefinition<
    infer _Source,
    infer _Command,
    infer PipelineError
  >
    ? PipelineError
    : never;

export interface RunRequest<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> {
  readonly cursor?: SourceCursor;
  readonly definitionIds?: readonly MigrationDefinitionId[];
  readonly definitions: Definitions;
  readonly mode?: RunMode;
}

export interface RunRequestInput<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> {
  readonly cursor?: SourceCursor;
  readonly definitionIds?: readonly MigrationDefinitionIdInput[];
  readonly definitions: Definitions;
  readonly mode?: RunModeInput;
}

export const makeRunRequest = <
  Definitions extends readonly AnyMigrationDefinition[],
>(
  input: RunRequestInput<Definitions>
): RunRequest<Definitions> => ({
  definitions: input.definitions,
  ...(input.mode === undefined ? {} : { mode: makeRunMode(input.mode) }),
  ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  ...(input.definitionIds === undefined
    ? {}
    : { definitionIds: input.definitionIds.map(toMigrationDefinitionId) }),
});

export interface MigrationRunState {
  readonly definitionIds: readonly MigrationDefinitionId[];
  readonly finishedAt?: Date;
  readonly runId: MigrationRunId;
  readonly startedAt: Date;
  readonly status: "running" | "succeeded" | "failed";
}

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
  readonly cursor?: SourceCursor;
  readonly definitionId: MigrationDefinitionId;
  readonly status: "succeeded" | "failed" | "skipped";
}

export type ExecutionStartResult =
  | { readonly kind: "Completed"; readonly summary: MigrationRunSummary }
  | { readonly kind: "Started"; readonly runId: MigrationRunId };
