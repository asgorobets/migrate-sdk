import { mkdir, rm, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { DestinationError } from "migrate-sdk";

export const writeAuthor = (author: { id: string; name: string }) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir("./authors", { recursive: true });
      const path = `./authors/${encodeURIComponent(author.id)}.json`;
      await writeFile(path, JSON.stringify(author, null, 2));
      return path;
    },
    catch: (cause) =>
      new DestinationError({ cause, message: "Could not write author" }),
  });

export const deleteAuthor = (path: string) =>
  Effect.tryPromise({
    try: () => rm(path, { force: true }),
    catch: (cause) =>
      new DestinationError({ cause, message: "Could not remove author" }),
  });
