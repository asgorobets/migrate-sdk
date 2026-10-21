import {
  FilesSDKDocumentFetchers,
  type FilesSDKObjectDiscoveryOptions,
} from "@migrate-sdk/files-sdk/source";
import { Schema } from "effect";
import { Files as FilesSDKClient } from "files-sdk";
import { Files } from "files-sdk/effect";
import { fs } from "files-sdk/fs";
import { SourceIdentity } from "migrate-sdk";
import { DocumentParsers, DocumentSource } from "migrate-sdk/sources/document";

export const CatalogDocument = Schema.Struct({
  products: Schema.Array(Schema.Struct({ id: Schema.String })),
});

const client = new FilesSDKClient({
  adapter: fs({ root: "./source-storage" }),
});
const filesLayer = Files.layer(client);

export const selection = {
  storageId: "catalog",
  prefix: "input/",
  pageSize: 20,
  filter: { id: "json-files@v1", test: (file) => file.key.endsWith(".json") },
} satisfies FilesSDKObjectDiscoveryOptions;

export const catalogSource = DocumentSource.make({
  fetcher: FilesSDKDocumentFetchers.texts({
    ...selection,
    filesLayer,
    maxBytes: 10 * 1024 * 1024,
  }),
  parser: DocumentParsers.each(DocumentParsers.json(CatalogDocument)),
  selector: { item: (document) => document.products },
  identity: {
    id: "catalog-product@v1",
    schema: SourceIdentity.key("id", Schema.String),
    key: ({ item }) => item.id,
  },
  lookup: { kind: "scan" },
  version: { kind: "content-hash" },
  batchSize: 100,
});
