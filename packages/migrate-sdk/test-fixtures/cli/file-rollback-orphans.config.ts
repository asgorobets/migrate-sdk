import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  SourceIdentity,
} from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { FileMigrationStore } from "migrate-sdk/stores/file";

const EntrySource = Schema.Struct({ title: Schema.String });
const EntrySourceIdentity = SourceIdentity.make({
  id: "file-cli-entry@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});
const probeKey = "__migrateSdkCliFileRollbackOrphansProbe";
const scope = globalThis as typeof globalThis & {
  [probeKey]?: {
    readonly rollbackCalls: string[];
    readonly sourceItems: {
      readonly identityKey: string;
      readonly item: { readonly title: string };
      readonly version: string;
    }[];
  };
};

scope[probeKey] ??= {
  rollbackCalls: [],
  sourceItems: [
    {
      identityKey: "article-1",
      item: { title: "Article 1" },
      version: "source-version-1",
    },
    {
      identityKey: "article-2",
      item: { title: "Article 2" },
      version: "source-version-1",
    },
  ],
};

const probe = scope[probeKey];
const directory = fileURLToPath(new URL("./.migration-state", import.meta.url));
const articles = MigrationDefinition.make({
  id: "articles",
  source: InMemorySource.make({
    identity: EntrySourceIdentity,
    items: probe.sourceItems,
    sourceSchema: EntrySource,
  }),
  store: FileMigrationStore.layer({ directory }),
  process: () => Effect.void,
  rollback: (state) =>
    Effect.sync(() => {
      probe.rollbackCalls.push(state.sourceIdentity.encoded);
    }),
});

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({ definitions: [articles] }),
});
