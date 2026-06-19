import { Effect, Exit, Schema } from "effect";
import type { MigrationRunId } from "./ids.ts";
import { MigrationRunId as MigrationRunIdSchema } from "./ids.ts";
import {
  makeTrackingRecordContractFingerprint,
  type TrackingRecordContractFingerprint,
  TrackingRecordContractId,
  type TrackingRecordContractIdInput,
} from "./migration-contract.ts";

export const DestinationChangeDescriptorId = Schema.NonEmptyString.pipe(
  Schema.brand("DestinationChangeDescriptorId")
);
export type DestinationChangeDescriptorId =
  typeof DestinationChangeDescriptorId.Type;

export type DestinationChangeValue = Schema.Json;

export interface DestinationJournalChangeEntry<
  Value extends DestinationChangeValue = DestinationChangeValue,
> {
  readonly descriptorId: DestinationChangeDescriptorId;
  readonly kind: "change";
  readonly sequence: number;
  readonly value: Value;
}

export const DestinationJournalChangeEntry = Schema.Struct({
  descriptorId: DestinationChangeDescriptorId,
  kind: Schema.Literal("change"),
  sequence: Schema.Int,
  value: Schema.Json,
});

export const DestinationJournalDiagnosticSeverity = Schema.Literals([
  "info",
  "warning",
  "error",
]);
export type DestinationJournalDiagnosticSeverity =
  typeof DestinationJournalDiagnosticSeverity.Type;

const JsonObject = Schema.Record(Schema.String, Schema.Json);

export interface DestinationJournalDiagnosticInput {
  readonly details?: Schema.JsonObject | undefined;
  readonly message: string;
  readonly severity: DestinationJournalDiagnosticSeverity;
}

const DestinationJournalDiagnosticFields = {
  details: Schema.optional(JsonObject),
  message: Schema.String,
  severity: DestinationJournalDiagnosticSeverity,
} as const;

export const DestinationJournalDiagnosticInput = Schema.Struct(
  DestinationJournalDiagnosticFields
);

export interface DestinationJournalDiagnosticEntry
  extends DestinationJournalDiagnosticInput {
  readonly kind: "diagnostic";
  readonly sequence: number;
}

export const DestinationJournalDiagnosticEntry = Schema.Struct({
  ...DestinationJournalDiagnosticFields,
  kind: Schema.Literal("diagnostic"),
  sequence: Schema.Int,
});

export type DestinationJournalEntry =
  | DestinationJournalChangeEntry
  | DestinationJournalDiagnosticEntry;

export const DestinationJournalEntry = Schema.Union([
  DestinationJournalChangeEntry,
  DestinationJournalDiagnosticEntry,
]);

const DestinationJournalSegmentFields = {
  entries: Schema.Array(DestinationJournalEntry),
  runId: MigrationRunIdSchema,
} as const;

export const DestinationJournalSegment = Schema.Struct(
  DestinationJournalSegmentFields
);
export interface DestinationJournalSegment {
  readonly entries: readonly DestinationJournalEntry[];
  readonly runId: MigrationRunId;
}

const DestinationJournalRollbackAttemptErrorDetail = Schema.Struct({
  path: Schema.optional(Schema.String),
  message: Schema.String,
});

export const DestinationJournalRollbackAttemptError = Schema.Struct({
  kind: Schema.Literals([
    "source",
    "tracking",
    "process",
    "destination",
  ]),
  errorTag: Schema.String,
  message: Schema.String,
  details: Schema.optional(
    Schema.Array(DestinationJournalRollbackAttemptErrorDetail)
  ),
});
export type DestinationJournalRollbackAttemptError =
  typeof DestinationJournalRollbackAttemptError.Type;

export const DestinationRollbackAttemptJournalSegment = Schema.Struct({
  ...DestinationJournalSegmentFields,
  error: DestinationJournalRollbackAttemptError,
  failedAt: Schema.Date,
});
export interface DestinationRollbackAttemptJournalSegment
  extends DestinationJournalSegment {
  readonly error: DestinationJournalRollbackAttemptError;
  readonly failedAt: Date;
}

export const DestinationJournal = Schema.Struct({
  process: DestinationJournalSegment,
  rollbackAttempts: Schema.Array(DestinationRollbackAttemptJournalSegment),
});
export interface DestinationJournal {
  readonly process: DestinationJournalSegment;
  readonly rollbackAttempts: readonly DestinationRollbackAttemptJournalSegment[];
}

export type TrackingRecordValue = Schema.JsonObject;

export const TrackingRecord = Schema.Record(Schema.String, Schema.Json);
export type TrackingRecord = typeof TrackingRecord.Type;

export interface TrackingRecordContract<
  Value extends TrackingRecordValue = TrackingRecordValue,
  Encoded extends TrackingRecordValue = TrackingRecordValue,
> {
  readonly fingerprint: TrackingRecordContractFingerprint;
  readonly id: TrackingRecordContractId;
  readonly schema: Schema.Codec<Value, Encoded, never, never>;
}

export interface TrackingRecordContractInput<
  Value extends TrackingRecordValue,
  Encoded extends TrackingRecordValue,
> {
  readonly id: TrackingRecordContractIdInput;
  readonly schema: Schema.Codec<Value, Encoded, never, never>;
}

export interface DestinationChangeDescriptor<
  Value extends DestinationChangeValue,
  Encoded extends Schema.Json = Schema.Json,
> {
  readonly decode: (
    entry: DestinationJournalEntry
  ) => Effect.Effect<DestinationJournalChangeEntry<Value>, Schema.SchemaError>;
  readonly id: DestinationChangeDescriptorId;
  readonly is: (
    entry: DestinationJournalEntry
  ) => entry is DestinationJournalChangeEntry;
  readonly schema: Schema.Codec<Value, Encoded, never, never>;
}

const make = <
  Value extends DestinationChangeValue,
  Encoded extends Schema.Json,
>(
  id: string,
  schema: Schema.Codec<Value, Encoded, never, never>
): DestinationChangeDescriptor<Value, Encoded> => {
  const descriptorId = DestinationChangeDescriptorId.make(id);
  const entrySchema = Schema.Struct({
    descriptorId: Schema.Literal(descriptorId),
    kind: Schema.Literal("change"),
    sequence: Schema.Int,
    value: schema,
  });
  const is = (
    entry: DestinationJournalEntry
  ): entry is DestinationJournalChangeEntry =>
    entry.kind === "change" &&
    entry.descriptorId === descriptorId &&
    Exit.isSuccess(Schema.decodeUnknownExit(entrySchema)(entry));
  const decode = (entry: DestinationJournalEntry) =>
    Schema.decodeUnknownEffect(entrySchema, { errors: "all" })(entry).pipe(
      Effect.map(
        (decoded): DestinationJournalChangeEntry<Value> => ({
          descriptorId,
          kind: "change",
          sequence: decoded.sequence,
          value: decoded.value,
        })
      )
    );

  return {
    decode,
    id: descriptorId,
    is,
    schema,
  };
};

export const DestinationChangeDescriptor = {
  make,
} as const;

const record = <
  Value extends TrackingRecordValue,
  Encoded extends TrackingRecordValue,
>(
  input: TrackingRecordContractInput<Value, Encoded>
): TrackingRecordContract<Value, Encoded> => ({
  fingerprint: makeTrackingRecordContractFingerprint(input.schema),
  id: TrackingRecordContractId.make(input.id),
  schema: input.schema,
});

export const TrackingRecordContract = {
  make: record,
} as const;
