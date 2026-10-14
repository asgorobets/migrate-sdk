import { rm } from "node:fs/promises";
import { Effect, type Schema } from "effect";
import { DestinationError, type RollbackPipelineFor } from "migrate-sdk";
import { authorFileWritten, type authorTracking } from "./recovery-tracking";

type AuthorRollback = RollbackPipelineFor<
  typeof authorTracking,
  DestinationError | Schema.SchemaError
>;

export const rollbackAuthor: AuthorRollback = (state) =>
  Effect.gen(function* () {
    const paths = new Set<string>();

    if (state.trackingRecord !== undefined) {
      paths.add(state.trackingRecord.path);
    }

    // A failed item can have write evidence without a success record.
    for (const entry of state.journal?.process.entries ?? []) {
      if (authorFileWritten.is(entry)) {
        const change = yield* authorFileWritten.decode(entry);
        paths.add(change.value.path);
      }
    }

    for (const path of paths) {
      yield* Effect.tryPromise({
        // An already-removed file counts as successfully cleaned up.
        try: () => rm(path, { force: true }),
        catch: (cause) =>
          new DestinationError({ cause, message: "Could not remove author" }),
      });
    }
  });
