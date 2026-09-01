import { Effect } from "effect";
import type {
  MigrationExecutionOptions,
  PipelineExecutionOptions,
} from "../domain/execution.ts";
import type {
  MigrateDashboard,
  MigrateOperationRequest,
  MigratePreparedOperation,
  MigrateRegistry,
} from "../protocol/index.ts";
import type {
  ExecutableMigrationOperation,
  MigrateServerPrepareOptions,
  MigrateServerSnapshot,
  RegistryMigrateServerRuntime,
} from "./registry-runtime.ts";
import type { MigrateServerBackend } from "./service.ts";

const dashboard = (
  runtime: RegistryMigrateServerRuntime,
  snapshot: MigrateServerSnapshot
): MigrateDashboard => ({
  activeRuns: snapshot.activeRuns,
  groups: runtime.groups,
  rows: snapshot.rows,
  scannedSource: snapshot.scannedSource,
});

const projectOperation = (
  operation: ExecutableMigrationOperation
): Omit<MigratePreparedOperation, "fingerprint" | "request"> => {
  const execution = operation.plan.execution;
  const discoveryByDefinitionId = new Map(
    operation.action === "rollback"
      ? []
      : operation.plan.definitions.map((definition) => [
          definition.id,
          definition.source.discovery,
        ])
  );

  return {
    action: operation.action,
    dependencyChecks: operation.dependencyChecks,
    observationDefinitionId: operation.observationDefinitionId,
    plan: {
      ...(execution === undefined ? {} : { execution }),
      executionDefinitionIds: operation.plan.executionDefinitionIds,
      executionPolicy: operation.plan.executionPolicy.map((policy) => ({
        definitionId: policy.definitionId,
        ...(operation.action === "rollback"
          ? {}
          : { discovery: discoveryByDefinitionId.get(policy.definitionId) }),
        processConcurrency: policy.processConcurrency,
        rollbackConcurrency: policy.rollbackConcurrency,
      })),
      ...(operation.plan.force === undefined
        ? {}
        : { force: operation.plan.force }),
      includedDefinitionIds: operation.plan.includedDefinitionIds,
      notices: operation.plan.notices,
      requestedDefinitionIds: operation.plan.requestedDefinitionIds,
      ...(operation.plan.requestedGroup === undefined
        ? {}
        : { requestedGroup: operation.plan.requestedGroup }),
      ...(!("rescan" in operation.plan) || operation.plan.rescan === undefined
        ? {}
        : { rescan: operation.plan.rescan }),
      ...(!("rollbackOrphans" in operation.plan) ||
      operation.plan.rollbackOrphans === undefined
        ? {}
        : { rollbackOrphans: operation.plan.rollbackOrphans }),
      withDependencies: operation.plan.withDependencies,
    },
    planRows: operation.planRows,
    ...(!("sourceIdentities" in operation) ||
    operation.sourceIdentities === undefined
      ? {}
      : { sourceIdentities: operation.sourceIdentities }),
    selection: operation.selection,
  };
};

const runtimePrepareOptions = (
  options: MigrateOperationRequest["options"]
): MigrateServerPrepareOptions => ({
  ...(options.execution === undefined
    ? {}
    : { execution: runtimeExecutionOptions(options.execution) }),
  ...(options.force === undefined ? {} : { force: options.force }),
  ...(options.rollbackOrphans === undefined
    ? {}
    : { rollbackOrphans: options.rollbackOrphans }),
  ...(options.sourceIdentities === undefined
    ? {}
    : { sourceIdentities: options.sourceIdentities }),
  ...(options.withDependencies === undefined
    ? {}
    : { withDependencies: options.withDependencies }),
});

const runtimePipelineExecutionOptions = (options: {
  readonly concurrency?: number | "unbounded" | undefined;
}): PipelineExecutionOptions =>
  options.concurrency === undefined ? {} : { concurrency: options.concurrency };

const runtimeExecutionOptions = (
  options: NonNullable<MigrateOperationRequest["options"]["execution"]>
): MigrationExecutionOptions => ({
  ...(options.process === undefined
    ? {}
    : { process: runtimePipelineExecutionOptions(options.process) }),
  ...(options.rollback === undefined
    ? {}
    : { rollback: runtimePipelineExecutionOptions(options.rollback) }),
});

export const makeRegistryMigrateServerBackend = (
  runtime: RegistryMigrateServerRuntime
): MigrateServerBackend<ExecutableMigrationOperation> => ({
  breakLock: runtime.breakLock,
  executeOperation: (operation, observer) =>
    runtime.startExecution(operation, observer),
  getActiveRuns: runtime.listActiveRuns,
  getDashboard: runtime.refresh.pipe(
    Effect.map((snapshot) => dashboard(runtime, snapshot))
  ),
  getMessages: (target) => runtime.listMessages(target),
  getRegistry: Effect.succeed({
    entries: runtime.entries,
    groups: runtime.groups,
  } satisfies MigrateRegistry),
  getRegistryMessages: runtime.getRegistryMessages,
  getRegistryStatus: runtime.getRegistryStatus,
  getRunProgress: runtime.getRunProgress,
  getSourceIdentityHistory: runtime.listSourceIdentityHistory,
  getSourceItemTotals: runtime.getSourceItemTotals,
  normalizeSourceIdentity: (definitionId, sourceIdentity) =>
    runtime.normalizeSourceIdentity(definitionId, sourceIdentity),
  observeRun: (runId, observer, observationDefinitionId) =>
    runtime.observeRun(runId, observer, observationDefinitionId),
  watchDashboardRun: runtime.watchDashboardRun,
  prepareOperation: (input) =>
    runtime
      .prepare(
        input.selection,
        input.action,
        runtimePrepareOptions(input.options)
      )
      .pipe(
        Effect.map((executable) => ({
          executable,
          operation: projectOperation(executable),
        }))
      ),
  scanSource: ({ concurrency, target }) =>
    runtime
      .scanSource(target, concurrency === undefined ? {} : { concurrency })
      .pipe(Effect.map((snapshot) => dashboard(runtime, snapshot))),
  stopRun: runtime.stopRun,
});
