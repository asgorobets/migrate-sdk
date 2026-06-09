import type { MigrationDefinitionId } from "../domain/ids.ts";
import type {
  MigrationDefinitionRegistry,
  MigrationDefinitionRegistryConstructionIssue,
  MigrationDefinitionRegistryEntry,
} from "../domain/registry.ts";

interface MigrationDefinitionGraphEdge {
  readonly fromDefinitionId: MigrationDefinitionId;
  readonly kind: "required" | "optional";
  readonly toDefinitionId: MigrationDefinitionId;
  readonly unresolved: boolean;
}

const formatRequiredDependencies = (
  dependencies: readonly MigrationDefinitionId[]
): string => (dependencies.length === 0 ? "-" : dependencies.join(", "));

const formatOptionalDependencies = (
  dependencies: readonly MigrationDefinitionId[],
  registeredIds: ReadonlySet<MigrationDefinitionId>
): string =>
  dependencies.length === 0
    ? "-"
    : dependencies
        .map((dependencyId) =>
          registeredIds.has(dependencyId)
            ? dependencyId
            : `${dependencyId} (unresolved)`
        )
        .join(", ");

export const renderRegistryList = (
  registry: MigrationDefinitionRegistry
): string => {
  const entries = registry.list();
  const registeredIds = new Set(entries.map((entry) => entry.id));

  return [
    "Migration Definitions",
    ...entries.flatMap((entry) => [
      `- ${entry.id}`,
      `  rollback: ${entry.hasRollback ? "yes" : "no"}`,
      `  required: ${formatRequiredDependencies(entry.dependencies.required)}`,
      `  optional: ${formatOptionalDependencies(
        entry.dependencies.optional,
        registeredIds
      )}`,
    ]),
  ].join("\n");
};

const collectGraphEdges = (
  entries: readonly MigrationDefinitionRegistryEntry[]
): readonly MigrationDefinitionGraphEdge[] => {
  const registeredIds = new Set(entries.map((entry) => entry.id));

  return entries.flatMap((entry) => [
    ...entry.dependencies.required.map((dependencyId) => ({
      fromDefinitionId: entry.id,
      kind: "required" as const,
      toDefinitionId: dependencyId,
      unresolved: false,
    })),
    ...entry.dependencies.optional.map((dependencyId) => ({
      fromDefinitionId: entry.id,
      kind: "optional" as const,
      toDefinitionId: dependencyId,
      unresolved: !registeredIds.has(dependencyId),
    })),
  ]);
};

const renderGraphEdge = (edge: MigrationDefinitionGraphEdge): string => {
  const label =
    edge.kind === "optional" && edge.unresolved
      ? "optional unresolved"
      : edge.kind;

  return `${edge.fromDefinitionId}(${label}) --> ${edge.toDefinitionId}`;
};

export const renderRegistryGraph = (
  registry: MigrationDefinitionRegistry,
  focusedDefinitionId?: MigrationDefinitionId
): string => {
  const entries = registry.list();
  const edges = collectGraphEdges(entries).filter(
    (edge) =>
      focusedDefinitionId === undefined ||
      edge.fromDefinitionId === focusedDefinitionId ||
      edge.toDefinitionId === focusedDefinitionId
  );
  const header =
    focusedDefinitionId === undefined
      ? "Migration Dependency Graph"
      : `Migration Dependency Graph: ${focusedDefinitionId}`;

  if (edges.length === 0) {
    return [header, "No dependencies."].join("\n");
  }

  return [header, ...edges.map(renderGraphEdge)].join("\n");
};

export const renderConfigLoadError = (error: {
  readonly cause?: unknown;
  readonly configPath: string;
  readonly kind: string;
  readonly message: string;
}): string => {
  const lines = [`Failed to load ${error.configPath}`];

  if (isRegistryConstructionError(error.cause)) {
    lines.push(
      `Registry has ${error.cause.issues.length} hard errors:`,
      ...error.cause.issues.map(
        (issue) => `- ${renderConstructionIssue(issue)}`
      )
    );

    return lines.join("\n");
  }

  lines.push(error.message);

  if (error.cause !== undefined) {
    lines.push(
      error.kind === "ConfigImportFailed"
        ? formatCauseWithStack(error.cause)
        : formatCause(error.cause)
    );
  }

  return lines.join("\n");
};

const isRegistryConstructionError = (
  value: unknown
): value is {
  readonly issues: readonly MigrationDefinitionRegistryConstructionIssue[];
} =>
  typeof value === "object" &&
  value !== null &&
  "issues" in value &&
  Array.isArray(value.issues);

const renderConstructionIssue = (
  issue: MigrationDefinitionRegistryConstructionIssue
): string => {
  switch (issue._tag) {
    case "DuplicateMigrationDefinitionId":
      return `Duplicate migration definition id: ${issue.definitionId}`;
    case "MissingRequiredMigrationDefinitionDependency":
      return `${issue.definitionId} requires ${issue.dependencyId}, but ${issue.dependencyId} is not registered`;
    case "RequiredMigrationDefinitionDependencyCycle":
      return `Required dependency cycle: ${issue.definitionIds.join(" -> ")}`;
    default: {
      const exhaustive: never = issue;
      return exhaustive;
    }
  }
};

const formatCause = (cause: unknown): string => {
  if (cause instanceof Error) {
    return cause.message;
  }

  return String(cause);
};

const formatCauseWithStack = (cause: unknown): string => {
  if (cause instanceof Error) {
    return cause.stack ?? cause.message;
  }

  return String(cause);
};
