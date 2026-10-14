// authors.csv
// id,first_name,last_name
// author-1040,Ada,Morgan
// author-1041,Alex,Chen
// author-1042,Sam,Rivera

import { mkdir, rm, writeFile } from "node:fs/promises";
import { NodeServices } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import {
  DestinationError,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  type ProcessPipelineFor,
  type RollbackPipelineFor,
  Tracking,
} from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";
import { CsvIdentity, CsvSource } from "migrate-sdk/sources/csv";
import { FileMigrationStore } from "migrate-sdk/stores/file";

const csvOptions = {
  platform: NodeServices.layer,
  dialect: { kind: "standard" },
  headers: { kind: "from-row", rowIndex: 0 },
  emptyRows: { kind: "skip" },
  version: { kind: "row-hash" },
} as const;

const AuthorRow = Schema.Struct({
  id: Schema.NonEmptyString,
  first_name: Schema.NonEmptyString,
  last_name: Schema.NonEmptyString,
});

const authorSource = CsvSource.make({
  ...csvOptions,
  path: "./authors.csv",
  sourceSchema: AuthorRow,
  identity: CsvIdentity.column({ column: "id", id: "author-id@v1" }),
});

const AuthorInput = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
});

const upsertAuthor = (input: typeof AuthorInput.Type) =>
  Schema.decodeEffect(AuthorInput)(input).pipe(Effect.flatMap(writeAuthor));

const authorTracking = Tracking.record({
  id: "author-file@v1",
  schema: Schema.Struct({ path: Schema.NonEmptyString }),
});

const writeAuthor = (author: typeof AuthorInput.Type) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir("./authors", { recursive: true });
      const path = `./authors/${encodeURIComponent(author.id)}.json`;
      await writeFile(path, JSON.stringify(author, null, 2));
      return path;
    },
    catch: (cause) =>
      new DestinationError({ cause, message: "Could not write author" }),
  });

const deleteAuthor = (path: string) =>
  Effect.tryPromise({
    try: () => rm(path, { force: true }),
    catch: (cause) =>
      new DestinationError({ cause, message: "Could not remove author" }),
  });

type AuthorProcess = ProcessPipelineFor<
  typeof authorSource,
  DestinationError | Schema.SchemaError,
  typeof authorTracking
>;
type AuthorRollback = RollbackPipelineFor<
  typeof authorTracking,
  DestinationError
>;

const processAuthor: AuthorProcess = Effect.fn("processAuthor")(
  function* (sourceItem) {
    const row = sourceItem.item;
    const path = yield* upsertAuthor({
      id: row.id,
      name: `${row.first_name} ${row.last_name}`,
    });
    yield* Tracking.setRecord({ path });
  }
);

const rollbackAuthor: AuthorRollback = (state) => {
  const path = state.trackingRecord?.path;
  return path === undefined ? Effect.void : deleteAuthor(path);
};

export const authors = MigrationDefinition.make({
  id: "authors",
  source: authorSource,
  process: processAuthor,
  tracking: authorTracking,
  rollback: rollbackAuthor,
  store: FileMigrationStore.layer({ directory: "./.migrate" }),
});

// Save this file as migrate.config.ts, then run: pnpm exec migrate run authors
export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({ definitions: [authors] }),
});
