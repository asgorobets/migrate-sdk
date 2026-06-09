import type { MigrationDefinitionId } from "../domain/ids.ts";
import type {
  MigrationDefinitionPlanNotice,
  MigrationDefinitionRegistry,
  MigrationDefinitionRegistryConstructionIssue,
  MigrationDefinitionRegistryEntry,
  MigrationDefinitionRegistryPlanningError,
  MigrationDefinitionRollbackPlan,
  MigrationDefinitionRunPlan,
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

const renderDefinitionIdList = (
  definitionIds: readonly MigrationDefinitionId[]
): string => (definitionIds.length === 0 ? "-" : definitionIds.join("\n"));

const renderRequestedDefinitionIds = (
  requestedDefinitionIds:
    | MigrationDefinitionRunPlan["requestedDefinitionIds"]
    | MigrationDefinitionRollbackPlan["requestedDefinitionIds"]
): string =>
  requestedDefinitionIds === "all"
    ? "all"
    : renderDefinitionIdList(requestedDefinitionIds);

const renderExecutionOrder = (
  definitionIds: readonly MigrationDefinitionId[]
): string =>
  definitionIds.length === 0
    ? "-"
    : definitionIds
        .map((definitionId, index) => `${index + 1}. ${definitionId}`)
        .join("\n");

const renderTargetSection = (
  sourceIdentities: readonly string[] | undefined
): readonly string[] =>
  sourceIdentities === undefined
    ? []
    : ["", "Target ids:", sourceIdentities.join(", ")];

const renderPlanNotice = (notice: MigrationDefinitionPlanNotice): string => {
  switch (notice._tag) {
    case "MigrationDefinitionDuplicateRequestedDefinitionIgnored":
      return `Duplicate requested definition ignored: ${notice.definitionId}`;
    case "MigrationDefinitionDuplicateTargetIdIgnored":
      return `Duplicate target id ignored: ${notice.sourceIdentity}`;
    case "MigrationDefinitionOptionalDependencyCycleIgnored":
      return `Ignored optional dependency cycle: ${notice.definitionIds.join(
        " -> "
      )}`;
    default: {
      const exhaustive: never = notice;
      return exhaustive;
    }
  }
};

const renderNoticeSection = (
  notices: readonly MigrationDefinitionPlanNotice[]
): readonly string[] =>
  notices.length === 0
    ? []
    : [
        "",
        "Notices:",
        ...notices.map((notice) => `- ${renderPlanNotice(notice)}`),
      ];

export const renderRunPlan = (
  plan: MigrationDefinitionRunPlan,
  options: {
    readonly mode?: "failed" | "skipped";
  } = {}
): string =>
  [
    "Run plan",
    "",
    "Requested:",
    renderRequestedDefinitionIds(plan.requestedDefinitionIds),
    ...(options.mode === undefined ? [] : ["", "Mode:", options.mode]),
    ...renderTargetSection(plan.target?.sourceIdentities),
    "",
    "Included:",
    renderDefinitionIdList(plan.includedDefinitionIds),
    "",
    "Execution order:",
    renderExecutionOrder(plan.executionDefinitionIds),
    ...renderNoticeSection(plan.notices),
  ].join("\n");

export const renderRollbackPlan = (
  plan: MigrationDefinitionRollbackPlan
): string => {
  const targetLines =
    plan.target === undefined
      ? []
      : renderTargetSection(plan.target.sourceIdentities);

  return [
    "Rollback plan",
    "",
    "Requested:",
    renderRequestedDefinitionIds(plan.requestedDefinitionIds),
    ...targetLines,
    "",
    "Included:",
    renderDefinitionIdList(plan.includedDefinitionIds),
    "",
    "Execution order:",
    renderExecutionOrder(plan.executionDefinitionIds),
    ...renderNoticeSection(plan.notices),
  ].join("\n");
};

const formatPlanCommand = (
  command: "rollback" | "run",
  flags: readonly string[],
  definitionIds: readonly string[]
): string =>
  [`migrate ${command}`, ...flags, ...definitionIds].filter(Boolean).join(" ");

const dedupeStrings = (values: readonly string[]): readonly string[] => {
  const uniqueValues: string[] = [];
  const seenValues = new Set<string>();

  for (const value of values) {
    if (seenValues.has(value)) {
      continue;
    }

    seenValues.add(value);
    uniqueValues.push(value);
  }

  return uniqueValues;
};

export const renderPlanningError = (
  error: MigrationDefinitionRegistryPlanningError,
  input: {
    readonly command: "rollback" | "run";
    readonly definitionIds: readonly string[];
    readonly hasTarget: boolean;
    readonly mode?: "failed" | "skipped";
  }
): string => {
  switch (error._tag) {
    case "MigrationDefinitionRegistryInvalidSelectionError":
      return error.message;
    case "MigrationDefinitionRegistryUnknownDefinitionError":
      return `${error.message}: ${error.definitionId}`;
    case "MigrationDefinitionRegistryMissingExplicitRequiredDependenciesError": {
      const definitionIdsWithMissingDependencies = dedupeStrings([
        ...error.missingDependencyIds,
        ...input.definitionIds,
      ]);
      const modeFlags =
        input.mode === undefined ? [] : ([`--${input.mode}`] as const);
      const message = [
        error.message,
        `${error.definitionId} is missing required dependencies: ${error.missingDependencyIds.join(
          ", "
        )}`,
      ];

      if (input.hasTarget) {
        return message.join("\n");
      }

      return [
        ...message,
        "",
        "Try:",
        formatPlanCommand(
          input.command,
          ["--plan", ...modeFlags, "--with-dependencies"],
          input.definitionIds
        ),
        formatPlanCommand(
          input.command,
          ["--plan", ...modeFlags],
          definitionIdsWithMissingDependencies
        ),
      ].join("\n");
    }
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
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
