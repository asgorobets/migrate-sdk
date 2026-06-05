// biome-ignore-all lint/performance/noBarrelFile: Public subpath entrypoint intentionally re-exports the file store API.

export type {
  FileMigrationStoreOptions,
  FileMigrationStorePlatform as FileMigrationStorePlatformType,
} from "./file-migration-store.ts";
export {
  FileMigrationStore,
  FileMigrationStorePlatform,
} from "./file-migration-store.ts";
