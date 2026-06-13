import { describe, expect, it } from "@effect/vitest";
import { Effect, type Layer, Option, Schema } from "effect";
import { expectTypeOf } from "vitest";
import {
  type ConfiguredDestinationPlugin,
  type ConfiguredSourcePlugin,
  type DestinationCommand,
  defineMigration,
  InMemoryDestinationPlugin,
  InMemoryMigrationStore,
  InMemorySourcePlugin,
  type MigrationDefinitionDependenciesInput,
  type MigrationDefinitionIdInput,
  MigrationDefinitionRegistry,
  MigrationDefinitionRegistryConstructionError,
  MigrationDefinitionRegistryInvalidSelectionError,
  MigrationDefinitionRegistryLookupError,
  MigrationDefinitionRegistryMissingExplicitRequiredDependenciesError,
  type MigrationDefinitionRegistryStatusError,
  type MigrationDefinitionRegistryStatusReport,
  MigrationDefinitionRegistryUnknownDefinitionError,
  type MigrationStore,
  type MigrationStoreError,
  type RollbackPipeline,
  RollbackPreflightError,
  toDestinationIdentity,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceIdentity,
  toSourceVersion,
} from "migrate-sdk";

const ArticleSource = Schema.Struct({
  title: Schema.String,
});
type ArticleSource = typeof ArticleSource.Type;

const ArticleEntryFields = Schema.Struct({
  title: Schema.String,
});

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

interface RequiredRegistryStatusSourceService {
  readonly _tag: "RequiredRegistryStatusSourceService";
}

const sourceRequiringService = source as ConfiguredSourcePlugin<
  ArticleSource,
  unknown,
  ArticleSource,
  never,
  RequiredRegistryStatusSourceService
>;

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

const makeStatusDefinition = (
  input: TestDefinitionInput & {
    readonly store: Layer.Layer<MigrationStore, MigrationStoreError>;
  }
) =>
  defineMigration<ArticleSource, NoopCommand>({
    id: input.id,
    ...(input.dependencies === undefined
      ? {}
      : { dependencies: input.dependencies }),
    ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
    source,
    destination,
    store: input.store,
    pipeline: () => ({ kind: "Noop" }),
  });

const makeSourceRequiredStatusDefinition = (
  input: TestDefinitionInput & {
    readonly store: Layer.Layer<MigrationStore, MigrationStoreError>;
  }
) =>
  defineMigration({
    id: input.id,
    ...(input.dependencies === undefined
      ? {}
      : { dependencies: input.dependencies }),
    ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
    source: sourceRequiringService,
    destination,
    store: input.store,
    pipeline: () => ({ kind: "Noop" }),
  });

const makeRollbackSafetyFixture = () => {
  const authorsId = toMigrationDefinitionId("authors");
  const articlesId = toMigrationDefinitionId("articles");
  const storeState = InMemoryMigrationStore.makeState();
  const store = InMemoryMigrationStore.layer(storeState);
  const destination = InMemoryDestinationPlugin.makeEntries({
    contentType: "rollback-safety",
    commands: {
      upsertEntry: {
        fields: ArticleEntryFields,
      },
      publishEntry: true,
    },
  });
  const previousRunId = toMigrationRunId("run-previous");
  const previousDate = new Date("2026-01-01T00:00:00.000Z");
  const authorState = {
    definitionId: authorsId,
    destinationIdentity: toDestinationIdentity("entry-author-1"),
    lastRunId: previousRunId,
    sourceIdentity: toSourceIdentity("author-1"),
    sourceVersion: toSourceVersion("source-version-1"),
    status: "migrated" as const,
    updatedAt: previousDate,
  };
  const articleState = {
    definitionId: articlesId,
    destinationIdentity: toDestinationIdentity("entry-article-1"),
    lastRunId: previousRunId,
    sourceIdentity: toSourceIdentity("article-1"),
    sourceVersion: toSourceVersion("source-version-1"),
    status: "migrated" as const,
    updatedAt: previousDate,
  };

  for (const itemState of [authorState, articleState]) {
    storeState.itemStates.set(
      InMemoryMigrationStore.itemStateKey(
        itemState.definitionId,
        itemState.sourceIdentity
      ),
      itemState
    );
  }

  const authors = defineMigration({
    id: authorsId,
    source: InMemorySourcePlugin.make({
      sourceSchema: ArticleSource,
      items: [],
    }),
    destination,
    store,
    pipeline: () =>
      destination.commands.upsertEntry({
        title: "unused",
      }),
    rollback: () => destination.commands.publishEntry(),
  });
  const articles = defineMigration({
    id: articlesId,
    dependencies: {
      required: [authorsId],
    },
    source: InMemorySourcePlugin.make({
      sourceSchema: ArticleSource,
      items: [],
    }),
    destination,
    store,
    pipeline: () =>
      destination.commands.upsertEntry({
        title: "unused",
      }),
    rollback: () => destination.commands.publishEntry(),
  });
  const registry = MigrationDefinitionRegistry.make({
    definitions: [authors, articles] as const,
  });

  return {
    articleState,
    articlesId,
    authorState,
    authorsId,
    registry,
    storeState,
  };
};

