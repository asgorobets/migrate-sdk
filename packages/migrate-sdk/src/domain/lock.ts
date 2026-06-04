import { Schema } from "effect";
import {
  MigrationDefinitionId,
  MigrationDefinitionLockToken,
  MigrationRunId,
} from "./ids.ts";

export const MigrationDefinitionLock = Schema.Struct({
  createdAt: Schema.Date,
  definitionId: MigrationDefinitionId,
  ownerRunId: MigrationRunId,
  token: MigrationDefinitionLockToken,
});
export type MigrationDefinitionLock = typeof MigrationDefinitionLock.Type;
