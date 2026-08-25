import { Effect, Schema } from "effect";
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
  MigrationTuiTarget,
} from "../runtime.ts";

class MigrationServerBackendError extends Schema.TaggedError<MigrationServerBackendError>()(
  "MigrationServerBackendError",
  {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
  }
) {}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const fromPromise = <Value>(
  evaluate: (signal: AbortSignal) => Promise<Value>
): Effect.Effect<Value, MigrationServerBackendError> =>
  Effect.tryPromise({
    catch: (cause) =>
      new MigrationServerBackendError({
        cause,
        message: errorMessage(cause),
      }),
    try: evaluate,
  });

const dashboard = (
  runtime: ConfiguredMigrationHost,
  snapshot: Awaited<ReturnType<ConfiguredMigrationHost["refresh"]>>
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
  breakLock: (lock) => fromPromise(() => runtime.breakLock(lock)),
  cancelActiveExecution: fromPromise(runtime.cancelActiveExecution),
  executeOperation: (operation, observer) =>
    fromPromise(() => runtime.execute(operation, observer)),
  getActiveRuns: fromPromise(runtime.listActiveRuns),
  getDashboard: fromPromise(runtime.refresh).pipe(
    Effect.map((snapshot) => dashboard(runtime, snapshot))
  ),
  getMessages: (target) =>
    fromPromise(() => runtime.listMessages(target as MigrationTuiTarget)),
  getSourceIdentityHistory: (definitionId) =>
    fromPromise(() => runtime.listSourceIdentityHistory(definitionId)),
  normalizeSourceIdentity: (definitionId, sourceIdentity) =>
    fromPromise(() =>
      runtime.normalizeSourceIdentity(definitionId, sourceIdentity)
    ),
  observeRun: (runId, observer) =>
    fromPromise((signal) => runtime.observeRun(runId, { ...observer, signal })),
  prepareOperation: (input) =>
    fromPromise(() =>
      runtime.prepare(
        input.target as MigrationTuiTarget,
        input.action,
        runtimePrepareOptions(input.options)
      )
    ).pipe(
      Effect.map((executable) => ({
        executable,
        operation: projectOperation(executable),
      }))
    ),
  scanSource: ({ concurrency, target }) =>
    fromPromise(() =>
      runtime.scanSource(
        target as MigrationTuiTarget,
        concurrency === undefined ? {} : { concurrency }
      )
    ).pipe(Effect.map((snapshot) => dashboard(runtime, snapshot))),
});
