import { Schema } from "effect";
import { MigrationDefinitionId, MigrationRunId } from "./ids.ts";

export const MigrationDefinitionLock = Schema.Struct({
  definitionId: MigrationDefinitionId,
  expiresAt: Schema.Date,
  ownerRunId: MigrationRunId,
  token: Schema.String,
});
export type MigrationDefinitionLock = typeof MigrationDefinitionLock.Type;
