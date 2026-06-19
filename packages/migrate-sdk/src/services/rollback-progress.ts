import { Effect, Layer, Option } from "effect";
import { Service } from "effect/Context";
import type { RollbackProgressEvent } from "../domain/rollback-progress.ts";

export interface RollbackProgressService {
  readonly emit: (
    event: RollbackProgressEvent
  ) => Effect.Effect<void, never, never>;
}

const noop: RollbackProgressService = {
  emit: () => Effect.void,
};

export class RollbackProgress extends Service<
  RollbackProgress,
  RollbackProgressService
>()("@migrate-sdk/RollbackProgress") {
  static readonly noopLayer = Layer.succeed(RollbackProgress, noop);

  static readonly emit = (event: RollbackProgressEvent) =>
    Effect.serviceOption(RollbackProgress).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (progress) => progress.emit(event),
        })
      )
    );
}
