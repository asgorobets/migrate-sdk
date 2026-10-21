import { fileURLToPath } from "node:url";
import { FilesSDKMigrationStore } from "@migrate-sdk/files-sdk/migration-store";
import { Files as FilesSDKClient } from "files-sdk";
import { fs } from "files-sdk/fs";

export const sourceClient = new FilesSDKClient({
  adapter: fs({
    root: fileURLToPath(new URL("./.data/source/", import.meta.url)),
  }),
});

export const destinationClient = new FilesSDKClient({
  adapter: fs({
    root: fileURLToPath(new URL("./.data/destination/", import.meta.url)),
  }),
});

const stateClient = new FilesSDKClient({
  adapter: fs({
    root: fileURLToPath(new URL("./.data/state/", import.meta.url)),
  }),
});

// Run one writer at a time: this store's locks are not atomic.
export const store = FilesSDKMigrationStore.layerFromClient({
  client: stateClient,
  storageId: "local-state",
  namespace: "folder-copy",
  locking: "advisory",
});
