import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FilesError, Files as FilesSDKClient } from "files-sdk";
import { Files } from "files-sdk/effect";
import { SourceIdentity } from "migrate-sdk";
import { useConfiguredSource } from "migrate-sdk/testing";
import { makeMemoryFilesSDK } from "../testing/index.ts";
import { FilesSDKSource } from "./source.ts";

describe("FilesSDKSource", () => {
  it.effect(
    "does not hide authorization errors as missing or persist provider secrets",
    () =>
      Effect.gen(function* () {
        const backend = makeMemoryFilesSDK();
        const client = new FilesSDKClient({
          adapter: {
            ...backend.adapter,
            head: () =>
              Promise.reject(
                new FilesError("Unauthorized", "secret credential", {
                  token: "do-not-store",
                })
              ),
          },
        });
        const source = FilesSDKSource.objects({ storageId: "source" }).provide(
          Files.layer(client)
        );
        const error = yield* useConfiguredSource(source, (runtime) =>
          Effect.flip(
            runtime.readByIdentity(SourceIdentity.fromKey(source.identity, "a"))
          )
        );
        expect(error.cause).toMatchObject({ reason: "Unauthorized" });
        expect(JSON.stringify(error)).not.toContain("secret credential");
        expect(JSON.stringify(error)).not.toContain("do-not-store");
      })
  );
  it.effect("pages plain references and supports scoped identity lookup", () =>
    Effect.gen(function* () {
      const backend = makeMemoryFilesSDK({
        initial: {
          "input/α.txt": "alpha",
          "input/z.txt": "zed",
          "other.txt": "other",
        },
      });
      const source = FilesSDKSource.objects({
        storageId: "source",
        prefix: "input/",
        pageSize: 1,
      }).provide(backend.layer);
      yield* useConfiguredSource(source, (runtime) =>
        Effect.gen(function* () {
          const first = yield* runtime.read(null);
          expect(first.items).toHaveLength(1);
          expect(first.nextCursor).toBeDefined();
          const second = yield* runtime.read(first.nextCursor ?? null);
          expect(second.items).toHaveLength(1);
          expect(
            new Set([...first.items, ...second.items].map((s) => s.item.key))
              .size
          ).toBe(2);
          const item = first.items[0];
          if (item === undefined) {
            throw new Error("missing fixture");
          }
          expect(yield* runtime.readByIdentity(item.identity)).toEqual(item);
          expect(
            yield* runtime.readByIdentity(
              SourceIdentity.fromKey(source.identity, "other.txt")
            )
          ).toBeNull();
          expect(
            yield* runtime.readByIdentity(
              SourceIdentity.fromKey(source.identity, "input/missing")
            )
          ).toBeNull();
          expect(runtime.countTotal).toBeUndefined();
          expect(source.discovery).toBe("full");
        })
      );
    })
  );

  it.effect(
    "stable versions change with bytes, and storage binding changes contracts",
    () =>
      Effect.gen(function* () {
        const backend = makeMemoryFilesSDK({ initial: { "a.txt": "one" } });
        const source = FilesSDKSource.objects({ storageId: "source" }).provide(
          backend.layer
        );
        const read = useConfiguredSource(source, (runtime) =>
          runtime.read(null)
        );
        const first = yield* read;
        expect((yield* read).items[0]?.version).toBe(first.items[0]?.version);
        yield* backend.service.upload("a.txt", "two");
        expect((yield* read).items[0]?.version).not.toBe(
          first.items[0]?.version
        );
        expect(
          FilesSDKSource.objects({ storageId: "other" })
            .sourceIdentityContractFingerprint
        ).not.toBe(source.sourceIdentityContractFingerprint);
      })
  );

  it.effect("preserves continuation after an empty filtered page", () =>
    Effect.gen(function* () {
      const backend = makeMemoryFilesSDK({
        initial: { "a.txt": "a", "b.txt": "b" },
      });
      const source = FilesSDKSource.objects({
        storageId: "source",
        pageSize: 1,
        filter: { id: "only-b@v1", test: (o) => o.key === "b.txt" },
      }).provide(backend.layer);
      yield* useConfiguredSource(source, (runtime) =>
        Effect.gen(function* () {
          const first = yield* runtime.read(null);
          expect(first.items).toEqual([]);
          expect(first.nextCursor).toBeDefined();
          expect(
            (yield* runtime.read(first.nextCursor ?? null)).items[0]?.item.key
          ).toBe("b.txt");
        })
      );
    })
  );

  it.effect(
    "rejects saved cursors from another scope and repeating tokens",
    () =>
      Effect.gen(function* () {
        const backend = makeMemoryFilesSDK({ initial: { a: "a", b: "b" } });
        const first = FilesSDKSource.objects({
          storageId: "one",
          pageSize: 1,
        }).provide(backend.layer);
        const page = yield* useConfiguredSource(first, (runtime) =>
          runtime.read(null)
        );
        const other = FilesSDKSource.objects({
          storageId: "two",
          pageSize: 1,
        }).provide(backend.layer);
        const mismatch = yield* useConfiguredSource(other, (runtime) =>
          Effect.flip(runtime.read(page.nextCursor ?? null))
        );
        expect(mismatch.message).toContain("--rescan");
        const client = new FilesSDKClient({
          adapter: {
            ...backend.adapter,
            list: async () => ({ items: [], cursor: "again" }),
          },
        });
        const looping = FilesSDKSource.objects({ storageId: "loop" }).provide(
          Files.layer(client)
        );
        yield* useConfiguredSource(looping, (runtime) =>
          Effect.gen(function* () {
            const start = yield* runtime.read(null);
            const error = yield* Effect.flip(
              runtime.read(start.nextCursor ?? null)
            );
            expect(error.message).toContain("repeated cursor");
          })
        );
      })
  );

  it.effect("hashes actual bytes when explicitly requested", () =>
    Effect.gen(function* () {
      const backend = makeMemoryFilesSDK({ initial: { a: "same", b: "same" } });
      const source = FilesSDKSource.objects({
        storageId: "one",
        version: { kind: "sha256" },
      }).provide(backend.layer);
      const page = yield* useConfiguredSource(source, (runtime) =>
        runtime.read(null)
      );
      expect(page.items[0]?.version).toBe(page.items[1]?.version);
      expect(page.items[0]?.version).toHaveLength(64);
    })
  );
});
