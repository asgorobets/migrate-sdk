import { Effect, Schema, Stream } from "effect";
import type { DownloadedFile, FilesService } from "files-sdk/effect";
import { MigrationStoreError } from "migrate-sdk";
import { hash, safeFailure } from "../internal/files.ts";

const itemFilePattern = /^[a-f0-9]{64}\.json$/u;

export interface FilesSDKMigrationStoreOptions {
  /**
   * Explicitly acknowledges non-atomic Migration Definition Locks. Use one
   * authoritative writer per namespace, including execution and run-control
   * updates. Concurrent processes can both acquire a lock, overwrite state,
   * or delete a replacement lock. Locks do not expire; stop the original
   * worker before explicitly unlocking. Use a transactional Migration Store
   * for concurrent writers. A warning is logged when this store initializes.
   */
  readonly locking: "advisory";
  readonly maxRecordBytes?: number;
  readonly namespace: string;
  readonly pageSize?: number;
  readonly prefix?: string;
  readonly readConcurrency?: number;
  readonly storageId: string;
}

export function storeError(
  message: string,
  cause?: unknown
): MigrationStoreError {
  return new MigrationStoreError({
    message: `FilesSDKMigrationStore: ${message}`,
    ...(cause === undefined ? {} : { cause: safeFailure(cause) }),
  });
}

export interface Address {
  readonly ids: readonly string[];
  readonly key: string;
  readonly kind: string;
}

export function makePersistence(
  files: FilesService,
  options: FilesSDKMigrationStoreOptions
) {
  const root = `${options.prefix ?? "migrate-sdk"}/${options.namespace}`;
  const maxRecordBytes = options.maxRecordBytes ?? 16 * 1024 * 1024;

  function address(kind: string, ...ids: string[]): Address {
    const [definitionId, identity] = ids;
    if (kind === "manifest") {
      return { kind, ids, key: `${root}/manifest.json` };
    }
    if (kind === "run") {
      return {
        kind,
        ids,
        key: `${root}/runs/${hash(definitionId ?? "")}.json`,
      };
    }
    const directory = `${root}/definitions/${hash(definitionId ?? "")}`;
    return {
      kind,
      ids,
      key:
        kind === "item"
          ? `${directory}/items/${hash(identity ?? "")}.json`
          : `${directory}/${kind}.json`,
    };
  }

  function codec<A>(
    target: Address,
    state: Schema.Codec<A, unknown, never, never>
  ) {
    return Schema.fromJsonString(
      Schema.Struct({
        formatVersion: Schema.Literal(1),
        storageId: Schema.Literal(options.storageId),
        namespace: Schema.Literal(options.namespace),
        recordKind: Schema.Literal(target.kind),
        address: Schema.Literal(JSON.stringify(target.ids)),
        state,
      })
    );
  }

  function bodyText(file: DownloadedFile) {
    return Effect.gen(function* () {
      const chunks: Uint8Array[] = [];
      let size = 0;
      yield* file.stream.pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            size += chunk.byteLength;
            if (size > maxRecordBytes) {
              return yield* storeError("record exceeds maxRecordBytes");
            }
            chunks.push(chunk);
          })
        ),
        Effect.mapError((error) =>
          error instanceof MigrationStoreError
            ? error
            : storeError("read record body", error)
        )
      );
      return yield* Effect.try({
        try: () =>
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks, size)
          ),
        catch: () => storeError("record is not valid UTF-8"),
      });
    });
  }

  function read<A>(
    target: Address,
    schema: Schema.Codec<A, unknown, never, never>
  ) {
    return Effect.gen(function* () {
      const file = yield* files.download(target.key).pipe(
        Effect.catchReason("FilesError", "NotFound", () =>
          Effect.succeed(null)
        ),
        Effect.mapError((error) => storeError(`read ${target.kind}`, error))
      );
      if (file === null) {
        return null;
      }
      const text = yield* bodyText(file);
      const record = yield* Schema.decodeUnknownEffect(codec(target, schema))(
        text
      ).pipe(
        Effect.mapError(() =>
          storeError(`invalid ${target.kind} record at ${target.key}`)
        )
      );
      return record.state;
    });
  }

  function write<A>(
    target: Address,
    schema: Schema.Codec<A, unknown, never, never>,
    state: A
  ) {
    return Effect.gen(function* () {
      const text = yield* Schema.encodeEffect(codec(target, schema))({
        formatVersion: 1,
        storageId: options.storageId,
        namespace: options.namespace,
        recordKind: target.kind,
        address: JSON.stringify(target.ids),
        state,
      }).pipe(
        Effect.mapError(() => storeError(`unable to encode ${target.kind}`))
      );
      if (Buffer.byteLength(text) > maxRecordBytes) {
        return yield* storeError(`${target.kind} exceeds maxRecordBytes`);
      }
      yield* files
        .upload(target.key, text, {
          contentType: "application/json",
          multipart: false,
        })
        .pipe(
          Effect.mapError((error) => storeError(`write ${target.kind}`, error))
        );
    });
  }

  function remove(target: Address) {
    return files.delete(target.key).pipe(
      Effect.catchReason("FilesError", "NotFound", () => Effect.void),
      Effect.mapError((error) => storeError(`delete ${target.kind}`, error))
    );
  }

  function scanItems<A extends { readonly definitionId: string }>(
    definitionId: string,
    schema: Schema.Codec<A, unknown, never, never>,
    identityOf: (state: A) => string,
    visit: (state: A) => void
  ) {
    return Effect.gen(function* () {
      const prefix = `${root}/definitions/${hash(definitionId)}/items/`;
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = yield* files
          .list({
            prefix,
            limit: options.pageSize ?? 100,
            ...(cursor === undefined ? {} : { cursor }),
          })
          .pipe(
            Effect.mapError((error) => storeError("list item states", error))
          );
        yield* Effect.forEach(
          page.items,
          (info) =>
            Effect.gen(function* () {
              if (
                !(
                  info.key.startsWith(prefix) &&
                  itemFilePattern.test(info.key.slice(prefix.length))
                )
              ) {
                return yield* storeError(
                  "unexpected object in item-state directory"
                );
              }
              // Decode enough to derive the expected logical address, then validate
              // the complete envelope and deterministic key through the normal reader.
              const file = yield* files
                .download(info.key)
                .pipe(
                  Effect.mapError((error) =>
                    storeError("read listed item", error)
                  )
                );
              const text = yield* bodyText(file);
              const peek = yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(Schema.Struct({ state: schema }))
              )(text).pipe(
                Effect.mapError(() => storeError("invalid listed item"))
              );
              if (peek.state.definitionId !== definitionId) {
                return yield* storeError("listed item definition mismatch");
              }
              const target = address(
                "item",
                definitionId,
                identityOf(peek.state)
              );
              if (target.key !== info.key) {
                return yield* storeError(
                  "item-state key does not match its identity"
                );
              }
              const decoded = yield* Schema.decodeUnknownEffect(
                codec(target, schema)
              )(text).pipe(
                Effect.mapError(() => storeError("invalid item-state envelope"))
              );
              visit(decoded.state);
            }),
          { concurrency: options.readConcurrency ?? 4, discard: true }
        );
        cursor = page.cursor;
        if (cursor !== undefined) {
          if (seen.has(cursor)) {
            return yield* storeError("listing cursor repeated");
          }
          seen.add(cursor);
        }
      } while (cursor !== undefined);
    });
  }

  return { address, read, write, remove, scanItems };
}
