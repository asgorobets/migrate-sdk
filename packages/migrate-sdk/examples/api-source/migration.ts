import { Effect, Schema } from "effect";
import { defineMigration, runMigration } from "migrate-sdk";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import { JsonPlaceholderPostSourcePlugin } from "./json-placeholder-source.ts";

export const PostEntryFields = Schema.Struct({
  authorId: Schema.Number,
  body: Schema.String,
  title: Schema.String,
});

export type PostEntryFields = typeof PostEntryFields.Type;
export type ApiSourcePostSource = ReturnType<
  typeof JsonPlaceholderPostSourcePlugin.make
>;

export interface ApiSourceExampleOptions {
  readonly recordPostEntry?: (fields: PostEntryFields) => void;
  readonly source?: ApiSourcePostSource;
}

export const makeJsonPlaceholderPostsMigration = (
  options?: ApiSourceExampleOptions
) => {
  return defineMigration({
    id: "jsonplaceholder-posts",
    source: options?.source ?? JsonPlaceholderPostSourcePlugin.make(),
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
  return yield* runMigration(makeJsonPlaceholderPostsMigration(options));
});
