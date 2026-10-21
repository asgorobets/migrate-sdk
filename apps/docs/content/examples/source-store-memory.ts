import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";

export const state = InMemoryMigrationStore.makeState();
export const migrationStore = InMemoryMigrationStore.layer(state);
