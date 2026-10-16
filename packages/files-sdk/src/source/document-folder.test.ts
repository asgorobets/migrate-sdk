import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FilesError, Files as FilesSDKClient } from "files-sdk";
import { Files } from "files-sdk/effect";
import { SourceIdentity } from "migrate-sdk";
import { useConfiguredSource } from "migrate-sdk/testing";
import { makeCatalogSource } from "../../examples/document-source.ts";
import { makeMemoryFilesSDK } from "../testing/index.ts";
import { FilesSDKDocumentFetchers } from "./document-fetcher.ts";
import type { FilesSDKObjectDiscoveryOptions } from "./options.ts";
import { FilesSDKSource } from "./source.ts";

const jsonFilter = {
  id: "json-files@v1",
  test: (file: { readonly key: string }) => file.key.endsWith(".json"),
};

describe("Files SDK folder Document Fetcher", () => {
  it.effect(
    "shares file selection with the Source and resumes records within file pages",
    () =>
      Effect.gen(function* () {
        const backend = makeMemoryFilesSDK({
          initial: {
            "input/0.txt": "ignored",
            "input/a.json": '{"products":[{"id":"a"},{"id":"b"}]}',
            "input/b.json": '{"products":[{"id":"c"}]}',
            "other.json": "not selected",
          },
        });
        const selection = {
          storageId: "catalog",
          prefix: "input/",
          pageSize: 1,
          filter: jsonFilter,
        } satisfies FilesSDKObjectDiscoveryOptions;
        const files = FilesSDKSource.objects(selection).provide(backend.layer);
        yield* useConfiguredSource(files, (runtime) =>
          Effect.gen(function* () {
            let page = yield* runtime.read(null);
            const keys = page.items.map((item) => item.item.key);
            while (page.nextCursor !== undefined) {
              page = yield* runtime.read(page.nextCursor);
              keys.push(...page.items.map((item) => item.item.key));
            }
            expect(keys).toEqual(["input/a.json", "input/b.json"]);
          })
        );
        const source = makeCatalogSource(
          { ...selection, filesLayer: backend.layer },
          1
        );
        yield* useConfiguredSource(source, (runtime) =>
          Effect.gen(function* () {
            const empty = yield* runtime.read(null);
            expect(empty.items).toEqual([]);
            expect(empty.nextCursor).toBeDefined();
            const first = yield* runtime.read(empty.nextCursor ?? null);
            expect(first.items[0]?.item.item.id).toBe("a");
            if (first.nextCursor === undefined) {
              throw new Error("missing partial-page cursor");
            }
            const saved = yield* Schema.encodeEffect(runtime.cursorSchema)(
              first.nextCursor
            );
            const cursor = yield* Schema.decodeUnknownEffect(
              runtime.cursorSchema
            )(saved);
            const second = yield* runtime.read(cursor);
            expect(second.items[0]?.item.item.id).toBe("b");
            const third = yield* runtime.read(second.nextCursor ?? null);
            expect(third.items[0]?.item.item.id).toBe("c");
            expect(third.nextCursor).toBeUndefined();
            expect(
              (yield* runtime.readByIdentity(
                SourceIdentity.fromKey(source.identity, "c")
              ))?.item.item.id
            ).toBe("c");
            expect(runtime.countTotal).toBeUndefined();
          })
        );
      })
  );

  it.effect("completes an empty folder with no documents", () =>
    Effect.gen(function* () {
      const backend = makeMemoryFilesSDK();
      const source = makeCatalogSource({
        storageId: "catalog",
        filesLayer: backend.layer,
      });
      yield* useConfiguredSource(source, (runtime) =>
        Effect.gen(function* () {
          const page = yield* runtime.read(null);
          expect(page.items).toEqual([]);
          expect(page.nextCursor).toBeUndefined();
        })
      );
    })
  );

  it.effect("restarts a partially consumed page when one file changes", () =>
    Effect.gen(function* () {
      const backend = makeMemoryFilesSDK({
        initial: {
          "a.json": '{"products":[{"id":"a"},{"id":"b"}]}',
          "b.json": '{"products":[{"id":"c"}]}',
        },
      });
      const source = makeCatalogSource(
        { storageId: "catalog", filesLayer: backend.layer },
        1
      );
      yield* useConfiguredSource(source, (runtime) =>
        Effect.gen(function* () {
          const first = yield* runtime.read(null);
          yield* backend.service.upload(
            "b.json",
            '{"products":[{"id":"new"}]}'
          );
          expect(
            (yield* runtime.read(first.nextCursor ?? null)).items[0]?.item.item
              .id
          ).toBe("a");
        })
      );
    })
  );

  it.effect(
    "bounds the aggregate bytes of a page and fingerprints file keys",
    () =>
      Effect.gen(function* () {
        const backend = makeMemoryFilesSDK({ initial: { a: "abc", b: "def" } });
        const bounded = FilesSDKDocumentFetchers.texts({
          storageId: "catalog",
          filesLayer: backend.layer,
          maxBytes: 5,
        });
        expect((yield* Effect.flip(bounded.read(null))).message).toContain(
          "maxBytes"
        );
        const fetcher = FilesSDKDocumentFetchers.texts({
          storageId: "catalog",
          filesLayer: backend.layer,
        });
        const before = yield* fetcher.read(null);
        yield* backend.service.delete("a");
        yield* backend.service.upload("c", "abc");
        const after = yield* fetcher.read(null);
        expect(after.fingerprint).not.toBe(before.fingerprint);
      })
  );

  it.effect(
    "rejects changed cursor scope, repeating tokens, and provider authorization failures",
    () =>
      Effect.gen(function* () {
        const backend = makeMemoryFilesSDK({ initial: { a: "a", b: "b" } });
        const fetcher = FilesSDKDocumentFetchers.texts({
          storageId: "catalog",
          filesLayer: backend.layer,
          pageSize: 1,
        });
        const first = yield* fetcher.read(null);
        const other = FilesSDKDocumentFetchers.texts({
          storageId: "different",
          filesLayer: backend.layer,
          pageSize: 1,
        });
        expect(
          (yield* Effect.flip(other.read(first.nextCursor ?? null))).message
        ).toContain("--rescan");
        const client = new FilesSDKClient({
          adapter: {
            ...backend.adapter,
            list: async () => ({ items: [], cursor: "again" }),
          },
        });
        const looping = FilesSDKDocumentFetchers.texts({
          storageId: "catalog",
          filesLayer: Files.layer(client),
        });
        const page = yield* looping.read(null);
        expect(
          (yield* Effect.flip(looping.read(page.nextCursor ?? null))).message
        ).toContain("repeated cursor");
        const denied = new FilesSDKClient({
          adapter: {
            ...backend.adapter,
            download: () =>
              Promise.reject(
                new FilesError("Unauthorized", "secret credential")
              ),
          },
        });
        const unauthorized = FilesSDKDocumentFetchers.texts({
          storageId: "catalog",
          filesLayer: Files.layer(denied),
        });
        const error = yield* Effect.flip(unauthorized.read(null));
        expect(error.cause).toMatchObject({ reason: "Unauthorized" });
        expect(JSON.stringify(error)).not.toContain("secret credential");
      })
  );
});
