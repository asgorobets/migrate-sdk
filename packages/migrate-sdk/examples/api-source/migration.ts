import { Effect, Schema } from "effect";
import { defineMigration, runMigration } from "migrate-sdk";
import { InMemoryDestinationPlugin } from "migrate-sdk/destinations/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import { JsonPlaceholderPostSourcePlugin } from "./json-placeholder-source.ts";

export const PostEntryFields = Schema.Struct({
  authorId: Schema.Number,
  body: Schema.String,
  title: Schema.String,
});

export const makePostEntryDestination = () =>
  InMemoryDestinationPlugin.makeEntries({
    contentType: "post",
    commands: {
      publishEntry: true,
      upsertEntry: { fields: PostEntryFields },
    },
  });

export type ApiSourcePostDestination = ReturnType<
  typeof makePostEntryDestination
>;
export type ApiSourcePostSource = ReturnType<
  typeof JsonPlaceholderPostSourcePlugin.make
>;

export interface ApiSourceExampleOptions {
  readonly destination?: ApiSourcePostDestination;
  readonly source?: ApiSourcePostSource;
}

export const makeJsonPlaceholderPostsMigration = (
  options?: ApiSourceExampleOptions
) => {
  const destination = options?.destination ?? makePostEntryDestination();

  return defineMigration({
    id: "jsonplaceholder-posts",
    source: options?.source ?? JsonPlaceholderPostSourcePlugin.make(),
    destination,
    store: InMemoryMigrationStore.layer(),
    pipeline: (source) =>
      destination.commands.upsertEntry({
        authorId: source.item.userId,
        body: source.item.body,
        title: source.item.title,
      }),
  });
};

export const runApiSourceExample = Effect.fn("runApiSourceExample")(function* (
  options?: ApiSourceExampleOptions
) {
  return yield* runMigration(makeJsonPlaceholderPostsMigration(options));
});
