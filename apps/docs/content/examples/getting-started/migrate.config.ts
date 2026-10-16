import { MigrationDefinitionRegistry } from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";
import { authors } from "./migration.ts";

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({ definitions: [authors] }),
});
