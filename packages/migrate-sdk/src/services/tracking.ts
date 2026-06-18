import { Effect, Layer, Ref, Schema } from "effect";
import { Service } from "effect/Context";
import type {
  EncodedSourceIdentity,
  MigrationDefinitionId,
  MigrationRunId,
  SourceVersion,
} from "../domain/ids.ts";
import type { MigrationItemState } from "../domain/state.ts";
import type {
  DestinationChangeDescriptor,
  DestinationChangeValue,
  DestinationJournalChangeEntry,
  DestinationJournalDiagnosticEntry,
  DestinationJournalDiagnosticInput,
  DestinationJournalEntry,
  DestinationJournalSegment,
  TrackingRecordContractInput,
  TrackingRecordValue,
} from "../domain/tracking.ts";
import {
  DestinationJournalDiagnosticInput as DestinationJournalDiagnosticInputSchema,
  TrackingRecordContract,
} from "../domain/tracking.ts";

export interface TrackingProcessContext {
  readonly definitionId: MigrationDefinitionId;
  readonly previousState?: MigrationItemState;
  readonly runId: MigrationRunId;
  readonly sourceIdentity: EncodedSourceIdentity;
  readonly sourceVersion?: SourceVersion;
}

interface TrackingState {
  readonly entries: readonly DestinationJournalEntry[];
  readonly nextSequence: number;
  readonly records: readonly TrackingRecordValue[];
}

const diagnosticLogLevel = (
  severity: DestinationJournalDiagnosticInput["severity"]
) => {
  switch (severity) {
    case "error":
      return "Error";
    case "warning":
      return "Warn";
    case "info":
      return "Info";
  }
};

const logDiagnosticEvent = (entry: DestinationJournalDiagnosticEntry) =>
  Effect.logWithLevel(diagnosticLogLevel(entry.severity))(
    entry.message,
    ...(entry.details === undefined ? [] : [entry.details])
  );

export interface TrackingService {
  readonly context: TrackingProcessContext;
  readonly recordChange: <
    Value extends DestinationChangeValue,
    Encoded extends Schema.Json,
  >(
    descriptor: DestinationChangeDescriptor<Value, Encoded>,
    value: Value
  ) => Effect.Effect<DestinationJournalChangeEntry<Value>, Schema.SchemaError>;
  readonly logDiagnostic: (
    input: DestinationJournalDiagnosticInput
  ) => Effect.Effect<DestinationJournalDiagnosticEntry, Schema.SchemaError>;
  readonly records: Effect.Effect<readonly TrackingRecordValue[]>;
  readonly setRecord: <Value extends TrackingRecordValue>(
    value: Value
  ) => Effect.Effect<void>;
  readonly snapshot: Effect.Effect<DestinationJournalSegment | null>;
}

export class Tracking extends Service<Tracking, TrackingService>()(
  "@migrate-sdk/Tracking"
) {
  static readonly currentContext = Effect.map(
    Tracking,
    (tracking) => tracking.context
  );

  static readonly recordChange = <
    Value extends DestinationChangeValue,
    Encoded extends Schema.Json,
  >(
    descriptor: DestinationChangeDescriptor<Value, Encoded>,
    value: Value
  ) =>
    Effect.flatMap(Tracking, (tracking) =>
      tracking.recordChange(descriptor, value)
    );

  static readonly snapshot = Effect.flatMap(
    Tracking,
    (tracking) => tracking.snapshot
  );

  static readonly logDiagnostic = (input: DestinationJournalDiagnosticInput) =>
    Effect.flatMap(Tracking, (tracking) => tracking.logDiagnostic(input));

  static readonly record = <
    Value extends TrackingRecordValue,
    Encoded extends TrackingRecordValue,
  >(
    input: TrackingRecordContractInput<Value, Encoded>
  ) => TrackingRecordContract.make(input);

  static readonly setRecord = <Value extends TrackingRecordValue>(
    value: Value
  ) => Effect.flatMap(Tracking, (tracking) => tracking.setRecord(value));

  static readonly layerProcessScope = (
    context: TrackingProcessContext
  ): Layer.Layer<Tracking> => Layer.effect(Tracking, makeProcessScope(context));
}

export const makeProcessScope = (
  context: TrackingProcessContext
): Effect.Effect<TrackingService> =>
  Effect.gen(function* () {
    const stateRef = yield* Ref.make<TrackingState>({
      entries: [],
      nextSequence: 0,
      records: [],
    });

    const recordChange = <
      Value extends DestinationChangeValue,
      Encoded extends Schema.Json,
    >(
      descriptor: DestinationChangeDescriptor<Value, Encoded>,
      value: Value
    ) =>
      Schema.encodeEffect(descriptor.schema, { errors: "all" })(value).pipe(
        Effect.flatMap((encoded) =>
          Schema.decodeUnknownEffect(Schema.Json, { errors: "all" })(encoded)
        ),
        Effect.flatMap((encodedValue) =>
          Schema.decodeUnknownEffect(descriptor.schema, { errors: "all" })(
            encodedValue
          ).pipe(
            Effect.flatMap((decodedValue) =>
              Ref.modify(stateRef, (state) => {
                const entry = {
                  descriptorId: descriptor.id,
                  kind: "change" as const,
                  sequence: state.nextSequence,
                  value: encodedValue,
                };
                const decodedEntry: DestinationJournalChangeEntry<Value> = {
                  descriptorId: descriptor.id,
                  kind: "change",
                  sequence: state.nextSequence,
                  value: decodedValue,
                };

                return [
                  decodedEntry,
                  {
                    entries: [...state.entries, entry],
                    nextSequence: state.nextSequence + 1,
                    records: state.records,
                  },
                ] as const;
              })
            )
          )
        )
      );

    const logDiagnostic = (input: DestinationJournalDiagnosticInput) =>
      Schema.decodeUnknownEffect(DestinationJournalDiagnosticInputSchema, {
        errors: "all",
      })(input).pipe(
        Effect.flatMap((diagnostic) =>
          Ref.modify(stateRef, (state) => {
            const entry: DestinationJournalDiagnosticEntry = {
              kind: "diagnostic",
              message: diagnostic.message,
              sequence: state.nextSequence,
              severity: diagnostic.severity,
              ...(diagnostic.details === undefined
                ? {}
                : { details: diagnostic.details }),
            };

            return [
              entry,
              {
                entries: [...state.entries, entry],
                nextSequence: state.nextSequence + 1,
                records: state.records,
              },
            ] as const;
          })
        ),
        Effect.tap(logDiagnosticEvent)
      );

    const setRecord = <Value extends TrackingRecordValue>(value: Value) =>
      Ref.update(stateRef, (state) => ({
        ...state,
        records: [...state.records, value],
      }));

    const records = Ref.get(stateRef).pipe(
      Effect.map((state) => state.records)
    );

    const snapshot = Ref.get(stateRef).pipe(
      Effect.map((state) =>
        state.entries.length === 0
          ? null
          : {
              entries: state.entries,
              runId: context.runId,
            }
      )
    );

    return {
      context,
      logDiagnostic,
      recordChange,
      records,
      setRecord,
      snapshot,
    };
  });
