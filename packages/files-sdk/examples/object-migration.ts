import { FilesSDKDestination } from "@migrate-sdk/files-sdk/destination";
import { FilesSDKMigrationStore } from "@migrate-sdk/files-sdk/migration-store";
import { FilesSDKSource } from "@migrate-sdk/files-sdk/source";
import { Effect, type Layer, Schema } from "effect";
import type { Files as FilesSDKClient } from "files-sdk";
import { Files, make } from "files-sdk/effect";
import {
  MigrationDefinition,
  type MigrationStore,
  type MigrationStoreError,
  Tracking,
} from "migrate-sdk";

export interface ObjectMigrationClients {
  readonly destination: FilesSDKClient;
  readonly source: FilesSDKClient;
  readonly state: FilesSDKClient;
}

/** Copy input/ files to output/ with a separate client for migration state. */
export function makeObjectMigration(clients: ObjectMigrationClients) {
  const store = FilesSDKMigrationStore.layerFromClient({
    client: clients.state,
    storageId: "state",
    namespace: "object-copy",
    locking: "advisory",
  });
  return makeObjectMigrationWithStore(clients, store);
}

/** Compose file copies with a supplied Migration Store. */
export function makeObjectMigrationWithStore(
  clients: Pick<ObjectMigrationClients, "source" | "destination">,
  store: Layer.Layer<MigrationStore, MigrationStoreError>
) {
  const destination = FilesSDKDestination.make({
    storageId: "destination",
  }).provide(Files.layer(clients.destination));
  const source = FilesSDKSource.objects({
    storageId: "source",
    prefix: "input/",
    pageSize: 2,
  }).provide(Files.layer(clients.source));
  const tracking = Tracking.record({
    id: "files-copy@v1",
    schema: Schema.Struct({
      key: Schema.String,
      etag: Schema.NullOr(Schema.String),
    }),
  });
  return MigrationDefinition.make({
    id: "files-copy",
    source,
    store,
    tracking,
    process: Effect.fn("files-copy.process")(function* (sourceItem) {
      const object = yield* destination.transferFrom({
        source: make(clients.source),
        object: sourceItem.item,
        key: `output/${sourceItem.item.key.slice("input/".length)}`,
        write: { kind: "overwrite" },
        verify: "sha256",
      });
      yield* Tracking.setRecord({ key: object.key, etag: object.etag ?? null });
    }),
    rollback: Effect.fn("files-copy.rollback")(function* (state) {
      for (const entry of state.journal?.process.entries ?? []) {
        if (destination.changes.uploaded.is(entry)) {
          const change = yield* destination.changes.uploaded.decode(entry);
          yield* destination.delete({
            key: change.value.key,
            // Reserve output/ exclusively for this migration's files.
            policy: { kind: "owned-prefix", prefix: "output/" },
          });
        }
      }
    }),
  });
}
