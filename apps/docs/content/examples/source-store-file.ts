import { FileMigrationStore } from "migrate-sdk/stores/file";

export const migrationStore = FileMigrationStore.layer({
  directory: "./.migrate",
});
