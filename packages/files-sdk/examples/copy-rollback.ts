import { FilesSDKDestination } from "@migrate-sdk/files-sdk/destination";
import { Effect } from "effect";
import { DestinationError, type MigrationItemState } from "migrate-sdk";

const destination = FilesSDKDestination.make({ storageId: "destination" });

/** Delete copied files only while their journaled ETags still match. */
export const copyRollback = Effect.fn("files-copy.rollback")(function* (
  state: MigrationItemState
) {
  for (const entry of state.journal?.process.entries ?? []) {
    if (destination.changes.copied.is(entry)) {
      const { value: change } = yield* destination.changes.copied.decode(entry);
      if (change.etag === undefined) {
        return yield* new DestinationError({
          message: "Copy has no recorded ETag; reconcile before rollback",
        });
      }
      yield* destination.delete({
        key: change.key,
        policy: { kind: "exact", etag: change.etag },
      });
    }
  }
});
