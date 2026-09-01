import { Effect, Schema } from "effect";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  SourceIdentity,
} from "migrate-sdk";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { FileMigrationStore } from "migrate-sdk/stores/file";

const Item = Schema.Struct({ value: Schema.Number });
const ItemIdentity = SourceIdentity.make({
  id: "persistent-reconnect-item@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});

export const reconnectFixtureDirectory = (): string => {
  const directory = process.env.MIGRATE_TUI_RECONNECT_FIXTURE_DIR;

  if (directory === undefined || directory === "") {
    throw new Error("MIGRATE_TUI_RECONNECT_FIXTURE_DIR is required");
  }

  return directory;
};

export const reconnectFixtureToken = (): string => {
  const token = process.env.MIGRATE_TUI_RECONNECT_FIXTURE_TOKEN;

  if (token === undefined || token === "") {
    throw new Error("MIGRATE_TUI_RECONNECT_FIXTURE_TOKEN is required");
  }

  return token;
};

export const reconnectFixturePaths = (directory: string) => ({
  exited: `${directory}/execution-exited.json`,
  started: `${directory}/execution-started.json`,
  store: `${directory}/store`,
  stop: `${directory}/execution-stop.json`,
  terminal: `${directory}/execution-terminal.json`,
});

export const makePersistentReconnectRegistry = (directory: string) => {
  const paths = reconnectFixturePaths(directory);
  const definition = MigrationDefinition.make({
    id: "persistent-reconnect",
    process: () => Effect.sleep("200 millis"),
    source: InMemorySource.make({
      batchSize: 1,
      identity: ItemIdentity,
      items: Array.from({ length: 20 }, (_, index) => ({
        identityKey: `item-${index + 1}`,
        item: { value: index + 1 },
        version: "v1",
      })),
      sourceSchema: Item,
    }),
    store: FileMigrationStore.layer({ directory: paths.store }),
  });

  return MigrationDefinitionRegistry.make({
    definitions: [definition] as const,
  });
};
