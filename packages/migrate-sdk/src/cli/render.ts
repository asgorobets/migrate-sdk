import type { MigrationDefinitionId } from "../domain/ids.ts";
import type {
  MigrationDefinitionPlanNotice,
  MigrationDefinitionRegistry,
  MigrationDefinitionRegistryConstructionIssue,
  MigrationDefinitionRegistryEntry,
  MigrationDefinitionRegistryPlanningError,
  MigrationDefinitionRegistryStatusReport,
  MigrationDefinitionRollbackPlan,
  MigrationDefinitionRunPlan,
} from "../domain/registry.ts";
import type { RollbackRunSummary } from "../domain/rollback.ts";
import type { MigrationRunSummary } from "../domain/run.ts";

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

const renderRunDefinitionSummary = (
  definition: MigrationRunSummary["definitions"][number],
  index: number
): string =>
  `${index + 1}. ${definition.definitionId}: ${definition.status} (migrated ${
    definition.counts.migrated
  }, unchanged ${definition.counts.unchanged}, skipped ${
    definition.counts.skipped
  }, failed ${definition.counts.failed}, needs update ${
    definition.counts.needsUpdate
  })`;

const renderRollbackDefinitionSummary = (
  definition: RollbackRunSummary["definitions"][number],
  index: number
): string =>
  `${index + 1}. ${definition.definitionId}: ${
    definition.status
  } (rolled back ${definition.counts.rolledBack}, skipped ${
    definition.counts.skipped
  }, failed ${definition.counts.failed})`;

export const renderRunSummary = (summary: MigrationRunSummary): string =>
  [
    `Run completed: ${summary.status}`,
    `Run id: ${summary.runId}`,
    "",
    "Definitions:",
    ...summary.definitions.map(renderRunDefinitionSummary),
  ].join("\n");

export const renderRollbackSummary = (summary: RollbackRunSummary): string =>
  [
    `Rollback completed: ${summary.status}`,
    `Run id: ${summary.runId}`,
    "",
    "Definitions:",
    ...summary.definitions.map(renderRollbackDefinitionSummary),
  ].join("\n");

const renderStatusDefinition = (
  definition: MigrationDefinitionRegistryStatusReport["definitions"][number],
  index: number
): string => {
  const durable = definition.durable;
  const source =
    definition.source === undefined
      ? ""
      : `; source total ${definition.source.total}, unprocessed ${definition.source.unprocessed}, invalid ${definition.source.invalid}, duplicate ${definition.source.duplicate}, orphaned ${definition.source.orphaned}`;
  const latest =
    definition.lastRun === null ? "none" : definition.lastRun.status;

  return `${index + 1}. ${definition.definitionId}: latest ${latest} (migrated ${durable.migrated}, skipped ${durable.skipped}, failed ${durable.failed}, needs update ${durable.needsUpdate}${source})`;
};

const renderStatusWarning = (
  warning: MigrationDefinitionRegistryStatusReport["warnings"][number]
): string => {
  switch (warning._tag) {
    case "DuplicateSourceIdentityStatusWarning":
      return `Duplicate source identity in ${warning.definitionId}: ${warning.sourceIdentity} (${warning.count} duplicate item(s)). Check the source plugin identity mapping.`;
    case "InvalidSourceItemStatusWarning":
      return `Invalid source item in ${warning.definitionId}: ${warning.sourceIdentity}. ${warning.message}. Check the Source Payload Schema and source data.`;
    default: {
      const exhaustive: never = warning;
      return exhaustive;
    }
  }
};

export const renderStatusReport = (
  report: MigrationDefinitionRegistryStatusReport
): string =>
  [
    "Migration Status",
    "",
    "Requested:",
    renderRequestedDefinitionIds(report.requestedDefinitionIds),
    "",
    "Included:",
    renderDefinitionIdList(report.includedDefinitionIds),
    "",
    "Definitions:",
    ...report.definitions.map(renderStatusDefinition),
    ...renderNoticeSection(report.notices),
    ...(report.warnings.length === 0
      ? []
      : [
          "",
          "Warnings:",
          ...report.warnings.map(
            (warning) => `- ${renderStatusWarning(warning)}`
          ),
        ]),
  ].join("\n");

const formatPlanCommand = (
  command: "rollback" | "run" | "status",
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

const missingDependencyExpansionFlags = (
  command: "rollback" | "run" | "status",
  modeFlags: readonly string[]
): readonly string[] =>
  command === "status"
    ? ["--with-dependencies"]
    : ["--plan", ...modeFlags, "--with-dependencies"];

const missingDependencyExplicitFlags = (
  command: "rollback" | "run" | "status",
  modeFlags: readonly string[]
): readonly string[] => (command === "status" ? [] : ["--plan", ...modeFlags]);

export const renderPlanningError = (
  error: MigrationDefinitionRegistryPlanningError,
  input: {
    readonly command: "rollback" | "run" | "status";
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
          missingDependencyExpansionFlags(input.command, modeFlags),
          input.definitionIds
        ),
        formatPlanCommand(
          input.command,
          missingDependencyExplicitFlags(input.command, modeFlags),
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

export const renderRuntimeError = (error: {
  readonly _tag: string;
  readonly message?: string;
}): string =>
  error.message === undefined ? error._tag : `${error._tag}: ${error.message}`;

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
