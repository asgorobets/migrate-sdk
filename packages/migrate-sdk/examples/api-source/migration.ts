import { Effect, Schema } from "effect";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationExecution,
} from "migrate-sdk";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import { completedInlineExecution } from "../inline-execution.ts";
import { JsonPlaceholderPostSource } from "./json-placeholder-source.ts";

export const PostEntryFields = Schema.Struct({
  authorId: Schema.Finite,
  body: Schema.String,
  title: Schema.String,
});

export type PostEntryFields = typeof PostEntryFields.Type;
export type ApiSourcePostSource = ReturnType<
  typeof JsonPlaceholderPostSource.make
>;

export interface ApiSourceExampleOptions {
  readonly recordPostEntry?: (fields: PostEntryFields) => void;
  readonly source?: ApiSourcePostSource;
}

export const makeJsonPlaceholderPostsMigration = (
  options?: ApiSourceExampleOptions
) => {
  return MigrationDefinition.make({
    id: "jsonplaceholder-posts",
    source: options?.source ?? JsonPlaceholderPostSource.make(),
    store: InMemoryMigrationStore.layer(),
    process: (source) => {
      const fields = {
        authorId: source.item.item.userId,
        body: source.item.item.body,
        title: source.item.item.title,
      };

      options?.recordPostEntry?.(fields);
    },
  });
};

export const runApiSourceExample = Effect.fn("runApiSourceExample")(function* (
  options?: ApiSourceExampleOptions
) {
  const registry = MigrationDefinitionRegistry.make({
    definitions: [makeJsonPlaceholderPostsMigration(options)] as const,
  });
  const execution = MigrationExecution.make({ registry });

  return yield* completedInlineExecution(execution.run({ all: true }));
});
