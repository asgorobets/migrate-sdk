import { Effect, Schema } from "effect";
import type { FileInfo } from "files-sdk";
import type { FilesService } from "files-sdk/effect";
import { FilesSDKObject } from "../object.ts";
import type { FilesSDKObjectDiscoveryOptions } from "../source/options.ts";
import { objectFromInfo, sourceError } from "./files.ts";

export function makeObjectDiscovery(options: FilesSDKObjectDiscoveryOptions) {
  const prefix = options.prefix ?? "";
  const pageSize = options.pageSize ?? 100;
  const concurrency = options.metadataConcurrency ?? 4;
  const traversed = new Map<string | null, string | undefined>();
  const validate = Effect.gen(function* () {
    if (
      options.storageId.trim().length === 0 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize <= 0 ||
      !Number.isSafeInteger(concurrency) ||
      concurrency <= 0 ||
      (options.filter !== undefined && options.filter.id.trim().length === 0)
    ) {
      return yield* sourceError("invalid discovery configuration");
    }
  });
  const accepts = (object: FilesSDKObject) =>
    Effect.try({
      try: () =>
        object.key.startsWith(prefix) && (options.filter?.test(object) ?? true),
      catch: () => sourceError("filter callback"),
    });
  const hydrate = (files: FilesService, info: FileInfo) =>
    Effect.gen(function* () {
      const complete =
        info.etag === undefined && info.lastModified === undefined
          ? yield* files
              .head(info.key)
              .pipe(Effect.mapError((e) => sourceError("head", e)))
          : info;
      return yield* Schema.decodeUnknownEffect(FilesSDKObject)(
        objectFromInfo(options.storageId, complete)
      ).pipe(Effect.mapError(() => sourceError("invalid object metadata")));
    });
  const read = Effect.fn("FilesSDK.discovery.read")(function* (
    files: FilesService,
    cursor: string | null
  ) {
    yield* validate;
    if (cursor === null) {
      traversed.clear();
    }
    const page = yield* files
      .list({
        prefix,
        limit: pageSize,
        ...(cursor === null ? {} : { cursor }),
      })
      .pipe(
        Effect.mapError((e) =>
          sourceError("list; use --rescan if the saved cursor expired", e)
        )
      );
    if (
      page.cursor !== undefined &&
      (page.cursor === cursor ||
        (traversed.has(page.cursor) && traversed.get(cursor) !== page.cursor))
    ) {
      return yield* sourceError("listing returned a repeated cursor");
    }
    traversed.set(cursor, page.cursor);
    const objects = yield* Effect.forEach(
      page.items,
      (info) => hydrate(files, info),
      { concurrency }
    );
    return {
      objects: yield* Effect.filter(objects, accepts),
      nextCursor: page.cursor,
    };
  });
  const lookup = Effect.fn("FilesSDK.discovery.lookup")(function* (
    files: FilesService,
    key: string
  ) {
    yield* validate;
    if (!key.startsWith(prefix)) {
      return null;
    }
    const info = yield* files.head(key).pipe(
      Effect.catchReason("FilesError", "NotFound", () => Effect.succeed(null)),
      Effect.mapError((e) => sourceError("lookup", e))
    );
    if (info === null) {
      return null;
    }
    const object = yield* hydrate(files, info);
    return (yield* accepts(object)) ? object : null;
  });
  return { validate, read, lookup };
}
