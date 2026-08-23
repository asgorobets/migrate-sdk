import { fileURLToPath } from "node:url";
import {
  toMigrationDefinitionGroupId,
  toMigrationDefinitionId,
} from "migrate-sdk";
import { describe, expect, it } from "vitest";
import { makeMigrationTuiRuntime } from "./runtime.ts";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const authorsId = toMigrationDefinitionId("authors");
const articlesId = toMigrationDefinitionId("articles");
const contentGroupId = toMigrationDefinitionGroupId("content");
const succeededRunPattern = /^Run .+ succeeded$/;

describe("Migration TUI runtime", () => {
  it("loads the CLI config through the shared loader", async () => {
    const runtime = await makeMigrationTuiRuntime({
      cwd: fileURLToPath(new URL("../examples", import.meta.url)),
    });

    expect(runtime.configPath).toBe(
      fileURLToPath(new URL("../examples/migrate.config.ts", import.meta.url))
    );
    expect(runtime.rows.map((row) => row.entry.id)).toEqual([
      "authors",
      "articles",
      "assets",
    ]);
    expect(runtime.groups).toEqual([
      {
        definitionIds: ["authors", "articles", "assets"],
        id: contentGroupId,
      },
    ]);
  });

  it("prepares an executable SDK plan before executing it", async () => {
    const runtime = await makeMigrationTuiRuntime({
      configPath: "examples/migrate.config.ts",
      cwd: packageDirectory,
    });
    const operation = await runtime.prepare(
      { definitionId: articlesId, kind: "migration" },
      "retry-failed"
    );

    expect(operation).toMatchObject({
      action: "retry-failed",
      observationDefinitionId: articlesId,
      plan: {
        executionDefinitionIds: ["authors", "articles"],
        includedDefinitionIds: ["authors", "articles"],
        kind: "run",
        mode: { kind: "failed" },
        withDependencies: true,
      },
    });

    await expect(runtime.execute(operation)).resolves.toMatch(
      succeededRunPattern
    );
    const snapshot = await runtime.refresh();
    const articles = snapshot.rows.find((row) => row.entry.id === articlesId);

    expect(articles?.status?.durable.failed).toBe(0);
    expect(articles?.status?.durable.migrated).toBe(2);
  });

  it("prepares multiple source identities from durable item history", async () => {
    const runtime = await makeMigrationTuiRuntime({
      configPath: "examples/migrate.config.ts",
      cwd: packageDirectory,
    });
    const history = await runtime.listSourceIdentityHistory(articlesId);
    const sourceIdentities = history.map((entry) => entry.sourceIdentity);
    const operation = await runtime.prepare(
      { definitionId: articlesId, kind: "migration" },
      "run",
      { sourceIdentities }
    );

    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceIdentity: "article-welcome",
          status: "migrated",
        }),
        expect.objectContaining({
          sourceIdentity: "article-effect",
          status: "failed",
        }),
      ])
    );
    expect(
      runtime.normalizeSourceIdentity(articlesId, "article%2Dwelcome")
    ).toBe("article-welcome");
    expect(operation).toMatchObject({
      action: "run",
      plan: {
        target: {
          definitionId: articlesId,
          sourceIdentities: ["article-welcome", "article-effect"],
        },
      },
      sourceIdentities: ["article-welcome", "article-effect"],
    });
  });

  it("prepares rollback dependencies in reverse execution order", async () => {
    const runtime = await makeMigrationTuiRuntime({
      configPath: "examples/migrate.config.ts",
      cwd: packageDirectory,
    });
    const operation = await runtime.prepare(
      { definitionId: authorsId, kind: "migration" },
      "rollback"
    );

    expect(operation).toMatchObject({
      action: "rollback",
      observationDefinitionId: authorsId,
      plan: {
        executionDefinitionIds: ["articles", "authors"],
        includedDefinitionIds: ["authors", "articles"],
        kind: "rollback",
        withDependencies: true,
      },
      planRows: [{ entry: { id: "articles" } }, { entry: { id: "authors" } }],
    });
  });

  it("reports unmet run dependencies and prepares include or force resolutions", async () => {
    const runtime = await makeMigrationTuiRuntime({
      configPath: "examples/dependency-preflight.config.ts",
      cwd: packageDirectory,
    });
    const target = { definitionId: articlesId, kind: "migration" } as const;
    const selectedOnly = await runtime.prepare(target, "run");
    const expanded = await runtime.prepare(target, "run", {
      withDependencies: true,
    });
    const forced = await runtime.prepare(target, "run", {
      force: true,
      withDependencies: false,
    });

    expect(selectedOnly).toMatchObject({
      dependencyChecks: [
        {
          dependencyId: "authors",
          requiredByDefinitionId: "articles",
          satisfied: false,
        },
      ],
      plan: {
        executionDefinitionIds: ["articles"],
        withDependencies: false,
      },
      planRows: [{ entry: { id: "articles" } }],
    });
    expect(expanded).toMatchObject({
      dependencyChecks: [],
      plan: {
        executionDefinitionIds: ["authors", "articles"],
        withDependencies: true,
      },
    });
    expect(forced).toMatchObject({
      plan: {
        executionDefinitionIds: ["articles"],
        force: true,
        withDependencies: false,
      },
    });
  });

  it("prepares a group plan without expanding external dependencies", async () => {
    const runtime = await makeMigrationTuiRuntime({
      configPath: "examples/migrate.config.ts",
      cwd: packageDirectory,
    });
    const operation = await runtime.prepare(
      { groupId: contentGroupId, kind: "group" },
      "run"
    );

    expect(operation).toMatchObject({
      action: "run",
      observationDefinitionId: "authors",
      plan: {
        executionDefinitionIds: ["authors", "assets", "articles"],
        includedDefinitionIds: ["authors", "articles", "assets"],
        kind: "run",
        requestedGroup: contentGroupId,
        withDependencies: false,
      },
      target: { groupId: contentGroupId, kind: "group" },
    });
  });
});
