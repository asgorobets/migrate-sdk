import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Queue,
  Redacted,
  Stdio,
  Stream,
} from "effect";
import { pretty as prettyCause } from "effect/Cause";
import { isFailure, isSuccess } from "effect/Exit";
import { TestClock, TestConsole } from "effect/testing";
import { CliOutput, Command } from "effect/unstable/cli";
import type { MigrateServerConnectionInput } from "../client/node/index.ts";
import {
  toEncodedSourceIdentity,
  toMigrationDefinitionGroupId,
  toMigrationDefinitionId,
  toMigrationDefinitionLockToken,
  toMigrationRunId,
} from "../domain/ids.ts";
import {
  MigrationDefinitionRegistryUnknownDefinitionError,
  MigrationDefinitionRegistryUnknownGroupError,
} from "../domain/registry.ts";
import type {
  MigrateActiveRun,
  MigrateDashboardRow,
  MigrateObservationEvent,
  MigrateOperationRequest,
  MigratePreparedOperation,
  MigrateTerminalSummary,
} from "../protocol/index.ts";
import {
  MigrateDashboardResumeToken,
  MigratePlanFingerprint,
} from "../protocol/index.ts";
import { migrateCommand } from "./command.ts";
import type { ActiveMigrationCliInterrupts } from "./interrupts.ts";
import {
  MigrationCliConnectionError,
  MigrationCliRuntime,
  type MigrationCliRuntimeShape,
  type MigrationCliServerConnection,
} from "./runtime.ts";

const definitionId = toMigrationDefinitionId("articles");
const runId = toMigrationRunId("run-cli-observation");
const activeRun: MigrateActiveRun = {
  definitionIds: [definitionId],
  execution: { adapter: "workflow-sdk", executionId: "workflow-1" },
  observationDefinitionId: definitionId,
  runId,
  startedAt: new Date("2026-08-29T12:00:00.000Z"),
  status: "running",
  stopSupported: true,
};
const remoteDashboardRow = {
  entry: {
    dependencies: { optional: [], required: [] },
    hasRollback: true,
    id: definitionId,
  },
  status: {
    definitionId,
    discovery: "full",
    durable: { failed: 0, migrated: 3, needsUpdate: 0, skipped: 1 },
    lastRun: null,
    lock: {
      createdAt: new Date("2026-08-29T11:00:00.000Z"),
      definitionId,
      ownerRunId: runId,
      token: toMigrationDefinitionLockToken("lock-remote"),
    },
    warnings: [],
  },
} satisfies MigrateDashboardRow;

const runTerminalSummary = (
  status: "succeeded" | "failed" = "succeeded"
): Extract<MigrateTerminalSummary, { readonly kind: "run" }> => ({
  definitions: [
    {
      counts: {
        failed: status === "failed" ? 1 : 0,
        migrated: 3,
        needsUpdate: 1,
        orphaned: 2,
        rollbackFailed: 1,
        rolledBack: 1,
        skipped: 2,
        unchanged: 4,
      },
      definitionId,
      status,
    },
  ],
  finishedAt: new Date("2026-08-29T12:01:00.000Z"),
  kind: "run",
  runId,
  startedAt: new Date("2026-08-29T12:00:00.000Z"),
  status,
});

const preparedOperation = (
  request: MigrateOperationRequest
): MigratePreparedOperation => {
  let requestedDefinitionIds: "all" | readonly (typeof definitionId)[] = [
    definitionId,
  ];

  if (request.selection.kind === "all") {
    requestedDefinitionIds = "all";
  } else if (request.selection.kind === "definitions") {
    requestedDefinitionIds = request.selection.definitionIds;
  }

  return {
    action: request.action,
    dependencyChecks: [],
    fingerprint: MigratePlanFingerprint.make("sha256:cli-operation"),
    observationDefinitionId: definitionId,
    plan: {
      ...(request.options.execution === undefined
        ? {}
        : { execution: request.options.execution }),
      executionDefinitionIds: [definitionId],
      executionPolicy: [
        {
          definitionId,
          discovery: "full",
          processConcurrency:
            request.options.execution?.process?.concurrency ?? 1,
          rollbackConcurrency:
            request.options.execution?.rollback?.concurrency ?? 1,
        },
      ],
      ...(request.options.force === undefined
        ? {}
        : { force: request.options.force }),
      includedDefinitionIds: [definitionId],
      notices: [],
      requestedDefinitionIds,
      ...(request.selection.kind === "group"
        ? { requestedGroup: request.selection.groupId }
        : {}),
      ...(request.action === "rescan" ||
      request.options.rollbackOrphans === true
        ? { rescan: true }
        : {}),
      ...(request.options.rollbackOrphans === undefined
        ? {}
        : { rollbackOrphans: request.options.rollbackOrphans }),
      withDependencies: request.options.withDependencies ?? false,
    },
    planRows: [],
    request,
    selection: request.selection,
    ...(request.options.sourceIdentities === undefined
      ? {}
      : { sourceIdentities: request.options.sourceIdentities }),
  };
};

const makeConnection = (
  overrides: Partial<MigrationCliServerConnection> = {},
  onDispose: () => void = () => undefined
): MigrationCliServerConnection => ({
  breakLock: () => Effect.die("Unexpected lock break"),
  dispose: () => {
    onDispose();
    return Promise.resolve();
  },
  getActiveRuns: Effect.succeed([]),
  getDashboard: Effect.succeed({
    dashboard: {
      activeRuns: [],
      groups: [],
      rows: [],
      scannedSource: false,
    },
    resumeToken: MigrateDashboardResumeToken.make("dashboard-empty"),
  }),
  getMessages: () => Effect.succeed([]),
  observeRun: () => Stream.die("Unexpected run observation"),
  prepareOperation: () => Effect.die("Unexpected operation preparation"),
  startOperation: () => Effect.die("Unexpected operation start"),
  scanSource: () => Effect.die("Unexpected source scan"),
  stopRun: (requestedRunId) =>
    Effect.succeed({
      kind: "requested" as const,
      message: `Stopping run ${requestedRunId}`,
      runId: requestedRunId,
    }),
  ...overrides,
});

