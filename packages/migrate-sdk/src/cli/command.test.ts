import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Fiber, Layer, Queue, Runtime } from "effect";
import { toMigrationDefinitionId, toMigrationRunId } from "../domain/ids.ts";
import type {
  MigrationRunHandle,
  MigrationRunHandleState,
  MigrationRunTerminalResult,
} from "../domain/run.ts";
import { failCancelledCliMessage, waitForRun } from "./command.ts";
import {
  type ActiveMigrationCliInterrupts,
  isMigrationCliInterruptScopeActive,
} from "./interrupts.ts";
import {
  MigrationCliRuntime,
  type MigrationCliRuntimeShape,
} from "./runtime.ts";

const runId = toMigrationRunId("run-cli-cancellation");
const definitionId = toMigrationDefinitionId("articles");
const startedAt = new Date("2026-08-09T12:00:00.000Z");

const runState = (
  status: MigrationRunHandleState["status"]
): MigrationRunHandleState => ({
  ...(["cancelled", "failed", "start-failed", "succeeded"].includes(status)
    ? { finishedAt: new Date("2026-08-09T12:00:01.000Z") }
    : {}),
  definitionIds: [definitionId],
  runId,
  startedAt,
  status,
});

const interruptRuntime = (
  interrupts: ActiveMigrationCliInterrupts
): MigrationCliRuntimeShape => ({
  cwd: "/tmp",
  interrupts: {
    withInterrupts: (use) => use(interrupts),
  },
});

