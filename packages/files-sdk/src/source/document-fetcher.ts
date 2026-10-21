import { createHash } from "node:crypto";
import { Effect, type Layer, Schema, Stream } from "effect";
import { Files, type FilesService } from "files-sdk/effect";
import { DocumentFetchers } from "migrate-sdk/sources/document";
import { hash, sourceError } from "../internal/files.ts";
import { makeObjectDiscovery } from "../internal/object-discovery.ts";
import type { FilesSDKObjectDiscoveryOptions } from "./options.ts";

export interface FilesSDKTextFetcherOptions<E = never> {
  readonly filesLayer: Layer.Layer<Files, E>;
  readonly key: string;
  readonly maxBytes?: number;
}

export interface FilesSDKTextsFetcherOptions<E = never>
  extends FilesSDKObjectDiscoveryOptions {
  readonly filesLayer: Layer.Layer<Files, E>;
  /** Maximum total downloaded bytes per listing page. Defaults to 10 MiB. */
  readonly maxBytes?: number;
}

export const FilesSDKDocumentFetcherCursor = Schema.Struct({
  formatVersion: Schema.Literal(1),
  scope: Schema.String,
  cursor: Schema.String,
});
export type FilesSDKDocumentFetcherCursor =
  typeof FilesSDKDocumentFetcherCursor.Type;

const maxBytesFor = (configured: number | undefined) =>
  Effect.gen(function* () {
    const maxBytes = configured ?? 10 * 1024 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      return yield* sourceError("maxBytes must be a positive safe integer");
    }
    return maxBytes;
  });

const readText = Effect.fn("FilesSDKDocumentFetchers.readText")(function* (
  files: FilesService,
  key: string,
  maxBytes: number
) {
  const file = yield* files
    .download(key)
    .pipe(Effect.mapError((e) => sourceError("document download", e)));
  const digest = createHash("sha256");
  const chunks: Uint8Array[] = [];
  let size = 0;
  yield* file.stream.pipe(
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        size += chunk.byteLength;
        if (size > maxBytes) {
          return yield* sourceError("document exceeds maxBytes");
        }
        digest.update(chunk);
        chunks.push(chunk);
      })
    ),
    Effect.mapError((e) => sourceError("document read", e))
  );
  const bytes = Buffer.concat(chunks, size);
  const resource = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () => sourceError("invalid UTF-8 document"),
  });
  return { resource, fingerprint: digest.digest("hex"), size };
});

/** Retrieve one stored file as UTF-8 text for a caller-selected parser. */
function text<E>(options: FilesSDKTextFetcherOptions<E>) {
  return DocumentFetchers.effect({
    cursorSchema: Schema.Null,
    read: () =>
      Effect.gen(function* () {
        const maxBytes = yield* maxBytesFor(options.maxBytes);
        const files = yield* Files;
        const { resource, fingerprint } = yield* readText(
          files,
          options.key,
          maxBytes
        );
        return { resource, fingerprint };
      }).pipe(
        Effect.provide(options.filesLayer),
        Effect.mapError((error) => sourceError("document fetch", error))
      ),
  });
}

/** Retrieve pages of file texts; compose with DocumentParsers.each(parser). */
function texts<E>(options: FilesSDKTextsFetcherOptions<E>) {
  const discovery = makeObjectDiscovery(options);
  const scope = hash(
    JSON.stringify([
      "files.document-texts@v1",
      options.storageId,
      options.prefix ?? "",
      options.pageSize ?? 100,
      options.filter?.id,
      options.maxBytes ?? 10 * 1024 * 1024,
    ])
  );
  return DocumentFetchers.effect({
    cursorSchema: FilesSDKDocumentFetcherCursor,
    read: (cursor) =>
      Effect.gen(function* () {
        const maxBytes = yield* maxBytesFor(options.maxBytes);
        if (cursor !== null && cursor.scope !== scope) {
          return yield* sourceError(
            "document cursor scope changed; use --rescan"
          );
        }
        const files = yield* Files;
        const page = yield* discovery.read(files, cursor?.cursor ?? null);
        let bytesRead = 0;
        const resources = yield* Effect.forEach(page.objects, (object) =>
          Effect.gen(function* () {
            const file = yield* readText(
              files,
              object.key,
              maxBytes - bytesRead
            );
            bytesRead += file.size;
            return file;
          })
        );
        return {
          resource: resources.map((file) => file.resource),
          fingerprint: hash(
            JSON.stringify([
              page.objects.map((object) => object.key),
              resources.map((file) => file.fingerprint),
            ])
          ),
          ...(page.nextCursor === undefined
            ? {}
            : {
                nextCursor: {
                  formatVersion: 1 as const,
                  scope,
                  cursor: page.nextCursor,
                },
              }),
        };
      }).pipe(
        Effect.provide(options.filesLayer),
        Effect.mapError((error) => sourceError("document page fetch", error))
      ),
  });
}

export const FilesSDKDocumentFetchers = { text, texts } as const;
