import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { SourceIdentity } from "migrate-sdk";
import { DocumentParsers, DocumentSource } from "migrate-sdk/sources/document";
import { useConfiguredSource } from "migrate-sdk/testing";
import { makeMemoryFilesSDK } from "../testing/index.ts";
import { FilesSDKDocumentFetchers } from "./document-fetcher.ts";

describe("Files document fetcher", () => {
  it.effect("composes remote JSON with the existing parser and selector", () =>
    Effect.gen(function* () {
      const backend = makeMemoryFilesSDK({
        initial: { "rows.json": '{"rows":[{"id":"a"},{"id":"b"}]}' },
      });
      const fetcher = FilesSDKDocumentFetchers.text({
        key: "rows.json",
        filesLayer: backend.layer,
      });
      const source = DocumentSource.make({
        fetcher,
        parser: DocumentParsers.json(
          Schema.Struct({
            rows: Schema.Array(Schema.Struct({ id: Schema.String })),
          })
        ),
        selector: { item: (document) => document.rows },
        identity: {
          id: "rows@v1",
          schema: SourceIdentity.key("id", Schema.String),
          key: ({ item }) => item.id,
        },
        lookup: { kind: "scan" },
        version: { kind: "content-hash" },
        batchSize: 1,
      });
      yield* useConfiguredSource(source, (runtime) =>
        Effect.gen(function* () {
          const first = yield* runtime.read(null);
          expect(first.items[0]?.item.item.id).toBe("a");
          yield* backend.service.upload(
            "rows.json",
            '{"rows":[{"id":"new"},{"id":"b"}]}'
          );
          expect(
            (yield* runtime.read(first.nextCursor ?? null)).items[0]?.item.item
              .id
          ).toBe("new");
        })
      );
    })
  );

  it.effect(
    "enforces byte limits and strict UTF-8 while consuming the body",
    () =>
      Effect.gen(function* () {
        const backend = makeMemoryFilesSDK({
          initial: { big: "12345", invalid: new Uint8Array([255]) },
        });
        const large = FilesSDKDocumentFetchers.text({
          key: "big",
          filesLayer: backend.layer,
          maxBytes: 4,
        });
        expect((yield* Effect.flip(large.read(null))).message).toContain(
          "maxBytes"
        );
        const invalid = FilesSDKDocumentFetchers.text({
          key: "invalid",
          filesLayer: backend.layer,
        });
        expect((yield* Effect.flip(invalid.read(null))).message).toContain(
          "UTF-8"
        );
      })
  );
});
