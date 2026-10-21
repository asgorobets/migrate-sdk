import { mkdir, writeFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import {
  DestinationChangeDescriptor,
  DestinationError,
  Tracking,
} from "migrate-sdk";

export const Author = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
});

export const authorTracking = Tracking.record({
  id: "author-file@v1",
  schema: Schema.Struct({ path: Schema.NonEmptyString }),
});

export const authorFileWritten = DestinationChangeDescriptor.make(
  "author-file-written@v1",
  Schema.Struct({ path: Schema.NonEmptyString })
);

// Call this helper inside a process with tracking: authorTracking.
export const writeTrackedAuthor = Effect.fn("writeTrackedAuthor")(function* (
  author: typeof Author.Type
) {
  const path = `./authors/${encodeURIComponent(author.id)}.json`;

  yield* Effect.tryPromise({
    try: async () => {
      await mkdir("./authors", { recursive: true });
      await writeFile(path, JSON.stringify(author, null, 2));
    },
    catch: (cause) =>
      new DestinationError({ cause, message: "Could not write author" }),
  });

  // Evidence of a confirmed write, available if later work fails.
  yield* Tracking.recordChange(authorFileWritten, { path });

  // Exactly one final record for this item's successful outcome.
  const record = { path } satisfies typeof authorTracking.schema.Type;
  yield* Tracking.setRecord(record);
});
