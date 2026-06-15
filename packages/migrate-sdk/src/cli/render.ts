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

interface RenderOptions {
  readonly colors?: boolean;
}

interface MigrationDefinitionGraphEdge {
  readonly fromDefinitionId: MigrationDefinitionId;
  readonly kind: "required" | "optional";
  readonly toDefinitionId: MigrationDefinitionId;
  readonly unresolved: boolean;
}

const ansi = {
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
  yellow: "\x1b[33m",
} as const;

const annotate = (
  value: string,
  code: string,
  options: RenderOptions
): string => (options.colors === true ? `${code}${value}${ansi.reset}` : value);

const bold = (value: string, options: RenderOptions): string =>
  annotate(value, ansi.bold, options);

const cyan = (value: string, options: RenderOptions): string =>
  annotate(value, ansi.cyan, options);

const dim = (value: string, options: RenderOptions): string =>
  annotate(value, ansi.dim, options);

const green = (value: string, options: RenderOptions): string =>
  annotate(value, ansi.green, options);

const red = (value: string, options: RenderOptions): string =>
  annotate(value, ansi.red, options);

const yellow = (value: string, options: RenderOptions): string =>
  annotate(value, ansi.yellow, options);

type TableAlignment = "left" | "right";

interface TableColumn<Row> {
  readonly align?: TableAlignment;
  readonly header: string;
  readonly render: (row: Row, index: number) => string;
  readonly style?: (value: string, row: Row, options: RenderOptions) => string;
}

const padCell = (
  value: string,
  width: number,
  align: TableAlignment
): string => (align === "right" ? value.padStart(width) : value.padEnd(width));

const renderTable = <Row>(
  columns: readonly TableColumn<Row>[],
  rows: readonly Row[],
  options: RenderOptions
): readonly string[] => {
  const widths = columns.map((column) =>
    Math.max(
      column.header.length,
      ...rows.map((row, index) => column.render(row, index).length)
    )
  );
  const header = columns
    .map((column, index) =>
      bold(
        padCell(column.header, widths[index] ?? 0, column.align ?? "left"),
        options
      )
    )
    .join("  ");
  const separator = dim(
    widths.map((width) => "-".repeat(width)).join("  "),
    options
  );
  const body = rows.map((row, rowIndex) =>
    columns
      .map((column, index) => {
        const value = column.render(row, rowIndex);
        const padded = padCell(
          value,
          widths[index] ?? 0,
          column.align ?? "left"
        );

        return column.style?.(padded, row, options) ?? padded;
      })
      .join("  ")
  );

  return [header, separator, ...body];
};

