import { FilesSDKDestination } from "@migrate-sdk/files-sdk/destination";
import { FilesSDKSource } from "@migrate-sdk/files-sdk/source";
import { Effect, Schema } from "effect";
import { Files, make } from "files-sdk/effect";
import { MigrationDefinition, Tracking } from "migrate-sdk";
import { destinationClient, sourceClient, store } from "./storage.ts";

const source = FilesSDKSource.objects({
  storageId: "local-source",
  pageSize: 2,
  version: { kind: "sha256" },
}).provide(Files.layer(sourceClient));

const destination = FilesSDKDestination.make({
  storageId: "local-destination",
}).provide(Files.layer(destinationClient));

export const folderCopy = MigrationDefinition.make({
  id: "folder-copy",
  source,
  store,
  tracking: Tracking.record({
    id: "folder-copy@v1",
    schema: Schema.Struct({
      key: Schema.String,
      etag: Schema.NullOr(Schema.String),
    }),
  }),
  process: Effect.fn("folder-copy.process")(function* (sourceItem) {
    const copied = yield* destination.transferFrom({
      source: make(sourceClient),
      object: sourceItem.item,
      key: `copied/${sourceItem.item.key}`,
      write: { kind: "overwrite" },
      verify: "sha256",
    });
    yield* Tracking.setRecord({ key: copied.key, etag: copied.etag ?? null });
  }),
  rollback: Effect.fn("folder-copy.rollback")(function* (state) {
    for (const entry of state.journal?.process.entries ?? []) {
      if (destination.changes.uploaded.is(entry)) {
        const { value: change } =
          yield* destination.changes.uploaded.decode(entry);
        yield* destination.delete({
          key: change.key,
          // This example reserves copied/ exclusively for this migration.
          policy: { kind: "owned-prefix", prefix: "copied/" },
        });
      }
    }
  }),
});
