import { Effect } from "effect";
import type {
  MigrateDashboard,
  MigrateExecutionOptions,
  MigrateOperationRequest,
  MigratePreparedOperation,
} from "migrate-sdk/protocol";
import type { MigrateServerBackend } from "migrate-sdk/server";
import type {
  ConfiguredMigrationHost,
  MigrationTuiExecutablePreparedOperation,
  MigrationTuiPrepareOptions,
  MigrationTuiSnapshot,
  MigrationTuiTarget,
} from "../runtime.ts";

const dashboard = (
  runtime: ConfiguredMigrationHost,
  snapshot: MigrationTuiSnapshot
): MigrateDashboard => ({
  activeRuns: snapshot.activeRuns,
  groups: runtime.groups,
  rows: snapshot.rows,
  scannedSource: snapshot.scannedSource,
});

const projectExecution = (
  execution: MigrationTuiExecutablePreparedOperation["plan"]["execution"]
): MigrateExecutionOptions | undefined => {
  if (execution === undefined) {
    return;
  }

  return {
    ...(execution.process === undefined
      ? {}
      : {
          process:
            execution.process.concurrency === undefined
              ? {}
              : { concurrency: execution.process.concurrency },
        }),
    ...(execution.rollback === undefined
      ? {}
      : {
          rollback:
            execution.rollback.concurrency === undefined
              ? {}
              : { concurrency: execution.rollback.concurrency },
        }),
  };
};

const projectOperation = (
  operation: MigrationTuiExecutablePreparedOperation
): Omit<MigratePreparedOperation, "fingerprint"> => ({
  action: operation.action,
  dependencyChecks: operation.dependencyChecks,
  observationDefinitionId: operation.observationDefinitionId,
  plan: {
    ...(projectExecution(operation.plan.execution) === undefined
      ? {}
      : { execution: projectExecution(operation.plan.execution) }),
    executionDefinitionIds: operation.plan.executionDefinitionIds,
    ...(operation.plan.force === undefined
      ? {}
      : { force: operation.plan.force }),
    requestedDefinitionIds: operation.plan.requestedDefinitionIds,
    withDependencies: operation.plan.withDependencies,
  },
  planRows: operation.planRows,
  ...(!("sourceIdentities" in operation) ||
  operation.sourceIdentities === undefined
    ? {}
    : { sourceIdentities: operation.sourceIdentities }),
  target: operation.target,
});

const runtimePrepareOptions = (
  options: MigrateOperationRequest["options"]
): MigrationTuiPrepareOptions => ({
  ...(options.execution === undefined
    ? {}
    : {
        execution: {
          ...(options.execution.process === undefined
            ? {}
            : {
                process:
                  options.execution.process.concurrency === undefined
                    ? {}
                    : {
                        concurrency: options.execution.process.concurrency,
                      },
              }),
          ...(options.execution.rollback === undefined
            ? {}
            : {
                rollback:
                  options.execution.rollback.concurrency === undefined
                    ? {}
                    : {
                        concurrency: options.execution.rollback.concurrency,
                      },
              }),
        },
      }),
  ...(options.force === undefined ? {} : { force: options.force }),
  ...(options.sourceIdentities === undefined
    ? {}
    : { sourceIdentities: options.sourceIdentities }),
  ...(options.withDependencies === undefined
    ? {}
    : { withDependencies: options.withDependencies }),
});

export const makeConfiguredMigrationServerBackend = (
  runtime: ConfiguredMigrationHost
): MigrateServerBackend<MigrationTuiExecutablePreparedOperation> => ({
  breakLock: runtime.breakLock,
  executeOperation: (operation, observer) =>
    runtime.startExecution(operation, observer),
  getActiveRuns: runtime.listActiveRuns,
  getDashboard: runtime.refresh.pipe(
    Effect.map((snapshot) => dashboard(runtime, snapshot))
  ),
  getMessages: (target) => runtime.listMessages(target as MigrationTuiTarget),
  getSourceIdentityHistory: runtime.listSourceIdentityHistory,
  normalizeSourceIdentity: (definitionId, sourceIdentity) =>
    runtime.normalizeSourceIdentity(definitionId, sourceIdentity),
  observeRun: (runId, observer) => runtime.observeRun(runId, observer),
  prepareOperation: (input) =>
    runtime
      .prepare(
        input.target as MigrationTuiTarget,
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
      .scanSource(
        target as MigrationTuiTarget,
        concurrency === undefined ? {} : { concurrency }
      )
      .pipe(Effect.map((snapshot) => dashboard(runtime, snapshot))),
});
