import type { MigrationDefinitionId } from "migrate-sdk";
import type {
  MigrateDashboardRow,
  MigratePrepareOptions,
  MigrateSelection,
} from "migrate-sdk/protocol";
import type { MigrationTuiRuntime } from "./runtime.ts";

export type RollbackScope = "include-dependencies" | "selected-only";

const hasOmittedDependentItems = (
  rows: readonly MigrateDashboardRow[],
  selectedIds: readonly MigrationDefinitionId[]
): boolean => {
  const selected = new Set(selectedIds);
  const dependents = new Map<MigrationDefinitionId, MigrateDashboardRow[]>();
  for (const row of rows) {
    for (const dependency of row.entry.dependencies.required) {
      const existing = dependents.get(dependency) ?? [];
      existing.push(row);
      dependents.set(dependency, existing);
    }
  }

  const visited = new Set<MigrationDefinitionId>();
  const pending = [...selectedIds];
  let hasItems = false;
  for (const id of pending) {
    if (visited.has(id)) {
      continue;
    }
    visited.add(id);
    for (const row of dependents.get(id) ?? []) {
      pending.push(row.entry.id);
      if (selected.has(row.entry.id)) {
        continue;
      }
      if (row.status === undefined) {
        throw new Error(
          `Cannot check rollback dependencies: status unavailable for ${row.entry.id}.`
        );
      }
      hasItems ||= Object.values(row.status.durable).some((count) => count > 0);
    }
  }
  return hasItems;
};

/** Translate the TUI scope choice into explicit API options before confirmation. */
export const prepareRollbackScope = async (
  runtime: Pick<MigrationTuiRuntime, "prepare" | "refresh">,
  selection: MigrateSelection,
  scope: RollbackScope,
  options: MigratePrepareOptions = {}
) => {
  const requestOptions = {
    ...options,
    force: false,
    withDependencies: scope === "include-dependencies",
  };
  const operation = await runtime.prepare(
    selection,
    "rollback",
    requestOptions
  );
  if (scope === "include-dependencies") {
    return operation;
  }

  // Read durable counts, not source inventory or the outcome of the last run.
  // The server still performs authoritative preflight when execution starts.
  const snapshot = await runtime.refresh();
  if (
    !hasOmittedDependentItems(
      snapshot.rows,
      operation.plan.executionDefinitionIds
    )
  ) {
    return operation;
  }
  return runtime.prepare(selection, "rollback", {
    ...requestOptions,
    force: true,
  });
};
