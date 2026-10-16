import {
  FilesSDKDocumentFetchers,
  type FilesSDKTextsFetcherOptions,
} from "@migrate-sdk/files-sdk/source";
import { Schema } from "effect";
import { SourceIdentity } from "migrate-sdk";
import { DocumentParsers, DocumentSource } from "migrate-sdk/sources/document";

const CatalogDocument = Schema.Struct({
  products: Schema.Array(Schema.Struct({ id: Schema.String })),
});

/** Record identities must be unique across every selected catalog file. */
export function makeCatalogSource<E>(
  options: FilesSDKTextsFetcherOptions<E>,
  batchSize = 100
) {
  return DocumentSource.make({
    fetcher: FilesSDKDocumentFetchers.texts(options),
    parser: DocumentParsers.each(DocumentParsers.json(CatalogDocument)),
    selector: { item: (document) => document.products },
    identity: {
      id: "catalog-product@v1",
      schema: SourceIdentity.key("id", Schema.String),
      key: ({ item }) => item.id,
    },
    lookup: { kind: "scan" },
    version: { kind: "content-hash" },
    batchSize,
  });
}
