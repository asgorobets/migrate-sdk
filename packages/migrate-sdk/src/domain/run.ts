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

export interface RunRequest {
  readonly definitions: ReadonlyArray<
    MigrationDefinition<any, DestinationCommand>
  >;
  readonly mode?: RunMode;
  readonly cursor?: SourceCursor;
  readonly definitionIds?: ReadonlyArray<MigrationDefinitionId>;
}

export interface RunRequestInput {
  readonly definitions: ReadonlyArray<
    MigrationDefinition<any, DestinationCommand>
  >;
  readonly mode?: RunModeInput;
  readonly cursor?: SourceCursor;
  readonly definitionIds?: ReadonlyArray<MigrationDefinitionIdInput>;
}

export const makeRunRequest = (input: RunRequestInput): RunRequest => ({
  definitions: input.definitions,
  ...(input.mode === undefined ? {} : { mode: makeRunMode(input.mode) }),
  ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  ...(input.definitionIds === undefined
    ? {}
    : { definitionIds: input.definitionIds.map(toMigrationDefinitionId) }),
});

export interface MigrationRunState {
  readonly runId: MigrationRunId;
  readonly definitionIds: ReadonlyArray<MigrationDefinitionId>;
  readonly status: "running" | "succeeded" | "failed";
  readonly startedAt: Date;
  readonly finishedAt?: Date;
}

export interface MigrationRunSummary {
  readonly runId: MigrationRunId;
  readonly status: "succeeded" | "failed";
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly definitions: ReadonlyArray<MigrationDefinitionRunSummary>;
}

export interface MigrationDefinitionRunSummary {
  readonly definitionId: MigrationDefinitionId;
  readonly status: "succeeded" | "failed" | "skipped";
  readonly counts: {
    readonly migrated: number;
    readonly skipped: number;
    readonly failed: number;
    readonly unchanged: number;
    readonly needsUpdate: number;
  };
  readonly cursor?: SourceCursor;
}

export type ExecutionStartResult =
  | { readonly kind: "Completed"; readonly summary: MigrationRunSummary }
  | { readonly kind: "Started"; readonly runId: MigrationRunId };
