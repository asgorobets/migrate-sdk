import { Effect, type Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { SourcePluginError } from "../../domain/errors.ts";

export interface DocumentFetchResult<Resource, Cursor> {
  readonly fingerprint?: string | undefined;
  readonly nextCursor?: Cursor | undefined;
  readonly resource: Resource;
}

export interface DocumentFetcher<Resource, Cursor> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly read: (
    cursor: Cursor | null
  ) => Effect.Effect<DocumentFetchResult<Resource, Cursor>, SourcePluginError>;
}

export type DocumentFetcherPlatform = Layer.Layer<FileSystem | Path>;

export interface DocumentFileTextFetcherOptions {
  readonly path: string;
  readonly platform: DocumentFetcherPlatform;
}

export const DocumentFileTextFetcherCursor = Schema.Null;

export type DocumentFileTextFetcherCursor =
  typeof DocumentFileTextFetcherCursor.Type;

const documentFetcherError = (
  message: string,
  cause?: unknown
): SourcePluginError =>
  new SourcePluginError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const hexFromBytes = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256Hex = (
  bytes: Uint8Array
): Effect.Effect<string, SourcePluginError> =>
  Effect.tryPromise({
    try: async () => {
      const webCrypto = globalThis.crypto;

      if (webCrypto?.subtle !== undefined) {
        const digestInput = new Uint8Array(bytes).buffer;
        const digest = await webCrypto.subtle.digest("SHA-256", digestInput);
        return hexFromBytes(new Uint8Array(digest));
      }

      throw new Error("Web Crypto SHA-256 support is required");
    },
    catch: (cause) =>
      documentFetcherError("Unable to fingerprint document resource", cause),
  });

const readFileBytes = (
  fs: FileSystem,
  path: Path,
  filePath: string
): Effect.Effect<
  { readonly bytes: Uint8Array; readonly resolvedPath: string },
  SourcePluginError
> => {
  const resolvedPath = path.resolve(filePath);

  return fs.readFile(resolvedPath).pipe(
    Effect.map((bytes) => ({
      bytes,
      resolvedPath,
    })),
    Effect.mapError((cause) =>
      documentFetcherError("Unable to read document resource file", {
        cause,
        path: filePath,
        resolvedPath,
      })
    )
  );
};

const decodeUtf8 = (
  bytes: Uint8Array,
  resolvedPath: string
): Effect.Effect<string, SourcePluginError> =>
  Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: (cause) =>
      documentFetcherError("Unable to decode document resource file as UTF-8", {
        cause,
        path: resolvedPath,
      }),
  });

const readFileText = Effect.fn("DocumentFetchers.fileText.read")(function* (
  options: DocumentFileTextFetcherOptions
) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const file = yield* readFileBytes(fs, path, options.path);
  const fingerprint = yield* sha256Hex(file.bytes);
  const resource = yield* decodeUtf8(file.bytes, file.resolvedPath);

  return {
    fingerprint,
    resource,
  } satisfies DocumentFetchResult<string, DocumentFileTextFetcherCursor>;
});

const makeFileTextFetcher = (
  options: DocumentFileTextFetcherOptions
): DocumentFetcher<string, DocumentFileTextFetcherCursor> => ({
  cursorSchema: DocumentFileTextFetcherCursor,
  read: () => readFileText(options).pipe(Effect.provide(options.platform)),
});

export const DocumentFetchers = {
  fileText: makeFileTextFetcher,
} as const;
