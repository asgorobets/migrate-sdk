import { Effect, Schema } from "effect";
import { MigrationDefinition, Tracking } from "migrate-sdk";
import { FileMigrationStore } from "migrate-sdk/stores/file";
import { deleteAuthor, writeAuthor } from "./destination.ts";
import { authorSource } from "./source.ts";

const authorTracking = Tracking.record({
  id: "author-file@v1",
  schema: Schema.Struct({ path: Schema.NonEmptyString }),
});

const store = FileMigrationStore.layer({
  directory: "./.migrate",
});

export const authors = MigrationDefinition.make({
  id: "authors",
  source: authorSource,
  store,
  tracking: authorTracking,
  process: (sourceItem) =>
    Effect.gen(function* () {
      const row = sourceItem.item;
      const path = yield* writeAuthor({
        id: row.id,
        name: `${row.firstName} ${row.lastName}`,
      });
      yield* Tracking.setRecord({ path });
    }),
  rollback: (state) => {
    const path = state.trackingRecord?.path;
    return path === undefined ? Effect.void : deleteAuthor(path);
  },
});
