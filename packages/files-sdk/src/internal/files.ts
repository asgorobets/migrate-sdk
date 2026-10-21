import { createHash } from "node:crypto";
import { Effect, Stream } from "effect";
import type { FileInfo } from "files-sdk";
import { FilesError, type FilesService } from "files-sdk/effect";
import { SourceError } from "migrate-sdk";
import type { FilesSDKObject } from "../object.ts";

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeFailure(error: unknown): Record<string, string | boolean> {
  if (error instanceof FilesError) {
    return {
      reason: error.reason._tag,
      permanent: error.reason.permanent,
      aborted: error.reason.aborted,
      timedOut: error.reason.timedOut,
      applied: error.reason.applied,
      ...(error.reason.appliedEtag === undefined
        ? {}
        : { appliedEtag: error.reason.appliedEtag }),
    };
  }
  return { reason: "Invalid" };
}

export function sourceError(operation: string, cause?: unknown): SourceError {
  if (cause instanceof SourceError) {
    return cause;
  }
  return new SourceError({
    message: `Files source ${operation} failed`,
    ...(cause === undefined ? {} : { cause: safeFailure(cause) }),
  });
}

export function objectFromInfo(
  storageId: string,
  info: FileInfo
): FilesSDKObject {
  return {
    storageId,
    key: info.key,
    size: info.size,
    contentType: info.contentType,
    ...(info.etag ? { etag: info.etag } : {}),
    ...(info.lastModified === undefined
      ? {}
      : { lastModified: info.lastModified }),
    ...(info.metadata === undefined ? {} : { metadata: info.metadata }),
  };
}

export function sameObject(
  expected: FilesSDKObject,
  actual: FileInfo
): boolean {
  return (
    expected.size === actual.size &&
    (expected.etag === undefined || expected.etag === actual.etag) &&
    (expected.lastModified === undefined ||
      expected.lastModified === actual.lastModified)
  );
}

export const contentHash = Effect.fn("FilesSDKSource.contentHash")(function* (
  files: FilesService,
  object: FilesSDKObject
) {
  const file = yield* files.download(object.key, {
    ...(object.etag !== undefined && files.capabilities.conditional.exactRead
      ? { condition: { etag: object.etag } }
      : {}),
  });
  if (!sameObject(object, file)) {
    yield* Effect.promise(() =>
      file.file
        .stream()
        .cancel()
        .catch(() => undefined)
    );
    return yield* sourceError("object changed before hashing");
  }
  const digest = createHash("sha256");
  yield* file.stream.pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        digest.update(chunk);
      })
    )
  );
  const current = yield* files.head(object.key);
  if (!sameObject(object, current)) {
    return yield* sourceError("object changed during hashing");
  }
  return digest.digest("hex");
});
