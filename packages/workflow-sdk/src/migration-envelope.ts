import type {
  MigrationRollbackExecutionEnvelopeType,
  MigrationRunExecutionEnvelopeType,
} from "migrate-sdk/core";

type WithRequiredLocks<Envelope extends { readonly locks?: unknown }> = Omit<
  Envelope,
  "locks"
> & {
  readonly locks: NonNullable<Envelope["locks"]>;
};

export type WorkflowSdkMigrationRunEnvelope =
  WithRequiredLocks<MigrationRunExecutionEnvelopeType>;

export type WorkflowSdkMigrationRollbackEnvelope =
  WithRequiredLocks<MigrationRollbackExecutionEnvelopeType>;

export type WorkflowSdkMigrationExecutionEnvelope =
  | WorkflowSdkMigrationRunEnvelope
  | WorkflowSdkMigrationRollbackEnvelope;
