import { Effect, Layer, Option, Schema } from "effect";
import { Service } from "effect/Context";
import {
  type MigrationDefinitionRegistryId,
  type MigrationDefinitionRegistryIdInput,
  MigrationDefinitionRegistryId as MigrationDefinitionRegistryIdSchema,
  toMigrationDefinitionRegistryId,
} from "../domain/ids.ts";
import type { MigrationDefinitionRegistry } from "../domain/registry.ts";

export class MissingMigrationDefinitionRegistryId extends Schema.TaggedClass<MissingMigrationDefinitionRegistryId>()(
  "MissingMigrationDefinitionRegistryId",
  {
    message: Schema.String,
  }
) {}

export class DuplicateMigrationDefinitionRegistryId extends Schema.TaggedClass<DuplicateMigrationDefinitionRegistryId>()(
  "DuplicateMigrationDefinitionRegistryId",
  {
    registryId: MigrationDefinitionRegistryIdSchema,
  }
) {}

export const MigrationDefinitionRegistryCatalogConstructionIssue = Schema.Union(
  [MissingMigrationDefinitionRegistryId, DuplicateMigrationDefinitionRegistryId]
);
export type MigrationDefinitionRegistryCatalogConstructionIssue =
  typeof MigrationDefinitionRegistryCatalogConstructionIssue.Type;

export class MigrationDefinitionRegistryCatalogConstructionError extends Schema.TaggedErrorClass<MigrationDefinitionRegistryCatalogConstructionError>()(
  "MigrationDefinitionRegistryCatalogConstructionError",
  {
    issues: Schema.NonEmptyArray(
      MigrationDefinitionRegistryCatalogConstructionIssue
    ),
    message: Schema.String,
  }
) {}

export class MigrationDefinitionRegistryCatalogLookupError extends Schema.TaggedErrorClass<MigrationDefinitionRegistryCatalogLookupError>()(
  "MigrationDefinitionRegistryCatalogLookupError",
  {
    message: Schema.String,
    registryId: MigrationDefinitionRegistryIdSchema,
  }
) {}

export interface MigrationDefinitionRegistryCatalogService {
  readonly get: (
    registryId: MigrationDefinitionRegistryIdInput
  ) => Effect.Effect<
    MigrationDefinitionRegistry,
    MigrationDefinitionRegistryCatalogLookupError
  >;
}

export interface MigrationDefinitionRegistryCatalogLayerInput {
  readonly registries: readonly MigrationDefinitionRegistry[];
}

const makeCatalog = (
  input: MigrationDefinitionRegistryCatalogLayerInput
): Effect.Effect<
  MigrationDefinitionRegistryCatalogService,
  MigrationDefinitionRegistryCatalogConstructionError
> =>
  Effect.suspend(() => {
    const issues: MigrationDefinitionRegistryCatalogConstructionIssue[] = [];
    const registriesById = new Map<
      MigrationDefinitionRegistryId,
      MigrationDefinitionRegistry
    >();

    for (const registry of input.registries) {
      const registryId = Option.getOrUndefined(registry.id());

      if (registryId === undefined) {
        issues.push(
          new MissingMigrationDefinitionRegistryId({
            message:
              "Migration Definition Registry Catalog requires registry ids",
          })
        );
        continue;
      }

      if (registriesById.has(registryId)) {
        issues.push(new DuplicateMigrationDefinitionRegistryId({ registryId }));
        continue;
      }

      registriesById.set(registryId, registry);
    }

    const [firstIssue, ...remainingIssues] = issues;

    if (firstIssue !== undefined) {
      return Effect.fail(
        new MigrationDefinitionRegistryCatalogConstructionError({
          issues: [firstIssue, ...remainingIssues],
          message:
            "Migration Definition Registry Catalog contains invalid registries",
        })
      );
    }

    return Effect.succeed({
      get: (registryIdInput) => {
        const registryId = toMigrationDefinitionRegistryId(registryIdInput);
        const registry = registriesById.get(registryId);

        if (registry === undefined) {
          return Effect.fail(
            new MigrationDefinitionRegistryCatalogLookupError({
              registryId,
              message:
                "Migration Definition Registry was not found in the catalog",
            })
          );
        }

        return Effect.succeed(registry);
      },
    });
  });

export class MigrationDefinitionRegistryCatalog extends Service<
  MigrationDefinitionRegistryCatalog,
  MigrationDefinitionRegistryCatalogService
>()("@migrate-sdk/MigrationDefinitionRegistryCatalog") {
  static readonly get = (registryId: MigrationDefinitionRegistryIdInput) =>
    Effect.flatMap(MigrationDefinitionRegistryCatalog, (catalog) =>
      catalog.get(registryId)
    );

  static readonly layer = (
    input: MigrationDefinitionRegistryCatalogLayerInput
  ) => Layer.effect(MigrationDefinitionRegistryCatalog, makeCatalog(input));
}
