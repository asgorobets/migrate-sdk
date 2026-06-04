import { Schema } from "effect";
import { MigrationDefinitionId, MigrationRunId } from "./ids.ts";

export const MigrationDefinitionLock = Schema.Struct({
  createdAt: Schema.Date,
  definitionId: MigrationDefinitionId,
  ownerRunId: MigrationRunId,
  token: Schema.String,
});
export type MigrationDefinitionLock = typeof MigrationDefinitionLock.Type;