describe("waitForRun", () => {
  it.effect("captures SIGINT only while an attached run is waiting", () => {
    const listenersBeforeRuntime = process.listenerCount("SIGINT");

    return Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* MigrationCliRuntime;
        const interrupts = runtime.interrupts;

        if (interrupts === undefined) {
          return yield* Effect.die("Expected live interrupt scope");
        }

        const listenersWhileWaiting = yield* interrupts.withInterrupts(() =>
          Effect.sync(() => {
            expect(isMigrationCliInterruptScopeActive()).toBe(true);
            return process.listenerCount("SIGINT");
          })
        );

        expect(listenersWhileWaiting).toBe(listenersBeforeRuntime + 1);
        expect(isMigrationCliInterruptScopeActive()).toBe(false);
        expect(process.listenerCount("SIGINT")).toBe(listenersBeforeRuntime);
      }).pipe(
        Effect.provide(
          MigrationCliRuntime.live.pipe(Layer.provide(nodeServicesLayer))
        )
      )
    );
  });

  it.effect("reports cooperative cancellation with exit code 130", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(failCancelledCliMessage("Run cancelled"));

      if (exit._tag !== "Failure") {
        return yield* Effect.die("Expected cancellation failure");
      }

      expect(Runtime.getErrorExitCode(Cause.squash(exit.cause))).toBe(130);
    })
  );

  it.effect("turns the first interrupt into a cooperative cancellation", () =>
    Effect.gen(function* () {
      const interrupt = yield* Deferred.make<void>();
      const cancelCalled = yield* Deferred.make<void>();
      const terminal =
        yield* Deferred.make<MigrationRunTerminalResult<never>>();
      const handle: MigrationRunHandle<never> = {
        cancel: Deferred.succeed(cancelCalled, undefined).pipe(
          Effect.as(runState("cancelling"))
        ),
        get: Effect.succeed(runState("running")),
        runId,
        wait: Deferred.await(terminal),
      };
      const fiber = yield* waitForRun(
        handle,
        interruptRuntime({
          confirmUnsafeExit: Effect.succeed(false),
          forceExit: Effect.never,
          wait: Deferred.await(interrupt),
        }),
        "migration"
      ).pipe(Effect.forkChild);

      yield* Deferred.succeed(interrupt, undefined);
      yield* Deferred.await(cancelCalled);

      expect(fiber.pollUnsafe()).toBeUndefined();

      const cancelled = runState("cancelled") as MigrationRunHandleState & {
        readonly finishedAt: Date;
        readonly status: "cancelled";
      };
      yield* Deferred.succeed(terminal, {
        kind: "cancelled",
        state: cancelled,
      });

      expect(yield* Fiber.join(fiber)).toEqual({
        kind: "cancelled",
        state: cancelled,
      });
    })
  );

  it.effect("requires explicit confirmation before an unsafe exit", () =>
    Effect.gen(function* () {
      const interrupts = yield* Queue.unbounded<void>();
      const confirmationRequests = yield* Queue.unbounded<void>();
      const confirmationResponses = yield* Queue.unbounded<boolean>();
      const cancelCalled = yield* Deferred.make<void>();
      const forceExitCalled = yield* Deferred.make<void>();
      const handle: MigrationRunHandle<never> = {
        cancel: Deferred.succeed(cancelCalled, undefined).pipe(
          Effect.as(runState("cancelling"))
        ),
        get: Effect.succeed(runState("running")),
        runId,
        wait: Effect.never,
      };
      const forceExit = Deferred.succeed(forceExitCalled, undefined).pipe(
        Effect.andThen(Effect.die("forced exit"))
      );
      const fiber = yield* waitForRun(
        handle,
        interruptRuntime({
          confirmUnsafeExit: Queue.offer(confirmationRequests, undefined).pipe(
            Effect.andThen(Queue.take(confirmationResponses))
          ),
          forceExit,
          wait: Queue.take(interrupts),
        }),
        "migration"
      ).pipe(Effect.exit, Effect.forkChild);

      yield* Queue.offer(interrupts, undefined);
      yield* Deferred.await(cancelCalled);
      yield* Queue.offer(interrupts, undefined);
      yield* Queue.take(confirmationRequests);

      expect(yield* Deferred.isDone(forceExitCalled)).toBe(false);

      yield* Queue.offer(confirmationResponses, true);
      yield* Deferred.await(forceExitCalled);

      const exit = yield* Fiber.join(fiber);
      expect(exit._tag).toBe("Failure");
    })
  );

  it.effect("continues draining when unsafe exit is declined", () =>
    Effect.gen(function* () {
      const interrupts = yield* Queue.unbounded<void>();
      const confirmationRequests = yield* Queue.unbounded<void>();
      const confirmationResponses = yield* Queue.unbounded<boolean>();
      const terminal =
        yield* Deferred.make<MigrationRunTerminalResult<never>>();
      const forceExitCalled = yield* Deferred.make<void>();
      const handle: MigrationRunHandle<never> = {
        cancel: Effect.succeed(runState("cancelling")),
        get: Effect.succeed(runState("running")),
        runId,
        wait: Deferred.await(terminal),
      };
      const fiber = yield* waitForRun(
        handle,
        interruptRuntime({
          confirmUnsafeExit: Queue.offer(confirmationRequests, undefined).pipe(
            Effect.andThen(Queue.take(confirmationResponses))
          ),
          forceExit: Deferred.succeed(forceExitCalled, undefined).pipe(
            Effect.andThen(Effect.die("forced exit"))
          ),
          wait: Queue.take(interrupts),
        }),
        "migration"
      ).pipe(Effect.forkChild);

      yield* Queue.offer(interrupts, undefined);
      yield* Queue.offer(interrupts, undefined);
      yield* Queue.take(confirmationRequests);
      yield* Queue.offer(confirmationResponses, false);

      expect(yield* Deferred.isDone(forceExitCalled)).toBe(false);

      const cancelled = runState("cancelled") as MigrationRunHandleState & {
        readonly finishedAt: Date;
        readonly status: "cancelled";
      };
      yield* Deferred.succeed(terminal, {
        kind: "cancelled",
        state: cancelled,
      });

      expect(yield* Fiber.join(fiber)).toEqual({
        kind: "cancelled",
        state: cancelled,
      });
      expect(yield* Deferred.isDone(forceExitCalled)).toBe(false);
    })
  );
});
