// Effect FileSystem only exposes an array-returning directory read.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { opendir } from "node:fs/promises";
import { Effect, Layer, Stream } from "effect";
import { MigrationStoreError } from "../../domain/errors.ts";
import { FileMigrationStoreDirectoryEntries } from "./file-migration-store-directory-entries.ts";

const storeError = (message: string, cause?: unknown): MigrationStoreError =>
  new MigrationStoreError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const hasErrorCode = (cause: unknown, code: string): boolean =>
  cause instanceof Error && "code" in cause && cause.code === code;

const streamDirectoryEntries = (
  directory: string
): Stream.Stream<string, MigrationStoreError> =>
  Stream.unwrap(
    Effect.tryPromise({
      try: () => opendir(directory),
      catch: (cause) =>
        hasErrorCode(cause, "ENOENT")
          ? null
          : storeError(`Unable to read directory ${directory}`, cause),
    }).pipe(
      Effect.catchIf(
        (cause) => cause === null,
        () => Effect.succeed(null)
      ),
      Effect.map((directoryHandle) =>
        directoryHandle === null
          ? Stream.empty
          : Stream.fromAsyncIterable(directoryHandle, (cause) =>
              storeError(`Unable to read directory ${directory}`, cause)
            ).pipe(Stream.map((entry) => entry.name))
      )
    )
  );

export const nodeFileMigrationStoreDirectoryEntriesLayer = Layer.succeed(
  FileMigrationStoreDirectoryEntries,
  FileMigrationStoreDirectoryEntries.of({ stream: streamDirectoryEntries })
);
