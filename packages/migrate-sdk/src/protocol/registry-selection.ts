import type { MigrationDefinitionRegistrySelectionInput } from "../domain/registry.ts";
import type { MigrateRegistryMessagesRequest } from "./index.ts";

export const toMigrationDefinitionRegistrySelectionInput = (
  input: MigrateRegistryMessagesRequest
): MigrationDefinitionRegistrySelectionInput => {
  switch (input.selection.kind) {
    case "all":
      return { all: true, withDependencies: input.withDependencies };
    case "definitions":
      return {
        definitionIds: input.selection.definitionIds,
        withDependencies: input.withDependencies,
      };
    case "group":
      return {
        group: input.selection.groupId,
        withDependencies: input.withDependencies,
      };
    default: {
      const unhandled: never = input.selection;
      return unhandled;
    }
  }
};
