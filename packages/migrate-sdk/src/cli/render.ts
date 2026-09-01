import type {
  MigrationDefinitionGroupId,
  MigrationDefinitionId,
} from "../domain/ids.ts";
import type {
  MigrationDefinitionPlanNotice,
  MigrationDefinitionRegistry,
  MigrationDefinitionRegistryConstructionIssue,
  MigrationDefinitionRegistryEntry,
  MigrationDefinitionRegistryMessagesReport,
  MigrationDefinitionRegistryPlanningError,
  MigrationDefinitionRegistrySelectionReport,
  MigrationDefinitionRegistryStatusReport,
} from "../domain/registry.ts";
import type {
  MigrateActiveRun,
  MigrateObservationEvent,
  MigratePlanProjection,
  MigratePreparedOperation,
  MigrateRunStopResult,
  MigrateTerminalSummary,
} from "../protocol/index.ts";
import type { SqlMigrationStoreSchemaPlan } from "../stores/sql/sql-migration-store-schema.ts";

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

export const renderActiveMigrationRuns = (
  runs: readonly MigrateActiveRun[],
  options: RenderOptions = {}
): string => {
  if (runs.length === 0) {
    return [bold("Active Migration Runs", options), "No active runs."].join(
      "\n"
    );
  }

  return [
    bold("Active Migration Runs", options),
    "",
    ...renderTable(
      [
        {
          header: "Run ID",
          render: (run) => run.runId,
        },
        {
          header: "Status",
          render: (run) => run.status,
          style: (value, run, renderOptions) =>
            run.status === "cancelling"
              ? yellow(value, renderOptions)
              : cyan(value, renderOptions),
        },
        {
          header: "Definitions",
          render: (run) => run.definitionIds.join(", "),
        },
        {
          header: "Adapter",
          render: (run) => run.execution?.adapter ?? "inline",
        },
        {
          header: "Started",
          render: (run) => run.startedAt.toISOString(),
        },
        {
          header: "Stop",
          render: (run) => (run.stopSupported ? "supported" : "unsupported"),
        },
      ],
      runs,
      options
    ),
  ].join("\n");
};

export const renderMigrationObservationEvent = (
  event: MigrateObservationEvent,
  options: RenderOptions = {}
): string => {
  switch (event.kind) {
    case "state":
      return event.state.kind === "starting"
        ? `Starting ${event.state.definitionId}`
        : `${event.state.kind === "cancelling" ? yellow("Cancelling", options) : cyan("Running", options)} ${event.state.definitionId}`;
    case "progress":
      return [
        bold("Progress", options),
        ...renderTable(
          [
            {
              header: "Migration ID",
              render: (definition) => definition.definitionId,
            },
            {
              align: "right",
              header: "Migrated",
              render: (definition) => String(definition.durable.migrated),
            },
            {
              align: "right",
              header: "Skipped",
              render: (definition) => String(definition.durable.skipped),
            },
            {
              align: "right",
              header: "Needs Update",
              render: (definition) => String(definition.durable.needsUpdate),
            },
            {
              align: "right",
              header: "Failed",
              render: (definition) => String(definition.durable.failed),
              style: (value, definition, renderOptions) =>
                definition.durable.failed > 0
                  ? red(value, renderOptions)
                  : value,
            },
          ],
          event.definitions,
          options
        ),
      ].join("\n");
    case "warning":
      return `${yellow("Warning", options)} ${event.message}`;
    case "detached":
      return `${event.message}\nRun id ${event.runId}`;
    case "terminal":
      return event.summary === undefined
        ? `${event.message}\nRun id ${event.runId}`
        : renderMigrationTerminalSummary(event.summary, options);
    default: {
      const unhandled: never = event;
      return unhandled;
    }
  }
};

export const renderRunStopResult = (
  result: MigrateRunStopResult,
  options: RenderOptions = {}
): string => {
  let title = "Stop Unsupported";

  if (result.kind === "requested") {
    title = yellow("Stop Requested", options);
  } else if (result.kind === "not-running") {
    title = "Run Not Active";
  }

  return [title, `Run id ${result.runId}`, result.message].join("\n");
};

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
          header: "Group",
          render: (entry) => entry.group ?? "-",
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
  requestedDefinitionIds: MigratePlanProjection["requestedDefinitionIds"]
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

