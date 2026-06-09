import { describe, expect, it } from "@effect/vitest";
import { Effect, type Layer, Option, Schema } from "effect";
import {
  type ConfiguredDestinationPlugin,
  type ConfiguredSourcePlugin,
  type DestinationCommand,
  defineMigration,
  type MigrationDefinitionDependenciesInput,
  type MigrationDefinitionIdInput,
  MigrationDefinitionRegistry,
  MigrationDefinitionRegistryConstructionError,
  MigrationDefinitionRegistryLookupError,
  type MigrationStore,
  type MigrationStoreError,
  type RollbackPipeline,
  toMigrationDefinitionId,
} from "migrate-sdk";

const ArticleSource = Schema.Struct({
  title: Schema.String,
});
type ArticleSource = typeof ArticleSource.Type;

interface NoopCommand extends DestinationCommand {
  readonly kind: "Noop";
}

interface TestDefinitionInput {
  readonly dependencies?: MigrationDefinitionDependenciesInput;
  readonly dependsOn?: readonly MigrationDefinitionIdInput[];
  readonly id: MigrationDefinitionIdInput;
  readonly rollback?: RollbackPipeline<NoopCommand, never>;
}

const source = {} as ConfiguredSourcePlugin<ArticleSource, unknown>;
const destination = {} as ConfiguredDestinationPlugin<NoopCommand>;
const store = {} as Layer.Layer<MigrationStore, MigrationStoreError>;

const makeDefinition = (input: TestDefinitionInput) =>
  defineMigration<ArticleSource, NoopCommand>({
    id: input.id,
    ...(input.dependencies === undefined
      ? {}
      : { dependencies: input.dependencies }),
    ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
    source,
    destination,
    store,
    pipeline: () => ({ kind: "Noop" }),
    ...(input.rollback === undefined ? {} : { rollback: input.rollback }),
  });

describe("MigrationDefinitionRegistry", () => {
  it("allows an empty immutable registry", () => {
    const registry = MigrationDefinitionRegistry.make({ definitions: [] });

    expect(registry.definitions()).toEqual([]);
    expect(registry.list()).toEqual([]);
    expect(() =>
      (registry.definitions() as unknown as unknown[]).push("unsafe")
    ).toThrow(TypeError);
  });

  it("lists static definition metadata and exposes definitions by id", () => {
    const authors = makeDefinition({ id: "authors" });
    const articles = makeDefinition({
      id: "articles",
      dependsOn: ["authors"],
      dependencies: {
        optional: ["asset-cleanup"],
      },
      rollback: () => Effect.succeed({ kind: "Noop" }),
    });

    const registry = MigrationDefinitionRegistry.make({
      definitions: [authors, articles] as const,
    });

    expect(registry.definitions()).toEqual([authors, articles]);
    expect(registry.list()).toEqual([
      {
        id: toMigrationDefinitionId("authors"),
        dependencies: {
          required: [],
          optional: [],
        },
        hasRollback: false,
      },
      {
        id: toMigrationDefinitionId("articles"),
        dependencies: {
          required: [toMigrationDefinitionId("authors")],
          optional: [toMigrationDefinitionId("asset-cleanup")],
        },
        hasRollback: true,
      },
    ]);
    expect(Option.getOrNull(registry.get("articles"))).toBe(articles);
    expect(Option.isNone(registry.get("unknown"))).toBe(true);
  });

  it("aggregates hard catalog issues into a schema-backed construction error", () => {
    const articles = makeDefinition({
      id: "articles",
      dependencies: {
        required: ["authors"],
      },
    });
    const duplicateArticles = makeDefinition({
      id: "articles",
      dependencies: {
        required: ["images"],
      },
    });

    try {
      MigrationDefinitionRegistry.make({
        definitions: [articles, duplicateArticles],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(
        MigrationDefinitionRegistryConstructionError
      );

      const constructionError = Schema.decodeUnknownSync(
        MigrationDefinitionRegistryConstructionError
      )(
        Schema.encodeSync(MigrationDefinitionRegistryConstructionError)(
          error as MigrationDefinitionRegistryConstructionError
        )
      );

      expect(constructionError.issues).toEqual([
        {
          _tag: "DuplicateMigrationDefinitionId",
          definitionId: toMigrationDefinitionId("articles"),
        },
        {
          _tag: "MissingRequiredMigrationDefinitionDependency",
          definitionId: toMigrationDefinitionId("articles"),
          dependencyId: toMigrationDefinitionId("authors"),
        },
        {
          _tag: "MissingRequiredMigrationDefinitionDependency",
          definitionId: toMigrationDefinitionId("articles"),
          dependencyId: toMigrationDefinitionId("images"),
        },
      ]);
      return;
    }

    throw new Error("Expected registry construction to fail");
  });

  it("rejects required dependency cycles and ignores optional dependency cycles", () => {
    const authors = makeDefinition({
      id: "authors",
      dependencies: {
        required: ["articles"],
      },
    });
    const articles = makeDefinition({
      id: "articles",
      dependencies: {
        required: ["authors"],
      },
    });
    const tags = makeDefinition({
      id: "tags",
      dependencies: {
        optional: ["categories"],
      },
    });
    const categories = makeDefinition({
      id: "categories",
      dependencies: {
        optional: ["tags"],
      },
    });

    try {
      MigrationDefinitionRegistry.make({
        definitions: [authors, articles, tags, categories],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(
        MigrationDefinitionRegistryConstructionError
      );
      expect(
        (error as MigrationDefinitionRegistryConstructionError).issues
      ).toEqual([
        {
          _tag: "RequiredMigrationDefinitionDependencyCycle",
          definitionIds: [
            toMigrationDefinitionId("authors"),
            toMigrationDefinitionId("articles"),
            toMigrationDefinitionId("authors"),
          ],
        },
      ]);
      return;
    }

    throw new Error("Expected registry construction to fail");
  });

  it("allows missing optional dependencies and optional-only cycles", () => {
    const tags = makeDefinition({
      id: "tags",
      dependencies: {
        optional: ["categories", "legacy-tags"],
      },
    });
    const categories = makeDefinition({
      id: "categories",
      dependencies: {
        optional: ["tags"],
      },
    });

    const registry = MigrationDefinitionRegistry.make({
      definitions: [tags, categories],
    });

    expect(registry.list()).toEqual([
      {
        id: toMigrationDefinitionId("tags"),
        dependencies: {
          required: [],
          optional: [
            toMigrationDefinitionId("categories"),
            toMigrationDefinitionId("legacy-tags"),
          ],
        },
        hasRollback: false,
      },
      {
        id: toMigrationDefinitionId("categories"),
        dependencies: {
          required: [],
          optional: [toMigrationDefinitionId("tags")],
        },
        hasRollback: false,
      },
    ]);
  });

  it.effect(
    "requires known definitions or fails with a typed lookup error",
    () =>
      Effect.gen(function* () {
        const articles = makeDefinition({ id: "articles" });
        const registry = MigrationDefinitionRegistry.make({
          definitions: [articles],
        });

        expect(yield* registry.require("articles")).toBe(articles);

        const error = yield* Effect.flip(registry.require("unknown"));

        expect(error).toBeInstanceOf(MigrationDefinitionRegistryLookupError);
        expect(error).toEqual(
          new MigrationDefinitionRegistryLookupError({
            definitionId: toMigrationDefinitionId("unknown"),
            message: "Migration Definition was not found in the registry",
          })
        );
      })
  );
});
