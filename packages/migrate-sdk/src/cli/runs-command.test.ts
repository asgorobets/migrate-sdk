import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Queue, Stdio, Stream } from "effect";
import { pretty as prettyCause } from "effect/Cause";
import { isFailure, isSuccess } from "effect/Exit";
import { TestConsole } from "effect/testing";
import { CliOutput, Command } from "effect/unstable/cli";
import type { MigrateServerConnectionInput } from "../client/node/index.ts";
import { toMigrationDefinitionId, toMigrationRunId } from "../domain/ids.ts";
import type {
  MigrateActiveRun,
  MigrateObservationEvent,
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

const makeConnection = (
  overrides: Partial<MigrationCliServerConnection> = {},
  onDispose: () => void = () => undefined
): MigrationCliServerConnection => ({
  dispose: () => {
    onDispose();
    return Promise.resolve();
  },
  getActiveRuns: Effect.succeed([]),
  observeRun: () => Stream.die("Unexpected run observation"),
  stopRun: (requestedRunId) =>
    Effect.succeed({
      kind: "requested" as const,
      message: `Stopping run ${requestedRunId}`,
      runId: requestedRunId,
    }),
  ...overrides,
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
          migrateServerToken: "secret",
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
      expect(result.stdout).toContain(`Run ${runId} succeeded`);
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
});
