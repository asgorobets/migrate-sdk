import { Effect } from "effect";
import type { MigrationStoreError } from "../domain/errors.ts";
import {
  type MigrationMessage,
  migrationMessagesFromItemState,
} from "../domain/message.ts";
import type { AnyMigrationDefinition } from "../domain/run.ts";
import { MigrationStore } from "../services/migration-store.ts";

export interface GetMigrationMessagesInput {
  readonly definitions: readonly AnyMigrationDefinition[];
}

const getDefinitionMessages = Effect.fn("getDefinitionMessages")(function* (
  definition: AnyMigrationDefinition
) {
  const store = yield* MigrationStore;
  const states = yield* store.listItemStates(definition.id);

  return states.flatMap(migrationMessagesFromItemState);
});

export const getMigrationMessages = Effect.fn("getMigrationMessages")(
  function* (
    input: GetMigrationMessagesInput
  ): Effect.fn.Return<readonly MigrationMessage[], MigrationStoreError> {
    const messagesByDefinition = yield* Effect.forEach(
      input.definitions,
      (definition) =>
        getDefinitionMessages(definition).pipe(
          Effect.provide(definition.store)
        ),
      { concurrency: 1 }
    );

    return messagesByDefinition
      .flat()
      .sort(
        (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime()
      );
  }
);
