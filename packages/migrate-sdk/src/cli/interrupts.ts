import { Effect, Queue } from "effect";

export interface ActiveMigrationCliInterrupts {
  readonly confirmUnsafeExit: Effect.Effect<boolean>;
  readonly forceExit: Effect.Effect<never>;
  readonly wait: Effect.Effect<void>;
}

export interface MigrationCliInterruptController {
  readonly withInterrupts: <A, E, R>(
    use: (interrupts: ActiveMigrationCliInterrupts) => Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
}

interface MigrationCliInterruptControllerInput {
  readonly confirmUnsafeExit: Effect.Effect<boolean>;
  readonly forceExit: Effect.Effect<never>;
}

let activeInterruptScopes = 0;

export const isMigrationCliInterruptScopeActive = (): boolean =>
  activeInterruptScopes > 0;

export const makeMigrationCliInterruptController = (
  input: MigrationCliInterruptControllerInput
): MigrationCliInterruptController => ({
  withInterrupts: (use) =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        const interrupts = yield* Queue.unbounded<void>();
        const interruptHandler = () => {
          Queue.offerUnsafe(interrupts, undefined);
        };

        yield* Effect.sync(() => {
          process.on("SIGINT", interruptHandler);
          activeInterruptScopes += 1;
        });

        return { interruptHandler, interrupts };
      }),
      ({ interrupts }) =>
        use({
          confirmUnsafeExit: input.confirmUnsafeExit,
          forceExit: input.forceExit,
          wait: Queue.take(interrupts),
        }),
      ({ interruptHandler, interrupts }) =>
        Effect.sync(() => {
          process.removeListener("SIGINT", interruptHandler);
          activeInterruptScopes -= 1;
        }).pipe(Effect.andThen(Queue.shutdown(interrupts)), Effect.asVoid)
    ),
});
