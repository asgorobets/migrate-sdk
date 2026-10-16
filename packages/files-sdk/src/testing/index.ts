import { Files as FilesSDKClient } from "files-sdk";
import { Files, make } from "files-sdk/effect";
import { type MemoryAdapterOptions, memory } from "files-sdk/memory";

/** Create a memory client, Effect service, and layer for integration tests. */
export function makeMemoryFilesSDK(options?: MemoryAdapterOptions) {
  const adapter = memory(options);
  const client = new FilesSDKClient({ adapter });
  return { adapter, client, service: make(client), layer: Files.layer(client) };
}
