import { Effect, Ref, Schema } from "effect";
import { Service } from "effect/Context";
import type { EncodedSourceIdentity, MigrationRunId } from "../domain/ids.ts";
import type {
  DestinationChangeDescriptor,
  DestinationChangeValue,
  DestinationJournal,
  DestinationJournalChangeEntry,
  DestinationJournalDiagnosticEntry,
  DestinationJournalDiagnosticInput,
  DestinationJournalEntry,
  DestinationJournalExtension,
  DestinationJournalExtensions,
  DestinationJournalExtensionValue,
  DestinationJournalSegment,
  TrackingRecordContractInput,
  TrackingRecordValue,
} from "../domain/tracking.ts";
import {
  DestinationJournalDiagnosticInput as DestinationJournalDiagnosticInputSchema,
  TrackingRecordContract,
} from "../domain/tracking.ts";

interface TrackingProcessContext {
  readonly extensions?: DestinationJournalExtensions | undefined;
  readonly runId: MigrationRunId;
  readonly sourceIdentity: EncodedSourceIdentity;
}

interface TrackingState {
  readonly entries: readonly DestinationJournalEntry[];
  readonly extensions: DestinationJournalExtensions;
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
    default: {
      const exhaustive: never = severity;
      return exhaustive;
    }
  }
};

const logDiagnosticEvent = (entry: DestinationJournalDiagnosticEntry) =>
  Effect.logWithLevel(diagnosticLogLevel(entry.severity))(
    entry.message,
    ...(entry.details === undefined ? [] : [entry.details])
  );

interface TrackingService {
  readonly logDiagnostic: (
    input: DestinationJournalDiagnosticInput
  ) => Effect.Effect<DestinationJournalDiagnosticEntry, Schema.SchemaError>;
  readonly recordChange: <
    Value extends DestinationChangeValue,
    Encoded extends Schema.Json,
  >(
    descriptor: DestinationChangeDescriptor<Value, Encoded>,
    value: Value
  ) => Effect.Effect<DestinationJournalChangeEntry<Value>, Schema.SchemaError>;
  readonly removeExtension: <
    Value extends DestinationJournalExtensionValue,
    Encoded extends Schema.Json,
  >(
    extension: DestinationJournalExtension<Value, Encoded>
  ) => Effect.Effect<void>;
  readonly setExtension: <
    Value extends DestinationJournalExtensionValue,
    Encoded extends Schema.Json,
  >(
    extension: DestinationJournalExtension<Value, Encoded>,
    value: Value
  ) => Effect.Effect<void, Schema.SchemaError>;
  readonly setRecord: <Value extends TrackingRecordValue>(
    value: Value
  ) => Effect.Effect<void>;
}

export interface TrackingProcessScope {
  readonly extensions: Effect.Effect<DestinationJournalExtensions>;
  readonly records: Effect.Effect<readonly TrackingRecordValue[]>;
  readonly service: TrackingService;
  readonly snapshot: Effect.Effect<DestinationJournalSegment | null>;
}

const scopedSourceIdentities = new WeakMap<
  TrackingService,
  EncodedSourceIdentity
>();

export class Tracking extends Service<Tracking, TrackingService>()(
  "@migrate-sdk/Tracking"
) {
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

  static readonly logDiagnostic = (input: DestinationJournalDiagnosticInput) =>
    Effect.flatMap(Tracking, (tracking) => tracking.logDiagnostic(input));

  static readonly removeExtension = <
    Value extends DestinationJournalExtensionValue,
    Encoded extends Schema.Json,
  >(
    extension: DestinationJournalExtension<Value, Encoded>
  ) =>
    Effect.flatMap(Tracking, (tracking) => tracking.removeExtension(extension));

  static readonly record = <
    Value extends TrackingRecordValue,
    Encoded extends TrackingRecordValue,
  >(
    input: TrackingRecordContractInput<Value, Encoded>
  ) => TrackingRecordContract.make(input);

  static readonly setRecord = <Value extends TrackingRecordValue>(
    value: Value
  ) => Effect.flatMap(Tracking, (tracking) => tracking.setRecord(value));

  static readonly setExtension = <
    Value extends DestinationJournalExtensionValue,
    Encoded extends Schema.Json,
  >(
    extension: DestinationJournalExtension<Value, Encoded>,
    value: Value
  ) =>
    Effect.flatMap(Tracking, (tracking) =>
      tracking.setExtension(extension, value)
    );
}

