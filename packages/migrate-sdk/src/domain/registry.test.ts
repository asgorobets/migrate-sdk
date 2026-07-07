import { describe, expect, it } from "@effect/vitest";
import { Effect, type Layer, Option, Schema } from "effect";
import {
  defaultSourceVersionContractFingerprint,
  type ExecutionStartResult,
  MigrationDefinition,
  type MigrationDefinitionDependenciesInput,
  type MigrationDefinitionExecutableRollbackPlan,
  type MigrationDefinitionExecutableRunPlan,
  type MigrationDefinitionIdInput,
  MigrationDefinitionRegistry,
  MigrationDefinitionRegistryConstructionError,
  MigrationDefinitionRegistryExecutableError,
  MigrationDefinitionRegistryInvalidSelectionError,
  MigrationDefinitionRegistryLookupError,
  MigrationDefinitionRegistryMissingExplicitRequiredDependenciesError,
  MigrationDefinitionRegistryUnknownDefinitionError,
  MigrationExecutable,
  MigrationExecution,
  type MigrationExecutionOptions,
  type MigrationRunSummary,
  type MigrationStore,
  type MigrationStoreError,
  type RollbackPipeline,
  RollbackPreflightError,
  type RollbackRunSummary,
  SourceIdentity,
  toEncodedSourceCursor,
  toEncodedSourceIdentity,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceVersion,
} from "migrate-sdk";
import {
  InMemorySource,
} from "migrate-sdk/sources/in-memory";
import {
  InMemoryMigrationStore,
} from "migrate-sdk/stores/in-memory";
import { expectTypeOf } from "vitest";

const ArticleSource = Schema.Struct({
  title: Schema.String,
});

