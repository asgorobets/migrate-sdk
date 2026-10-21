import { Effect, Option } from "effect";
import { Service } from "effect/Context";
import type { MigrationDefinitionId, MigrationRunId } from "../domain/ids.ts";
import type { MigrationItemState } from "../domain/state.ts";
import type { MigrationStore } from "./migration-store.ts";

export interface MigrationItemStateChange {
  readonly after: MigrationItemState["status"] | null;
  readonly before: MigrationItemState["status"] | null;
  readonly definitionId: MigrationDefinitionId;
  readonly runId: MigrationRunId;
}

export class MigrationItemProgress extends Service<
  MigrationItemProgress,
  {
    readonly emit: (change: MigrationItemStateChange) => Effect.Effect<void>;
  }
>()("@migrate-sdk/MigrationItemProgress") {
  static readonly emit = (change: MigrationItemStateChange) =>
    change.before === change.after
      ? Effect.void
      : Effect.serviceOption(MigrationItemProgress).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (service) => service.emit(change),
            })
          )
        );
}

/** Observe only successful writes, using the state already read by execution. */
export const persistObservedItemState = (
  store: typeof MigrationStore.Service,
  previous: MigrationItemState | null,
  next: MigrationItemState
) =>
  store.upsertItemState(next).pipe(
    Effect.tap(() =>
      MigrationItemProgress.emit({
        definitionId: next.definitionId,
        runId: next.lastRunId,
        before: previous?.status ?? null,
        after: next.status,
      })
    )
  );
