import type { FilesSDKObject } from "../object.ts";

/** Shared file discovery for the file Source and folder Document Fetcher. */
export interface FilesSDKObjectDiscoveryOptions {
  readonly filter?: {
    /** Change this id when the selection rules change. */
    readonly id: string;
    readonly test: (object: FilesSDKObject) => boolean;
  };
  readonly metadataConcurrency?: number;
  readonly pageSize?: number;
  /** Literal key prefix; folder listings follow the configured provider. */
  readonly prefix?: string;
  /** Stable identity of the configured storage. */
  readonly storageId: string;
}