const makeServerBackedCommandConnection = (): MigrationCliServerConnection =>
  makeConnection({
    breakLock: (lock) =>
      Effect.succeed({ definitionId: lock.definitionId, kind: "cleared" }),
    getDashboard: Effect.succeed({
      dashboard: {
        activeRuns: [],
        groups: [],
        rows: [remoteDashboardRow],
        scannedSource: false,
      },
      resumeToken: MigrateDashboardResumeToken.make("dashboard-remote"),
    }),
    getMessages: () =>
      Effect.succeed([
        {
          definitionId,
          kind: "skip-reason",
          message: "Already migrated remotely",
          runId,
          severity: "info",
          sourceIdentity: toEncodedSourceIdentity("article-1"),
          updatedAt: new Date("2026-08-29T11:30:00.000Z"),
        },
      ]),
    prepareOperation: (request) =>
      Effect.succeed({
        ...preparedOperation(request),
        planRows: [remoteDashboardRow],
      }),
  });

const makeLayer = (runtime: MigrationCliRuntimeShape) =>
  Layer.mergeAll(
    CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
    Layer.succeed(MigrationCliRuntime, runtime),
    nodeServicesLayer,
    Stdio.layerTest({}),
    TestConsole.layer
  );

const runCli = (args: readonly string[], runtime: MigrationCliRuntimeShape) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      Command.runWith(migrateCommand, { version: "0.0.0" })(args)
    );

    return {
      cause: isFailure(exit) ? prettyCause(exit.cause) : "",
      exitCode: isSuccess(exit) ? 0 : 1,
      stderr: (yield* TestConsole.errorLines).map(String).join("\n"),
      stdout: (yield* TestConsole.logLines).map(String).join("\n"),
    };
  }).pipe(Effect.provide(makeLayer(runtime)));

const interruptRuntime = (
  connection: MigrationCliServerConnection,
  interrupts: ActiveMigrationCliInterrupts,
  input: Partial<MigrationCliRuntimeShape> = {}
): MigrationCliRuntimeShape => ({
  chooseRunObservationInterrupt: () => Effect.succeed("detach"),
  connectMigrateServer: () => Effect.succeed(connection),
  cwd: "/workspace",
  interrupts: { withInterrupts: (use) => use(interrupts) },
  stdoutIsTTY: true,
  ...input,
});