export const applyJournalExtensions = (
  journal: DestinationJournal | undefined,
  extensions: DestinationJournalExtensions,
  runId: MigrationRunId
): DestinationJournal | undefined => {
  if (journal === undefined && Object.keys(extensions).length === 0) {
    return;
  }

  const baseJournal = journal ?? {
    process: {
      entries: [],
      runId,
    },
    rollbackAttempts: [],
  };
  const journalWithoutExtensions: DestinationJournal = {
    process: baseJournal.process,
    rollbackAttempts: baseJournal.rollbackAttempts,
  };

  return Object.keys(extensions).length === 0
    ? journalWithoutExtensions
    : {
        ...journalWithoutExtensions,
        extensions,
      };
};

export const makeProcessScope = (
  context: TrackingProcessContext
): Effect.Effect<TrackingProcessScope> =>
  Effect.gen(function* () {
    const stateRef = yield* Ref.make<TrackingState>({
      entries: [],
      extensions: { ...(context.extensions ?? {}) },
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
                    extensions: state.extensions,
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
                extensions: state.extensions,
                nextSequence: state.nextSequence + 1,
                records: state.records,
              },
            ] as const;
          })
        ),
        Effect.tap(logDiagnosticEvent)
      );

    const removeExtension = <
      Value extends DestinationJournalExtensionValue,
      Encoded extends Schema.Json,
    >(
      extension: DestinationJournalExtension<Value, Encoded>
    ) =>
      Ref.update(stateRef, (state) => ({
        ...state,
        extensions: Object.fromEntries(
          Object.entries(state.extensions).filter(
            ([extensionId]) => extensionId !== extension.id
          )
        ),
      }));

    const setExtension = <
      Value extends DestinationJournalExtensionValue,
      Encoded extends Schema.Json,
    >(
      extension: DestinationJournalExtension<Value, Encoded>,
      value: Value
    ) =>
      Schema.encodeEffect(extension.schema, { errors: "all" })(value).pipe(
        Effect.flatMap((encoded) =>
          Schema.decodeUnknownEffect(Schema.Json, { errors: "all" })(encoded)
        ),
        Effect.flatMap((encodedValue) =>
          Schema.decodeUnknownEffect(extension.schema, { errors: "all" })(
            encodedValue
          ).pipe(
            Effect.flatMap(() =>
              Ref.update(stateRef, (state) => ({
                ...state,
                extensions: {
                  ...state.extensions,
                  [extension.id]: encodedValue,
                },
              }))
            )
          )
        )
      );

    const setRecord = <Value extends TrackingRecordValue>(value: Value) =>
      Ref.update(stateRef, (state) => ({
        ...state,
        records: [...state.records, value],
      }));

    const records = Ref.get(stateRef).pipe(
      Effect.map((state) => state.records)
    );

    const extensions = Ref.get(stateRef).pipe(
      Effect.map((state) => state.extensions)
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

    const service: TrackingService = {
      logDiagnostic,
      recordChange,
      removeExtension,
      setExtension,
      setRecord,
    };

    scopedSourceIdentities.set(service, context.sourceIdentity);

    return {
      extensions,
      records,
      service,
      snapshot,
    };
  });

export const scopedSourceIdentity = Effect.flatMap(Tracking, (tracking) => {
  const sourceIdentity = scopedSourceIdentities.get(tracking);

  return sourceIdentity === undefined
    ? Effect.die(
        new Error(
          "Tracking source identity is only available inside a migration pipeline"
        )
      )
    : Effect.succeed(sourceIdentity);
});
