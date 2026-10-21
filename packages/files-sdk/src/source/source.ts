import { Effect, Layer, Schema } from "effect";
import { Files } from "files-sdk/effect";
import {
  makeSourceIdentityContractFingerprint,
  makeSourceVersionContractFingerprint,
  Source,
  SourceError,
  SourceIdentity,
} from "migrate-sdk";
import { contentHash, hash, sourceError } from "../internal/files.ts";
import { makeObjectDiscovery } from "../internal/object-discovery.ts";
import { FilesSDKObject } from "../object.ts";
import type { FilesSDKObjectDiscoveryOptions } from "./options.ts";

export const FilesSDKSourceCursor = Schema.Struct({
  formatVersion: Schema.Literal(1),
  scope: Schema.String,
  cursor: Schema.String,
});
export type FilesSDKSourceCursor = typeof FilesSDKSourceCursor.Type;

export type FilesSDKSourceVersion =
  | { readonly kind: "metadata" }
  | { readonly kind: "sha256" }
  | {
      readonly kind: "custom";
      readonly id: string;
      readonly read: (
        object: FilesSDKObject
      ) => Effect.Effect<string, SourceError>;
    };

export interface FilesSDKSourceOptions extends FilesSDKObjectDiscoveryOptions {
  readonly version?: FilesSDKSourceVersion;
}

function objects(options: FilesSDKSourceOptions) {
  const prefix = options.prefix ?? "";
  const pageSize = options.pageSize ?? 100;
  const concurrency = options.metadataConcurrency ?? 4;
  const version = options.version ?? { kind: "metadata" };
  const versionId = version.kind === "custom" ? version.id : version.kind;
  const scope = hash(
    JSON.stringify([
      options.storageId,
      prefix,
      pageSize,
      options.filter?.id,
      versionId,
    ])
  );
  const identity = SourceIdentity.make({
    id: "files.object-key@v1",
    schema: SourceIdentity.key("key", Schema.NonEmptyString),
  });

  return Source.fromLayer({
    identity,
    sourceIdentityContractFingerprint: makeSourceIdentityContractFingerprint({
      identity: identity.fingerprint,
      storageId: options.storageId,
    }),
    sourceVersionContractFingerprint: makeSourceVersionContractFingerprint({
      kind: "files.object-version@v1",
      versionId,
    }),
    cursorSchema: FilesSDKSourceCursor,
    sourceSchema: FilesSDKObject,
    layer: (Runtime) =>
      Layer.effect(
        Runtime,
        Effect.gen(function* () {
          if (versionId.trim().length === 0) {
            return yield* sourceError("invalid configuration");
          }
          const files = yield* Files;
          const discovery = makeObjectDiscovery(options);
          yield* discovery.validate;
          const item = (object: FilesSDKObject) =>
            Effect.gen(function* () {
              let fingerprint: string;
              switch (version.kind) {
                case "sha256":
                  fingerprint = yield* contentHash(files, object).pipe(
                    Effect.mapError((e) =>
                      e instanceof SourceError ? e : sourceError("hash", e)
                    )
                  );
                  break;
                case "custom":
                  fingerprint = yield* Effect.suspend(() =>
                    version.read(object)
                  );
                  break;
                default:
                  if (
                    object.etag === undefined &&
                    object.lastModified === undefined
                  ) {
                    return yield* sourceError(
                      "version requires an ETag, modification time, or custom resolver"
                    );
                  }
                  fingerprint = hash(
                    JSON.stringify([
                      object.etag ?? null,
                      object.lastModified ?? null,
                      object.size,
                    ])
                  );
              }
              return {
                identityKey: object.key,
                item: object,
                version: fingerprint,
              };
            });
          return Runtime.of({
            lookupStrategy: "direct",
            read: Effect.fn("FilesSDKSource.read")(function* (cursor) {
              if (cursor !== null && cursor.scope !== scope) {
                return yield* sourceError("cursor scope changed; use --rescan");
              }
              const page = yield* discovery.read(files, cursor?.cursor ?? null);
              const items = yield* Effect.forEach(page.objects, item, {
                concurrency,
              });
              return {
                items,
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
            }),
            readByIdentity: Effect.fn("FilesSDKSource.readByIdentity")(
              function* (target) {
                const object = yield* discovery.lookup(files, target.key);
                return object === null ? null : yield* item(object);
              }
            ),
          });
        })
      ),
  });
}

export const FilesSDKSource = { objects } as const;
