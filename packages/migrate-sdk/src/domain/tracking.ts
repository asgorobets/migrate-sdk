import { Effect, Exit, Schema } from "effect";
import type { MigrationRunId } from "./ids.ts";
import { MigrationRunId as MigrationRunIdSchema } from "./ids.ts";

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

export type DestinationJournalEntry = DestinationJournalChangeEntry;

export const DestinationJournalEntry = DestinationJournalChangeEntry;

export const DestinationJournalSegment = Schema.Struct({
  entries: Schema.Array(DestinationJournalEntry),
  runId: MigrationRunIdSchema,
});
export interface DestinationJournalSegment {
  readonly entries: readonly DestinationJournalEntry[];
  readonly runId: MigrationRunId;
}

export const DestinationJournal = Schema.Struct({
  process: DestinationJournalSegment,
  rollbackAttempts: Schema.Array(DestinationJournalSegment),
});
export interface DestinationJournal {
  readonly process: DestinationJournalSegment;
  readonly rollbackAttempts: readonly DestinationJournalSegment[];
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
