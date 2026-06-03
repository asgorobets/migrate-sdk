import type { MigrationDefinitionId, MigrationRunId } from "./ids.ts";

export interface MigrationDefinitionLock {
  readonly definitionId: MigrationDefinitionId;
  readonly ownerRunId: MigrationRunId;
  readonly token: string;
  readonly expiresAt: Date;
}