const renderConcurrency = (value: number | "unbounded"): string =>
  value === "unbounded" ? value : String(value);

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

const incrementalDiscoveryWarning = (
  definitionId: MigrationDefinitionId,
  restartsFromBeginning: boolean
): string =>
  restartsFromBeginning
    ? `${definitionId} uses incremental source discovery. This run starts from the beginning and will retain the new high-water cursor for later runs.`
    : `${definitionId} uses incremental source discovery. Once a cursor is saved, changes at or before it will not be discovered. Pass --rescan to scan from the beginning.`;

function renderWarningSection(
  warnings: readonly string[],
  options: RenderOptions,
  includeLeadingBlank = true
): readonly string[] {
  if (warnings.length === 0) {
    return [];
  }

  return [
    ...(includeLeadingBlank ? [""] : []),
    yellow("Warnings:", options),
    ...warnings.map((warning) => yellow(`! ${warning}`, options)),
  ];
}

const renderPlanScope = (
  input: {
    readonly force?: boolean;
    readonly includedDefinitionIds: readonly MigrationDefinitionId[];
    readonly mode?: "failed" | "skipped";
    readonly requestedGroup?: MigrationDefinitionGroupId;
    readonly requestedDefinitionIds: MigratePlanProjection["requestedDefinitionIds"];
    readonly rescan?: boolean;
    readonly rollbackOrphans?: boolean;
    readonly sourceIdentities?: readonly string[];
    readonly update?: boolean;
  },
  options: RenderOptions
): readonly string[] => [
  bold("Scope", options),
  ...(input.requestedGroup === undefined
    ? []
    : [`Group      ${input.requestedGroup}`]),
  `Requested  ${renderRequestedDefinitionIdsInline(input.requestedDefinitionIds)}`,
  `Included   ${renderDefinitionIdInlineList(input.includedDefinitionIds)}`,
  ...(input.force === true ? ["Force      yes"] : []),
  ...(input.mode === undefined ? [] : [`Mode       ${input.mode}`]),
  ...(input.rescan === true ? ["Rescan     yes"] : []),
  ...(input.rollbackOrphans === true ? ["Rollback orphans  yes"] : []),
  ...(input.update === true ? ["Update     yes"] : []),
  ...(input.sourceIdentities === undefined
    ? []
    : [`Target source identities ${input.sourceIdentities.join(", ")}`]),
];

const projectedRunDiscoveryWarningLines = (
  operation: MigratePreparedOperation
): readonly string[] => {
  if (
    operation.action === "rollback" ||
    operation.action === "retry-failed" ||
    operation.action === "retry-skipped" ||
    operation.sourceIdentities !== undefined
  ) {
    return [];
  }

  const restartsFromBeginning =
    operation.plan.rescan === true || operation.action === "update";

  return operation.plan.executionPolicy
    .filter((policy) => policy.discovery === "incremental")
    .map((policy) =>
      incrementalDiscoveryWarning(policy.definitionId, restartsFromBeginning)
    );
};

export const renderPreparedOperationWarnings = (
  operation: MigratePreparedOperation,
  options: RenderOptions = {}
): string =>
  renderWarningSection(
    projectedRunDiscoveryWarningLines(operation),
    options,
    false
  ).join("\n");

export const renderPreparedOperationDependencyFailure = (
  operation: MigratePreparedOperation
): string => {
  const failures = operation.dependencyChecks.filter(
    (dependency) => !dependency.satisfied
  );

  return [
    "Migration Definition required dependency state is not satisfied",
    ...failures.map((dependency) => {
      const state = dependency.row?.status;
      let reason: string;

      if (state?.lastRun === null || state === undefined) {
        reason = `${dependency.dependencyId} has no completed Migration Run State`;
      } else if (state.durable.failed > 0) {
        reason = `${dependency.dependencyId} has failed Migration Item State (failed=${state.durable.failed})`;
      } else {
        reason = `${dependency.dependencyId} latest run is ${state.lastRun.status}`;
      }

      return `${dependency.requiredByDefinitionId} requires ${dependency.dependencyId}, but ${reason}.`;
    }),
    `Run ${[...new Set(failures.map((failure) => failure.dependencyId))].join(
      ", "
    )} without failures, rerun with --with-dependencies, or use --force.`,
  ].join("\n");
};

