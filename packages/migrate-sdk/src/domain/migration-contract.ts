import { Schema, SchemaRepresentation } from "effect";
import {
  MigrationDefinitionId,
  SourceIdentityContractFingerprint,
} from "./ids.ts";

export const SourceVersionContractId = Schema.NonEmptyString.pipe(
  Schema.brand("SourceVersionContractId")
);
export type SourceVersionContractId = typeof SourceVersionContractId.Type;
export type SourceVersionContractIdInput = string | SourceVersionContractId;

export const SourceVersionContractFingerprint = Schema.NonEmptyString.pipe(
  Schema.brand("SourceVersionContractFingerprint")
);
export type SourceVersionContractFingerprint =
  typeof SourceVersionContractFingerprint.Type;
export type SourceVersionContractFingerprintInput =
  | string
  | SourceVersionContractFingerprint;

export const TrackingRecordContractId = Schema.NonEmptyString.pipe(
  Schema.brand("TrackingRecordContractId")
);
export type TrackingRecordContractId = typeof TrackingRecordContractId.Type;
export type TrackingRecordContractIdInput = string | TrackingRecordContractId;

export const TrackingRecordContractFingerprint = Schema.NonEmptyString.pipe(
  Schema.brand("TrackingRecordContractFingerprint")
);
export type TrackingRecordContractFingerprint =
  typeof TrackingRecordContractFingerprint.Type;
export type TrackingRecordContractFingerprintInput =
  | string
  | TrackingRecordContractFingerprint;

export const MigrationContract = Schema.Struct({
  definitionId: MigrationDefinitionId,
  sourceIdentityContractFingerprint: SourceIdentityContractFingerprint,
  sourceVersionContractFingerprint: SourceVersionContractFingerprint,
  trackingRecordContractFingerprint: Schema.optional(
    TrackingRecordContractFingerprint
  ),
  trackingRecordContractId: Schema.optional(TrackingRecordContractId),
});
export type MigrationContract = typeof MigrationContract.Type;

export const defaultSourceVersionContractFingerprint =
  SourceVersionContractFingerprint.make("source-version:custom@v1");

const stringifyContractInput = (input: unknown): string =>
  JSON.stringify(input) ?? String(input);

export const makeSourceIdentityContractFingerprint = (
  input: unknown
): SourceIdentityContractFingerprint =>
  SourceIdentityContractFingerprint.make(stringifyContractInput(input));

export const makeSourceVersionContractFingerprint = (
  input: unknown
): SourceVersionContractFingerprint =>
  SourceVersionContractFingerprint.make(stringifyContractInput(input));

export const makeTrackingRecordContractFingerprint = (
  schema: Schema.Codec<unknown, unknown, never, never>
): TrackingRecordContractFingerprint =>
  TrackingRecordContractFingerprint.make(
    stringifyContractInput(SchemaRepresentation.fromAST(schema.ast))
  );
