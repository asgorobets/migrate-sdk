import { Effect, Option } from "effect";
import type { AnySelfContainedMigrationDefinition } from "../domain/definition.ts";
import type { MigrationDefinitionId } from "../domain/ids.ts";
import type { MigrationDefinitionLock } from "../domain/lock.ts";
import type { MigrationDefinitionRegistry } from "../domain/registry.ts";
import type {
  MigrateRegistry,
  MigrateRegistryMessagesReport,
  MigrateRegistryMessagesRequest,
  MigrateRegistryStatusReport,
  MigrateRegistryStatusRequest,
} from "../protocol/index.ts";
import { toMigrationDefinitionRegistrySelectionInput } from "../protocol/registry-selection.ts";
import { MigrationStore } from "../services/migration-store.ts";
import type {
  MigrationCliServerConnection,
  MigrationCliServerError,
} from "./runtime.ts";

export type MigrationCliUnlockResult =
  | { readonly kind: "already-clear" }
  | { readonly kind: "cleared"; readonly lock: MigrationDefinitionLock }
  | { readonly kind: "not-found" };

export interface MigrationCliRegistryOperations {
  readonly breakLock: (
    definitionId: MigrationDefinitionId
  ) => Effect.Effect<MigrationCliUnlockResult, MigrationCliServerError>;
  readonly getMessages: (
    input: MigrateRegistryMessagesRequest
  ) => Effect.Effect<MigrateRegistryMessagesReport, MigrationCliServerError>;
  readonly getRegistry: Effect.Effect<MigrateRegistry, MigrationCliServerError>;
  readonly getStatus: (
    input: MigrateRegistryStatusRequest
  ) => Effect.Effect<MigrateRegistryStatusReport, MigrationCliServerError>;
}

type CliExecutableRegistry = MigrationDefinitionRegistry<
  readonly AnySelfContainedMigrationDefinition[]
>;

export const makeLocalMigrationCliRegistryOperations = (
  registry: MigrationDefinitionRegistry
): MigrationCliRegistryOperations => {
  const executableRegistry = registry as CliExecutableRegistry;

  return {
    breakLock: (definitionId) =>
      Effect.gen(function* () {
        const definition = Option.getOrUndefined(registry.get(definitionId));

        if (definition === undefined) {
          return { kind: "not-found" as const };
        }

        const lock = yield* MigrationStore.pipe(
          Effect.flatMap((store) => store.breakDefinitionLock(definitionId)),
          Effect.provide(definition.store)
        );

        return lock === null
          ? { kind: "already-clear" as const }
          : { kind: "cleared" as const, lock };
      }),
    getMessages: (input) =>
      registry.messages(toMigrationDefinitionRegistrySelectionInput(input)),
    getRegistry: Effect.succeed({
      entries: registry.list(),
      groups: registry.groups(),
    }),
    getStatus: (input) =>
      executableRegistry.status({
        ...toMigrationDefinitionRegistrySelectionInput(input),
        ...(input.concurrency === undefined
          ? {}
          : { concurrency: input.concurrency }),
        scanSource: input.scanSource,
      }),
  };
};

export const makeRemoteMigrationCliRegistryOperations = (
  connection: MigrationCliServerConnection
): MigrationCliRegistryOperations => ({
  breakLock: (definitionId) =>
    Effect.gen(function* () {
      const snapshot = yield* connection.getDashboard;
      const row = snapshot.dashboard.rows.find(
        (candidate) => candidate.entry.id === definitionId
      );

      if (row === undefined) {
        return { kind: "not-found" as const };
      }

      const lock = row.status?.lock;

      if (lock === undefined || lock === null) {
        return { kind: "already-clear" as const };
      }

      const result = yield* connection.breakLock(lock);

      return result.kind === "already-clear"
        ? { kind: "already-clear" as const }
        : { kind: "cleared" as const, lock };
    }),
  getMessages: connection.getRegistryMessages,
  getRegistry: connection.getRegistry,
  getStatus: connection.getRegistryStatus,
});
