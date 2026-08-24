import { createHash, randomUUID } from "node:crypto";
import { Effect, Queue, Stream } from "effect";
import type { MigrationRunId } from "migrate-sdk";
import {
  type MigrateDashboard,
  MigrateExecutionId,
  MigrateExecutionNotFoundError,
  type MigrateExecutionOptions,
  type MigrateExecutionReference,
  type MigrateObservationEvent,
  MigrateOperationError,
  MigratePlanChangedError,
  MigratePlanFingerprint,
  type MigratePreparedOperation,
  type MigrateProtocolError,
  type MigrateServerInfo,
} from "migrate-sdk/protocol";
import type {
  MigratePrepareOperationInput,
  MigrateServerService,
} from "migrate-sdk/server";
import type {
  MigrationTuiExecutablePreparedOperation,
  MigrationTuiPrepareOptions,
  MigrationTuiServerRuntime,
  MigrationTuiTarget,
} from "../runtime.ts";

interface MigrationServerApplicationInput {
  readonly runtime: MigrationTuiServerRuntime;
  readonly serverInfo: MigrateServerInfo;
}

interface ExecutionListener {
  readonly emit: (event: MigrateObservationEvent) => void;
  readonly end: () => void;
}

interface ExecutionRecord {
  closed: boolean;
  readonly events: MigrateObservationEvent[];
  readonly listeners: Set<ExecutionListener>;
  observed: boolean;
}

const errorMessage = (cause: unknown): string => {
  if (cause instanceof Error) {
    return cause.message;
  }

  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }

  return String(cause);
};

const operationError = (
  cause: unknown,
  code: "execution-failed" | "operation-failed" = "operation-failed"
): MigrateProtocolError => {
  if (
    cause instanceof MigrateOperationError ||
    cause instanceof MigratePlanChangedError ||
    cause instanceof MigrateExecutionNotFoundError
  ) {
    return cause;
  }

  return new MigrateOperationError({ code, message: errorMessage(cause) });
};

const dashboard = (
  runtime: MigrationTuiServerRuntime,
  snapshot: Awaited<ReturnType<MigrationTuiServerRuntime["refresh"]>>
): MigrateDashboard => ({
  groups: runtime.groups,
  rows: snapshot.rows,
  scannedSource: snapshot.scannedSource,
});

