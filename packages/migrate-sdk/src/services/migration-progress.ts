import { Effect, Layer, Option } from "effect";
import { Service } from "effect/Context";
import type { MigrationProgressEvent } from "../domain/progress.ts";

export interface MigrationProgressService {
  readonly discoverSourceItemTotals?: boolean;
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

  static readonly shouldDiscoverSourceItemTotals = Effect.serviceOption(
    MigrationProgress
  ).pipe(
    Effect.map(
      Option.match({
        onNone: () => false,
        onSome: (progress) => progress.discoverSourceItemTotals === true,
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
