import { layer as nodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { layer as nodePathLayer } from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { SourcePluginError } from "migrate-sdk";
import type {
  DocumentFetcher,
  DocumentFetchResult,
  DocumentFileTextFetcherCursor,
} from "migrate-sdk/sources/document";
import { DocumentFetchers } from "migrate-sdk/sources/document";
import { expectTypeOf } from "vitest";

const sha256HexPattern = /^[a-f0-9]{64}$/;
const testPlatformLayer = Layer.mergeAll(nodeFileSystemLayer, nodePathLayer);

describe("DocumentFetchers.fileText", () => {
  it("exports reusable fetcher contracts", () => {
    const fetcher = DocumentFetchers.fileText({
      path: "./companies.json",
      platform: testPlatformLayer,
    });

    expectTypeOf(fetcher).toMatchTypeOf<
      DocumentFetcher<string, DocumentFileTextFetcherCursor>
    >();
    expectTypeOf<DocumentFileTextFetcherCursor>().toEqualTypeOf<null>();
    expectTypeOf<
      DocumentFetchResult<string, DocumentFileTextFetcherCursor>
    >().toEqualTypeOf<{
      readonly fingerprint?: string | undefined;
      readonly nextCursor?: null | undefined;
      readonly resource: string;
    }>();
  });

  it.effect("reads local text resources with stable fingerprints", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-sdk-document-fetcher-",
      });
      const filePath = path.join(directory, "companies.json");
      yield* fs.writeFileString(filePath, '{"companies":[]}');

      const fetcher = DocumentFetchers.fileText({
        path: filePath,
        platform: testPlatformLayer,
      });

      const first = yield* fetcher.read(null);
      const second = yield* fetcher.read(null);

      expect(first.resource).toBe('{"companies":[]}');
      expect(first.fingerprint).toMatch(sha256HexPattern);
      expect(second.fingerprint).toBe(first.fingerprint);
      expect(first.nextCursor).toBeUndefined();
      expect(fetcher.cursorSchema.ast).toBeDefined();
    }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect("does not parse or validate JSON contents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-sdk-document-fetcher-",
      });
      const filePath = path.join(directory, "invalid.json");
      yield* fs.writeFileString(filePath, "{not json");

      const fetcher = DocumentFetchers.fileText({
        path: filePath,
        platform: testPlatformLayer,
      });

      const result = yield* fetcher.read(null);

      expect(result.resource).toBe("{not json");
    }).pipe(Effect.provide(testPlatformLayer))
  );

  it.effect(
    "fails missing files as source plugin errors with path context",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-sdk-document-fetcher-",
        });
        const filePath = path.join(directory, "missing.json");
        const fetcher = DocumentFetchers.fileText({
          path: filePath,
          platform: testPlatformLayer,
        });

        const error = yield* fetcher.read(null).pipe(Effect.flip);

        expect(error).toBeInstanceOf(SourcePluginError);
        expect(error.message).toBe("Unable to read document resource file");
        expect(error.cause).toEqual(
          expect.objectContaining({
            path: filePath,
            resolvedPath: path.resolve(filePath),
          })
        );
      }).pipe(Effect.provide(testPlatformLayer))
  );
});
