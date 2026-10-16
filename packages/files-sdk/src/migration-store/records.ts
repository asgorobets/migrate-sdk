import { Schema } from "effect";
import {
  EncodedSourceCursor,
  MigrationDefinitionId,
  MigrationDefinitionLockToken,
  MigrationRunId,
  MigrationRunOperation,
} from "migrate-sdk";

export const Completion = Schema.Struct({
  definitionId: MigrationDefinitionId,
  runId: MigrationRunId,
  completedAt: Schema.DateFromString,
  sourceCursor: Schema.NullOr(EncodedSourceCursor),
});

export const Lock = Schema.Struct({
  definitionId: MigrationDefinitionId,
  ownerRunId: MigrationRunId,
  token: MigrationDefinitionLockToken,
  createdAt: Schema.DateFromString,
});

const DefinitionOutcome = Schema.Struct({
  definitionId: MigrationDefinitionId,
  status: Schema.Literals(["succeeded", "failed", "skipped"]),
});

export const Run = Schema.Struct({
  state: Schema.Struct({
    runId: MigrationRunId,
    definitionIds: Schema.Array(MigrationDefinitionId),
    operation: Schema.optional(MigrationRunOperation),
    startedAt: Schema.DateFromString,
    finishedAt: Schema.optional(Schema.DateFromString),
    status: Schema.Literals([
      "queued",
      "running",
      "cancelling",
      "cancelled",
      "succeeded",
      "failed",
      "start-failed",
    ]),
    execution: Schema.optional(
      Schema.Struct({
        adapter: Schema.String,
        executionId: Schema.optional(Schema.String),
      })
    ),
  }),
  predecessors: Schema.Array(
    Schema.Struct({
      definitionId: MigrationDefinitionId,
      runId: Schema.NullOr(MigrationRunId),
    })
  ),
  outcomes: Schema.optional(Schema.Array(DefinitionOutcome)),
});
export type Run = typeof Run.Type;

export const Manifest = Schema.Struct({
  storeKind: Schema.Literal("files-sdk"),
  createdAt: Schema.DateFromString,
});
