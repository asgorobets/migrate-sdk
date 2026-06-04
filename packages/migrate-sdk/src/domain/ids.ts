import { Schema } from "effect";

export const MigrationDefinitionId = Schema.NonEmptyString.pipe(
  Schema.brand("MigrationDefinitionId")
);
export type MigrationDefinitionId = typeof MigrationDefinitionId.Type;
export type MigrationDefinitionIdInput = string | MigrationDefinitionId;

export const MigrationRunId = Schema.String.pipe(
  Schema.brand("MigrationRunId")
);
export type MigrationRunId = typeof MigrationRunId.Type;
export type MigrationRunIdInput = string | MigrationRunId;

export const SourceIdentity = Schema.NonEmptyString.pipe(
  Schema.brand("SourceIdentity")
);
export type SourceIdentity = typeof SourceIdentity.Type;
export type SourceIdentityInput = string | SourceIdentity;

export const SourceVersion = Schema.String.pipe(Schema.brand("SourceVersion"));
export type SourceVersion = typeof SourceVersion.Type;
export type SourceVersionInput = string | SourceVersion;

export const EncodedSourceCursor = Schema.String.pipe(
  Schema.brand("EncodedSourceCursor")
);
export type EncodedSourceCursor = typeof EncodedSourceCursor.Type;
export type EncodedSourceCursorInput = string | EncodedSourceCursor;

export const DestinationIdentity = Schema.String.pipe(
  Schema.brand("DestinationIdentity")
);
export type DestinationIdentity = typeof DestinationIdentity.Type;
export type DestinationIdentityInput = string | DestinationIdentity;

export const DestinationVersion = Schema.String.pipe(
  Schema.brand("DestinationVersion")
);
export type DestinationVersion = typeof DestinationVersion.Type;
export type DestinationVersionInput = string | DestinationVersion;

export const toMigrationDefinitionId = (
  value: MigrationDefinitionIdInput
): MigrationDefinitionId => MigrationDefinitionId.make(value);

export const toMigrationRunId = (value: MigrationRunIdInput): MigrationRunId =>
  MigrationRunId.make(value);

export const toSourceIdentity = (value: SourceIdentityInput): SourceIdentity =>
  SourceIdentity.make(value);

export const toSourceVersion = (value: SourceVersionInput): SourceVersion =>
  SourceVersion.make(value);

export const toEncodedSourceCursor = (
  value: EncodedSourceCursorInput
): EncodedSourceCursor => EncodedSourceCursor.make(value);

export const toDestinationIdentity = (
  value: DestinationIdentityInput
): DestinationIdentity => DestinationIdentity.make(value);

export const toDestinationVersion = (
  value: DestinationVersionInput
): DestinationVersion => DestinationVersion.make(value);