describe("MigrationDefinitionRegistry", () => {
  it("keeps durable-only status source requirements out of the public type", () => {
    const definition = makeSourceRequiredStatusDefinition({
      id: "articles",
      store: InMemoryMigrationStore.layer(),
    });
    const registry = MigrationDefinitionRegistry.make({
      definitions: [definition] as const,
    });

    expectTypeOf(registry.status({ all: true })).toMatchTypeOf<
      Effect.Effect<
        MigrationDefinitionRegistryStatusReport,
        MigrationDefinitionRegistryStatusError,
        never
      >
    >();
    expectTypeOf(
      registry.status({ all: true, scanSource: true })
    ).toMatchTypeOf<
      Effect.Effect<
        MigrationDefinitionRegistryStatusReport,
        MigrationDefinitionRegistryStatusError,
        RequiredRegistryStatusSourceService
      >
    >();
  });

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

  it.effect(
    "plans a run by expanding required dependencies and recording participating optional edges",
    () =>
      Effect.gen(function* () {
        const authors = makeDefinition({ id: "authors" });
        const articles = makeDefinition({
          id: "articles",
          dependencies: {
            required: ["authors"],
            optional: ["tags"],
          },
        });
        const tags = makeDefinition({ id: "tags" });
        const registry = MigrationDefinitionRegistry.make({
          definitions: [tags, articles, authors] as const,
        });

        const plan = yield* registry.planRun({
          definitionIds: ["articles", "tags"],
          withDependencies: true,
        });

        expect(plan).toEqual({
          kind: "run",
          requestedDefinitionIds: [
            toMigrationDefinitionId("articles"),
            toMigrationDefinitionId("tags"),
          ],
          includedDefinitionIds: [
            toMigrationDefinitionId("tags"),
            toMigrationDefinitionId("articles"),
            toMigrationDefinitionId("authors"),
          ],
          executionDefinitionIds: [
            toMigrationDefinitionId("tags"),
            toMigrationDefinitionId("authors"),
            toMigrationDefinitionId("articles"),
          ],
          optionalDependencyEdges: [
            {
              fromDefinitionId: toMigrationDefinitionId("articles"),
              toDefinitionId: toMigrationDefinitionId("tags"),
              kind: "optional",
            },
          ],
          definitions: [tags, authors, articles],
          notices: [],
          withDependencies: true,
        });
      })
  );

  it.effect(
    "reports status for selected definitions with dependency expansion in registry order",
    () =>
      Effect.gen(function* () {
        const articlesId = toMigrationDefinitionId("articles");
        const authorsId = toMigrationDefinitionId("authors");
        const runId = toMigrationRunId("run-1");
        const updatedAt = new Date("2026-01-01T00:00:02.000Z");
        const articlesStoreState = InMemoryMigrationStore.makeState();
        const authorsStoreState = InMemoryMigrationStore.makeState();
        articlesStoreState.itemStates.set(
          InMemoryMigrationStore.itemStateKey(articlesId, "article-1"),
          {
            definitionId: articlesId,
            destinationIdentity: toDestinationIdentity("entry-article-1"),
            lastRunId: runId,
            sourceIdentity: toSourceIdentity("article-1"),
            sourceVersion: toSourceVersion("source-version-1"),
            status: "migrated",
            updatedAt,
          }
        );
        authorsStoreState.itemStates.set(
          InMemoryMigrationStore.itemStateKey(authorsId, "author-1"),
          {
            definitionId: authorsId,
            lastRunId: runId,
            skipReason: "No byline",
            sourceIdentity: toSourceIdentity("author-1"),
            sourceVersion: toSourceVersion("source-version-1"),
            status: "skipped",
            updatedAt,
          }
        );
        const articles = makeStatusDefinition({
          id: articlesId,
          dependencies: {
            required: [authorsId],
          },
          store: InMemoryMigrationStore.layer(articlesStoreState),
        });
        const authors = makeStatusDefinition({
          id: authorsId,
          store: InMemoryMigrationStore.layer(authorsStoreState),
        });
        const registry = MigrationDefinitionRegistry.make({
          definitions: [articles, authors] as const,
        });

        const report = yield* registry.status({
          definitionIds: ["articles"],
          withDependencies: true,
        });

        expect(report.requestedDefinitionIds).toEqual([articlesId]);
        expect(report.includedDefinitionIds).toEqual([articlesId, authorsId]);
        expect(report.notices).toEqual([]);
        expect(report.scanSource).toBe(false);
        expect(report.definitions.map((status) => status.definitionId)).toEqual(
          [articlesId, authorsId]
        );
        expect("executionDefinitionIds" in report).toBe(false);
        expect(report.definitions[0]?.durable).toEqual({
          failed: 0,
          migrated: 1,
          needsUpdate: 0,
          skipped: 0,
        });
        expect(report.definitions[1]?.durable).toEqual({
          failed: 0,
          migrated: 0,
          needsUpdate: 0,
          skipped: 1,
        });
      })
  );

  it.effect("records status notices from registry selection", () =>
    Effect.gen(function* () {
      const articles = makeStatusDefinition({
        id: "articles",
        dependencies: {
          optional: ["tags"],
        },
        store: InMemoryMigrationStore.layer(),
      });
      const tags = makeStatusDefinition({
        id: "tags",
        dependencies: {
          optional: ["articles"],
        },
        store: InMemoryMigrationStore.layer(),
      });
      const registry = MigrationDefinitionRegistry.make({
        definitions: [articles, tags] as const,
      });

      const report = yield* registry.status({
        definitionIds: ["articles", "articles", "tags"],
      });

      expect(report.includedDefinitionIds).toEqual([
        toMigrationDefinitionId("articles"),
        toMigrationDefinitionId("tags"),
      ]);
      expect(report.notices).toEqual([
        {
          _tag: "MigrationDefinitionDuplicateRequestedDefinitionIgnored",
          definitionId: toMigrationDefinitionId("articles"),
        },
        {
          _tag: "MigrationDefinitionOptionalDependencyCycleIgnored",
          definitionIds: [
            toMigrationDefinitionId("articles"),
            toMigrationDefinitionId("tags"),
            toMigrationDefinitionId("articles"),
          ],
          edges: [
            {
              fromDefinitionId: toMigrationDefinitionId("articles"),
              kind: "optional",
              toDefinitionId: toMigrationDefinitionId("tags"),
            },
            {
              fromDefinitionId: toMigrationDefinitionId("tags"),
              kind: "optional",
              toDefinitionId: toMigrationDefinitionId("articles"),
            },
          ],
        },
      ]);
    })
  );

  it.effect("requires an explicit status scope", () =>
    Effect.gen(function* () {
      const registry = MigrationDefinitionRegistry.make({
        definitions: [
          makeStatusDefinition({
            id: "articles",
            store: InMemoryMigrationStore.layer(),
          }),
        ],
      });

      const error = yield* Effect.flip(
        registry.status({} as Parameters<typeof registry.status>[0])
      );

      expect(error).toEqual(
        new MigrationDefinitionRegistryInvalidSelectionError({
          message:
            "Registry planning requires all: true or at least one Migration Definition id",
        })
      );
    })
  );

  it.effect(
    "rejects status selections with missing required dependencies",
    () =>
      Effect.gen(function* () {
        const authors = makeStatusDefinition({
          id: "authors",
          store: InMemoryMigrationStore.layer(),
        });
        const articles = makeStatusDefinition({
          id: "articles",
          dependencies: {
            required: ["authors"],
          },
          store: InMemoryMigrationStore.layer(),
        });
        const registry = MigrationDefinitionRegistry.make({
          definitions: [authors, articles] as const,
        });

        const error = yield* Effect.flip(
          registry.status({ definitionIds: ["articles"] })
        );

        expect(error).toEqual(
          new MigrationDefinitionRegistryMissingExplicitRequiredDependenciesError(
            {
              definitionId: toMigrationDefinitionId("articles"),
              message:
                "Migration Definition selection is missing required dependencies",
              missingDependencyIds: [toMigrationDefinitionId("authors")],
            }
          )
        );
      })
  );

  it.effect("reports status for all definitions in registry order", () =>
    Effect.gen(function* () {
      const articles = makeStatusDefinition({
        id: "articles",
        store: InMemoryMigrationStore.layer(),
      });
      const authors = makeStatusDefinition({
        id: "authors",
        store: InMemoryMigrationStore.layer(),
      });
      const registry = MigrationDefinitionRegistry.make({
        definitions: [articles, authors] as const,
      });

      const report = yield* registry.status({ all: true });

      expect(report.requestedDefinitionIds).toBe("all");
      expect(report.includedDefinitionIds).toEqual([
        toMigrationDefinitionId("articles"),
        toMigrationDefinitionId("authors"),
      ]);
      expect(report.definitions.map((status) => status.definitionId)).toEqual([
        toMigrationDefinitionId("articles"),
        toMigrationDefinitionId("authors"),
      ]);
    })
  );

  it.effect("rejects run planning without an explicit scope", () =>
    Effect.gen(function* () {
      const registry = MigrationDefinitionRegistry.make({
        definitions: [makeDefinition({ id: "articles" })],
      });

      const error = yield* Effect.flip(
        registry.planRun({} as Parameters<typeof registry.planRun>[0])
      );

      expect(error).toBeInstanceOf(
        MigrationDefinitionRegistryInvalidSelectionError
      );
      expect(error).toEqual(
        new MigrationDefinitionRegistryInvalidSelectionError({
          message:
            "Registry planning requires all: true or at least one Migration Definition id",
        })
      );
    })
  );

  it.effect("rejects planning with all scope and explicit definitions", () =>
    Effect.gen(function* () {
      const registry = MigrationDefinitionRegistry.make({
        definitions: [makeDefinition({ id: "articles" })],
      });

      const runError = yield* Effect.flip(
        registry.planRun({
          all: true,
          definitionIds: ["articles"],
        } as Parameters<typeof registry.planRun>[0])
      );
      expect(runError).toEqual(
        new MigrationDefinitionRegistryInvalidSelectionError({
          message:
            "Registry planning cannot combine all: true with Migration Definition ids",
        })
      );

      const rollbackError = yield* Effect.flip(
        registry.planRollback({
          all: true,
          definitionIds: ["articles"],
        } as Parameters<typeof registry.planRollback>[0])
      );
      expect(rollbackError).toEqual(
        new MigrationDefinitionRegistryInvalidSelectionError({
          message:
            "Registry planning cannot combine all: true with Migration Definition ids",
        })
      );
    })
  );

  it.effect(
    "keeps registry order and records a notice when optional dependencies cycle",
    () =>
      Effect.gen(function* () {
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
        const registry = MigrationDefinitionRegistry.make({
          definitions: [tags, categories] as const,
        });

        const plan = yield* registry.planRun({ all: true });

        expect(plan.executionDefinitionIds).toEqual([
          toMigrationDefinitionId("tags"),
          toMigrationDefinitionId("categories"),
        ]);
        expect(plan.optionalDependencyEdges).toEqual([
          {
            fromDefinitionId: toMigrationDefinitionId("tags"),
            toDefinitionId: toMigrationDefinitionId("categories"),
            kind: "optional",
          },
          {
            fromDefinitionId: toMigrationDefinitionId("categories"),
            toDefinitionId: toMigrationDefinitionId("tags"),
            kind: "optional",
          },
        ]);
        expect(plan.notices).toEqual([
          {
            _tag: "MigrationDefinitionOptionalDependencyCycleIgnored",
            definitionIds: [
              toMigrationDefinitionId("tags"),
              toMigrationDefinitionId("categories"),
              toMigrationDefinitionId("tags"),
            ],
            edges: [
              {
                fromDefinitionId: toMigrationDefinitionId("tags"),
                toDefinitionId: toMigrationDefinitionId("categories"),
                kind: "optional",
              },
              {
                fromDefinitionId: toMigrationDefinitionId("categories"),
                toDefinitionId: toMigrationDefinitionId("tags"),
                kind: "optional",
              },
            ],
          },
        ]);
      })
  );

  it.effect(
    "degrades all optional ordering when any optional dependency cycle is present",
    () =>
      Effect.gen(function* () {
        const articles = makeDefinition({
          id: "articles",
          dependencies: {
            optional: ["authors"],
          },
        });
        const authors = makeDefinition({ id: "authors" });
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
        const registry = MigrationDefinitionRegistry.make({
          definitions: [articles, authors, tags, categories] as const,
        });

        const plan = yield* registry.planRun({ all: true });

        expect(plan.executionDefinitionIds).toEqual([
          toMigrationDefinitionId("articles"),
          toMigrationDefinitionId("authors"),
          toMigrationDefinitionId("tags"),
          toMigrationDefinitionId("categories"),
        ]);
        expect(plan.optionalDependencyEdges).toEqual([
          {
            fromDefinitionId: toMigrationDefinitionId("articles"),
            toDefinitionId: toMigrationDefinitionId("authors"),
            kind: "optional",
          },
          {
            fromDefinitionId: toMigrationDefinitionId("tags"),
            toDefinitionId: toMigrationDefinitionId("categories"),
            kind: "optional",
          },
          {
            fromDefinitionId: toMigrationDefinitionId("categories"),
            toDefinitionId: toMigrationDefinitionId("tags"),
            kind: "optional",
          },
        ]);
        expect(plan.notices).toEqual([
          {
            _tag: "MigrationDefinitionOptionalDependencyCycleIgnored",
            definitionIds: [
              toMigrationDefinitionId("tags"),
              toMigrationDefinitionId("categories"),
              toMigrationDefinitionId("tags"),
            ],
            edges: [
              {
                fromDefinitionId: toMigrationDefinitionId("articles"),
                toDefinitionId: toMigrationDefinitionId("authors"),
                kind: "optional",
              },
              {
                fromDefinitionId: toMigrationDefinitionId("tags"),
                toDefinitionId: toMigrationDefinitionId("categories"),
                kind: "optional",
              },
              {
                fromDefinitionId: toMigrationDefinitionId("categories"),
                toDefinitionId: toMigrationDefinitionId("tags"),
                kind: "optional",
              },
            ],
          },
        ]);
      })
  );

  it.effect("plans targeted rollback for one explicit definition", () =>
    Effect.gen(function* () {
      const articles = makeDefinition({
        id: "articles",
      });
      const registry = MigrationDefinitionRegistry.make({
        definitions: [articles] as const,
      });

      const plan = yield* registry.planRollback({
        definitionIds: ["articles"],
        sourceIdentities: ["article-1", "article-2"],
      });

      expect(plan).toEqual({
        kind: "rollback",
        requestedDefinitionIds: [toMigrationDefinitionId("articles")],
        includedDefinitionIds: [toMigrationDefinitionId("articles")],
        executionDefinitionIds: [toMigrationDefinitionId("articles")],
        optionalDependencyEdges: [],
        definitions: [articles],
        target: {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentities: [
            toSourceIdentity("article-1"),
            toSourceIdentity("article-2"),
          ],
        },
        notices: [],
        withDependencies: false,
      });
    })
  );

  it.effect(
    "rejects unknown and missing required dependencies while planning",
    () =>
      Effect.gen(function* () {
        const authors = makeDefinition({ id: "authors" });
        const articles = makeDefinition({
          id: "articles",
          dependencies: {
            required: ["authors"],
          },
        });
        const registry = MigrationDefinitionRegistry.make({
          definitions: [authors, articles] as const,
        });

        const unknownError = yield* Effect.flip(
          registry.planRun({ definitionIds: ["missing"] })
        );
        expect(unknownError).toEqual(
          new MigrationDefinitionRegistryUnknownDefinitionError({
            definitionId: toMigrationDefinitionId("missing"),
            message: "Migration Definition was not found in the registry",
          })
        );

        const dependencyError = yield* Effect.flip(
          registry.planRun({ definitionIds: ["articles"] })
        );
        expect(dependencyError).toEqual(
          new MigrationDefinitionRegistryMissingExplicitRequiredDependenciesError(
            {
              definitionId: toMigrationDefinitionId("articles"),
              missingDependencyIds: [toMigrationDefinitionId("authors")],
              message:
                "Migration Definition selection is missing required dependencies",
            }
          )
        );
      })
  );

  it.effect(
    "preserves duplicate requested ids and deduplicates execution",
    () =>
      Effect.gen(function* () {
        const articles = makeDefinition({ id: "articles" });
        const registry = MigrationDefinitionRegistry.make({
          definitions: [articles] as const,
        });

        const plan = yield* registry.planRun({
          definitionIds: ["articles", "articles"],
        });

        expect(plan.requestedDefinitionIds).toEqual([
          toMigrationDefinitionId("articles"),
          toMigrationDefinitionId("articles"),
        ]);
        expect(plan.includedDefinitionIds).toEqual([
          toMigrationDefinitionId("articles"),
        ]);
        expect(plan.executionDefinitionIds).toEqual([
          toMigrationDefinitionId("articles"),
        ]);
        expect(plan.notices).toEqual([
          {
            _tag: "MigrationDefinitionDuplicateRequestedDefinitionIgnored",
            definitionId: toMigrationDefinitionId("articles"),
          },
        ]);
      })
  );

  it.effect(
    "plans forward item mode for one explicit definition and deduplicates target ids",
    () =>
      Effect.gen(function* () {
        const articles = makeDefinition({ id: "articles" });
        const registry = MigrationDefinitionRegistry.make({
          definitions: [articles] as const,
        });

        const plan = yield* registry.planRun({
          definitionIds: ["articles"],
          sourceIdentities: ["article-1", "article-1"],
        });

        expect(plan.target).toEqual({
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentities: [toSourceIdentity("article-1")],
        });
        expect(plan.notices).toEqual([
          {
            _tag: "MigrationDefinitionDuplicateTargetIdIgnored",
            sourceIdentity: toSourceIdentity("article-1"),
          },
        ]);
        expect(plan.executionDefinitionIds).toEqual([
          toMigrationDefinitionId("articles"),
        ]);
      })
  );

  it.effect("rejects invalid source identity targeting combinations", () =>
    Effect.gen(function* () {
      const articles = makeDefinition({ id: "articles" });
      const authors = makeDefinition({ id: "authors" });
      const dependentArticles = makeDefinition({
        id: "dependent-articles",
        dependencies: {
          required: ["authors"],
        },
      });
      const registry = MigrationDefinitionRegistry.make({
        definitions: [authors, articles] as const,
      });
      const dependencyRegistry = MigrationDefinitionRegistry.make({
        definitions: [authors, dependentArticles] as const,
      });

      const multipleRunTargetsError = yield* Effect.flip(
        registry.planRun({
          definitionIds: ["articles"],
          sourceIdentities: ["article-1", "article-2"],
        })
      );
      expect(multipleRunTargetsError).toEqual(
        new MigrationDefinitionRegistryInvalidSelectionError({
          message:
            "Run source identity targeting requires exactly one source identity",
        })
      );

      const explicitItemModeError = yield* Effect.flip(
        registry.planRun({
          all: true,
          mode: {
            kind: "item",
            sourceIdentity: "article-1",
          },
        } as unknown as Parameters<typeof registry.planRun>[0])
      );
      expect(explicitItemModeError).toEqual(
        new MigrationDefinitionRegistryInvalidSelectionError({
          message:
            "Registry run item mode must be requested with sourceIdentities",
        })
      );

      const rollbackAllTargetError = yield* Effect.flip(
        registry.planRollback({
          all: true,
          sourceIdentities: ["article-1"],
        })
      );
      expect(rollbackAllTargetError).toEqual(
        new MigrationDefinitionRegistryInvalidSelectionError({
          message:
            "Rollback source identity targeting requires exactly one explicit Migration Definition id",
        })
      );

      const rollbackMultipleDefinitionTargetError = yield* Effect.flip(
        registry.planRollback({
          definitionIds: ["authors", "articles"],
          sourceIdentities: ["article-1"],
        })
      );
      expect(rollbackMultipleDefinitionTargetError).toEqual(
        new MigrationDefinitionRegistryInvalidSelectionError({
          message:
            "Rollback source identity targeting requires exactly one explicit Migration Definition id",
        })
      );

      const rollbackExpandedTargetError = yield* Effect.flip(
        registry.planRollback({
          definitionIds: ["articles"],
          sourceIdentities: ["article-1"],
          withDependencies: true,
        })
      );
      expect(rollbackExpandedTargetError).toEqual(
        new MigrationDefinitionRegistryInvalidSelectionError({
          message:
            "Rollback source identity targeting cannot expand required dependencies",
        })
      );

      const runExpandedTargetError = yield* Effect.flip(
        dependencyRegistry.run({
          definitionIds: ["dependent-articles"],
          sourceIdentities: ["article-1"],
          withDependencies: true,
        })
      );
      expect(runExpandedTargetError).toEqual(
        new MigrationDefinitionRegistryInvalidSelectionError({
          message:
            "Run source identity targeting cannot expand required dependencies",
        })
      );

      const runTargetMissingDependencyError = yield* Effect.flip(
        dependencyRegistry.run({
          definitionIds: ["dependent-articles"],
          sourceIdentities: ["article-1"],
        })
      );
      expect(runTargetMissingDependencyError).toEqual(
        new MigrationDefinitionRegistryMissingExplicitRequiredDependenciesError(
          {
            definitionId: toMigrationDefinitionId("dependent-articles"),
            message:
              "Migration Definition selection is missing required dependencies",
            missingDependencyIds: [toMigrationDefinitionId("authors")],
          }
        )
      );

      const rollbackExpandedTargetRunnerError = yield* Effect.flip(
        dependencyRegistry.rollback({
          definitionIds: ["dependent-articles"],
          sourceIdentities: ["article-1"],
          withDependencies: true,
        })
      );
      expect(rollbackExpandedTargetRunnerError).toEqual(
        new MigrationDefinitionRegistryInvalidSelectionError({
          message:
            "Rollback source identity targeting cannot expand required dependencies",
        })
      );
    })
  );

  it.effect("runs a valid registry plan through the existing runtime", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const destination = InMemoryDestinationPlugin.makeEntries({
        contentType: "article",
        commands: {
          upsertEntry: {
            fields: ArticleEntryFields,
          },
        },
      });
      const articles = defineMigration({
        id: "articles",
        source: InMemorySourcePlugin.make({
          sourceSchema: ArticleSource,
          items: [
            {
              identity: "article-1",
              version: "source-version-1",
              item: {
                title: "Registry run",
              },
            },
          ],
        }),
        destination,
        store: InMemoryMigrationStore.layer(storeState),
        pipeline: (sourceItem) =>
          destination.commands.upsertEntry({
            title: sourceItem.item.title,
          }),
      });
      const registry = MigrationDefinitionRegistry.make({
        definitions: [articles] as const,
      });

      const summary = yield* registry.run({ definitionIds: ["articles"] });

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions).toEqual([
        {
          definitionId: toMigrationDefinitionId("articles"),
          status: "succeeded",
          counts: {
            migrated: 1,
            skipped: 0,
            failed: 0,
            unchanged: 0,
            needsUpdate: 0,
          },
        },
      ]);
    })
  );

  it.effect(
    "rolls back a valid registry plan through the existing runtime",
    () =>
      Effect.gen(function* () {
        const definitionId = toMigrationDefinitionId("articles");
        const sourceIdentity = toSourceIdentity("article-1");
        const storeState = InMemoryMigrationStore.makeState();
        const itemStateKey = InMemoryMigrationStore.itemStateKey(
          definitionId,
          sourceIdentity
        );
        const destination = InMemoryDestinationPlugin.makeEntries({
          contentType: "article",
          commands: {
            upsertEntry: {
              fields: ArticleEntryFields,
            },
            publishEntry: true,
          },
        });
        const articles = defineMigration({
          id: definitionId,
          source: InMemorySourcePlugin.make({
            sourceSchema: ArticleSource,
            items: [
              {
                identity: sourceIdentity,
                version: "source-version-1",
                item: {
                  title: "Registry rollback",
                },
              },
            ],
          }),
          destination,
          store: InMemoryMigrationStore.layer(storeState),
          pipeline: (sourceItem) =>
            destination.commands.upsertEntry({
              title: sourceItem.item.title,
            }),
          rollback: () => destination.commands.publishEntry(),
        });
        const registry = MigrationDefinitionRegistry.make({
          definitions: [articles] as const,
        });

        yield* registry.run({ definitionIds: ["articles"] });
        expect(storeState.itemStates.has(itemStateKey)).toBe(true);

        const summary = yield* registry.rollback({
          definitionIds: ["articles"],
        });

        expect(summary.kind).toBe("rollback");
        expect(summary.status).toBe("succeeded");
        expect(summary.definitions).toEqual([
          {
            definitionId,
            status: "succeeded",
            counts: {
              rolledBack: 1,
              failed: 0,
              skipped: 0,
            },
          },
        ]);
        expect(storeState.itemStates.has(itemStateKey)).toBe(false);
      })
  );

  it.effect(
    "preserves dependent rollback safety when rolling back a selected definition",
    () =>
      Effect.gen(function* () {
        const { articleState, authorState, authorsId, registry, storeState } =
          makeRollbackSafetyFixture();

        const error = yield* Effect.flip(
          registry.rollback({
            definitionIds: [authorsId],
          })
        );

        expect(error).toBeInstanceOf(RollbackPreflightError);
        expect(error).toEqual(
          expect.objectContaining({
            message:
              "Rollback would leave dependent Migration Definition state rollbackable",
          })
        );
        expect(storeState.latestRunStates.size).toBe(0);
        expect(storeState.definitionLocks.size).toBe(0);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey(
              authorState.definitionId,
              authorState.sourceIdentity
            )
          )
        ).toEqual(authorState);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey(
              articleState.definitionId,
              articleState.sourceIdentity
            )
          )
        ).toEqual(articleState);
      })
  );

  it.effect(
    "preserves dependent rollback safety when rolling back targeted source identities",
    () =>
      Effect.gen(function* () {
        const { articleState, authorState, authorsId, registry, storeState } =
          makeRollbackSafetyFixture();

        const error = yield* Effect.flip(
          registry.rollback({
            definitionIds: [authorsId],
            sourceIdentities: [authorState.sourceIdentity],
          })
        );

        expect(error).toBeInstanceOf(RollbackPreflightError);
        expect(error).toEqual(
          expect.objectContaining({
            message:
              "Rollback would leave dependent Migration Definition state rollbackable",
          })
        );
        expect(storeState.latestRunStates.size).toBe(0);
        expect(storeState.definitionLocks.size).toBe(0);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey(
              authorState.definitionId,
              authorState.sourceIdentity
            )
          )
        ).toEqual(authorState);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey(
              articleState.definitionId,
              articleState.sourceIdentity
            )
          )
        ).toEqual(articleState);
      })
  );

  it.effect(
    "rolls back registry plans in planned optional dependency order",
    () =>
      Effect.gen(function* () {
        const authorsId = toMigrationDefinitionId("authors");
        const articlesId = toMigrationDefinitionId("articles");
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const destination = InMemoryDestinationPlugin.makeEntries({
          contentType: "rollback-order",
          commands: {
            upsertEntry: {
              fields: ArticleEntryFields,
            },
          },
        });
        const previousRunId = toMigrationRunId("run-previous");
        const previousDate = new Date("2026-01-01T00:00:00.000Z");
        const authorState = {
          definitionId: authorsId,
          destinationIdentity: toDestinationIdentity("entry-author-1"),
          lastRunId: previousRunId,
          sourceIdentity: toSourceIdentity("author-1"),
          sourceVersion: toSourceVersion("source-version-1"),
          status: "migrated" as const,
          updatedAt: previousDate,
        };
        const articleState = {
          definitionId: articlesId,
          destinationIdentity: toDestinationIdentity("entry-article-1"),
          lastRunId: previousRunId,
          sourceIdentity: toSourceIdentity("article-1"),
          sourceVersion: toSourceVersion("source-version-1"),
          status: "migrated" as const,
          updatedAt: previousDate,
        };

        for (const itemState of [authorState, articleState]) {
          storeState.itemStates.set(
            InMemoryMigrationStore.itemStateKey(
              itemState.definitionId,
              itemState.sourceIdentity
            ),
            itemState
          );
        }

        const authors = defineMigration({
          id: authorsId,
          source: InMemorySourcePlugin.make({
            sourceSchema: ArticleSource,
            items: [],
          }),
          destination,
          store,
          pipeline: () =>
            destination.commands.upsertEntry({
              title: "unused",
            }),
          rollback: () =>
            destination.commands.upsertEntry({
              title: "author rollback",
            }),
        });
        const articles = defineMigration({
          id: articlesId,
          dependencies: {
            optional: [authorsId],
          },
          source: InMemorySourcePlugin.make({
            sourceSchema: ArticleSource,
            items: [],
          }),
          destination,
          store,
          pipeline: () =>
            destination.commands.upsertEntry({
              title: "unused",
            }),
          rollback: () =>
            destination.commands.upsertEntry({
              title: "article rollback",
            }),
        });
        const registry = MigrationDefinitionRegistry.make({
          definitions: [authors, articles] as const,
        });

        const summary = yield* registry.rollback({
          all: true,
        });

        expect(
          summary.definitions.map((definition) => definition.definitionId)
        ).toEqual([articlesId, authorsId]);
      })
  );
});