type PreparedExecutionPolicy =
  MigratePreparedOperation["plan"]["executionPolicy"][number];

const executionPolicyIdentityColumns: readonly TableColumn<PreparedExecutionPolicy>[] =
  [
    {
      align: "right",
      header: "#",
      render: (_policy, index) => String(index + 1),
    },
    {
      header: "Migration ID",
      render: (policy) => policy.definitionId,
    },
  ];

const renderRunExecutionPolicy = (
  executionPolicy: readonly PreparedExecutionPolicy[],
  options: RenderOptions
): readonly string[] =>
  renderTable(
    [
      ...executionPolicyIdentityColumns,
      {
        header: "Discovery",
        render: (policy) => policy.discovery ?? "full",
      },
      {
        align: "right",
        header: "Process Concurrency",
        render: (policy) => renderConcurrency(policy.processConcurrency),
      },
    ],
    executionPolicy,
    options
  );

const renderRollbackExecutionPolicy = (
  executionPolicy: readonly PreparedExecutionPolicy[],
  options: RenderOptions
): readonly string[] =>
  renderTable(
    [
      ...executionPolicyIdentityColumns,
      {
        align: "right",
        header: "Rollback Concurrency",
        render: (policy) => renderConcurrency(policy.rollbackConcurrency),
      },
    ],
    executionPolicy,
    options
  );

const renderPreparedDependencyChecks = (
  operation: MigratePreparedOperation,
  options: RenderOptions
): readonly string[] => {
  if (operation.action === "rollback") {
    return [];
  }

  return [
    "",
    bold("Dependency Preflight", options),
    ...(operation.dependencyChecks.length === 0
      ? [dim("No omitted required dependencies.", options)]
      : renderTable(
          [
            {
              align: "right",
              header: "#",
              render: (_check, index) => String(index + 1),
            },
            {
              header: "Migration ID",
              render: (check) => check.dependencyId,
            },
            {
              header: "Required By",
              render: (check) => check.requiredByDefinitionId,
            },
          ],
          operation.dependencyChecks,
          options
        )),
  ];
};

export const renderPreparedOperationPlan = (
  operation: MigratePreparedOperation,
  options: RenderOptions = {}
): string => {
  const rollback = operation.action === "rollback";
  let mode: "failed" | "skipped" | undefined;

  if (operation.action === "retry-failed") {
    mode = "failed";
  } else if (operation.action === "retry-skipped") {
    mode = "skipped";
  }
  const executionPolicy = operation.plan.executionPolicy;
  const policyTable = rollback
    ? renderRollbackExecutionPolicy(executionPolicy, options)
    : renderRunExecutionPolicy(executionPolicy, options);

  return [
    bold(rollback ? "Rollback Plan" : "Run Plan", options),
    "",
    ...renderPlanScope(
      {
        ...(operation.plan.force === undefined
          ? {}
          : { force: operation.plan.force }),
        includedDefinitionIds: operation.plan.includedDefinitionIds,
        ...(mode === undefined ? {} : { mode }),
        requestedDefinitionIds: operation.plan.requestedDefinitionIds,
        ...(operation.plan.requestedGroup === undefined
          ? {}
          : { requestedGroup: operation.plan.requestedGroup }),
        ...(operation.plan.rescan === undefined
          ? {}
          : { rescan: operation.plan.rescan }),
        ...(operation.plan.rollbackOrphans === undefined
          ? {}
          : { rollbackOrphans: operation.plan.rollbackOrphans }),
        ...(operation.sourceIdentities === undefined
          ? {}
          : { sourceIdentities: operation.sourceIdentities }),
        ...(operation.action === "update" ? { update: true } : {}),
      },
      options
    ),
    "",
    bold("Execution Order", options),
    ...renderExecutionOrderTable(
      operation.plan.executionDefinitionIds,
      options
    ),
    ...renderPreparedDependencyChecks(operation, options),
    "",
    bold("Execution Policy", options),
    ...(executionPolicy.length === 0
      ? [dim("No definitions.", options)]
      : policyTable),
    ...renderNoticeSection(operation.plan.notices, options),
    ...renderWarningSection(
      projectedRunDiscoveryWarningLines(operation),
      options
    ),
  ].join("\n");
};

