"use client";

import type { MigrationMessage } from "migrate-sdk";
import type {
  MigrateActiveRun,
  MigrateDashboard,
  MigrateDashboardRow,
  MigrateSourceItemTotal,
} from "migrate-sdk/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./migration-widget.module.css";
import { useBrowserMigrateDashboard } from "./use-browser-migrate-dashboard";

interface PendingAction {
  readonly action: "rollback" | "run";
  readonly definitionId: MigrateDashboardRow["entry"]["id"];
}

interface MigrationWidgetProps {
  readonly bearerToken: string;
}

interface MigrationProgress {
  readonly label: string;
  readonly percentage?: number;
}

interface ProgressSegment {
  readonly kind: "failed" | "migrated" | "needs-update" | "skipped";
  readonly percentage: number;
}

interface ActivityEntry {
  readonly id: number;
  readonly message: string;
  readonly occurredAt: Date;
  readonly tone: "danger" | "info" | "success" | "warning";
}

const concurrencyOptions = [1, 2, 4, 8, 16] as const;
type DemoConcurrency = (typeof concurrencyOptions)[number];

const activityLimit = 60;
const activityProgressInterval = 20;

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const activeRunFor = (
  activeRuns: readonly MigrateActiveRun[],
  definitionId: MigrateDashboardRow["entry"]["id"]
): MigrateActiveRun | undefined =>
  activeRuns.find((run) => run.definitionIds.includes(definitionId));

const statusLabel = (
  row: MigrateDashboardRow,
  activeRun: MigrateActiveRun | undefined
): string => {
  if (activeRun !== undefined) {
    return activeRun.status;
  }
  if (row.status === undefined) {
    return "loading";
  }
  if (
    row.status.durable.failed > 0 ||
    row.status.lastRun?.status === "failed"
  ) {
    return "failed";
  }
  if (row.status.durable.needsUpdate > 0) {
    return "needs update";
  }
  if (row.status.lastRun === null) {
    return "not run";
  }
  return row.status.lastRun.status;
};

const itemSummary = (row: MigrateDashboardRow): string => {
  if (row.status === undefined) {
    return "Reading durable state…";
  }

  const { failed, migrated, needsUpdate, skipped } = row.status.durable;
  if (failed + migrated + needsUpdate + skipped === 0) {
    return "No source items processed";
  }

  return [
    migrated > 0 ? `${migrated} migrated` : undefined,
    failed > 0 ? `${failed} failed` : undefined,
    skipped > 0 ? `${skipped} skipped` : undefined,
    needsUpdate > 0 ? `${needsUpdate} need update` : undefined,
  ]
    .filter((value) => value !== undefined)
    .join(" · ");
};

const migrationProgress = (
  row: MigrateDashboardRow,
  total: MigrateSourceItemTotal | undefined,
  isActive: boolean,
  totalsReady: boolean
): MigrationProgress => {
  if (row.status === undefined) {
    return {
      label: isActive
        ? "Waiting for the first checkpoint…"
        : "Reading durable state…",
    };
  }

  if (!totalsReady) {
    return { label: "Reading source total…" };
  }

  if (total === undefined) {
    return { label: "Source total unavailable" };
  }

  if (total.kind === "unknown") {
    return {
      label: isActive ? "Streaming progress…" : "Source total unavailable",
    };
  }

  const { failed, migrated, needsUpdate, skipped } = row.status.durable;
  const observedItems = failed + migrated + needsUpdate + skipped;

  if (total.kind === "lower-bound") {
    return {
      label: `${observedItems} processed · at least ${total.minimum} total${
        isActive ? " · live" : ""
      }`,
    };
  }

  const totalItems = total.count;
  const processed = Math.min(totalItems, observedItems);
  const percentage =
    totalItems === 0 ? 100 : Math.round((processed / totalItems) * 100);

  return {
    label: `${processed} of ${totalItems} items${isActive ? " · live" : ""}`,
    percentage,
  };
};

