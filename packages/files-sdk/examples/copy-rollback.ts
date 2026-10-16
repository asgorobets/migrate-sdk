import { FilesSDKDestination } from "@migrate-sdk/files-sdk/destination";
import { Effect } from "effect";
import type { Files as FilesSDKClient } from "files-sdk";
import { Files } from "files-sdk/effect";
import { DestinationError, type MigrationItemState } from "migrate-sdk";

/** Delete copied files only while their journaled ETags still match. */
export function makeGuardedCopyRollback(
  client: FilesSDKClient,
  storageId: string
) {
  const destination = FilesSDKDestination.make({ storageId }).provide(
    Files.layer(client)
  );

  return Effect.fn("files-copy.rollback")(function* (
    state: MigrationItemState
  ) {
    for (const entry of state.journal?.process.entries ?? []) {
      if (destination.changes.copied.is(entry)) {
        const { value: change } =
          yield* destination.changes.copied.decode(entry);
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
}
