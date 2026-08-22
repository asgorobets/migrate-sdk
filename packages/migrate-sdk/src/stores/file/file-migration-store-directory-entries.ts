import { Context, type Stream } from "effect";
import type { MigrationStoreError } from "../../domain/errors.ts";

export class FileMigrationStoreDirectoryEntries extends Context.Service<
  FileMigrationStoreDirectoryEntries,
  {
    readonly stream: (
      directory: string
    ) => Stream.Stream<string, MigrationStoreError>;
  }
>()("@migrate-sdk/FileMigrationStoreDirectoryEntries") {}
