import { Effect, Option, Schema } from "effect";
import type {
  MigrationDefinitionId,
  MigrationDefinitionIdInput,
} from "./ids.ts";
import {
  MigrationDefinitionId as MigrationDefinitionIdSchema,
  toMigrationDefinitionId,
} from "./ids.ts";
import type { AnyMigrationDefinition } from "./run.ts";

export interface MigrationDefinitionRegistryInput<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> {
  readonly definitions: Definitions;
}

export interface MigrationDefinitionRegistryEntry {
  readonly dependencies: {
    readonly optional: readonly MigrationDefinitionId[];
    readonly required: readonly MigrationDefinitionId[];
  };
  readonly hasRollback: boolean;
  readonly id: MigrationDefinitionId;
}

export class DuplicateMigrationDefinitionId extends Schema.TaggedClass<DuplicateMigrationDefinitionId>()(
  "DuplicateMigrationDefinitionId",
  {
    definitionId: MigrationDefinitionIdSchema,
  }
) {}

export class MissingRequiredMigrationDefinitionDependency extends Schema.TaggedClass<MissingRequiredMigrationDefinitionDependency>()(
  "MissingRequiredMigrationDefinitionDependency",
  {
    definitionId: MigrationDefinitionIdSchema,
    dependencyId: MigrationDefinitionIdSchema,
  }
) {}

export class RequiredMigrationDefinitionDependencyCycle extends Schema.TaggedClass<RequiredMigrationDefinitionDependencyCycle>()(
  "RequiredMigrationDefinitionDependencyCycle",
  {
    definitionIds: Schema.NonEmptyArray(MigrationDefinitionIdSchema),
  }
) {}

export const MigrationDefinitionRegistryConstructionIssue = Schema.Union([
  DuplicateMigrationDefinitionId,
  MissingRequiredMigrationDefinitionDependency,
  RequiredMigrationDefinitionDependencyCycle,
]);
export type MigrationDefinitionRegistryConstructionIssue =
  typeof MigrationDefinitionRegistryConstructionIssue.Type;

export class MigrationDefinitionRegistryConstructionError extends Schema.TaggedErrorClass<MigrationDefinitionRegistryConstructionError>()(
  "MigrationDefinitionRegistryConstructionError",
  {
    issues: Schema.NonEmptyArray(MigrationDefinitionRegistryConstructionIssue),
    message: Schema.String,
  }
) {}

export class MigrationDefinitionRegistryLookupError extends Schema.TaggedErrorClass<MigrationDefinitionRegistryLookupError>()(
  "MigrationDefinitionRegistryLookupError",
  {
    definitionId: MigrationDefinitionIdSchema,
    message: Schema.String,
  }
) {}

const definitionRequiredDependencies = (
  definition: AnyMigrationDefinition
): readonly MigrationDefinitionId[] =>
  definition.dependencies?.required ?? definition.dependsOn ?? [];

const definitionOptionalDependencies = (
  definition: AnyMigrationDefinition
): readonly MigrationDefinitionId[] => definition.dependencies?.optional ?? [];

