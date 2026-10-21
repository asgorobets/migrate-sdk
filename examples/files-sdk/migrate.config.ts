import { MigrationDefinitionRegistry } from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";
import { folderCopy } from "./folder-copy.ts";

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({
    id: "files-sdk-example",
    definitions: [folderCopy],
  }),
});