describe("migrate runs", () => {
  it.effect(
    "lists remote Migration Definitions through the shared connection",
    () =>
      Effect.gen(function* () {
        const result = yield* runCli(
          ["list", "--server", "https://migrate.example/api/migrate"],
          {
            connectMigrateServer: () => Effect.succeed(makeConnection()),
            cwd: "/workspace",
          }
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("Migration Definitions");
      })
  );

  it.effect(
    "routes every server-backed read and control command remotely",
    () =>
      Effect.gen(function* () {
        const runtime = {
          connectMigrateServer: () =>
            Effect.succeed(makeServerBackedCommandConnection()),
          cwd: "/workspace",
        } satisfies MigrationCliRuntimeShape;
        const server = "https://migrate.example/api/migrate";
        const graph = yield* runCli(
          ["graph", "articles", "--server", server],
          runtime
        );
        const status = yield* runCli(
          ["status", "articles", "--server", server],
          runtime
        );
        const messages = yield* runCli(
          ["messages", "articles", "--server", server],
          runtime
        );
        const unlock = yield* runCli(
          ["unlock", "articles", "--server", server],
          runtime
        );

        expect(graph.exitCode).toBe(0);
        expect(graph.stdout).toContain("Migration Dependency Graph: articles");
        expect(status.exitCode).toBe(0);
        expect(status.stdout).toContain("Migration Status");
        expect(status.stdout).toContain("articles");
        expect(status.stdout).toContain("3");
        expect(messages.exitCode).toBe(0);
        expect(messages.stdout).toContain("Already migrated remotely");
        expect(unlock.exitCode).toBe(0);
        expect(unlock.stdout).toContain("Migration Definition lock cleared");
        expect(unlock.stdout).toContain("lock-remote");
      })
  );

  it.effect("scans remote status through the Migrate Protocol", () =>
    Effect.gen(function* () {
      let scanInput:
        | Parameters<MigrationCliServerConnection["scanSource"]>[0]
        | undefined;
      const scannedRow = {
        ...remoteDashboardRow,
        status: {
          ...remoteDashboardRow.status,
          source: {
            duplicate: 0,
            invalid: 0,
            orphaned: 0,
            total: 5,
            unprocessed: 2,
          },
        },
      } satisfies MigrateDashboardRow;
      const connection = makeServerBackedCommandConnection();
      const result = yield* runCli(
        [
          "status",
          "articles",
          "--scan-source",
          "--concurrency",
          "2",
          "--server",
          "https://migrate.example/api/migrate",
        ],
        {
          connectMigrateServer: () =>
            Effect.succeed({
              ...connection,
              scanSource: (input) => {
                scanInput = input;
                return Effect.succeed({
                  activeRuns: [],
                  groups: [],
                  rows: [scannedRow],
                  scannedSource: true,
                });
              },
            }),
          cwd: "/workspace",
        }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("source inventory");
      expect(result.stdout).toContain("Unprocessed");
      expect(scanInput).toEqual({
        concurrency: 2,
        target: { definitionId, kind: "migration" },
      });
    })
  );

  it.effect("renders typed remote planning errors with their identifiers", () =>
    Effect.gen(function* () {
      const cases = [
        {
          args: ["run", "missing", "--plan"],
          error: new MigrationDefinitionRegistryUnknownDefinitionError({
            definitionId: toMigrationDefinitionId("missing"),
            message: "Migration was not found",
          }),
          expected: "Migration was not found: missing",
        },
        {
          args: ["run", "--group", "missing-group", "--plan"],
          error: new MigrationDefinitionRegistryUnknownGroupError({
            group: toMigrationDefinitionGroupId("missing-group"),
            message: "Migration group was not found",
          }),
          expected: "Migration group was not found: missing-group",
        },
      ] as const;

      for (const testCase of cases) {
        const result = yield* runCli(testCase.args, {
          connectMigrateServer: () =>
            Effect.succeed(
              makeConnection({
                prepareOperation: () => Effect.fail(testCase.error),
              })
            ),
          cwd: "/workspace",
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(testCase.expected);
      }
    })
  );

  it.effect("lists active remote runs through the shared connection", () =>
    Effect.gen(function* () {
      let connectionInput: MigrateServerConnectionInput | undefined;
      let disposed = false;
      const connection = makeConnection(
        { getActiveRuns: Effect.succeed([activeRun]) },
        () => {
          disposed = true;
        }
      );
      const result = yield* runCli(
        ["runs", "list", "--server", "https://migrate.example/api/migrate"],
        {
          connectMigrateServer: (input) => {
            connectionInput = input;
            return Effect.succeed(connection);
          },
          cwd: "/workspace",
          migrateServerToken: Redacted.make("secret"),
        }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Active Migration Runs");
      expect(result.stdout).toContain(runId);
      expect(result.stdout).toContain("workflow-sdk");
      expect(connectionInput).toEqual({
        bearerToken: "secret",
        kind: "remote",
        url: "https://migrate.example/api/migrate",
      });
      expect(disposed).toBe(true);
    })
  );

  it.effect("selects the local server generation from the build id", () =>
    Effect.gen(function* () {
      let connectionInput: MigrateServerConnectionInput | undefined;
      const result = yield* runCli(["runs", "list"], {
        connectMigrateServer: (input) => {
          connectionInput = input;
          return Effect.succeed(makeConnection());
        },
        cwd: "/workspace",
        migrateServerBuildId: "build-42",
      });

      expect(result.exitCode).toBe(0);
      expect(connectionInput).toEqual({
        buildId: "build-42",
        cwd: "/workspace",
        kind: "local",
      });
    })
  );

  it.effect("observes progress through terminal completion", () =>
    Effect.gen(function* () {
      const connection = makeConnection({
        observeRun: () =>
          Stream.fromIterable([
            {
              definitions: [
                {
                  definitionId,
                  discovery: "full" as const,
                  durable: {
                    failed: 0,
                    migrated: 3,
                    needsUpdate: 1,
                    skipped: 2,
                  },
                  lastRun: null,
                  lock: null,
                  warnings: [],
                },
              ],
              kind: "progress" as const,
            },
            {
              kind: "terminal" as const,
              message: `Run ${runId} succeeded`,
              outcome: "completed" as const,
              runId,
              summary: runTerminalSummary(),
            },
          ]),
      });
      const result = yield* runCli(["runs", "observe", runId], {
        connectMigrateServer: () => Effect.succeed(connection),
        cwd: "/workspace",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Progress");
      expect(result.stdout).toContain("articles");
      expect(result.stdout).toContain("Run Completed succeeded");
    })
  );

  it.effect(
    "renders a completed failed-item summary without failing the CLI command",
    () =>
      Effect.gen(function* () {
        const connection = makeConnection({
          observeRun: () =>
            Stream.make({
              kind: "terminal" as const,
              message: `Run ${runId} failed`,
              outcome: "completed" as const,
              runId,
              summary: runTerminalSummary("failed"),
            }),
        });
        const result = yield* runCli(["runs", "observe", runId], {
          connectMigrateServer: () => Effect.succeed(connection),
          cwd: "/workspace",
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("Run Completed failed");
        expect(result.stdout).toContain("Orphaned");
        expect(result.stdout).toContain("Rolled Back");
        expect(result.stdout).toContain("Rollback Failed");
      })
  );

  it.effect("renders rollback terminal summaries", () =>
    Effect.gen(function* () {
      const connection = makeConnection({
        observeRun: () =>
          Stream.make({
            kind: "terminal" as const,
            message: `Run ${runId} succeeded`,
            outcome: "completed" as const,
            runId,
            summary: {
              definitions: [
                {
                  counts: { failed: 0, rolledBack: 2, skipped: 1 },
                  definitionId,
                  status: "succeeded" as const,
                },
              ],
              finishedAt: new Date("2026-08-29T12:01:00.000Z"),
              kind: "rollback" as const,
              runId,
              startedAt: new Date("2026-08-29T12:00:00.000Z"),
              status: "succeeded" as const,
            },
          }),
      });
      const result = yield* runCli(["runs", "observe", runId], {
        connectMigrateServer: () => Effect.succeed(connection),
        cwd: "/workspace",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Rollback Completed succeeded");
      expect(result.stdout).toContain("Rolled Back");
    })
  );

  it.effect("prints recovery instructions when observation fails", () =>
    Effect.gen(function* () {
      const configPath =
        "/workspace/migrations $HOME/$(touch-nope)/operator's.config.ts";
      const connection = makeConnection({
        observeRun: () => Stream.fail(new Error("connection dropped")),
      });
      const result = yield* runCli(
        ["runs", "observe", runId, "--config", configPath],
        {
          connectMigrateServer: () => Effect.succeed(connection),
          cwd: "/workspace",
        }
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("connection dropped");
      expect(result.stderr).toContain(`Run id ${runId}`);
      expect(result.stderr).toContain(
        `Observe again: migrate --config '/workspace/migrations $HOME/$(touch-nope)/operator'\\''s.config.ts' runs observe '${runId}'`
      );
    })
  );

  it.effect("prints recovery instructions when the connection fails", () =>
    Effect.gen(function* () {
      const result = yield* runCli(
        [
          "runs",
          "observe",
          runId,
          "--server",
          "https://migrate.example/api/migrate",
        ],
        {
          connectMigrateServer: () =>
            Effect.fail(
              new MigrationCliConnectionError({
                cause: "Unauthorized",
                message: "Unable to connect to Migrate Server: Unauthorized",
              })
            ),
          cwd: "/workspace",
        }
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unauthorized");
      expect(result.stderr).toContain(`Run id ${runId}`);
      expect(result.stderr).toContain(
        `Observe again: migrate --server 'https://migrate.example/api/migrate' runs observe '${runId}'`
      );
    })
  );

  it.effect(
    "prints recovery instructions when observation ends without completion",
    () =>
      Effect.gen(function* () {
        const connection = makeConnection({
          observeRun: () => Stream.empty,
        });
        const result = yield* runCli(["runs", "observe", runId], {
          connectMigrateServer: () => Effect.succeed(connection),
          cwd: "/workspace",
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          "Observation ended before reaching a terminal state."
        );
        expect(result.stderr).toContain(`Run id ${runId}`);
        expect(result.stderr).toContain(
          `Observe again: migrate runs observe '${runId}'`
        );
      })
  );

  it.effect("stops a run only through the explicit stop command", () =>
    Effect.gen(function* () {
      let stoppedRunId: string | undefined;
      const connection = makeConnection({
        stopRun: (requestedRunId) => {
          stoppedRunId = requestedRunId;
          return Effect.succeed({
            kind: "requested" as const,
            message: `Stopping run ${requestedRunId}`,
            runId: requestedRunId,
          });
        },
      });
      const result = yield* runCli(["runs", "stop", runId], {
        connectMigrateServer: () => Effect.succeed(connection),
        cwd: "/workspace",
      });

      expect(result.exitCode).toBe(0);
      expect(stoppedRunId).toBe(runId);
      expect(result.stdout).toContain("Stop Requested");
      expect(result.stdout).toContain(runId);
    })
  );

  it.effect(
    "detaches non-interactively on Ctrl+C without stopping the run",
    () =>
      Effect.gen(function* () {
        const interrupts = yield* Queue.unbounded<void>();
        const observationStarted = yield* Deferred.make<void>();
        let stopCalls = 0;
        const connection = makeConnection({
          stopRun: () => {
            stopCalls += 1;
            return Effect.die("StopRun must not be called while detaching");
          },
          observeRun: () =>
            Stream.fromEffect(
              Deferred.succeed(observationStarted, undefined).pipe(
                Effect.as({
                  kind: "state" as const,
                  state: { definitionId, kind: "starting" as const },
                })
              )
            ).pipe(Stream.concat(Stream.never)),
        });
        const resultFiber = yield* runCli(
          [
            "runs",
            "observe",
            runId,
            "--server",
            "https://migrate.example/api/migrate",
          ],
          interruptRuntime(
            connection,
            {
              confirmUnsafeExit: Effect.succeed(false),
              forceExit: Effect.never,
              wait: Queue.take(interrupts),
            },
            { stdoutIsTTY: false }
          )
        ).pipe(Effect.forkChild);

        yield* Deferred.await(observationStarted);
        yield* Queue.offer(interrupts, undefined);
        const result = yield* Fiber.join(resultFiber);

        expect(result.exitCode).toBe(0);
        expect(stopCalls).toBe(0);
        expect(result.stdout).toContain("Observation detached");
        expect(result.stdout).toContain(
          `migrate --server 'https://migrate.example/api/migrate' runs observe '${runId}'`
        );
      })
  );

  it.effect("shell-quotes every argument in the observe-again command", () =>
    Effect.gen(function* () {
      const interrupts = yield* Queue.unbounded<void>();
      const observationStarted = yield* Deferred.make<void>();
      const unsafeRunId = toMigrationRunId(
        "run $HOME $(touch-nope) `id` 'one'"
      );
      const unsafeServerUrl =
        "https://migrate.example/api/$(touch-nope)/$HOME/`id`/operator's";
      const connection = makeConnection({
        observeRun: () =>
          Stream.fromEffect(
            Deferred.succeed(observationStarted, undefined).pipe(
              Effect.as({
                kind: "state" as const,
                state: { definitionId, kind: "starting" as const },
              })
            )
          ).pipe(Stream.concat(Stream.never)),
      });
      const resultFiber = yield* runCli(
        ["runs", "observe", unsafeRunId, "--server", unsafeServerUrl],
        interruptRuntime(
          connection,
          {
            confirmUnsafeExit: Effect.succeed(false),
            forceExit: Effect.never,
            wait: Queue.take(interrupts),
          },
          { stdoutIsTTY: false }
        )
      ).pipe(Effect.forkChild);

      yield* Deferred.await(observationStarted);
      yield* Queue.offer(interrupts, undefined);
      const result = yield* Fiber.join(resultFiber);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        "migrate --server 'https://migrate.example/api/$(touch-nope)/$HOME/`id`/operator'\\''s' runs observe 'run $HOME $(touch-nope) `id` '\\''one'\\'''"
      );
    })
  );

  it.effect("prints a PowerShell-safe observe-again command on Windows", () =>
    Effect.gen(function* () {
      const unsafeRunId = toMigrationRunId(
        "run $HOME $(touch-nope) `id` 'one'"
      );
      const unsafeServerUrl =
        "https://migrate.example/api/$(touch-nope)/$HOME/`id`/operator's";
      const connection = makeConnection({
        observeRun: () => Stream.fail(new Error("connection dropped")),
      });
      const result = yield* runCli(
        ["runs", "observe", unsafeRunId, "--server", unsafeServerUrl],
        {
          commandShell: "powershell",
          connectMigrateServer: () => Effect.succeed(connection),
          cwd: "C:\\workspace",
        }
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Observe again in PowerShell: migrate --server 'https://migrate.example/api/$(touch-nope)/$HOME/`id`/operator''s' runs observe 'run $HOME $(touch-nope) `id` ''one'''"
      );
    })
  );

  it.effect(
    "finishes terminal observation while the interrupt prompt is open",
    () =>
      Effect.gen(function* () {
        const interrupts = yield* Queue.unbounded<void>();
        const observationStarted = yield* Deferred.make<void>();
        const promptChoice = yield* Deferred.make<
          "continue" | "detach" | "stop"
        >();
        const terminalEvent =
          yield* Deferred.make<
            Extract<MigrateObservationEvent, { readonly kind: "terminal" }>
          >();
        let stopCalls = 0;
        const connection = makeConnection({
          observeRun: () =>
            Stream.fromEffect(
              Deferred.succeed(observationStarted, undefined).pipe(
                Effect.as({
                  kind: "state" as const,
                  state: { definitionId, kind: "starting" as const },
                })
              )
            ).pipe(
              Stream.concat(Stream.fromEffect(Deferred.await(terminalEvent)))
            ),
          stopRun: () => {
            stopCalls += 1;
            return Effect.die("StopRun must not be called after completion");
          },
        });
        let promptOpened = false;
        const resultFiber = yield* runCli(
          ["runs", "observe", runId],
          interruptRuntime(
            connection,
            {
              confirmUnsafeExit: Effect.succeed(false),
              forceExit: Effect.never,
              wait: Queue.take(interrupts),
            },
            {
              chooseRunObservationInterrupt: () => {
                promptOpened = true;
                return Deferred.await(promptChoice);
              },
            }
          )
        ).pipe(Effect.forkChild);

        yield* Deferred.await(observationStarted);
        yield* Queue.offer(interrupts, undefined);

        while (!promptOpened) {
          yield* Effect.yieldNow;
        }

        const completion: Extract<
          MigrateObservationEvent,
          { readonly kind: "terminal" }
        > = {
          kind: "terminal",
          message: `Run ${runId} succeeded while choosing`,
          outcome: "completed",
          runId,
        };
        yield* Deferred.succeed(terminalEvent, completion);
        const result = yield* Fiber.join(resultFiber);

        expect(result.exitCode).toBe(0);
        expect(stopCalls).toBe(0);
        expect(result.stdout).toContain(
          `Run ${runId} succeeded while choosing`
        );
        expect(result.stdout).not.toContain("Observation detached");
      })
  );

  it.effect(
    "pauses interactive progress while the interrupt prompt is open",
    () =>
      Effect.gen(function* () {
        const interrupts = yield* Queue.unbounded<void>();
        const observationStarted = yield* Deferred.make<void>();
        const promptOpened = yield* Deferred.make<void>();
        const promptChoice = yield* Deferred.make<
          "continue" | "detach" | "stop"
        >();
        const nextProgress = yield* Deferred.make<MigrateObservationEvent>();
        const terminalEvent =
          yield* Deferred.make<
            Extract<MigrateObservationEvent, { readonly kind: "terminal" }>
          >();
        const writes: string[] = [];
        const progressEvent = (
          migrated: number
        ): Extract<MigrateObservationEvent, { readonly kind: "progress" }> => ({
          definitions: [
            {
              definitionId,
              discovery: "full",
              durable: {
                failed: 0,
                migrated,
                needsUpdate: 0,
                skipped: 0,
              },
              lastRun: null,
              lock: null,
              warnings: [],
            },
          ],
          kind: "progress",
        });
        const connection = makeConnection({
          observeRun: () =>
            Stream.fromEffect(
              Deferred.succeed(observationStarted, undefined).pipe(
                Effect.as(progressEvent(1))
              )
            ).pipe(
              Stream.concat(Stream.fromEffect(Deferred.await(nextProgress))),
              Stream.concat(Stream.fromEffect(Deferred.await(terminalEvent)))
            ),
          prepareOperation: (request) =>
            Effect.succeed(preparedOperation(request)),
          startOperation: () =>
            Effect.succeed({ runId, status: "started" as const }),
        });
        const resultFiber = yield* runCli(
          ["run", "articles"],
          interruptRuntime(
            connection,
            {
              confirmUnsafeExit: Effect.succeed(false),
              forceExit: Effect.never,
              wait: Queue.take(interrupts),
            },
            {
              chooseRunObservationInterrupt: () =>
                Deferred.succeed(promptOpened, undefined).pipe(
                  Effect.andThen(Deferred.await(promptChoice))
                ),
              stdoutColumns: 120,
              stdoutIsTTY: true,
              writeProgress: (chunk) =>
                Effect.sync(() => {
                  writes.push(chunk);
                }),
            }
          )
        ).pipe(Effect.forkChild);

        yield* Deferred.await(observationStarted);
        yield* Queue.offer(interrupts, undefined);
        yield* Deferred.await(promptOpened);
        const writesWhilePromptOpened = writes.length;

        yield* Deferred.succeed(nextProgress, progressEvent(2));
        yield* Effect.yieldNow;
        expect(writes).toHaveLength(writesWhilePromptOpened);

        yield* Deferred.succeed(promptChoice, "continue");
        while (writes.length === writesWhilePromptOpened) {
          yield* Effect.yieldNow;
        }

        yield* Deferred.succeed(terminalEvent, {
          kind: "terminal",
          message: `Run ${runId} succeeded`,
          outcome: "completed",
          runId,
          summary: runTerminalSummary(),
        });
        const result = yield* Fiber.join(resultFiber);

        expect(result.exitCode).toBe(0);
        expect(writes.length).toBeGreaterThan(writesWhilePromptOpened);
        expect(result.stdout).toContain("Run Completed succeeded");
      })
  );

  it.effect(
    "requests safe stop and observes the run until it is cancelled",
    () =>
      Effect.gen(function* () {
        const interrupts = yield* Queue.unbounded<void>();
        const observationStarted = yield* Deferred.make<void>();
        const terminalEvent =
          yield* Deferred.make<
            Extract<MigrateObservationEvent, { readonly kind: "terminal" }>
          >();
        let stopCalls = 0;
        const connection = makeConnection({
          observeRun: () =>
            Stream.fromEffect(
              Deferred.succeed(observationStarted, undefined).pipe(
                Effect.as({
                  kind: "state" as const,
                  state: { definitionId, kind: "starting" as const },
                })
              )
            ).pipe(
              Stream.concat(Stream.fromEffect(Deferred.await(terminalEvent)))
            ),
          stopRun: (requestedRunId) => {
            stopCalls += 1;
            const completion: Extract<
              MigrateObservationEvent,
              { readonly kind: "terminal" }
            > = {
              kind: "terminal",
              message: `Run ${requestedRunId} cancelled safely`,
              outcome: "cancelled",
              runId: requestedRunId,
            };

            return Deferred.succeed(terminalEvent, completion).pipe(
              Effect.andThen(Effect.yieldNow),
              Effect.andThen(
                Effect.succeed({
                  kind: "requested" as const,
                  message: `Stopping run ${requestedRunId}`,
                  runId: requestedRunId,
                })
              )
            );
          },
        });
        const resultFiber = yield* runCli(
          ["runs", "observe", runId],
          interruptRuntime(
            connection,
            {
              confirmUnsafeExit: Effect.succeed(false),
              forceExit: Effect.never,
              wait: Queue.take(interrupts),
            },
            { chooseRunObservationInterrupt: () => Effect.succeed("stop") }
          )
        ).pipe(Effect.forkChild);

        yield* Deferred.await(observationStarted);
        yield* Queue.offer(interrupts, undefined);
        const result = yield* Fiber.join(resultFiber);

        expect(result.exitCode).toBe(1);
        expect(stopCalls).toBe(1);
        expect(result.stdout).toContain("Stop Requested");
        expect(result.stdout).toContain(`Run ${runId} cancelled safely`);
        expect(result.stdout.indexOf("Stop Requested")).toBeLessThan(
          result.stdout.indexOf(`Run ${runId} cancelled safely`)
        );
      })
  );

  it.effect("prints recovery instructions when safe stop fails", () =>
    Effect.gen(function* () {
      const interrupts = yield* Queue.unbounded<void>();
      const observationStarted = yield* Deferred.make<void>();
      const connection = makeConnection({
        observeRun: () =>
          Stream.fromEffect(
            Deferred.succeed(observationStarted, undefined).pipe(
              Effect.as({
                kind: "state" as const,
                state: { definitionId, kind: "starting" as const },
              })
            )
          ).pipe(Stream.concat(Stream.never)),
        stopRun: () =>
          Effect.fail(
            new MigrationCliConnectionError({
              cause: "stop request failed",
              message: "stop request failed",
            })
          ),
      });
      const resultFiber = yield* runCli(
        ["runs", "observe", runId],
        interruptRuntime(
          connection,
          {
            confirmUnsafeExit: Effect.succeed(false),
            forceExit: Effect.never,
            wait: Queue.take(interrupts),
          },
          { chooseRunObservationInterrupt: () => Effect.succeed("stop") }
        )
      ).pipe(Effect.forkChild);

      yield* Deferred.await(observationStarted);
      yield* Queue.offer(interrupts, undefined);
      const result = yield* Fiber.join(resultFiber);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("stop request failed");
      expect(result.stderr).toContain(`Run id ${runId}`);
      expect(result.stderr).toContain(
        `Observe again: migrate runs observe '${runId}'`
      );
    })
  );

  it.effect(
    "prepares, starts, and observes a remote run through one client",
    () =>
      Effect.gen(function* () {
        const requests: MigrateOperationRequest[] = [];
        let startedOperation:
          | Parameters<MigrationCliServerConnection["startOperation"]>[0]
          | undefined;
        const connection = makeConnection({
          observeRun: () =>
            Stream.fromIterable([
              {
                definitions: [
                  {
                    definitionId,
                    discovery: "full" as const,
                    durable: {
                      failed: 0,
                      migrated: 1,
                      needsUpdate: 0,
                      skipped: 0,
                    },
                    lastRun: null,
                    lock: null,
                    warnings: [],
                  },
                ],
                kind: "progress" as const,
              },
              {
                kind: "terminal" as const,
                message: `Run ${runId} succeeded`,
                outcome: "completed" as const,
                runId,
              },
            ]),
          prepareOperation: (request) => {
            requests.push(request);
            return Effect.succeed(preparedOperation(request));
          },
          startOperation: (operation) => {
            startedOperation = operation;
            return Effect.succeed({ runId, status: "started" as const });
          },
        });
        const result = yield* runCli(
          [
            "run",
            "articles",
            "authors",
            "--server",
            "https://migrate.example/api/migrate",
            "--concurrency",
            "3",
            "--rollback-orphans",
            "--progress",
            "log",
            "--with-dependencies",
          ],
          {
            connectMigrateServer: () => Effect.succeed(connection),
            cwd: "/workspace",
          }
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(requests).toEqual([
          {
            action: "run",
            options: {
              execution: {
                process: { concurrency: 3 },
                rollback: { concurrency: 3 },
              },
              rollbackOrphans: true,
              withDependencies: true,
            },
            selection: {
              definitionIds: [
                toMigrationDefinitionId("articles"),
                toMigrationDefinitionId("authors"),
              ],
              kind: "definitions",
            },
          },
        ]);
        expect(startedOperation).toEqual({
          acceptedFingerprint: MigratePlanFingerprint.make(
            "sha256:cli-operation"
          ),
          request: requests[0],
        });
        expect(result.stdout).toContain("Progress");
        expect(result.stdout).toContain(`Run ${runId} succeeded`);
      })
  );

  it.effect("maps run modes and selections into protocol requests", () =>
    Effect.gen(function* () {
      const requests: MigrateOperationRequest[] = [];
      const connection = makeConnection({
        prepareOperation: (request) => {
          requests.push(request);
          return Effect.succeed(preparedOperation(request));
        },
      });
      const runtime = {
        connectMigrateServer: () => Effect.succeed(connection),
        cwd: "/workspace",
      };

      for (const args of [
        ["run", "articles", "--failed", "--plan"],
        ["run", "articles", "--skipped", "--plan"],
        ["run", "--group", "content", "--rescan", "--plan"],
        ["run", "--all", "--update", "--plan"],
      ] as const) {
        const result = yield* runCli(args, runtime);
        expect(result.exitCode).toBe(0);
      }

      expect(requests).toEqual([
        {
          action: "retry-failed",
          options: { withDependencies: false },
          selection: {
            definitionIds: [definitionId],
            kind: "definitions",
          },
        },
        {
          action: "retry-skipped",
          options: { withDependencies: false },
          selection: {
            definitionIds: [definitionId],
            kind: "definitions",
          },
        },
        {
          action: "rescan",
          options: { withDependencies: false },
          selection: {
            groupId: toMigrationDefinitionGroupId("content"),
            kind: "group",
          },
        },
        {
          action: "update",
          options: { withDependencies: false },
          selection: { kind: "all" },
        },
      ]);
    })
  );

  it.effect(
    "rejects omitted and mixed operation selections before connecting",
    () =>
      Effect.gen(function* () {
        let connectionAttempts = 0;
        const runtime = {
          connectMigrateServer: () => {
            connectionAttempts += 1;
            return Effect.succeed(makeConnection());
          },
          cwd: "/workspace",
        };
        const omitted = yield* runCli(["run", "--plan"], runtime);
        const mixed = yield* runCli(
          ["rollback", "articles", "--all", "--plan"],
          runtime
        );

        expect(omitted.exitCode).toBe(1);
        expect(omitted.stderr).toContain(
          "Select migrations with definition IDs, --group, or --all"
        );
        expect(mixed.exitCode).toBe(1);
        expect(mixed.stderr).toContain(
          "Choose only one migration selection: definition IDs, --group, or --all"
        );
        expect(connectionAttempts).toBe(0);
      })
  );

  it.effect("plans an all-definition rollback without starting it", () =>
    Effect.gen(function* () {
      const requests: MigrateOperationRequest[] = [];
      let startCalls = 0;
      const connection = makeConnection({
        prepareOperation: (request) => {
          requests.push(request);
          return Effect.succeed(preparedOperation(request));
        },
        startOperation: () => {
          startCalls += 1;
          return Effect.succeed({ runId, status: "started" as const });
        },
      });
      const result = yield* runCli(["rollback", "--all", "--plan"], {
        connectMigrateServer: () => Effect.succeed(connection),
        cwd: "/workspace",
      });

      expect(result.exitCode).toBe(0);
      expect(requests).toEqual([
        {
          action: "rollback",
          options: { withDependencies: false },
          selection: { kind: "all" },
        },
      ]);
      expect(startCalls).toBe(0);
      expect(result.stdout).toContain("Rollback Plan");
      expect(result.stdout).toContain("Requested  all");
    })
  );

  it.effect("renders rollback-orphans as an effective rescan", () =>
    Effect.gen(function* () {
      const connection = makeConnection({
        prepareOperation: (request) => {
          const operation = preparedOperation(request);
          return Effect.succeed({
            ...operation,
            plan: {
              ...operation.plan,
              executionPolicy: operation.plan.executionPolicy.map((policy) => ({
                ...policy,
                discovery: "incremental" as const,
              })),
            },
          });
        },
      });
      const result = yield* runCli(
        ["run", "articles", "--rollback-orphans", "--plan"],
        {
          connectMigrateServer: () => Effect.succeed(connection),
          cwd: "/workspace",
        }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Rescan     yes");
      expect(result.stdout).toContain("starts from the beginning");
      expect(result.stdout).not.toContain("Pass --rescan");
    })
  );

  it.effect("reports dependency recovery before starting an invalid plan", () =>
    Effect.gen(function* () {
      let startCalls = 0;
      const connection = makeConnection({
        prepareOperation: (request) => {
          const operation = preparedOperation(request);
          return Effect.succeed({
            ...operation,
            dependencyChecks: [
              {
                dependencyId: toMigrationDefinitionId("authors"),
                requiredByDefinitionId: definitionId,
                satisfied: false,
              },
            ],
          });
        },
        startOperation: () => {
          startCalls += 1;
          return Effect.succeed({ runId, status: "started" as const });
        },
      });
      const result = yield* runCli(["run", "articles"], {
        connectMigrateServer: () => Effect.succeed(connection),
        cwd: "/workspace",
      });

      expect(result.exitCode).toBe(1);
      expect(startCalls).toBe(0);
      expect(result.stderr).toContain(
        "Migration Definition required dependency state is not satisfied"
      );
      expect(result.stderr).toContain("articles requires authors");
      expect(result.stderr).toContain("--with-dependencies");
      expect(result.stderr).toContain("--force");
    })
  );

  it.effect("passes rollback source identities through preparation", () =>
    Effect.gen(function* () {
      const requests: MigrateOperationRequest[] = [];
      const connection = makeConnection({
        prepareOperation: (request) => {
          requests.push(request);
          return Effect.succeed(preparedOperation(request));
        },
      });
      const result = yield* runCli(
        [
          "rollback",
          "articles",
          "--id",
          "article%3A1",
          "--id",
          "article%3A2",
          "--plan",
        ],
        {
          connectMigrateServer: () => Effect.succeed(connection),
          cwd: "/workspace",
        }
      );

      expect(result.exitCode).toBe(0);
      expect(requests).toEqual([
        {
          action: "rollback",
          options: {
            sourceIdentities: ["article%3A1", "article%3A2"],
            withDependencies: false,
          },
          selection: {
            definitionIds: [definitionId],
            kind: "definitions",
          },
        },
      ]);
    })
  );

  it.effect("suppresses only progress snapshots in none mode", () =>
    Effect.gen(function* () {
      const connection = makeConnection({
        observeRun: () =>
          Stream.fromIterable([
            { definitions: [], kind: "progress" as const },
            {
              kind: "terminal" as const,
              message: `Run ${runId} succeeded`,
              outcome: "completed" as const,
              runId,
              summary: runTerminalSummary(),
            },
          ]),
        prepareOperation: (request) =>
          Effect.succeed(preparedOperation(request)),
        startOperation: () =>
          Effect.succeed({ runId, status: "started" as const }),
      });
      const result = yield* runCli(["run", "articles", "--progress", "none"], {
        connectMigrateServer: () => Effect.succeed(connection),
        cwd: "/workspace",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("Progress");
      expect(result.stdout).toContain("Run Completed succeeded");
    })
  );

  it.effect("redraws auto progress in place on an interactive terminal", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const progressEvent: Extract<
        MigrateObservationEvent,
        { readonly kind: "progress" }
      > = {
        definitions: [
          {
            definitionId,
            discovery: "full" as const,
            durable: {
              failed: 0,
              migrated: 1,
              needsUpdate: 0,
              skipped: 0,
            },
            lastRun: null,
            lock: null,
            warnings: [],
          },
        ],
        kind: "progress" as const,
      };
      const connection = makeConnection({
        observeRun: () =>
          Stream.fromIterable([
            progressEvent,
            {
              ...progressEvent,
              definitions: [
                {
                  definitionId,
                  discovery: "full" as const,
                  durable: {
                    failed: 0,
                    migrated: 2,
                    needsUpdate: 0,
                    skipped: 0,
                  },
                  lastRun: null,
                  lock: null,
                  warnings: [],
                },
              ],
            },
            {
              kind: "terminal" as const,
              message: `Run ${runId} succeeded`,
              outcome: "completed" as const,
              runId,
              summary: runTerminalSummary(),
            },
          ]),
        prepareOperation: (request) =>
          Effect.succeed(preparedOperation(request)),
        startOperation: () =>
          Effect.succeed({ runId, status: "started" as const }),
      });
      const result = yield* runCli(["run", "articles"], {
        connectMigrateServer: () => Effect.succeed(connection),
        cwd: "/workspace",
        stdoutColumns: 120,
        stdoutIsTTY: true,
        writeProgress: (chunk) =>
          Effect.sync(() => {
            writes.push(chunk);
          }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("Progress");
      expect(result.stdout).toContain("Run Completed succeeded");
      expect(writes.join("")).toContain("Progress");
      expect(writes.join("")).toContain("\u001B[2K");
      expect(writes.join("")).toContain("Migrated");
    })
  );

  it.effect(
    "waits for a run id before applying an interrupt during start",
    () =>
      Effect.gen(function* () {
        const interrupts = yield* Queue.unbounded<void>();
        const startCalled = yield* Deferred.make<void>();
        const startResult = yield* Deferred.make<{
          readonly runId: typeof runId;
          readonly status: "started";
        }>();
        let startInterrupted = false;
        const connection = makeConnection({
          observeRun: () => Stream.never,
          prepareOperation: (request) =>
            Effect.succeed(preparedOperation(request)),
          startOperation: () =>
            Deferred.succeed(startCalled, undefined).pipe(
              Effect.andThen(Deferred.await(startResult)),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  startInterrupted = true;
                })
              )
            ),
        });
        const resultFiber = yield* runCli(
          ["run", "articles"],
          interruptRuntime(
            connection,
            {
              confirmUnsafeExit: Effect.succeed(false),
              forceExit: Effect.never,
              wait: Queue.take(interrupts),
            },
            { chooseRunObservationInterrupt: () => Effect.succeed("detach") }
          )
        ).pipe(Effect.forkChild);

        yield* Deferred.await(startCalled);
        yield* Queue.offer(interrupts, undefined);
        yield* Deferred.succeed(startResult, {
          runId,
          status: "started" as const,
        });
        const result = yield* Fiber.join(resultFiber);

        expect(startInterrupted).toBe(false);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Observation detached");
        expect(result.stdout).toContain(`Run id ${runId}`);
        expect(result.stdout).toContain(
          `Observe again: migrate runs observe '${runId}'`
        );
      })
  );

  it.effect(
    "stops waiting for an unknown start acknowledgement after the grace period",
    () =>
      Effect.gen(function* () {
        const interrupts = yield* Queue.unbounded<void>();
        const startCalled = yield* Deferred.make<void>();
        const connection = makeConnection({
          prepareOperation: (request) =>
            Effect.succeed(preparedOperation(request)),
          startOperation: () =>
            Deferred.succeed(startCalled, undefined).pipe(
              Effect.andThen(Effect.never)
            ),
        });
        const resultFiber = yield* runCli(
          ["run", "articles"],
          interruptRuntime(
            connection,
            {
              confirmUnsafeExit: Effect.succeed(false),
              forceExit: Effect.never,
              wait: Queue.take(interrupts),
            },
            { startAcknowledgementTimeoutMs: 1000 }
          )
        ).pipe(Effect.forkChild);

        yield* Deferred.await(startCalled);
        yield* Queue.offer(interrupts, undefined);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(1000);
        const result = yield* Fiber.join(resultFiber);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          "The start acknowledgement is still unknown after Ctrl+C"
        );
        expect(result.stderr).toContain("List active runs: migrate runs list");
        expect(result.stderr).not.toContain("Stopping");
      })
  );
});