const ArticleSourceIdentity = SourceIdentity.make({
  id: "registry-article@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});

interface TestDefinitionInput {
  readonly dependencies?: MigrationDefinitionDependenciesInput;
  readonly execution?: MigrationExecutionOptions;
  readonly id: MigrationDefinitionIdInput;
  readonly rollback?: RollbackPipeline;
}

const source = InMemorySource.make({
  identity: ArticleSourceIdentity,
  sourceSchema: ArticleSource,
  items: [],
});
const store = {} as Layer.Layer<MigrationStore, MigrationStoreError>;

const seedMigrationContract = (
  storeState: ReturnType<typeof InMemoryMigrationStore.makeState>,
  definitionId: MigrationDefinitionIdInput
) => {
  storeState.migrationContracts.set(toMigrationDefinitionId(definitionId), {
    definitionId: toMigrationDefinitionId(definitionId),
    sourceIdentityContractFingerprint: ArticleSourceIdentity.fingerprint,
    sourceVersionContractFingerprint: defaultSourceVersionContractFingerprint,
  });
};

const makeDefinition = (input: TestDefinitionInput) =>
  MigrationDefinition.make({
    id: input.id,
    ...(input.dependencies === undefined
      ? {}
      : { dependencies: input.dependencies }),
    ...(input.execution === undefined ? {} : { execution: input.execution }),
    source,
    store,
    process: () => Effect.void,
    ...(input.rollback === undefined ? {} : { rollback: input.rollback }),
  });

const makeStatusDefinition = (
  input: TestDefinitionInput & {
    readonly store: Layer.Layer<MigrationStore, MigrationStoreError>;
  }
) =>
  MigrationDefinition.make({
    id: input.id,
    ...(input.dependencies === undefined
      ? {}
      : { dependencies: input.dependencies }),
    source,
    store: input.store,
    process: () => Effect.void,
  });

const makeRollbackSafetyFixture = () => {
  const authorsId = toMigrationDefinitionId("authors");
  const articlesId = toMigrationDefinitionId("articles");
  const storeState = InMemoryMigrationStore.makeState();
  const store = InMemoryMigrationStore.layer(storeState);
  const previousRunId = toMigrationRunId("run-previous");
  const previousDate = new Date("2026-01-01T00:00:00.000Z");
  const authorState = {
    definitionId: authorsId,
    lastRunId: previousRunId,
    sourceIdentity: SourceIdentity.fromKey(ArticleSourceIdentity, "author-1"),
    sourceVersion: toSourceVersion("source-version-1"),
    status: "migrated" as const,
    updatedAt: previousDate,
  };
  const articleState = {
    definitionId: articlesId,
    lastRunId: previousRunId,
    sourceIdentity: SourceIdentity.fromKey(ArticleSourceIdentity, "article-1"),
    sourceVersion: toSourceVersion("source-version-1"),
    status: "migrated" as const,
    updatedAt: previousDate,
  };

  for (const itemState of [authorState, articleState]) {
    storeState.itemStates.set(
      InMemoryMigrationStore.itemStateKey(
        itemState.definitionId,
        itemState.sourceIdentity.encoded
      ),
      itemState
    );
  }

  const authors = MigrationDefinition.make({
    id: authorsId,
    source: InMemorySource.make({
      identity: ArticleSourceIdentity,
      sourceSchema: ArticleSource,
      items: [],
    }),
    store,
    process: () => Effect.void,
    rollback: () => undefined,
  });
  const articles = MigrationDefinition.make({
    id: articlesId,
    dependencies: {
      required: [authorsId],
    },
    source: InMemorySource.make({
      identity: ArticleSourceIdentity,
      sourceSchema: ArticleSource,
      items: [],
    }),
    store,
    process: () => Effect.void,
    rollback: () => undefined,
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
      dependencies: {
        required: ["authors"],
        optional: ["asset-cleanup"],
      },
      rollback: () => Effect.void,
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
          executionPolicy: [
            {
              definitionId: toMigrationDefinitionId("tags"),
              processConcurrency: 1,
              rollbackConcurrency: 1,
            },
            {
              definitionId: toMigrationDefinitionId("authors"),
              processConcurrency: 1,
              rollbackConcurrency: 1,
            },
            {
              definitionId: toMigrationDefinitionId("articles"),
              processConcurrency: 1,
              rollbackConcurrency: 1,
            },
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
    "expands rollback dependencies through required dependents",
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

        const leafPlan = yield* registry.planRollback({
          definitionIds: ["articles"],
          withDependencies: true,
        });
        const parentPlan = yield* registry.planRollback({
          definitionIds: ["authors"],
          withDependencies: true,
        });

        expect(leafPlan.includedDefinitionIds).toEqual([
          toMigrationDefinitionId("articles"),
        ]);
        expect(leafPlan.executionDefinitionIds).toEqual([
          toMigrationDefinitionId("articles"),
        ]);
        expect(parentPlan.includedDefinitionIds).toEqual([
          toMigrationDefinitionId("articles"),
          toMigrationDefinitionId("authors"),
        ]);
        expect(parentPlan.executionDefinitionIds).toEqual([
          toMigrationDefinitionId("articles"),
          toMigrationDefinitionId("authors"),
        ]);
        expect(parentPlan.definitions).toEqual([articles, authors]);
      })
  );

  it.effect("preserves update intent in run plans", () =>
    Effect.gen(function* () {
      const articles = makeDefinition({ id: "articles" });
      const registry = MigrationDefinitionRegistry.make({
        definitions: [articles] as const,
      });

      const plan = yield* registry.planRun({
        definitionIds: ["articles"],
        update: true,
      });

      expect(plan.update).toBe(true);
      expect(plan.executionDefinitionIds).toEqual([
        toMigrationDefinitionId("articles"),
      ]);
    })
  );

  it.effect(
    "plans effective execution policy from request overrides and definition defaults",
    () =>
      Effect.gen(function* () {
        const articles = makeDefinition({
          id: "articles",
          execution: {
            process: { concurrency: 2 },
            rollback: { concurrency: 3 },
          },
        });
        const registry = MigrationDefinitionRegistry.make({
          definitions: [articles] as const,
        });

        const runPlan = yield* registry.planRun({
          definitionIds: ["articles"],
          execution: {
            process: { concurrency: "unbounded" },
          },
        });
        const rollbackPlan = yield* registry.planRollback({
          definitionIds: ["articles"],
          execution: {
            rollback: { concurrency: 5 },
          },
        });

        expect(runPlan.executionPolicy).toEqual([
          {
            definitionId: toMigrationDefinitionId("articles"),
            processConcurrency: "unbounded",
            rollbackConcurrency: 3,
          },
        ]);
        expect(rollbackPlan.executionPolicy).toEqual([
          {
            definitionId: toMigrationDefinitionId("articles"),
            processConcurrency: 2,
            rollbackConcurrency: 5,
          },
        ]);
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
            lastRunId: runId,
            sourceIdentity: SourceIdentity.fromKey(
              ArticleSourceIdentity,
              "article-1"
            ),
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
            sourceIdentity: SourceIdentity.fromKey(
              ArticleSourceIdentity,
              "author-1"
            ),
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
        executionPolicy: [
          {
            definitionId: toMigrationDefinitionId("articles"),
            processConcurrency: 1,
            rollbackConcurrency: 1,
          },
        ],
        optionalDependencyEdges: [],
        definitions: [articles],
        target: {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentities: [
            toEncodedSourceIdentity("article-1"),
            toEncodedSourceIdentity("article-2"),
          ],
        },
        notices: [],
        withDependencies: false,
      });
    })
  );

  it.effect(
    "rejects unknown definitions and records omitted required dependency preflight while planning runs",
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

        const dependencyPlan = yield* registry.planRun({
          definitionIds: ["articles"],
        });
        expect(dependencyPlan.includedDefinitionIds).toEqual([
          toMigrationDefinitionId("articles"),
        ]);
        expect(dependencyPlan.executionDefinitionIds).toEqual([
          toMigrationDefinitionId("articles"),
        ]);
        expect(dependencyPlan.requiredDependencyPreflight).toEqual([
          {
            fromDefinitionId: toMigrationDefinitionId("articles"),
            toDefinitionId: toMigrationDefinitionId("authors"),
          },
        ]);

        const statusDependencyError = yield* Effect.flip(
          registry.status({ definitionIds: ["articles"] })
        );
        expect(statusDependencyError).toEqual(
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
    "plans forward item mode for one explicit definition and deduplicates source identity targets",
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
          sourceIdentities: [toEncodedSourceIdentity("article-1")],
        });
        expect(plan.notices).toEqual([
          {
            _tag: "MigrationDefinitionDuplicateSourceIdentityTargetIgnored",
            sourceIdentity: toEncodedSourceIdentity("article-1"),
          },
        ]);
        expect(plan.executionDefinitionIds).toEqual([
          toMigrationDefinitionId("articles"),
        ]);
      })
  );

  it.effect(
    "parses targeted source identities through the selected definition identity schema",
    () =>
      Effect.gen(function* () {
        const businessAddressIdentity = SourceIdentity.make({
          id: "business-address@v1",
          schema: SourceIdentity.tuple([
            SourceIdentity.part("businessUnitKey", Schema.NonEmptyString),
            SourceIdentity.part("addressIndex", Schema.Number),
          ]),
        });
        const businessAddressSource = InMemorySource.make({
          sourceSchema: ArticleSource,
          identity: businessAddressIdentity,
          items: [],
        });
        const businessAddresses = MigrationDefinition.make({
          id: "business-addresses",
          source: businessAddressSource,
          store,
          process: () => Effect.void,
        });
        const registry = MigrationDefinitionRegistry.make({
          definitions: [businessAddresses] as const,
        });

        const plan = yield* registry.planRun({
          definitionIds: ["business-addresses"],
          sourceIdentities: ["bu%3Awest:2"],
        });

        expect(plan.target).toEqual({
          definitionId: toMigrationDefinitionId("business-addresses"),
          sourceIdentities: [
            toEncodedSourceIdentity(JSON.stringify(["bu:west", 2])),
          ],
        });
      })
  );

  it.effect(
    "rejects targeted source identities that do not match the selected schema",
    () =>
      Effect.gen(function* () {
        const businessAddressIdentity = SourceIdentity.make({
          id: "business-address@v1",
          schema: SourceIdentity.tuple([
            SourceIdentity.part("businessUnitKey", Schema.NonEmptyString),
            SourceIdentity.part("addressIndex", Schema.Number),
          ]),
        });
        const businessAddressSource = InMemorySource.make({
          sourceSchema: ArticleSource,
          identity: businessAddressIdentity,
          items: [],
        });
        const businessAddresses = MigrationDefinition.make({
          id: "business-addresses",
          source: businessAddressSource,
          store,
          process: () => Effect.void,
        });
        const registry = MigrationDefinitionRegistry.make({
          definitions: [businessAddresses] as const,
        });

        const error = yield* Effect.flip(
          registry.planRun({
            definitionIds: ["business-addresses"],
            sourceIdentities: ["bu-1"],
          })
        );

        expect(error).toEqual(
          new MigrationDefinitionRegistryInvalidSelectionError({
            message:
              "Source identity target is invalid for Migration Definition business-addresses: bu-1",
          })
        );
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
            sourceIdentityKey: "article-1",
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
            "Rollback source identity targeting cannot expand dependencies",
        })
      );

      const runExpandedTargetError = yield* Effect.flip(
        MigrationExecution.make({ registry: dependencyRegistry }).run({
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

      const runTargetMissingDependencyPlan = yield* dependencyRegistry.planRun({
        definitionIds: ["dependent-articles"],
        sourceIdentities: ["article-1"],
      });
      expect(
        runTargetMissingDependencyPlan.requiredDependencyPreflight
      ).toEqual([
        {
          fromDefinitionId: toMigrationDefinitionId("dependent-articles"),
          toDefinitionId: toMigrationDefinitionId("authors"),
        },
      ]);

      const rollbackExpandedTargetRunnerError = yield* Effect.flip(
        MigrationExecution.make({ registry: dependencyRegistry }).rollback({
          definitionIds: ["dependent-articles"],
          sourceIdentities: ["article-1"],
          withDependencies: true,
        })
      );
      expect(rollbackExpandedTargetRunnerError).toEqual(
        new MigrationDefinitionRegistryInvalidSelectionError({
          message:
            "Rollback source identity targeting cannot expand dependencies",
        })
      );
    })
  );

  it.effect("rejects unsupported update run planning combinations", () =>
    Effect.gen(function* () {
      const articles = makeDefinition({ id: "articles" });
      const registry = MigrationDefinitionRegistry.make({
        definitions: [articles] as const,
      });

      const failedError = yield* Effect.flip(
        registry.planRun({
          definitionIds: ["articles"],
          mode: { kind: "failed" },
          update: true,
        })
      );
      expect(failedError).toEqual(
        new MigrationDefinitionRegistryInvalidSelectionError({
          message: "Update run planning cannot combine with failed mode",
        })
      );

      const skippedError = yield* Effect.flip(
        registry.planRun({
          definitionIds: ["articles"],
          mode: { kind: "skipped" },
          update: true,
        })
      );
      expect(skippedError).toEqual(
        new MigrationDefinitionRegistryInvalidSelectionError({
          message: "Update run planning cannot combine with skipped mode",
        })
      );

      const targetError = yield* Effect.flip(
        registry.planRun({
          definitionIds: ["articles"],
          sourceIdentities: ["article-1"],
          update: true,
        })
      );
      expect(targetError).toEqual(
        new MigrationDefinitionRegistryInvalidSelectionError({
          message: "Update run planning cannot target source identities",
        })
      );
    })
  );

  it.effect("plans executable runs with a distinct executable plan type", () =>
    Effect.gen(function* () {
      const articles = makeDefinition({ id: "articles" });
      const registry = MigrationDefinitionRegistry.make({
        definitions: [articles] as const,
      });

      const ordinaryPlan = yield* registry.planRun({
        definitionIds: ["articles"],
      });
      const executablePlan = yield* registry.executable().planRun({
        definitionIds: ["articles"],
      });

      expect(executablePlan).toEqual(
        expect.objectContaining({
          kind: "run",
          definitions: [articles],
          executionDefinitionIds: [toMigrationDefinitionId("articles")],
        })
      );
      expectTypeOf(
        executablePlan
      ).toMatchTypeOf<MigrationDefinitionExecutableRunPlan>();
      expect(executablePlan.registryDefinitions).toEqual([articles]);
      expect(Object.keys(executablePlan)).not.toContain(
        "registryDefinitions"
      );
      // @ts-expect-error Ordinary registry plans are not accepted by startRun.
      const rejectedOrdinaryPlanStartInput: Parameters<
        typeof MigrationExecutable.startRun
      >[0] = ordinaryPlan;
      expect(rejectedOrdinaryPlanStartInput).toBeDefined();
    })
  );

  it.effect(
    "reports missing runtime requirements during executable planning",
    () =>
      Effect.gen(function* () {
        const articles = makeDefinition({ id: "articles" });
        const registry = MigrationDefinitionRegistry.make({
          definitions: [articles] as const,
          missingRequirements: (definition) =>
            definition.id === toMigrationDefinitionId("articles")
              ? [
                  {
                    key: "SqlClient",
                    label: "SQL client layer",
                    owner: "source" as const,
                  },
                ]
              : [],
        });

        const error = yield* Effect.flip(
          registry.executable().planRun({ definitionIds: ["articles"] })
        );

        expect(error).toEqual(
          new MigrationDefinitionRegistryExecutableError({
            definitionId: toMigrationDefinitionId("articles"),
            message: "Migration Definition is missing runtime requirements",
            missingRequirements: [
              {
                key: "SqlClient",
                label: "SQL client layer",
                owner: "source",
              },
            ],
          })
        );
      })
  );

  it.effect("starts executable run plans through the inline executable", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const articles = MigrationDefinition.make({
        id: "articles",
        source: InMemorySource.make({
          identity: ArticleSourceIdentity,
          sourceSchema: ArticleSource,
          items: [
            {
              identityKey: "article-1",
              version: "source-version-1",
              item: {
                title: "Executable registry run",
              },
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: () => Effect.void,
      });
      const registry = MigrationDefinitionRegistry.make({
        definitions: [articles] as const,
      });
      const plan = yield* registry.executable().planRun({
        definitionIds: ["articles"],
      });

      const result = yield* MigrationExecutable.startRun(plan).pipe(
        Effect.provide(MigrationExecutable.inlineDefault)
      );

      expectTypeOf(result).toMatchTypeOf<
        ExecutionStartResult<MigrationRunSummary>
      >();
      expect(result.kind).toBe("completed");

      if (result.kind === "completed") {
        expect(result.runId).toBe(result.summary.runId);
        expect(result.summary.status).toBe("succeeded");
        expect(result.summary.definitions).toEqual([
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
        expect(
          storeState.latestRunStates.get(toMigrationDefinitionId("articles"))
        ).toEqual(
          expect.objectContaining({
            runId: result.runId,
            status: "succeeded",
          })
        );
      }

      expect(storeState.definitionLocks.size).toBe(0);
    })
  );

  it.effect(
    "starts targeted executable run plans through the inline executable",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const articles = MigrationDefinition.make({
          id: "articles",
          source: InMemorySource.make({
            identity: ArticleSourceIdentity,
            sourceSchema: ArticleSource,
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: "Targeted executable run",
                },
              },
              {
                identityKey: "article-2",
                version: "source-version-1",
                item: {
                  title: "Ignored article",
                },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: () => Effect.void,
        });
        const registry = MigrationDefinitionRegistry.make({
          definitions: [articles] as const,
        });
        const plan = yield* registry.executable().planRun({
          definitionIds: ["articles"],
          sourceIdentities: ["article-1"],
        });

        const result = yield* MigrationExecutable.startRun(plan).pipe(
          Effect.provide(MigrationExecutable.inlineDefault)
        );

        expect(result.kind).toBe("completed");

        if (result.kind === "completed") {
          expect(result.summary.definitions[0]?.counts).toEqual({
            migrated: 1,
            skipped: 0,
            failed: 0,
            unchanged: 0,
            needsUpdate: 0,
          });
          expect(
            storeState.itemStates.has(
              InMemoryMigrationStore.itemStateKey("articles", "article-1")
            )
          ).toBe(true);
          expect(
            storeState.itemStates.has(
              InMemoryMigrationStore.itemStateKey("articles", "article-2")
            )
          ).toBe(false);
        }

        expect(storeState.definitionLocks.size).toBe(0);
      })
  );

  it.effect(
    "plans executable rollbacks with a distinct executable plan type",
    () =>
      Effect.gen(function* () {
        const articles = makeDefinition({
          id: "articles",
          rollback: () => Effect.void,
        });
        const registry = MigrationDefinitionRegistry.make({
          definitions: [articles] as const,
        });

        const ordinaryPlan = yield* registry.planRollback({
          definitionIds: ["articles"],
        });
        const executablePlan = yield* registry.executable().planRollback({
          definitionIds: ["articles"],
        });

        expect(executablePlan).toEqual(
          expect.objectContaining({
            kind: "rollback",
            executionDefinitionIds: [toMigrationDefinitionId("articles")],
          })
        );
        expect(
          executablePlan.definitions.map((definition) => definition.definition)
        ).toEqual([articles]);
        expect(executablePlan.definitions[0]?.rollback).toEqual(
          expect.any(Function)
        );
        expectTypeOf(
          executablePlan
        ).toMatchTypeOf<MigrationDefinitionExecutableRollbackPlan>();
        expect(executablePlan.registryDefinitions).toEqual([articles]);
        expect(Object.keys(executablePlan)).not.toContain(
          "registryDefinitions"
        );
        // @ts-expect-error Ordinary registry rollback plans are not accepted by startRollback.
        const rejectedOrdinaryPlanStartInput: Parameters<
          typeof MigrationExecutable.startRollback
        >[0] = ordinaryPlan;
        expect(rejectedOrdinaryPlanStartInput).toBeDefined();
      })
  );

  it.effect(
    "starts executable rollback plans through the inline executable",
    () =>
      Effect.gen(function* () {
        const definitionId = toMigrationDefinitionId("articles");
        const sourceIdentity = toEncodedSourceIdentity("article-1");
        const storeState = InMemoryMigrationStore.makeState();
        const itemStateKey = InMemoryMigrationStore.itemStateKey(
          definitionId,
          sourceIdentity
        );
        const articles = MigrationDefinition.make({
          id: definitionId,
          source: InMemorySource.make({
            identity: ArticleSourceIdentity,
            sourceSchema: ArticleSource,
            items: [
              {
                identityKey: sourceIdentity,
                version: "source-version-1",
                item: {
                  title: "Executable rollback",
                },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: () => Effect.void,
          rollback: () => undefined,
        });
        const registry = MigrationDefinitionRegistry.make({
          definitions: [articles] as const,
        });

        const seedRun = yield* MigrationExecution.make({ registry }).run({
          definitionIds: ["articles"],
        });
        expect(seedRun.kind).toBe("completed");
        expect(storeState.itemStates.has(itemStateKey)).toBe(true);

        const plan = yield* registry.executable().planRollback({
          definitionIds: ["articles"],
        });
        const result = yield* MigrationExecutable.startRollback(plan).pipe(
          Effect.provide(MigrationExecutable.inlineDefault)
        );

        expectTypeOf(result).toMatchTypeOf<
          ExecutionStartResult<RollbackRunSummary>
        >();
        expect(result.kind).toBe("completed");

        if (result.kind === "completed") {
          expect(result.runId).toBe(result.summary.runId);
          expect(result.summary.kind).toBe("rollback");
          expect(result.summary.status).toBe("succeeded");
          expect(result.summary.definitions).toEqual([
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
          expect(
            storeState.latestRunStates.get(toMigrationDefinitionId("articles"))
          ).toEqual(
            expect.objectContaining({
              runId: result.runId,
              status: "succeeded",
            })
          );
        }

        expect(storeState.itemStates.has(itemStateKey)).toBe(false);
        expect(storeState.definitionLocks.size).toBe(0);
      })
  );

  it.effect(
    "preserves rollback preflight through executable rollback plans",
    () =>
      Effect.gen(function* () {
        const { articleState, authorState, authorsId, registry, storeState } =
          makeRollbackSafetyFixture();

        const plan = yield* registry.executable().planRollback({
          definitionIds: [authorsId],
        });
        const error = yield* Effect.flip(
          MigrationExecutable.startRollback(plan).pipe(
            Effect.provide(MigrationExecutable.inlineDefault)
          )
        );

        expect(error).toBeInstanceOf(RollbackPreflightError);
        expect(error).toEqual(
          expect.objectContaining({
            message: expect.stringContaining(
              "Rollback would leave dependent Migration Definition item state"
            ),
          })
        );
        expect(storeState.latestRunStates.size).toBe(0);
        expect(storeState.definitionLocks.size).toBe(0);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey(
              authorState.definitionId,
              authorState.sourceIdentity.encoded
            )
          )
        ).toEqual(authorState);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey(
              articleState.definitionId,
              articleState.sourceIdentity.encoded
            )
          )
        ).toEqual(articleState);
      })
  );

  it.effect("runs a valid registry plan through the existing runtime", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const articles = MigrationDefinition.make({
        id: "articles",
        source: InMemorySource.make({
          identity: ArticleSourceIdentity,
          sourceSchema: ArticleSource,
          items: [
            {
              identityKey: "article-1",
              version: "source-version-1",
              item: {
                title: "Registry run",
              },
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: () => Effect.void,
      });
      const registry = MigrationDefinitionRegistry.make({
        definitions: [articles] as const,
      });

      const result = yield* MigrationExecution.make({ registry }).run({
        definitionIds: ["articles"],
      });

      expect(result.kind).toBe("completed");
      if (result.kind !== "completed") {
        return;
      }

      const { summary } = result;

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
    "runs update intent through the registry-bound execution path",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const processCalls: string[] = [];
        const articles = MigrationDefinition.make({
          id: "articles",
          source: InMemorySource.make({
            identity: ArticleSourceIdentity,
            sourceSchema: ArticleSource,
            batchSize: 1,
            items: [
              {
                identityKey: "article-migrated",
                version: "source-version-1",
                item: {
                  title: "Already migrated",
                },
              },
              {
                identityKey: "article-new",
                version: "source-version-1",
                item: {
                  title: "New article",
                },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: (sourceItem) =>
            Effect.sync(() => {
              processCalls.push(sourceItem.identity.encoded);
            }),
        });
        const registry = MigrationDefinitionRegistry.make({
          definitions: [articles] as const,
        });

        seedMigrationContract(storeState, "articles");
        storeState.sourceCursors.set(
          articles.id,
          toEncodedSourceCursor('{"offset":1}')
        );
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("articles", "article-migrated"),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: SourceIdentity.fromKey(
              ArticleSourceIdentity,
              "article-migrated"
            ),
            sourceVersion: toSourceVersion("source-version-1"),
            sourceVersionContractFingerprint:
              defaultSourceVersionContractFingerprint,
            lastRunId: toMigrationRunId("run-previous"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            status: "migrated",
          }
        );

        const result = yield* MigrationExecution.make({ registry }).run({
          definitionIds: ["articles"],
          update: true,
        });

        expect(result.kind).toBe("completed");
        if (result.kind !== "completed") {
          return;
        }

        const { summary } = result;

        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 2,
          skipped: 0,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(processCalls).toEqual(["article-migrated", "article-new"]);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-migrated")
          )
        ).toEqual(
          expect.objectContaining({
            status: "migrated",
            lastRunId: summary.runId,
          })
        );
      })
  );

  it.effect(
    "rolls back a valid registry plan through the existing runtime",
    () =>
      Effect.gen(function* () {
        const definitionId = toMigrationDefinitionId("articles");
        const sourceIdentity = toEncodedSourceIdentity("article-1");
        const storeState = InMemoryMigrationStore.makeState();
        const itemStateKey = InMemoryMigrationStore.itemStateKey(
          definitionId,
          sourceIdentity
        );
        const articles = MigrationDefinition.make({
          id: definitionId,
          source: InMemorySource.make({
            identity: ArticleSourceIdentity,
            sourceSchema: ArticleSource,
            items: [
              {
                identityKey: sourceIdentity,
                version: "source-version-1",
                item: {
                  title: "Registry rollback",
                },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: () => Effect.void,
          rollback: () => undefined,
        });
        const registry = MigrationDefinitionRegistry.make({
          definitions: [articles] as const,
        });

        const seedRun = yield* MigrationExecution.make({ registry }).run({
          definitionIds: ["articles"],
        });
        expect(seedRun.kind).toBe("completed");
        expect(storeState.itemStates.has(itemStateKey)).toBe(true);

        const result = yield* MigrationExecution.make({ registry }).rollback({
          definitionIds: ["articles"],
        });

        expect(result.kind).toBe("completed");
        if (result.kind !== "completed") {
          return;
        }

        const { summary } = result;

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
          MigrationExecution.make({ registry }).rollback({
            definitionIds: [authorsId],
          })
        );

        expect(error).toBeInstanceOf(RollbackPreflightError);
        expect(error).toEqual(
          expect.objectContaining({
            message: expect.stringContaining(
              "Rollback would leave dependent Migration Definition item state"
            ),
          })
        );
        expect(storeState.latestRunStates.size).toBe(0);
        expect(storeState.definitionLocks.size).toBe(0);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey(
              authorState.definitionId,
              authorState.sourceIdentity.encoded
            )
          )
        ).toEqual(authorState);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey(
              articleState.definitionId,
              articleState.sourceIdentity.encoded
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
          MigrationExecution.make({ registry }).rollback({
            definitionIds: [authorsId],
            sourceIdentities: [authorState.sourceIdentity.encoded],
          })
        );

        expect(error).toBeInstanceOf(RollbackPreflightError);
        expect(error).toEqual(
          expect.objectContaining({
            message: expect.stringContaining(
              "Rollback would leave dependent Migration Definition item state"
            ),
          })
        );
        expect(storeState.latestRunStates.size).toBe(0);
        expect(storeState.definitionLocks.size).toBe(0);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey(
              authorState.definitionId,
              authorState.sourceIdentity.encoded
            )
          )
        ).toEqual(authorState);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey(
              articleState.definitionId,
              articleState.sourceIdentity.encoded
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
        const rollbackOrder: string[] = [];
        const previousRunId = toMigrationRunId("run-previous");
        const previousDate = new Date("2026-01-01T00:00:00.000Z");
        const authorState = {
          definitionId: authorsId,
          lastRunId: previousRunId,
          sourceIdentity: SourceIdentity.fromKey(
            ArticleSourceIdentity,
            "author-1"
          ),
          sourceVersion: toSourceVersion("source-version-1"),
          status: "migrated" as const,
          updatedAt: previousDate,
        };
        const articleState = {
          definitionId: articlesId,
          lastRunId: previousRunId,
          sourceIdentity: SourceIdentity.fromKey(
            ArticleSourceIdentity,
            "article-1"
          ),
          sourceVersion: toSourceVersion("source-version-1"),
          status: "migrated" as const,
          updatedAt: previousDate,
        };

        for (const itemState of [authorState, articleState]) {
          storeState.itemStates.set(
            InMemoryMigrationStore.itemStateKey(
              itemState.definitionId,
              itemState.sourceIdentity.encoded
            ),
            itemState
          );
        }

        const authors = MigrationDefinition.make({
          id: authorsId,
          source: InMemorySource.make({
            identity: ArticleSourceIdentity,
            sourceSchema: ArticleSource,
            items: [],
          }),
          store,
          process: () => Effect.void,
          rollback: () =>
            Effect.sync(() => {
              rollbackOrder.push("authors");
            }),
        });
        const articles = MigrationDefinition.make({
          id: articlesId,
          dependencies: {
            optional: [authorsId],
          },
          source: InMemorySource.make({
            identity: ArticleSourceIdentity,
            sourceSchema: ArticleSource,
            items: [],
          }),
          store,
          process: () => Effect.void,
          rollback: () =>
            Effect.sync(() => {
              rollbackOrder.push("articles");
            }),
        });
        const registry = MigrationDefinitionRegistry.make({
          definitions: [authors, articles] as const,
        });

        const result = yield* MigrationExecution.make({ registry }).rollback({
          all: true,
        });

        expect(result.kind).toBe("completed");
        if (result.kind !== "completed") {
          return;
        }

        const { summary } = result;

        expect(
          summary.definitions.map((definition) => definition.definitionId)
        ).toEqual([articlesId, authorsId]);
        expect(rollbackOrder).toEqual(["articles", "authors"]);
      })
  );
});