const projectPlan = (
  operation: MigrationTuiExecutablePreparedOperation
): MigratePreparedOperation["plan"] => ({
  ...(projectExecution(operation.plan.execution) === undefined
    ? {}
    : { execution: projectExecution(operation.plan.execution) }),
  executionDefinitionIds: operation.plan.executionDefinitionIds,
  ...(operation.plan.force === undefined
    ? {}
    : { force: operation.plan.force }),
  requestedDefinitionIds: operation.plan.requestedDefinitionIds,
  withDependencies: operation.plan.withDependencies,
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

const fingerprintInput = (
  operation: Omit<MigratePreparedOperation, "fingerprint">
) => ({
  action: operation.action,
  dependencyChecks: operation.dependencyChecks.map((check) => ({
    dependencyId: check.dependencyId,
    requiredByDefinitionId: check.requiredByDefinitionId,
    satisfied: check.satisfied,
  })),
  plan: operation.plan,
  sourceIdentities: operation.sourceIdentities,
  target: operation.target,
});

const fingerprint = (
  operation: Omit<MigratePreparedOperation, "fingerprint">
) =>
  MigratePlanFingerprint.make(
    `sha256:${createHash("sha256")
      .update(JSON.stringify(fingerprintInput(operation)))
      .digest("hex")}`
  );

const projectOperation = (
  operation: MigrationTuiExecutablePreparedOperation
): MigratePreparedOperation => {
  const projected = {
    action: operation.action,
    dependencyChecks: operation.dependencyChecks,
    observationDefinitionId: operation.observationDefinitionId,
    plan: projectPlan(operation),
    planRows: operation.planRows,
    ...(!("sourceIdentities" in operation) ||
    operation.sourceIdentities === undefined
      ? {}
      : { sourceIdentities: operation.sourceIdentities }),
    target: operation.target,
  } satisfies Omit<MigratePreparedOperation, "fingerprint">;

  return { ...projected, fingerprint: fingerprint(projected) };
};

const runtimePrepareOptions = (
  options: MigratePrepareOperationInput["options"]
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

export const makeMigrationServerService = ({
  runtime,
  serverInfo,
}: MigrationServerApplicationInput): MigrateServerService => {
  const executions = new Map<string, ExecutionRecord>();
  let activeExecutionId: MigrateExecutionId | undefined;

  const publish = (record: ExecutionRecord, event: MigrateObservationEvent) => {
    record.events.push(event);

    for (const listener of record.listeners) {
      listener.emit(event);
    }
  };

  const close = (record: ExecutionRecord) => {
    record.closed = true;

    for (const listener of record.listeners) {
      listener.end();
    }
    record.listeners.clear();
  };

  const prepareExecutable = (
    input: MigratePrepareOperationInput
  ): Effect.Effect<
    MigrationTuiExecutablePreparedOperation,
    MigrateProtocolError
  > =>
    Effect.tryPromise({
      catch: operationError,
      try: () =>
        runtime.prepare(
          input.target as MigrationTuiTarget,
          input.action,
          runtimePrepareOptions(input.options)
        ),
    });

  const prepare = (
    input: MigratePrepareOperationInput
  ): Effect.Effect<MigratePreparedOperation, MigrateProtocolError> =>
    Effect.map(prepareExecutable(input), projectOperation);

  return {
    breakLock: ({ lock }) =>
      Effect.tryPromise({
        catch: operationError,
        try: () => runtime.breakLock(lock),
      }),
    cancelExecution: ({ executionId }) =>
      Effect.tryPromise({
        catch: operationError,
        try: () => {
          const requestedExecutionId = executionId ?? activeExecutionId;

          if (
            requestedExecutionId !== undefined &&
            !executions.has(requestedExecutionId)
          ) {
            throw new MigrateExecutionNotFoundError({
              executionId: requestedExecutionId,
              message: `Execution was not found: ${requestedExecutionId}`,
            });
          }

          if (
            requestedExecutionId !== undefined &&
            requestedExecutionId !== activeExecutionId
          ) {
            return Promise.resolve({ kind: "idle" as const });
          }

          return runtime.cancelActiveExecution();
        },
      }),
    getDashboard: Effect.tryPromise({
      catch: operationError,
      try: () =>
        runtime.refresh().then((snapshot) => dashboard(runtime, snapshot)),
    }),
    getMessages: ({ target }) =>
      Effect.tryPromise({
        catch: operationError,
        try: () => runtime.listMessages(target as MigrationTuiTarget),
      }),
    getServerInfo: Effect.succeed(serverInfo),
    getSourceIdentityHistory: ({ definitionId }) =>
      Effect.tryPromise({
        catch: operationError,
        try: () => runtime.listSourceIdentityHistory(definitionId),
      }),
    normalizeSourceIdentity: ({ definitionId, sourceIdentity }) =>
      Effect.tryPromise({
        catch: operationError,
        try: () =>
          runtime.normalizeSourceIdentity(definitionId, sourceIdentity),
      }),
    observeExecution: ({ executionId }) => {
      const record = executions.get(executionId);

      if (record === undefined) {
        return Stream.fail(
          new MigrateExecutionNotFoundError({
            executionId,
            message: `Execution was not found: ${executionId}`,
          })
        );
      }

      record.observed = true;

      return Stream.callback<MigrateObservationEvent>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            for (const event of record.events) {
              Queue.offerUnsafe(queue, event);
            }

            if (record.closed) {
              Queue.endUnsafe(queue);
              return;
            }

            const listener: ExecutionListener = {
              emit: (event) => Queue.offerUnsafe(queue, event),
              end: () => Queue.endUnsafe(queue),
            };
            record.listeners.add(listener);
            return listener;
          }),
          (listener) =>
            Effect.sync(() => {
              if (listener !== undefined) {
                record.listeners.delete(listener);
              }
              if (record.closed) {
                executions.delete(executionId);
              }
            })
        )
      );
    },
    prepareOperation: prepare,
    scanSource: ({ concurrency, target }) =>
      Effect.tryPromise({
        catch: operationError,
        try: () =>
          runtime
            .scanSource(
              target as MigrationTuiTarget,
              concurrency === undefined ? {} : { concurrency }
            )
            .then((snapshot) => dashboard(runtime, snapshot)),
      }),
    startOperation: ({ acceptedFingerprint, request }) =>
      Effect.flatMap(
        prepareExecutable(request),
        (currentExecutableOperation) => {
          const currentOperation = projectOperation(currentExecutableOperation);

          if (currentOperation.fingerprint !== acceptedFingerprint) {
            return Effect.fail(
              new MigratePlanChangedError({
                acceptedFingerprint,
                currentFingerprint: currentOperation.fingerprint,
                message:
                  "Migration state changed after confirmation; review the updated plan before running it",
              })
            );
          }

          return Effect.callback<
            MigrateExecutionReference,
            MigrateProtocolError
          >((resume) => {
            const executionId = MigrateExecutionId.make(randomUUID());
            const record: ExecutionRecord = {
              closed: false,
              events: [],
              listeners: new Set(),
              observed: false,
            };
            let reference: MigrateExecutionReference | undefined;
            let runId: MigrationRunId | undefined;
            executions.set(executionId, record);
            activeExecutionId = executionId;

            const resolveStart = (nextReference: MigrateExecutionReference) => {
              if (reference === undefined) {
                reference = nextReference;
                resume(Effect.succeed(nextReference));
              }
            };

            runtime
              .execute(currentExecutableOperation, {
                onObservationWarning: (message) =>
                  publish(record, { kind: "warning", message }),
                onProgress: ({ definitions }) =>
                  publish(record, { definitions, kind: "progress" }),
                onProgressError: (cause) =>
                  publish(record, {
                    kind: "warning",
                    message: `Unable to refresh live status: ${errorMessage(cause)}`,
                  }),
                onStateChange: (state) => {
                  publish(record, { kind: "state", state });

                  if (state.kind === "running") {
                    runId = state.runId;
                    resolveStart({
                      adapter: state.adapter,
                      executionId,
                      lifecycle: "attached",
                      runId: state.runId,
                    });
                  } else if (state.kind === "observing") {
                    runId = state.runId;
                    resolveStart({
                      adapter: state.adapter,
                      executionId,
                      lifecycle: "detached",
                      providerExecutionId: state.executionId,
                      runId: state.runId,
                    });
                  }
                },
              })
              .then((result) => {
                runId = result.runId;
                resolveStart({
                  executionId,
                  lifecycle: "completed",
                  runId: result.runId,
                });
                publish(
                  record,
                  result.outcome === "detached"
                    ? {
                        kind: "detached",
                        message: result.message,
                        runId: result.runId,
                      }
                    : {
                        kind: "terminal",
                        message: result.message,
                        outcome: result.outcome,
                        runId: result.runId,
                      }
                );
                close(record);
              })
              .catch((cause: unknown) => {
                if (reference === undefined || runId === undefined) {
                  executions.delete(executionId);
                  resume(
                    Effect.fail(operationError(cause, "execution-failed"))
                  );
                  return;
                }

                publish(record, {
                  kind: "terminal",
                  message: errorMessage(cause),
                  outcome: "failed",
                  runId,
                });
                close(record);
              })
              .finally(() => {
                if (activeExecutionId === executionId) {
                  activeExecutionId = undefined;
                }
                if (record.observed && record.listeners.size === 0) {
                  executions.delete(executionId);
                }
              });
          });
        }
      ),
  };
};