type StatusDefinition =
  MigrationDefinitionRegistryStatusReport["definitions"][number];

type DefinitionState =
  | "failed"
  | "new"
  | "ok"
  | "pending"
  | "running"
  | "skipped"
  | "warning";

const latestStatus = (definition: StatusDefinition): string =>
  definition.lastRun === null ? "none" : definition.lastRun.status;

const lockStatus = (definition: StatusDefinition): "clear" | "locked" =>
  definition.lock == null ? "clear" : "locked";

const hasDurableItems = (definition: StatusDefinition): boolean =>
  definition.durable.migrated > 0 ||
  definition.durable.skipped > 0 ||
  definition.durable.failed > 0 ||
  definition.durable.needsUpdate > 0;

const definitionState = (definition: StatusDefinition): DefinitionState => {
  const source = definition.source;

  if (lockStatus(definition) === "locked") {
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
    definition.lastRun?.status === "running" ||
    definition.lastRun?.status === "cancelling"
  ) {
    return "warning";
  }

  if (definition.lastRun?.status === "skipped") {
    return "skipped";
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
    case "skipped":
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
    case "cancelling":
      return yellow(value, options);
    default:
      return dim(value, options);
  }
};

const styleLockStatus = (
  value: string,
  definition: StatusDefinition,
  options: RenderOptions
): string =>
  lockStatus(definition) === "locked"
    ? yellow(value, options)
    : dim(value, options);

const stylePositiveCount =
  <Row>(
    getValue: (row: Row) => number,
    style: (value: string, options: RenderOptions) => string
  ) =>
  (value: string, row: Row, options: RenderOptions): string =>
    getValue(row) > 0 ? style(value, options) : value;

const styleCompletionStatus = (
  value: string,
  status: "cancelled" | "failed" | "skipped" | "succeeded",
  options: RenderOptions
): string => {
  switch (status) {
    case "cancelled":
      return yellow(value, options);
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

type MigrateRunTerminalSummary = Extract<
  MigrateTerminalSummary,
  { readonly kind: "run" }
>;
type MigrateRollbackTerminalSummary = Extract<
  MigrateTerminalSummary,
  { readonly kind: "rollback" }
>;

const renderRunTerminalSummaryTable = (
  summary: MigrateRunTerminalSummary,
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
        style: (value, definition, renderOptions) =>
          styleCompletionStatus(value, definition.status, renderOptions),
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
      ...(summary.definitions.some(
        (definition) => definition.counts.orphaned !== undefined
      )
        ? [
            {
              align: "right" as const,
              header: "Orphaned",
              render: (
                definition: MigrateRunTerminalSummary["definitions"][number]
              ) => String(definition.counts.orphaned ?? 0),
            },
            {
              align: "right" as const,
              header: "Rolled Back",
              render: (
                definition: MigrateRunTerminalSummary["definitions"][number]
              ) => String(definition.counts.rolledBack ?? 0),
            },
            {
              align: "right" as const,
              header: "Rollback Failed",
              render: (
                definition: MigrateRunTerminalSummary["definitions"][number]
              ) => String(definition.counts.rollbackFailed ?? 0),
              style: stylePositiveCount(
                (
                  definition: MigrateRunTerminalSummary["definitions"][number]
                ) => definition.counts.rollbackFailed ?? 0,
                red
              ),
            },
          ]
        : []),
    ],
    summary.definitions,
    options
  );

const renderRollbackTerminalSummaryTable = (
  summary: MigrateRollbackTerminalSummary,
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
        style: (value, definition, renderOptions) =>
          styleCompletionStatus(value, definition.status, renderOptions),
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

export function renderMigrationTerminalSummary(
  summary: MigrateTerminalSummary,
  options: RenderOptions = {}
): string {
  const rollback = summary.kind === "rollback";

  return [
    `${bold(rollback ? "Rollback Completed" : "Run Completed", options)} ${styleCompletionStatus(
      summary.status,
      summary.status,
      options
    )}`,
    `Run id  ${summary.runId}`,
    "",
    bold("Definitions", options),
    ...(rollback
      ? renderRollbackTerminalSummaryTable(summary, options)
      : renderRunTerminalSummaryTable(summary, options)),
  ].join("\n");
}

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
    header: "Discovery",
    render: (definition: StatusDefinition) => definition.discovery,
  },
  {
    header: "Last Run",
    render: latestStatus,
    style: styleLatestStatus,
  },
  {
    header: "Lock",
    render: lockStatus,
    style: styleLockStatus,
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

const renderRegistrySelectionScope = (
  report: MigrationDefinitionRegistrySelectionReport,
  options: RenderOptions
): readonly string[] => [
  bold("Scope", options),
  ...(report.requestedGroup === undefined
    ? []
    : [`Group      ${report.requestedGroup}`]),
  `Requested  ${renderRequestedDefinitionIdsInline(report.requestedDefinitionIds)}`,
  `Included   ${renderDefinitionIdInlineList(report.includedDefinitionIds)}`,
];

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
    ...renderRegistrySelectionScope(report, options),
    `Scan       ${scanLine}`,
    ...hintLine,
  ];
};

