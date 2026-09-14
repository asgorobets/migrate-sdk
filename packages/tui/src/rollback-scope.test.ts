import { toMigrationDefinitionId } from "migrate-sdk";
import {
  MigrateDashboardResumeToken,
  type MigrateDashboardRow,
  MigratePlanFingerprint,
  type MigratePreparedOperation,
  type MigrateSelection,
} from "migrate-sdk/protocol";
import { describe, expect, it, vi } from "vitest";
import { prepareRollbackScope } from "./rollback-scope.ts";
import type { MigrationTuiRuntime } from "./runtime.ts";

const authorsId = toMigrationDefinitionId("authors");
const selection: MigrateSelection = {
  kind: "definitions",
  definitionIds: [authorsId],
};

const row = (
  id: string,
  required: readonly string[] = [],
  durable: Partial<NonNullable<MigrateDashboardRow["status"]>["durable"]> = {}
): MigrateDashboardRow => ({
  entry: {
    id: toMigrationDefinitionId(id),
    hasRollback: true,
    dependencies: {
      required: required.map(toMigrationDefinitionId),
      optional: [],
    },
  },
  status: {
    definitionId: toMigrationDefinitionId(id),
    discovery: "full",
    durable: { migrated: 0, skipped: 0, failed: 0, needsUpdate: 0, ...durable },
    lastRun: null,
    lock: null,
    warnings: [],
  },
});

const runtimeFor = (
  rows: readonly MigrateDashboardRow[],
  selectedIds = [authorsId]
) => ({
  refresh: vi.fn<MigrationTuiRuntime["refresh"]>(() =>
    Promise.resolve({
      activeRuns: [],
      resumeToken: MigrateDashboardResumeToken.make("rollback-test"),
      rows,
      scannedSource: false,
    })
  ),
  prepare: vi.fn<MigrationTuiRuntime["prepare"]>(
    (target, action, options = {}) => {
      const operation: MigratePreparedOperation = {
        action,
        dependencyChecks: [],
        fingerprint: MigratePlanFingerprint.make("rollback-test"),
        observationDefinitionId: authorsId,
        plan: {
          executionDefinitionIds: selectedIds,
          executionPolicy: [],
          includedDefinitionIds: selectedIds,
          notices: [],
          requestedDefinitionIds: selectedIds,
          force: options.force ?? false,
          withDependencies: options.withDependencies ?? false,
        },
        planRows: rows.filter((entry) => selectedIds.includes(entry.entry.id)),
        request: { selection: target, action, options },
        selection: target,
      };
      return Promise.resolve(operation);
    }
  ),
});

describe("prepareRollbackScope", () => {
  it("clears force when choosing the recommended scope", async () => {
    const runtime = runtimeFor([
      row("authors"),
      row("books", ["authors"], { migrated: 1 }),
    ]);
    const operation = await prepareRollbackScope(
      runtime,
      selection,
      "include-dependencies",
      { force: true }
    );
    expect(operation.request.options).toEqual({
      force: false,
      withDependencies: true,
    });
    expect(runtime.refresh).not.toHaveBeenCalled();
  });

  it.each([
    "migrated",
    "failed",
    "skipped",
    "needsUpdate",
  ] as const)("forces selected-only when a transitive dependent has %s records", async (status) => {
    const runtime = runtimeFor([
      row("authors"),
      row("books", ["authors"]),
      row("reviews", ["books"], { [status]: 1 }),
    ]);
    const operation = await prepareRollbackScope(
      runtime,
      selection,
      "selected-only"
    );
    expect(operation.request.options).toEqual({
      force: true,
      withDependencies: false,
    });
    expect(operation.plan.executionDefinitionIds).toEqual([authorsId]);
    expect(runtime.refresh).toHaveBeenCalledOnce();
  });

  it("leaves selected-only unforced when dependents have no tracked records", async () => {
    const runtime = runtimeFor([
      row("authors", [], { migrated: 1 }),
      row("books", ["authors"]),
      row("unrelated", [], { failed: 1 }),
      {
        ...row("optional", [], { migrated: 1 }),
        entry: {
          ...row("optional").entry,
          dependencies: { required: [], optional: [authorsId] },
        },
      },
    ]);
    const operation = await prepareRollbackScope(
      runtime,
      selection,
      "selected-only",
      { force: true }
    );
    expect(operation.request.options).toEqual({
      force: false,
      withDependencies: false,
    });
    expect(runtime.prepare).toHaveBeenCalledOnce();
  });

  it("does not force for dependent migrations already selected in a group", async () => {
    const runtime = runtimeFor(
      [row("authors"), row("books", ["authors"], { migrated: 1 })],
      [authorsId, toMigrationDefinitionId("books")]
    );
    const operation = await prepareRollbackScope(
      runtime,
      selection,
      "selected-only"
    );
    expect(operation.request.options.force).toBe(false);
  });

  it("preserves selected identities and execution options when force is needed", async () => {
    const runtime = runtimeFor([
      row("authors"),
      row("books", ["authors"], { failed: 1 }),
    ]);
    const options = {
      sourceIdentities: ["author-1"],
      execution: { rollback: { concurrency: 2 } },
    };
    const operation = await prepareRollbackScope(
      runtime,
      selection,
      "selected-only",
      options
    );
    expect(operation.request.options).toEqual({
      ...options,
      force: true,
      withDependencies: false,
    });
  });

  it("does not assume force is needed when a dependent status is unavailable", async () => {
    const runtime = runtimeFor([
      row("authors"),
      { entry: row("books", ["authors"]).entry },
    ]);
    await expect(
      prepareRollbackScope(runtime, selection, "selected-only")
    ).rejects.toThrow("status unavailable for books");
    expect(runtime.prepare).toHaveBeenCalledOnce();
  });

  it("keeps a status refresh failure from producing a forced plan", async () => {
    const runtime = runtimeFor([]);
    runtime.refresh.mockRejectedValueOnce(new Error("Store unavailable"));
    await expect(
      prepareRollbackScope(runtime, selection, "selected-only")
    ).rejects.toThrow("Store unavailable");
    expect(runtime.prepare).toHaveBeenCalledOnce();
  });
});