const progressSegments = (
  row: MigrateDashboardRow,
  total: MigrateSourceItemTotal | undefined
): readonly ProgressSegment[] => {
  if (
    row.status === undefined ||
    total?.kind !== "known" ||
    total.count === 0
  ) {
    return [];
  }

  const counts = row.status.durable;
  return [
    { kind: "migrated" as const, value: counts.migrated },
    { kind: "skipped" as const, value: counts.skipped },
    { kind: "needs-update" as const, value: counts.needsUpdate },
    { kind: "failed" as const, value: counts.failed },
  ]
    .filter(({ value }) => value > 0)
    .map(({ kind, value }) => ({
      kind,
      percentage: Math.min(100, (value / total.count) * 100),
    }));
};

const processedItems = (row: MigrateDashboardRow | undefined): number => {
  if (row?.status === undefined) {
    return 0;
  }
  const { failed, migrated, needsUpdate, skipped } = row.status.durable;
  return failed + migrated + needsUpdate + skipped;
};

const messageKindLabel = (kind: MigrationMessage["kind"]): string => {
  switch (kind) {
    case "item-error":
      return "Item error";
    case "skip-reason":
      return "Skip reason";
    case "update-reason":
      return "Update reason";
    case "process-diagnostic":
      return "Process diagnostic";
    case "rollback-error":
      return "Rollback error";
    case "rollback-diagnostic":
      return "Rollback diagnostic";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};

const messageTone = (
  severity: MigrationMessage["severity"]
): ActivityEntry["tone"] => {
  if (severity === "error") {
    return "danger";
  }
  if (severity === "warning") {
    return "warning";
  }
  return "info";
};

const messageKey = (message: MigrationMessage, index: number): string =>
  [
    message.runId,
    message.definitionId,
    message.sourceIdentity,
    message.kind,
    message.sequence ?? "unsequenced",
    message.updatedAt.toISOString(),
    index,
  ].join(":");

const formatTime = (date: Date): string =>
  date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

export function MigrationWidget({ bearerToken }: MigrationWidgetProps) {
  const activitySequenceRef = useRef(0);
  const activityViewportRef = useRef<HTMLOListElement>(null);
  const messagesViewportRef = useRef<HTMLOListElement>(null);
  const [serverUrl, setServerUrl] = useState("/api/migrate");
  const [activity, setActivity] = useState<readonly ActivityEntry[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pending, setPending] = useState<PendingAction>();
  const [concurrency, setConcurrency] = useState<DemoConcurrency>(1);
  const [rollbackConfirmation, setRollbackConfirmation] =
    useState<MigrateDashboardRow["entry"]["id"]>();

  const appendActivity = useCallback(
    (message: string, tone: ActivityEntry["tone"] = "info"): void => {
      const entry: ActivityEntry = {
        id: activitySequenceRef.current,
        message,
        occurredAt: new Date(),
        tone,
      };
      activitySequenceRef.current += 1;
      setActivity((current) => [...current.slice(-(activityLimit - 1)), entry]);
    },
    []
  );

  const recordDashboardChange = useCallback(
    (previous: MigrateDashboard, next: MigrateDashboard): void => {
      const nextRunIds = new Set(next.activeRuns.map((run) => run.runId));
      const previousRunIds = new Set(
        previous.activeRuns.map((run) => run.runId)
      );

      for (const run of next.activeRuns) {
        if (!previousRunIds.has(run.runId)) {
          appendActivity(
            `Run ${run.runId} is ${run.status} for ${run.definitionIds.join(
              ", "
            )}.`,
            "info"
          );
        }
      }

      for (const run of previous.activeRuns) {
        if (nextRunIds.has(run.runId)) {
          continue;
        }
        const terminalStatuses = next.rows
          .filter((row) => run.definitionIds.includes(row.entry.id))
          .map((row) => row.status?.lastRun)
          .filter((lastRun) => lastRun?.runId === run.runId)
          .map((lastRun) => lastRun?.status);
        const failed = terminalStatuses.includes("failed");
        const terminalMessage = `Run ${run.runId} ${
          failed ? "finished with errors" : "finished"
        }.`;
        setNotice(terminalMessage);
        appendActivity(terminalMessage, failed ? "danger" : "success");
      }

      const previousRows = new Map(
        previous.rows.map((row) => [row.entry.id, row])
      );
      for (const row of next.rows) {
        const previousProcessed = processedItems(
          previousRows.get(row.entry.id)
        );
        const nextProcessed = processedItems(row);
        if (nextProcessed <= previousProcessed || row.status === undefined) {
          continue;
        }
        const previousDurable = previousRows.get(row.entry.id)?.status?.durable;
        const { failed, skipped } = row.status.durable;
        const crossedProgressInterval =
          Math.floor(nextProcessed / activityProgressInterval) >
          Math.floor(previousProcessed / activityProgressInterval);
        const outcomeChanged =
          failed !== (previousDurable?.failed ?? 0) ||
          skipped !== (previousDurable?.skipped ?? 0);
        if (!(crossedProgressInterval || outcomeChanged)) {
          continue;
        }
        appendActivity(
          `${row.entry.id} progress: ${nextProcessed} processed · ${failed} failed · ${skipped} skipped.`,
          failed > 0 ? "warning" : "success"
        );
      }
    },
    [appendActivity]
  );

  const {
    connection,
    connectionError,
    connectionState,
    dashboard,
    environment,
    messages,
    messagesReady,
    sourceTotals,
  } = useBrowserMigrateDashboard({
    bearerToken,
    onActivity: appendActivity,
    onDashboardChange: recordDashboardChange,
  });

  useEffect(() => {
    setServerUrl(`${window.location.origin}/api/migrate`);
  }, []);

  useEffect(() => {
    if (activity.length === 0) {
      return;
    }
    activityViewportRef.current?.scrollTo({
      top: activityViewportRef.current.scrollHeight,
    });
  }, [activity]);

  useEffect(() => {
    if (messages.length === 0) {
      return;
    }
    messagesViewportRef.current?.scrollTo({
      top: messagesViewportRef.current.scrollHeight,
    });
  }, [messages]);

  const startOperation = useCallback(
    (row: MigrateDashboardRow, action: PendingAction["action"]): void => {
      if (connection === undefined || pending !== undefined) {
        return;
      }

      const operation: PendingAction = {
        action,
        definitionId: row.entry.id,
      };
      setPending(operation);
      setError(undefined);
      setNotice(undefined);
      setRollbackConfirmation(undefined);
      appendActivity(
        `${action === "run" ? "Run" : "Rollback"} requested for ${
          row.entry.id
        } with concurrency ${concurrency}.`,
        "info"
      );

      connection
        .runPromise(
          connection.client.PrepareOperation({
            action,
            options: {
              execution:
                action === "run"
                  ? { process: { concurrency } }
                  : { rollback: { concurrency } },
              ...(action === "run" ? { withDependencies: true } : {}),
            },
            selection: {
              definitionIds: [row.entry.id],
              kind: "definitions",
            },
          })
        )
        .then((prepared) =>
          connection.runPromise(
            connection.client.StartOperation({
              acceptedFingerprint: prepared.fingerprint,
              request: prepared.request,
            })
          )
        )
        .then((result) => {
          const message =
            result.status === "started"
              ? `${action === "run" ? "Run" : "Rollback"} ${
                  result.runId
                } started`
              : `${action === "run" ? "Run" : "Rollback"} ${
                  result.runId
                } completed`;
          setNotice(message);
          appendActivity(`${message}.`, "success");
        })
        .catch((cause: unknown) => {
          const message = errorMessage(cause);
          setError(message);
          appendActivity(message, "danger");
        })
        .finally(() => setPending(undefined));
    },
    [appendActivity, concurrency, connection, pending]
  );

  const tuiCommand = `MIGRATE_SERVER_TOKEN="${bearerToken}" pnpm dlx @migrate-sdk/tui --server "${serverUrl}"`;

  const copyCommand = useCallback((): void => {
    navigator.clipboard.writeText(tuiCommand).then(
      () => setNotice("TUI command copied"),
      (cause: unknown) => setError(errorMessage(cause))
    );
  }, [tuiCommand]);
  const displayedError = error ?? connectionError;

  return (
    <section aria-label="Browser migration controls" className={styles.shell}>
      <header className={styles.toolbar}>
        <div>
          <p className={styles.kicker}>Browser Migrate Client</p>
          <h2>Catalog migrations</h2>
        </div>
        <div className={styles.connectionGroup}>
          <span>{environment}</span>
          <span className={styles.connection} data-status={connectionState}>
            {connectionState}
          </span>
        </div>
      </header>

      <div className={styles.commandPanel}>
        <div>
          <span>Open the complete TUI in your terminal</span>
          <code>{tuiCommand}</code>
        </div>
        <button onClick={copyCommand} type="button">
          Copy command
        </button>
      </div>

      <div className={styles.liveMode}>
        <div className={styles.liveModeCopy}>
          <span>Durable progress</span>
          <strong>Watch every durable checkpoint as it completes.</strong>
        </div>
        <label className={styles.concurrencyControl}>
          <span>Concurrency</span>
          <select
            aria-describedby="concurrency-guidance"
            onChange={(event) => {
              const nextConcurrency = Number(event.currentTarget.value);
              if (
                concurrencyOptions.includes(nextConcurrency as DemoConcurrency)
              ) {
                setConcurrency(nextConcurrency as DemoConcurrency);
              }
            }}
            value={concurrency}
          >
            {concurrencyOptions.map((option) => (
              <option key={option} value={option}>
                {option === 1 ? "1 · demo pace" : option}
              </option>
            ))}
          </select>
          <small id="concurrency-guidance">
            Raise it to finish faster. Applies to new runs.
          </small>
        </label>
      </div>

      <div className={styles.migrationGrid}>
        {dashboard === undefined ? (
          <p className={styles.empty}>
            {connectionState === "error"
              ? "Migrations are unavailable."
              : "Connecting to Migrate Server…"}
          </p>
        ) : (
          dashboard.rows.map((row) => {
            const activeRun = activeRunFor(dashboard.activeRuns, row.entry.id);
            const status = statusLabel(row, activeRun);
            const total = sourceTotals?.get(row.entry.id);
            const progress = migrationProgress(
              row,
              total,
              activeRun !== undefined,
              sourceTotals !== undefined
            );
            const segments = progressSegments(row, total);
            const isPending = pending?.definitionId === row.entry.id;
            const hasPendingAction = pending !== undefined;
            const confirmsRollback = rollbackConfirmation === row.entry.id;

            return (
              <article className={styles.migration} key={row.entry.id}>
                <div className={styles.migrationHeader}>
                  <span
                    aria-hidden="true"
                    className={styles.statusIcon}
                    data-status={status}
                  />
                  <h3>{row.entry.id}</h3>
                  <span className={styles.badge} data-status={status}>
                    {status}
                  </span>
                </div>
                <p className={styles.summary}>{itemSummary(row)}</p>
                <div className={styles.progressMeta}>
                  <span>{progress.label}</span>
                  {activeRun === undefined ? null : (
                    <span className={styles.streaming}>Streaming</span>
                  )}
                </div>
                <div
                  aria-label={`${row.entry.id} migration progress`}
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={progress.percentage}
                  className={styles.progressTrack}
                  role="progressbar"
                >
                  {segments.map((segment) => (
                    <span
                      data-kind={segment.kind}
                      key={segment.kind}
                      style={{ width: `${segment.percentage}%` }}
                    />
                  ))}
                </div>
                <div className={styles.legend}>
                  <span data-kind="migrated">Migrated</span>
                  <span data-kind="skipped">Skipped</span>
                  <span data-kind="failed">Failed</span>
                </div>
                {activeRun === undefined ? null : (
                  <p className={styles.runId}>Run {activeRun.runId}</p>
                )}
                {activeRun === undefined && status === "succeeded" ? (
                  <p className={styles.replayHint}>
                    Roll back first to replay this migration from the beginning.
                  </p>
                ) : null}

                {confirmsRollback ? (
                  <fieldset className={styles.confirmation}>
                    <legend>
                      Roll back <strong>{row.entry.id}</strong>?
                    </legend>
                    <div>
                      <button
                        className={styles.dangerButton}
                        disabled={activeRun !== undefined || hasPendingAction}
                        onClick={() => startOperation(row, "rollback")}
                        type="button"
                      >
                        Confirm rollback
                      </button>
                      <button
                        className={styles.secondaryButton}
                        onClick={() => setRollbackConfirmation(undefined)}
                        type="button"
                      >
                        Cancel
                      </button>
                    </div>
                  </fieldset>
                ) : (
                  <div className={styles.actions}>
                    <button
                      className={styles.primaryButton}
                      disabled={activeRun !== undefined || hasPendingAction}
                      onClick={() => startOperation(row, "run")}
                      type="button"
                    >
                      {isPending && pending?.action === "run"
                        ? "Starting…"
                        : "Run"}
                    </button>
                    <button
                      className={styles.secondaryButton}
                      disabled={
                        !row.entry.hasRollback ||
                        activeRun !== undefined ||
                        hasPendingAction
                      }
                      onClick={() => setRollbackConfirmation(row.entry.id)}
                      type="button"
                    >
                      Rollback
                    </button>
                  </div>
                )}
              </article>
            );
          })
        )}
      </div>

      <div className={styles.streamGrid}>
        <section className={styles.streamPanel}>
          <header>
            <div>
              <span>Live session</span>
              <h3>Activity</h3>
            </div>
            <strong>{activity.length} events</strong>
          </header>
          <ol aria-live="polite" ref={activityViewportRef}>
            {activity.length === 0 ? (
              <li className={styles.streamEmpty}>Waiting for activity…</li>
            ) : (
              activity.map((entry, index) => (
                <li data-tone={entry.tone} key={entry.id}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <time dateTime={entry.occurredAt.toISOString()}>
                    {formatTime(entry.occurredAt)}
                  </time>
                  <p>{entry.message}</p>
                </li>
              ))
            )}
          </ol>
        </section>

        <section className={styles.streamPanel}>
          <header>
            <div>
              <span>Durable state</span>
              <h3>Migration messages</h3>
            </div>
            <strong>{messages.length} messages</strong>
          </header>
          <ol aria-live="polite" ref={messagesViewportRef}>
            {messagesReady ? null : (
              <li className={styles.streamEmpty}>Loading messages…</li>
            )}
            {messagesReady && messages.length === 0 ? (
              <li className={styles.streamEmpty}>
                Messages will appear when an item is skipped or fails.
              </li>
            ) : null}
            {messages.map((message, index) => (
              <li
                data-tone={messageTone(message.severity)}
                key={messageKey(message, index)}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <time dateTime={message.updatedAt.toISOString()}>
                  {formatTime(message.updatedAt)}
                </time>
                <div>
                  <p>
                    <strong>{message.definitionId}</strong> · {message.message}
                  </p>
                  <small>
                    {messageKindLabel(message.kind)} · Source identity{" "}
                    {message.sourceIdentity}
                  </small>
                  {message.details === undefined ? null : (
                    <details>
                      <summary>Details</summary>
                      <pre>{JSON.stringify(message.details, null, 2)}</pre>
                    </details>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <footer aria-live="polite" className={styles.footer}>
        {displayedError ? (
          <span className={styles.error}>{displayedError}</span>
        ) : null}
        {!displayedError && notice ? <span>{notice}</span> : null}
        {displayedError || notice ? null : (
          <span>Live state from the same Migrate Server as the TUI</span>
        )}
      </footer>
    </section>
  );
}