const renderStatusWarning = (
  warning: MigrationDefinitionRegistryStatusReport["warnings"][number]
): string => {
  switch (warning._tag) {
    case "DuplicateSourceIdentityStatusWarning": {
      const sourceIdentityParts =
        warning.sourceIdentityParts === undefined
          ? ""
          : ` (${warning.sourceIdentityParts
              .map((part) => `${part.name}=${String(part.value)}`)
              .join(", ")})`;

      return `Duplicate source identity in ${warning.definitionId}: ${warning.sourceIdentity}${sourceIdentityParts} (${warning.count} duplicate item(s)). Check the source identity mapping.`;
    }
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
): string => {
  const discoveryWarnings = report.definitions
    .filter((definition) => definition.discovery === "incremental")
    .map((definition) =>
      incrementalDiscoveryWarning(definition.definitionId, false)
    );
  const statusWarnings = report.warnings.map(renderStatusWarning);

  return [
    bold("Migration Status", options),
    "",
    ...renderStatusScope(report, options),
    "",
    bold("Definitions", options),
    ...renderStatusTable(report, options),
    ...renderNoticeSection(report.notices),
    ...renderWarningSection([...discoveryWarnings, ...statusWarnings], options),
  ].join("\n");
};

const renderMessageSeverity = (
  severity: MigrationDefinitionRegistryMessagesReport["messages"][number]["severity"],
  options: RenderOptions
): string => {
  const label = severity.toUpperCase();

  switch (severity) {
    case "error":
      return red(label, options);
    case "warning":
      return yellow(label, options);
    case "info":
      return cyan(label, options);
    default: {
      const exhaustive: never = severity;
      return exhaustive;
    }
  }
};

const renderMessageDetails = (
  details: Exclude<
    MigrationDefinitionRegistryMessagesReport["messages"][number]["details"],
    undefined
  >
): readonly string[] => {
  const json = JSON.stringify(details, null, 2) ?? String(details);

  return ["Details", ...json.split("\n").map((line) => `  ${line}`)];
};

export const renderMessagesReport = (
  report: MigrationDefinitionRegistryMessagesReport,
  options: RenderOptions = {}
): string => {
  const messageLines = report.messages.flatMap((message, index) => [
    `${index + 1}. ${renderMessageSeverity(message.severity, options)}  Migration Definition ${message.definitionId} · Source identity ${message.sourceIdentity}`,
    `   ${message.kind.replaceAll("-", " ")} · run ${message.runId} · ${message.updatedAt.toISOString()}`,
    `   ${message.message}`,
    ...(message.details === undefined
      ? []
      : renderMessageDetails(message.details).map((line) => `   ${line}`)),
    ...(index === report.messages.length - 1 ? [] : [""]),
  ]);

  return [
    bold("Migration Messages", options),
    "",
    ...renderRegistrySelectionScope(report, options),
    "",
    ...(report.messages.length === 0 ? ["No messages."] : messageLines),
    ...renderNoticeSection(report.notices),
  ].join("\n");
};

const renderSchemaStatus = (
  plan: SqlMigrationStoreSchemaPlan,
  options: RenderOptions
): string => {
  switch (plan.status) {
    case "current":
      return green(plan.status, options);
    case "not-installed":
    case "upgrade-required":
      return yellow(plan.status, options);
    case "divergent":
    case "future":
    case "partial":
    case "untracked":
      return red(plan.status, options);
    default: {
      const exhaustive: never = plan.status;
      return exhaustive;
    }
  }
};

export const renderSqlMigrationStoreSchemaPlan = (
  plan: SqlMigrationStoreSchemaPlan,
  options: RenderOptions = {}
): string => {
  const applied =
    plan.applied.length === 0
      ? ["- none"]
      : plan.applied.map((migration) => `- ${migration.id} ${migration.name}`);
  const pending =
    plan.pending.length === 0
      ? ["- none"]
      : plan.pending.map(
          (migration) =>
            `- ${migration.id} ${migration.name}: ${migration.description}`
        );

  return [
    bold("SQL Migration Store Schema", options),
    "",
    `Status           ${renderSchemaStatus(plan, options)}`,
    `Database         ${plan.database}`,
    `Table prefix     ${plan.tablePrefix}`,
    `Current version  ${plan.currentVersion ?? "not installed"}`,
    `Target version   ${plan.targetVersion}`,
    `Plan ID          ${plan.planId}`,
    "",
    bold("Applied migrations", options),
    ...applied,
    "",
    bold("Pending migrations", options),
    ...pending,
    ...(plan.issues.length === 0
      ? []
      : [
          "",
          bold("Issues", options),
          ...plan.issues.map((issue) => `- ${issue}`),
        ]),
    ...(plan.warnings.length === 0
      ? []
      : [
          "",
          bold("Warnings", options),
          ...plan.warnings.map((warning) => `- ${warning}`),
        ]),
  ].join("\n");
};

const formatPlanCommand = (
  command: "messages" | "rollback" | "run" | "status",
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
  command: "messages" | "rollback" | "run" | "status",
  modeFlags: readonly string[]
): readonly string[] =>
  command === "status"
    ? ["--with-dependencies"]
    : ["--plan", ...modeFlags, "--with-dependencies"];

const missingDependencyExplicitFlags = (
  command: "messages" | "rollback" | "run" | "status",
  modeFlags: readonly string[]
): readonly string[] =>
  command === "messages" || command === "status"
    ? []
    : ["--plan", ...modeFlags];

export const renderPlanningError = (
  error: MigrationDefinitionRegistryPlanningError,
  input: {
    readonly command: "messages" | "rollback" | "run" | "status";
    readonly definitionIds: readonly string[];
    readonly group?: string;
    readonly hasTarget: boolean;
    readonly mode?: "failed" | "skipped";
    readonly rescan?: boolean;
    readonly rollbackOrphans?: boolean;
    readonly update?: boolean;
  }
): string => {
  switch (error._tag) {
    case "MigrationDefinitionRegistryInvalidSelectionError":
      return error.message;
    case "MigrationDefinitionRegistryUnknownDefinitionError":
      return `${error.message}: ${error.definitionId}`;
    case "MigrationDefinitionRegistryUnknownGroupError":
      return `${error.message}: ${error.group}`;
    case "MigrationDefinitionRegistryMissingExplicitRequiredDependenciesError": {
      const definitionIdsWithMissingDependencies = dedupeStrings([
        ...error.missingDependencyIds,
        ...input.definitionIds,
      ]);
      const modeFlags =
        input.mode === undefined ? [] : ([`--${input.mode}`] as const);
      const runOptionFlags =
        input.command === "run"
          ? [
              ...(input.rescan === true ? ["--rescan"] : []),
              ...(input.rollbackOrphans === true ? ["--rollback-orphans"] : []),
              ...(input.update === true ? ["--update"] : []),
              ...modeFlags,
            ]
          : modeFlags;
      const selectionFlags =
        input.group === undefined ? [] : ["--group", input.group];
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
          [
            ...missingDependencyExpansionFlags(input.command, runOptionFlags),
            ...selectionFlags,
          ],
          input.definitionIds
        ),
        ...(input.group === undefined
          ? [
              formatPlanCommand(
                input.command,
                missingDependencyExplicitFlags(input.command, runOptionFlags),
                definitionIdsWithMissingDependencies
              ),
            ]
          : []),
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