const collectConstructionIssues = (
  definitions: readonly AnyMigrationDefinition[]
): readonly MigrationDefinitionRegistryConstructionIssue[] => {
  const issues: MigrationDefinitionRegistryConstructionIssue[] = [];
  const definitionIds = new Set<MigrationDefinitionId>();
  const duplicateDefinitionIds = new Set<MigrationDefinitionId>();

  for (const definition of definitions) {
    if (definitionIds.has(definition.id)) {
      duplicateDefinitionIds.add(definition.id);
    }

    definitionIds.add(definition.id);
  }

  for (const definitionId of duplicateDefinitionIds) {
    issues.push(new DuplicateMigrationDefinitionId({ definitionId }));
  }

  for (const definition of definitions) {
    for (const dependencyId of definitionRequiredDependencies(definition)) {
      if (!definitionIds.has(dependencyId)) {
        issues.push(
          new MissingRequiredMigrationDefinitionDependency({
            definitionId: definition.id,
            dependencyId,
          })
        );
      }
    }
  }

  const definitionsById = new Map<
    MigrationDefinitionId,
    AnyMigrationDefinition
  >();

  for (const definition of definitions) {
    if (!definitionsById.has(definition.id)) {
      definitionsById.set(definition.id, definition);
    }
  }

  const visitedDefinitionIds = new Set<MigrationDefinitionId>();
  const activeDefinitionIds: MigrationDefinitionId[] = [];

  const visit = (definitionId: MigrationDefinitionId): void => {
    const activeIndex = activeDefinitionIds.indexOf(definitionId);

    if (activeIndex !== -1) {
      const cycleDefinitionIds = [
        ...activeDefinitionIds.slice(activeIndex),
        definitionId,
      ];
      const [firstDefinitionId, ...remainingDefinitionIds] = cycleDefinitionIds;

      if (firstDefinitionId !== undefined) {
        issues.push(
          new RequiredMigrationDefinitionDependencyCycle({
            definitionIds: [firstDefinitionId, ...remainingDefinitionIds],
          })
        );
      }

      return;
    }

    if (visitedDefinitionIds.has(definitionId)) {
      return;
    }

    const definition = definitionsById.get(definitionId);

    if (definition === undefined) {
      return;
    }

    activeDefinitionIds.push(definitionId);

    for (const dependencyId of definitionRequiredDependencies(definition)) {
      visit(dependencyId);
    }

    activeDefinitionIds.pop();
    visitedDefinitionIds.add(definitionId);
  };

  for (const definition of definitions) {
    visit(definition.id);
  }

  return issues;
};

const validateConstruction = (
  definitions: readonly AnyMigrationDefinition[]
): void => {
  const issues = collectConstructionIssues(definitions);
  const [firstIssue, ...remainingIssues] = issues;

  if (firstIssue === undefined) {
    return;
  }

  throw new MigrationDefinitionRegistryConstructionError({
    issues: [firstIssue, ...remainingIssues],
    message: "Migration Definition Registry contains invalid definitions",
  });
};

const freezeEntry = (
  entry: MigrationDefinitionRegistryEntry
): MigrationDefinitionRegistryEntry =>
  Object.freeze({
    ...entry,
    dependencies: Object.freeze({
      optional: Object.freeze([...entry.dependencies.optional]),
      required: Object.freeze([...entry.dependencies.required]),
    }),
  });

export class MigrationDefinitionRegistry<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> {
  readonly #definitions: Definitions;
  readonly #definitionsById: ReadonlyMap<
    MigrationDefinitionId,
    AnyMigrationDefinition
  >;
  readonly #entries: readonly MigrationDefinitionRegistryEntry[];

  private constructor(definitions: Definitions) {
    validateConstruction(definitions);

    this.#definitions = Object.freeze([
      ...definitions,
    ]) as unknown as Definitions;
    this.#definitionsById = new Map(
      this.#definitions.map((definition) => [definition.id, definition])
    );
    this.#entries = Object.freeze(
      this.#definitions.map((definition) =>
        freezeEntry({
          id: definition.id,
          dependencies: {
            optional: definitionOptionalDependencies(definition),
            required: definitionRequiredDependencies(definition),
          },
          hasRollback: definition.rollback !== undefined,
        })
      )
    );
  }

  static make<const Definitions extends readonly AnyMigrationDefinition[]>(
    input: MigrationDefinitionRegistryInput<Definitions>
  ): MigrationDefinitionRegistry<Definitions> {
    return new MigrationDefinitionRegistry(input.definitions);
  }

  definitions(): Definitions {
    return this.#definitions;
  }

  get(
    definitionId: MigrationDefinitionIdInput
  ): Option.Option<AnyMigrationDefinition> {
    return Option.fromUndefinedOr(
      this.#definitionsById.get(toMigrationDefinitionId(definitionId))
    );
  }

  list(): readonly MigrationDefinitionRegistryEntry[] {
    return this.#entries;
  }

  require(
    definitionId: MigrationDefinitionIdInput
  ): Effect.Effect<
    AnyMigrationDefinition,
    MigrationDefinitionRegistryLookupError
  > {
    const id = toMigrationDefinitionId(definitionId);

    return Option.match(this.get(id), {
      onNone: () =>
        Effect.fail(
          new MigrationDefinitionRegistryLookupError({
            definitionId: id,
            message: "Migration Definition was not found in the registry",
          })
        ),
      onSome: (definition) => Effect.succeed(definition),
    });
  }
}
