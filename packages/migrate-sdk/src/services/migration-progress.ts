import { Effect, Layer, Option } from "effect";
import { Service } from "effect/Context";
import type { MigrationProgressEvent } from "../domain/progress.ts";

export interface MigrationProgressService {
  readonly countSourceItemTotals?: boolean;
  readonly emit: (
    event: MigrationProgressEvent
  ) => Effect.Effect<void, never, never>;
}

const noop: MigrationProgressService = {
  emit: () => Effect.void,
};

export class MigrationProgress extends Service<
  MigrationProgress,
  MigrationProgressService
>()("@migrate-sdk/MigrationProgress") {
  static readonly noopLayer = Layer.succeed(MigrationProgress, noop);

  static readonly shouldCountSourceItemTotals = Effect.serviceOption(
    MigrationProgress
  ).pipe(
    Effect.map(
      Option.match({
        onNone: () => false,
        onSome: (progress) => progress.countSourceItemTotals === true,
      })
    )
  );

  static readonly emit = (event: MigrationProgressEvent) =>
    Effect.serviceOption(MigrationProgress).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (progress) => progress.emit(event),
        })
      )
    );
}