const renderDefinitionIdInlineList = (
  definitionIds: readonly MigrationDefinitionId[]
): string => (definitionIds.length === 0 ? "-" : definitionIds.join(", "));

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
  registry: MigrationDefinitionRegistry,
  options: RenderOptions = {}
): string => {
  const entries = registry.list();
  const registeredIds = new Set(entries.map((entry) => entry.id));

  if (entries.length === 0) {
    return [bold("Migration Definitions", options), "No definitions."].join(
      "\n"
    );
  }

  return [
    bold("Migration Definitions", options),
    "",
    ...renderTable(
      [
        {
          header: "Migration ID",
          render: (entry) => entry.id,
        },
        {
          header: "Rollback",
          render: (entry) => (entry.hasRollback ? "yes" : "no"),
          style: (value, entry, renderOptions) =>
            entry.hasRollback
              ? green(value, renderOptions)
              : dim(value, renderOptions),
        },
        {
          header: "Required",
          render: (entry) =>
            formatRequiredDependencies(entry.dependencies.required),
        },
        {
          header: "Optional",
          render: (entry) =>
            formatOptionalDependencies(
              entry.dependencies.optional,
              registeredIds
            ),
          style: (value, entry, renderOptions) =>
            entry.dependencies.optional.some(
              (dependencyId) => !registeredIds.has(dependencyId)
            )
              ? yellow(value, renderOptions)
              : value,
        },
      ],
      entries,
      options
    ),
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

const renderGraphEdge = (
  edge: MigrationDefinitionGraphEdge,
  options: RenderOptions
): string => {
  const label =
    edge.kind === "optional" && edge.unresolved
      ? "optional unresolved"
      : edge.kind;
  let styledLabel: string;

  if (edge.kind === "required") {
    styledLabel = red(label, options);
  } else if (edge.unresolved) {
    styledLabel = yellow(label, options);
  } else {
    styledLabel = cyan(label, options);
  }

  return `${edge.fromDefinitionId}(${styledLabel}) --> ${edge.toDefinitionId}`;
};

export const renderRegistryGraph = (
  registry: MigrationDefinitionRegistry,
  focusedDefinitionId?: MigrationDefinitionId,
  options: RenderOptions = {}
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
    return [bold(header, options), dim("No dependencies.", options)].join("\n");
  }

  return [
    bold(header, options),
    ...edges.map((edge) => renderGraphEdge(edge, options)),
  ].join("\n");
};

const renderRequestedDefinitionIdsInline = (
  requestedDefinitionIds:
    | MigrationDefinitionRunPlan["requestedDefinitionIds"]
    | MigrationDefinitionRollbackPlan["requestedDefinitionIds"]
): string =>
  requestedDefinitionIds === "all"
    ? "all"
    : renderDefinitionIdInlineList(requestedDefinitionIds);

const renderExecutionOrderTable = (
  definitionIds: readonly MigrationDefinitionId[],
  options: RenderOptions
): readonly string[] =>
  definitionIds.length === 0
    ? [dim("No definitions.", options)]
    : renderTable(
        [
          {
            align: "right",
            header: "#",
            render: (_definitionId, index) => String(index + 1),
          },
          {
            header: "Migration ID",
            render: (definitionId) => definitionId,
          },
        ],
        definitionIds,
        options
      );

const renderPlanNotice = (notice: MigrationDefinitionPlanNotice): string => {
  switch (notice._tag) {
    case "MigrationDefinitionDuplicateRequestedDefinitionIgnored":
      return `Duplicate requested definition ignored: ${notice.definitionId}`;
    case "MigrationDefinitionDuplicateSourceIdentityTargetIgnored":
      return `Duplicate source identity target ignored: ${notice.sourceIdentity}`;
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
  notices: readonly MigrationDefinitionPlanNotice[],
  options: RenderOptions = {}
): readonly string[] =>
  notices.length === 0
    ? []
    : [
        "",
        yellow("Notices:", options),
        ...notices.map((notice) =>
          yellow(`! ${renderPlanNotice(notice)}`, options)
        ),
      ];

const renderPlanScope = (
  input: {
    readonly includedDefinitionIds: readonly MigrationDefinitionId[];
    readonly mode?: "failed" | "skipped";
    readonly requestedDefinitionIds:
      | MigrationDefinitionRunPlan["requestedDefinitionIds"]
      | MigrationDefinitionRollbackPlan["requestedDefinitionIds"];
    readonly sourceIdentities?: readonly string[];
  },
  options: RenderOptions
): readonly string[] => [
  bold("Scope", options),
  `Requested  ${renderRequestedDefinitionIdsInline(input.requestedDefinitionIds)}`,
  `Included   ${renderDefinitionIdInlineList(input.includedDefinitionIds)}`,
  ...(input.mode === undefined ? [] : [`Mode       ${input.mode}`]),
  ...(input.sourceIdentities === undefined
    ? []
    : [`Target source identities ${input.sourceIdentities.join(", ")}`]),
];

export const renderRunPlan = (
  plan: MigrationDefinitionRunPlan,
  options: {
    readonly colors?: boolean;
    readonly mode?: "failed" | "skipped";
  } = {}
): string =>
  [
    bold("Run Plan", options),
    "",
    ...renderPlanScope(
      {
        includedDefinitionIds: plan.includedDefinitionIds,
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        requestedDefinitionIds: plan.requestedDefinitionIds,
        ...(plan.target === undefined
          ? {}
          : { sourceIdentities: plan.target.sourceIdentities }),
      },
      options
    ),
    "",
    bold("Execution Order", options),
    ...renderExecutionOrderTable(plan.executionDefinitionIds, options),
    ...renderNoticeSection(plan.notices, options),
  ].join("\n");

export const renderRollbackPlan = (
  plan: MigrationDefinitionRollbackPlan,
  options: RenderOptions = {}
): string => {
  return [
    bold("Rollback Plan", options),
    "",
    ...renderPlanScope(
      {
        includedDefinitionIds: plan.includedDefinitionIds,
        requestedDefinitionIds: plan.requestedDefinitionIds,
        ...(plan.target === undefined
          ? {}
          : { sourceIdentities: plan.target.sourceIdentities }),
      },
      options
    ),
    "",
    bold("Execution Order", options),
    ...renderExecutionOrderTable(plan.executionDefinitionIds, options),
    ...renderNoticeSection(plan.notices, options),
  ].join("\n");
};

const styleCompletionStatus = (
  value: string,
  status: "failed" | "skipped" | "succeeded",
  options: RenderOptions
): string => {
  switch (status) {
    case "failed":
      return red(value, options);
    case "skipped":
      return dim(value, options);
    case "succeeded":
      return green(value, options);
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
};

const styleRunSummaryStatus = (
  value: string,
  definition: MigrationRunSummary["definitions"][number],
  options: RenderOptions
): string => styleCompletionStatus(value, definition.status, options);

const styleRollbackSummaryStatus = (
  value: string,
  definition: RollbackRunSummary["definitions"][number],
  options: RenderOptions
): string => styleCompletionStatus(value, definition.status, options);

const renderRunSummaryTable = (
  summary: MigrationRunSummary,
  options: RenderOptions
): readonly string[] =>
  renderTable(
    [
      {
        align: "right",
        header: "#",
        render: (_definition, index) => String(index + 1),
      },
      {
        header: "Migration ID",
        render: (definition) => definition.definitionId,
      },
      {
        header: "Status",
        render: (definition) => definition.status,
        style: styleRunSummaryStatus,
      },
      {
        align: "right",
        header: "Migrated",
        render: (definition) => String(definition.counts.migrated),
      },
      {
        align: "right",
        header: "Unchanged",
        render: (definition) => String(definition.counts.unchanged),
      },
      {
        align: "right",
        header: "Skipped",
        render: (definition) => String(definition.counts.skipped),
      },
      {
        align: "right",
        header: "Failed",
        render: (definition) => String(definition.counts.failed),
        style: stylePositiveCount(
          (definition) => definition.counts.failed,
          red
        ),
      },
      {
        align: "right",
        header: "Needs Update",
        render: (definition) => String(definition.counts.needsUpdate),
        style: stylePositiveCount(
          (definition) => definition.counts.needsUpdate,
          yellow
        ),
      },
    ],
    summary.definitions,
    options
  );

const renderRollbackSummaryTable = (
  summary: RollbackRunSummary,
  options: RenderOptions
): readonly string[] =>
  renderTable(
    [
      {
        align: "right",
        header: "#",
        render: (_definition, index) => String(index + 1),
      },
      {
        header: "Migration ID",
        render: (definition) => definition.definitionId,
      },
      {
        header: "Status",
        render: (definition) => definition.status,
        style: styleRollbackSummaryStatus,
      },
      {
        align: "right",
        header: "Rolled Back",
        render: (definition) => String(definition.counts.rolledBack),
      },
      {
        align: "right",
        header: "Skipped",
        render: (definition) => String(definition.counts.skipped),
      },
      {
        align: "right",
        header: "Failed",
        render: (definition) => String(definition.counts.failed),
        style: stylePositiveCount(
          (definition) => definition.counts.failed,
          red
        ),
      },
    ],
    summary.definitions,
    options
  );

export const renderRunSummary = (
  summary: MigrationRunSummary,
  options: RenderOptions = {}
): string =>
  [
    `${bold("Run Completed", options)} ${styleCompletionStatus(
      summary.status,
      summary.status,
      options
    )}`,
    `Run id  ${summary.runId}`,
    "",
    bold("Definitions", options),
    ...renderRunSummaryTable(summary, options),
  ].join("\n");

export const renderRollbackSummary = (
  summary: RollbackRunSummary,
  options: RenderOptions = {}
): string =>
  [
    `${bold("Rollback Completed", options)} ${styleCompletionStatus(
      summary.status,
      summary.status,
      options
    )}`,
    `Run id  ${summary.runId}`,
    "",
    bold("Definitions", options),
    ...renderRollbackSummaryTable(summary, options),
  ].join("\n");

type StatusDefinition =
  MigrationDefinitionRegistryStatusReport["definitions"][number];

type DefinitionState =
  | "failed"
  | "new"
  | "ok"
  | "pending"
  | "running"
  | "warning";

const latestStatus = (definition: StatusDefinition): string =>
  definition.lastRun === null ? "none" : definition.lastRun.status;

const hasDurableItems = (definition: StatusDefinition): boolean =>
  definition.durable.migrated > 0 ||
  definition.durable.skipped > 0 ||
  definition.durable.failed > 0 ||
  definition.durable.needsUpdate > 0;

const definitionState = (definition: StatusDefinition): DefinitionState => {
  const source = definition.source;

  if (definition.lastRun?.status === "running") {
    return "running";
  }

  if (
    definition.lastRun?.status === "failed" ||
    definition.durable.failed > 0 ||
    (source?.invalid ?? 0) > 0
  ) {
    return "failed";
  }

  if (
    definition.durable.needsUpdate > 0 ||
    (source?.duplicate ?? 0) > 0 ||
    (source?.orphaned ?? 0) > 0
  ) {
    return "warning";
  }

  if ((source?.unprocessed ?? 0) > 0) {
    return "pending";
  }

  if (definition.lastRun === null && !hasDurableItems(definition)) {
    return "new";
  }

  return "ok";
};

const styleDefinitionState = (
  value: string,
  definition: StatusDefinition,
  options: RenderOptions
): string => {
  const state = definitionState(definition);

  switch (state) {
    case "failed":
      return red(value, options);
    case "new":
      return dim(value, options);
    case "ok":
      return green(value, options);
    case "pending":
      return cyan(value, options);
    case "running":
    case "warning":
      return yellow(value, options);
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
};

const styleLatestStatus = (
  value: string,
  definition: StatusDefinition,
  options: RenderOptions
): string => {
  switch (latestStatus(definition)) {
    case "succeeded":
      return green(value, options);
    case "failed":
      return red(value, options);
    case "running":
      return yellow(value, options);
    default:
      return dim(value, options);
  }
};

const stylePositiveCount =
  <Row>(
    getValue: (row: Row) => number,
    style: (value: string, options: RenderOptions) => string
  ) =>
  (value: string, row: Row, options: RenderOptions): string =>
    getValue(row) > 0 ? style(value, options) : value;

const durableStatusColumns = [
  {
    header: "State",
    render: definitionState,
    style: styleDefinitionState,
  },
  {
    header: "Migration ID",
    render: (definition: StatusDefinition) => definition.definitionId,
  },
  {
    header: "Last Run",
    render: latestStatus,
    style: styleLatestStatus,
  },
  {
    align: "right",
    header: "Migrated",
    render: (definition: StatusDefinition) =>
      String(definition.durable.migrated),
  },
  {
    align: "right",
    header: "Skipped",
    render: (definition: StatusDefinition) =>
      String(definition.durable.skipped),
  },
  {
    align: "right",
    header: "Failed",
    render: (definition: StatusDefinition) => String(definition.durable.failed),
    style: stylePositiveCount((definition) => definition.durable.failed, red),
  },
  {
    align: "right",
    header: "Needs Update",
    render: (definition: StatusDefinition) =>
      String(definition.durable.needsUpdate),
    style: stylePositiveCount(
      (definition) => definition.durable.needsUpdate,
      yellow
    ),
  },
] satisfies readonly TableColumn<StatusDefinition>[];

const sourceStatusColumns = [
  {
    align: "right",
    header: "Total",
    render: (definition: StatusDefinition) =>
      String(definition.source?.total ?? ""),
  },
  {
    align: "right",
    header: "Unprocessed",
    render: (definition: StatusDefinition) =>
      String(definition.source?.unprocessed ?? ""),
    style: stylePositiveCount(
      (definition) => definition.source?.unprocessed ?? 0,
      cyan
    ),
  },
  {
    align: "right",
    header: "Invalid",
    render: (definition: StatusDefinition) =>
      String(definition.source?.invalid ?? ""),
    style: stylePositiveCount(
      (definition) => definition.source?.invalid ?? 0,
      red
    ),
  },
  {
    align: "right",
    header: "Duplicate",
    render: (definition: StatusDefinition) =>
      String(definition.source?.duplicate ?? ""),
    style: stylePositiveCount(
      (definition) => definition.source?.duplicate ?? 0,
      yellow
    ),
  },
  {
    align: "right",
    header: "Orphaned",
    render: (definition: StatusDefinition) =>
      String(definition.source?.orphaned ?? ""),
    style: stylePositiveCount(
      (definition) => definition.source?.orphaned ?? 0,
      yellow
    ),
  },
] satisfies readonly TableColumn<StatusDefinition>[];

const renderStatusTable = (
  report: MigrationDefinitionRegistryStatusReport,
  options: RenderOptions
): readonly string[] =>
  report.definitions.length === 0
    ? ["No Migration Definitions."]
    : renderTable(
        [
          ...durableStatusColumns,
          ...(report.scanSource ? sourceStatusColumns : []),
        ],
        report.definitions,
        options
      );

const renderStatusScope = (
  report: MigrationDefinitionRegistryStatusReport,
  options: RenderOptions
): readonly string[] => {
  const scanLine = report.scanSource
    ? cyan("source inventory", options)
    : dim("durable store only", options);
  const hintLine = report.scanSource
    ? []
    : [
        `Hint       ${dim(
          "Pass --scan-source to include source inventory counts.",
          options
        )}`,
      ];

  return [
    bold("Scope", options),
    `Requested  ${renderRequestedDefinitionIdsInline(report.requestedDefinitionIds)}`,
    `Included   ${renderDefinitionIdInlineList(report.includedDefinitionIds)}`,
    `Scan       ${scanLine}`,
    ...hintLine,
  ];
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
  report: MigrationDefinitionRegistryStatusReport,
  options: RenderOptions = {}
): string =>
  [
    bold("Migration Status", options),
    "",
    ...renderStatusScope(report, options),
    "",
    bold("Definitions", options),
    ...renderStatusTable(report, options),
    ...renderNoticeSection(report.notices),
    ...(report.warnings.length === 0
      ? []
      : [
          "",
          yellow("Warnings:", options),
          ...report.warnings.map((warning) =>
            yellow(`! ${renderStatusWarning(warning)}`, options)
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
