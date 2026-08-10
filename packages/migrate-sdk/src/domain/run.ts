import { type Effect, Schema } from "effect";
import type {
  AnyMigrationDefinition as AnyMigrationDefinitionShape,
  MigrationDefinitionProcessError,
  MigrationDefinitionSourceIdentityKey,
  MigrationDefinitionSourceImplementationError,
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
  MigrationDefinitionSourceIdentityKey,
  MigrationDefinitionSourceImplementationError,
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
    "cancelled",
    "succeeded",
    "failed",
    "start-failed",
  ]),
});
export type MigrationRunState = typeof MigrationRunState.Type;

export interface MigrationRunHandleState
  extends Omit<MigrationRunState, "status"> {
  readonly status: MigrationRunState["status"] | "cancelling";
}

export type MigrationRunTerminalState = MigrationRunState & {
  readonly finishedAt: Date;
  readonly status: "cancelled" | "failed" | "start-failed" | "succeeded";
};

export const isMigrationRunTerminal = (
  state: MigrationRunHandleState
): state is MigrationRunTerminalState =>
  state.finishedAt !== undefined &&
  (state.status === "cancelled" ||
    state.status === "failed" ||
    state.status === "start-failed" ||
    state.status === "succeeded");

export interface MigrationRunSummary {
  readonly definitions: readonly MigrationDefinitionRunSummary[];
  readonly finishedAt: Date;
  readonly runId: MigrationRunId;
  readonly startedAt: Date;
  readonly status: "succeeded" | "failed" | "cancelled";
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
  /** Identifies the execution within its adapter when the caller is detached. */
  readonly executionId?: string;
}

export type MigrationRunTerminalResult<Summary> =
  | {
      readonly kind: "cancelled";
      readonly state: MigrationRunTerminalState & {
        readonly status: "cancelled";
      };
    }
  | {
      readonly cause: unknown;
      readonly kind: "execution-failed";
      readonly state: MigrationRunTerminalState & {
        readonly status: "failed";
      };
    }
  | {
      readonly kind: "finished";
      readonly state: MigrationRunTerminalState & {
        readonly status: "failed" | "succeeded";
      };
      readonly summary: Summary;
    };

export interface MigrationRunHandle<Summary = MigrationRunSummary> {
  /**
   * Requests cooperative cancellation from the execution host that created
   * this handle. The host drains active work before cancellation is terminal.
   */
  readonly cancel: Effect.Effect<MigrationRunHandleState>;
  /** Reads the attached host's in-memory state without polling Migration Store. */
  readonly get: Effect.Effect<MigrationRunHandleState>;
  readonly runId: MigrationRunId;
  /** Awaits the attached host's terminal signal without polling. */
  readonly wait: Effect.Effect<MigrationRunTerminalResult<Summary>>;
}

export type ExecutionStartResult<Summary = MigrationRunSummary> =
  | {
      readonly kind: "completed";
      readonly runId: MigrationRunId;
      readonly summary: Summary;
    }
  | {
      readonly execution: MigrationExecutionHandle;
      /**
       * Live control remains available only while the executor and its host
       * environment are active. Any scoped source requirements supplied by the
       * caller must remain alive through `handle.wait`; bind those requirements
       * into the configured source with `source.provide(layer)` when the
       * definition should own their lifetime.
       */
      readonly handle: MigrationRunHandle<Summary>;
      readonly kind: "started";
      readonly runId: MigrationRunId;
    }
  | {
      /** Detached runs require the provider identity used to observe them. */
      readonly execution: MigrationExecutionHandle & {
        readonly executionId: string;
      };
      readonly handle?: undefined;
      readonly kind: "started";
      readonly runId: MigrationRunId;
    };
