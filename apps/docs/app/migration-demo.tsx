"use client";

import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import styles from "./migration-demo.module.css";

const workModes = [
  { id: "individual", label: "Individual" },
  { id: "groups", label: "Groups" },
  { id: "all", label: "All" },
] as const;

const workGroups = [
  { id: "content", label: "Content group" },
  { id: "routing", label: "Routing group" },
] as const;

type WorkMode = (typeof workModes)[number]["id"];
type WorkGroup = (typeof workGroups)[number]["id"];

interface DemoMigration {
  group: WorkGroup;
  id: string;
  name: string;
  requires: string[];
}

const migrations: DemoMigration[] = [
  { id: "authors", name: "Authors", group: "content", requires: [] },
  { id: "images", name: "Images", group: "content", requires: [] },
  {
    id: "articles",
    name: "Articles",
    group: "content",
    requires: ["authors", "images"],
  },
  { id: "pages", name: "Pages", group: "content", requires: [] },
  { id: "redirects", name: "Redirects", group: "routing", requires: [] },
];

function resolveWorkSelection(ids: string[]) {
  const visited = new Set<string>();
  const ordered: DemoMigration[] = [];
  function include(migration: DemoMigration) {
    if (visited.has(migration.id)) {
      return;
    }
    visited.add(migration.id);
    for (const requiredId of migration.requires) {
      const dependency = migrations.find((entry) => entry.id === requiredId);
      if (dependency) {
        include(dependency);
      }
    }
    ordered.push(migration);
  }
  for (const migration of migrations) {
    if (ids.includes(migration.id)) {
      include(migration);
    }
  }
  return ordered;
}

const items = Array.from({ length: 20 }, (_, index) => index + 1);

function sourceId(number: number) {
  return `article-${String(number).padStart(3, "0")}`;
}

const itemModes = [
  { id: "limit", label: "Limit the run" },
  { id: "ids", label: "Specific IDs" },
  { id: "all", label: "All items" },
] as const;

type ItemMode = (typeof itemModes)[number]["id"];

interface ItemOutcome {
  attempts: number;
  status: "completed" | "failed";
}

interface ItemRun {
  attempted: number;
  failed: number;
  mode: ItemMode;
  retried: number;
  running: boolean;
  targets: number[];
  unchanged: number;
}

interface ItemProgress {
  outcomes: Partial<Record<number, ItemOutcome>>;
  run: ItemRun | null;
  runCount: number;
}

const initialItemProgress: ItemProgress = {
  outcomes: {},
  run: null,
  runCount: 0,
};

function advanceItemRun(current: ItemProgress): ItemProgress {
  const run = current.run;
  if (!run?.running) {
    return current;
  }
  const number = run.targets[run.attempted];
  if (number === undefined) {
    return current;
  }
  const previous = current.outcomes[number];
  // A transient failure makes the next eligible-item run visible in the example.
  const failed = number === 3 && previous === undefined;
  const attempted = run.attempted + 1;
  return {
    ...current,
    outcomes: {
      ...current.outcomes,
      [number]: {
        attempts: (previous?.attempts ?? 0) + 1,
        status: failed ? "failed" : "completed",
      },
    },
    run: {
      ...run,
      attempted,
      failed: run.failed + Number(failed),
      retried: run.retried + Number(previous?.status === "failed"),
      running: attempted < run.targets.length,
    },
  };
}

function itemProgressSummary(outcomes: ItemProgress["outcomes"]) {
  const processed = Object.values(outcomes).filter(
    (item) => item !== undefined
  );
  const completed = processed.filter(
    (item) => item.status === "completed"
  ).length;
  const failed = processed.length - completed;
  let text = `${processed.length} of ${items.length} items processed`;
  if (processed.length > 0) {
    text += ` · ${completed} completed`;
  }
  if (failed > 0) {
    text += ` · ${failed} failed`;
  }
  return { text, failed };
}

function itemRunDetail(run: ItemRun | null) {
  if (!run) {
    return "";
  }
  if (run.running) {
    if (run.mode === "ids") {
      return "Processing eligible selected items. Unchanged items keep their saved results.";
    }
    return "Processing eligible items. Unchanged items keep their saved results.";
  }
  if (run.failed > 0) {
    return "003 failed once. It is eligible again on the next run.";
  }
  if (run.mode === "ids") {
    const processed = `${run.attempted} ${run.attempted === 1 ? "item" : "items"} processed`;
    return run.unchanged > 0
      ? `This run: ${processed} · ${run.unchanged} left unchanged.`
      : `This run: ${processed}.`;
  }
  const unchanged = `${run.unchanged} completed items left unchanged`;
  if (run.retried > 0) {
    return `This run: ${run.retried} retried + ${run.attempted - run.retried} new items. ${unchanged}.`;
  }
  return `This run: ${run.attempted} new items. ${unchanged}.`;
}

function Command({ children }: { children: string }) {
  return (
    <div className={styles.command}>
      <span aria-hidden="true">$</span>
      <code>{children}</code>
    </div>
  );
}

function Selection() {
  const [mode, setMode] = useState<WorkMode>("individual");
  const [selectedIds, setSelectedIds] = useState(["articles"]);
  const [selectedGroup, setSelectedGroup] = useState<WorkGroup>("content");
  const id = useId();
  let requestedIds = selectedIds;
  let command = `migrate run ${selectedIds.join(" ")} --with-dependencies --plan`;
  if (mode === "groups") {
    requestedIds = migrations
      .filter((migration) => migration.group === selectedGroup)
      .map((migration) => migration.id);
    command = `migrate run --group ${selectedGroup} --plan`;
  } else if (mode === "all") {
    requestedIds = migrations.map((migration) => migration.id);
    command = "migrate run --all --plan";
  }
  const ordered = resolveWorkSelection(requestedIds);
  const includedIds = ordered.map((migration) => migration.id);

  function toggleMigration(migrationId: string) {
    setSelectedIds((current) =>
      current.includes(migrationId)
        ? current.filter((value) => value !== migrationId)
        : [...current, migrationId]
    );
  }

  function renderMigration(migrationId: string) {
    const migration = migrations.find((entry) => entry.id === migrationId);
    if (!migration) {
      return null;
    }
    const requiredBy = ordered.filter((entry) =>
      entry.requires.includes(migrationId)
    );
    const included = includedIds.includes(migrationId);
    let accessibleName = migration.name;
    if (requiredBy.length > 0) {
      accessibleName += `, required by ${requiredBy.map((entry) => entry.name).join(" and ")}`;
    }
    return (
      <button
        aria-label={accessibleName}
        aria-pressed={included}
        className={styles.node}
        data-migration={migrationId}
        data-selected={included || undefined}
        disabled={mode !== "individual" || requiredBy.length > 0}
        onClick={() => toggleMigration(migrationId)}
        type="button"
      >
        <strong>{migration.name}</strong>
        {migration.requires.length > 0 && (
          <small>Requires {migration.requires.join(" and ")}</small>
        )}
      </button>
    );
  }

  return (
    <>
      <div className={styles.content}>
        <div className={styles.story}>
          <h2>
            Choose what runs.
            <br />
            We’ll work out the order.
          </h2>
          <p>
            Choose migrations individually, by group, or all at once. Declared
            requirements determine what runs first.
          </p>
        </div>
        <div className={styles.canvas}>
          <div className={styles.toolbar}>
            <fieldset className={styles.modes}>
              <legend className={styles.visuallyHidden}>
                Migration selection
              </legend>
              {workModes.map((option) => (
                <label key={option.id}>
                  <input
                    checked={mode === option.id}
                    name={`${id}-mode`}
                    onChange={() => setMode(option.id)}
                    type="radio"
                    value={option.id}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </fieldset>
            <span className={styles.label}>
              {mode === "individual" && "Requirements included automatically"}
              {mode === "groups" && "Choose a group to include its migrations"}
              {mode === "all" && "Every migration in every group"}
            </span>
          </div>
          <div className={styles.migrationGroups}>
            {workGroups.map((group) => (
              <section
                aria-labelledby={`${id}-group-${group.id}`}
                className={styles.migrationGroup}
                data-selected={
                  (mode !== "individual" &&
                    (mode === "all" || selectedGroup === group.id)) ||
                  undefined
                }
                key={group.id}
              >
                <h3
                  className={styles.groupHeading}
                  id={`${id}-group-${group.id}`}
                >
                  {mode === "groups" ? (
                    <button
                      aria-pressed={selectedGroup === group.id}
                      onClick={() => setSelectedGroup(group.id)}
                      type="button"
                    >
                      {group.label}
                    </button>
                  ) : (
                    <span>{group.label}</span>
                  )}
                </h3>
                <div className={styles.groupBody}>
                  {group.id === "content" ? (
                    <div className={styles.graph}>
                      <div className={styles.prerequisites}>
                        {renderMigration("authors")}
                        {renderMigration("images")}
                      </div>
                      <svg
                        aria-hidden="true"
                        className={styles.wires}
                        data-active={includedIds.includes("articles")}
                        preserveAspectRatio="none"
                        viewBox="0 0 52 142"
                      >
                        <path d="M0 24H24V71H52M0 118H24V71" />
                        <path d="m46 66 6 5-6 5" />
                      </svg>
                      {renderMigration("articles")}
                      <div className={styles.independentMigration}>
                        {renderMigration("pages")}
                      </div>
                    </div>
                  ) : (
                    renderMigration("redirects")
                  )}
                </div>
              </section>
            ))}
          </div>
          <div aria-atomic="true" aria-live="polite" className={styles.order}>
            <strong>
              {ordered.length}{" "}
              {ordered.length === 1 ? "migration" : "migrations"}
            </strong>
            <span>
              {ordered.length > 0
                ? ordered.map((migration) => migration.name).join(" → ")
                : "Choose a migration to preview its execution order."}
            </span>
          </div>
        </div>
      </div>
      {requestedIds.length > 0 ? (
        <Command>{command}</Command>
      ) : (
        <div className={styles.command}>No migrations selected</div>
      )}
    </>
  );
}

function Batch({ active }: { active: boolean }) {
  const [mode, setMode] = useState<ItemMode>("limit");
  const [limit, setLimit] = useState(5);
  const [selectedIds, setSelectedIds] = useState([3, 8]);
  const [progress, setProgress] = useState(initialItemProgress);
  const id = useId();
  const running = progress.run?.running ?? false;
  const summary = itemProgressSummary(progress.outcomes);
  const eligibleItems = items.filter(
    (number) => progress.outcomes[number]?.status !== "completed"
  );
  let targets = eligibleItems;
  let command = "migrate run articles";
  let selectionNote = "Every eligible item. No limit.";
  if (mode === "limit") {
    targets = eligibleItems.slice(0, limit);
    command += ` --limit ${limit}`;
    selectionNote = `Up to ${limit} items per run. Unchanged items are skipped.`;
  } else if (mode === "ids") {
    targets = selectedIds.filter((number) => eligibleItems.includes(number));
    command += selectedIds.length
      ? selectedIds.map((number) => ` --id ${sourceId(number)}`).join("")
      : " --id <source-id>";
    selectionNote = "Target these IDs. Unchanged items are skipped.";
  }
  const canRun = mode === "ids" ? selectedIds.length > 0 : targets.length > 0;
  const displayTargets =
    running && progress.run ? progress.run.targets : targets;
  let actionLabel = "Run selection →";
  if (running) {
    actionLabel = "Running…";
  } else if (!canRun) {
    actionLabel = "Nothing to run";
  } else if (progress.runCount > 0) {
    actionLabel = "Run again →";
  }

  useEffect(() => {
    if (!(active && running)) {
      return;
    }
    const timer = window.setInterval(() => setProgress(advanceItemRun), 220);
    return () => window.clearInterval(timer);
  }, [active, running]);

  function clearRunSummary() {
    setProgress((current) => ({ ...current, run: null }));
  }

  function startRun() {
    if (running || !canRun) {
      return;
    }
    const lastTarget = targets.at(-1) ?? 0;
    const unchanged =
      mode === "ids"
        ? selectedIds.length - targets.length
        : items.filter(
            (number) =>
              number <= lastTarget &&
              progress.outcomes[number]?.status === "completed"
          ).length;
    setProgress((current) => ({
      ...current,
      runCount: current.runCount + 1,
      run: {
        targets,
        mode,
        attempted: 0,
        failed: 0,
        retried: 0,
        unchanged,
        running: targets.length > 0,
      },
    }));
  }

  function changeMode(nextMode: ItemMode) {
    setMode(nextMode);
    clearRunSummary();
  }

  function toggleItem(number: number) {
    setSelectedIds((current) => {
      if (current.includes(number)) {
        return current.filter((item) => item !== number);
      }
      return [...current, number].sort((a, b) => a - b);
    });
    clearRunSummary();
  }

  return (
    <>
      <div className={styles.content}>
        <div className={styles.story}>
          <h2>
            Choose how much to run.
            <br />
            Or exactly which items.
          </h2>
          <p>
            Limit the number of items, target specific source IDs, or run every
            eligible item.
          </p>
        </div>
        <div className={styles.canvas}>
          <div className={styles.toolbar}>
            <fieldset className={styles.modes} disabled={running}>
              <legend className={styles.visuallyHidden}>Item selection</legend>
              {itemModes.map((option) => (
                <label key={option.id}>
                  <input
                    checked={mode === option.id}
                    name={`${id}-mode`}
                    onChange={() => changeMode(option.id)}
                    type="radio"
                    value={option.id}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </fieldset>
            {mode === "limit" && (
              <label className={styles.limitControl}>
                Item limit
                <select
                  disabled={running}
                  onChange={(event) => {
                    setLimit(Number(event.target.value));
                    clearRunSummary();
                  }}
                  value={limit}
                >
                  {[5, 10, 20].map((count) => (
                    <option key={count} value={count}>
                      {count}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className={styles.itemCaption}>
            <span>Articles · source IDs 001–020</span>
            <span>{selectionNote}</span>
          </div>
          <ol aria-label="Article progress" className={styles.items}>
            {items.map((number) => {
              const position = displayTargets.indexOf(number);
              const outcome = progress.outcomes[number];
              let status = position >= 0 ? "selected" : "untouched";
              let mark = "·";
              if (outcome) {
                status = outcome.status;
                mark = outcome.status === "failed" ? "!" : "✓";
              }
              if (running && position === progress.run?.attempted) {
                status = "running";
                mark = outcome?.status === "failed" ? "↻" : "→";
              }
              return (
                <li
                  data-attempts={outcome?.attempts ?? 0}
                  data-state={status}
                  key={number}
                >
                  <button
                    aria-label={`${sourceId(number)}: ${status}`}
                    aria-pressed={
                      mode === "ids" ? selectedIds.includes(number) : undefined
                    }
                    disabled={mode !== "ids" || running}
                    onClick={() => toggleItem(number)}
                    type="button"
                  >
                    <span aria-hidden="true">
                      {String(number).padStart(3, "0")}
                    </span>
                    <span aria-hidden="true" className={styles.itemMark}>
                      {mark}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className={styles.result}>
            <p
              aria-live="polite"
              className={styles.status}
              data-failed={summary.failed > 0 || undefined}
            >
              {summary.text}
              <span className={styles.detail}>
                {itemRunDetail(progress.run)}
              </span>
            </p>
            <div className={styles.runActions}>
              {progress.runCount > 0 && (
                <button
                  className={styles.playback}
                  disabled={running}
                  onClick={() => setProgress(initialItemProgress)}
                  type="button"
                >
                  Reset example
                </button>
              )}
              <button
                className={styles.action}
                disabled={running || !canRun}
                onClick={startRun}
                type="button"
              >
                {actionLabel}
              </button>
            </div>
          </div>
        </div>
      </div>
      <Command>{command}</Command>
    </>
  );
}

type RemotePhase = "following" | "disconnected" | "reconnected" | "complete";
interface RemoteProgress {
  client: number;
  phase: RemotePhase;
  server: number;
  ticks: number;
}
const initialRemoteProgress: RemoteProgress = {
  phase: "following",
  server: 240,
  client: 240,
  ticks: 0,
};

function advanceRemote(current: RemoteProgress): RemoteProgress {
  if (
    current.phase === "complete" ||
    (current.phase === "disconnected" && current.ticks >= 4)
  ) {
    return current;
  }
  if (current.phase === "following") {
    if (current.ticks === 3) {
      return {
        ...current,
        phase: "disconnected",
        server: current.server + 6,
        ticks: 0,
      };
    }
    return {
      ...current,
      server: current.server + 4,
      client: current.client + 4,
      ticks: current.ticks + 1,
    };
  }
  if (current.phase === "disconnected") {
    return { ...current, server: current.server + 6, ticks: current.ticks + 1 };
  }
  const completed = Math.min(current.server + 6, 300);
  return {
    ...current,
    server: completed,
    client: completed,
    phase: completed === 300 ? "complete" : "reconnected",
  };
}

function Remote({ active }: { active: boolean }) {
  const [progress, setProgress] = useState(initialRemoteProgress);
  const [paused, setPaused] = useState(false);
  const connected = progress.phase !== "disconnected";
  const complete = progress.phase === "complete";
  const waiting = !connected && progress.ticks >= 4;
  const advancing = active && !paused && !complete && !waiting;
  let story = "Following a run started by cron.";
  if (!connected) {
    story = "Terminal disconnected. The server keeps working.";
  } else if (progress.phase === "reconnected") {
    story = "Caught up to the same run. Following live progress.";
  } else if (complete) {
    story = "Run complete. All 300 items are accounted for.";
  }

  useEffect(() => {
    if (!advancing) {
      return;
    }
    const timer = window.setInterval(() => setProgress(advanceRemote), 650);
    return () => window.clearInterval(timer);
  }, [advancing]);

  function reconnect() {
    setProgress((current) => ({
      ...current,
      client: current.server,
      phase: "reconnected",
    }));
    setPaused(false);
  }

  return (
    <>
      <div className={styles.content}>
        <div className={styles.story}>
          <h2>
            Run on your server.
            <br />
            Follow from your terminal.
          </h2>
          <p>
            Follow remote runs, including work started by cron or another
            client. With Workflow SDK, execution keeps going while you
            disconnect and come back.
          </p>
        </div>
        <div className={styles.canvas}>
          <div className={styles.toolbar}>
            <span className={styles.label}>
              run-018 · articles · started by cron
            </span>
            <button
              className={styles.playback}
              disabled={complete}
              onClick={() => setPaused((current) => !current)}
              type="button"
            >
              {paused ? "[ resume animation ]" : "[ pause animation ]"}
            </button>
          </div>
          <div className={styles.remote}>
            <div className={styles.machine} data-connected={connected}>
              <span className={styles.label}>Your terminal</span>
              <strong>{connected ? "Connected" : "Disconnected"}</strong>
              <p className={styles.remoteCount} data-counter="client">
                {progress.client}
                <span> / 300</span>
              </p>
              <small>
                {connected
                  ? "items completed · run-018"
                  : "last seen · run-018"}
              </small>
              <div aria-hidden="true" className={styles.meter}>
                <span style={{ width: `${progress.client / 3}%` }} />
              </div>
            </div>
            <div
              aria-hidden="true"
              className={styles.connection}
              data-flowing={connected && advancing}
            >
              <span>{connected ? "↔" : "···"}</span>
            </div>
            <div className={styles.machine}>
              <span className={styles.label}>Remote server · Workflow SDK</span>
              <strong>{complete ? "Completed" : "Running"}</strong>
              <p className={styles.remoteCount} data-counter="server">
                {progress.server}
                <span> / 300</span>
              </p>
              <small>items completed · run-018</small>
              <div aria-hidden="true" className={styles.meter}>
                <span style={{ width: `${progress.server / 3}%` }} />
              </div>
            </div>
          </div>
          <div className={styles.result}>
            <p aria-live="polite">{story}</p>
            <button
              className={styles.action}
              disabled={connected && !complete}
              onClick={() => {
                if (complete) {
                  setProgress(initialRemoteProgress);
                  setPaused(false);
                } else {
                  reconnect();
                }
              }}
              type="button"
            >
              {complete ? "Replay →" : "Reconnect TUI →"}
            </button>
          </div>
        </div>
      </div>
      <Command>migrate-tui --server https://migrations.example.com</Command>
    </>
  );
}

const tabs = [
  { id: "selection", label: "Choose the work", Panel: Selection },
  { id: "batch", label: "Choose the items", Panel: Batch },
  { id: "remote", label: "Operate remotely", Panel: Remote },
];

export function MigrationDemo() {
  const [activeIndex, setActiveIndex] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();

  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number
  ) {
    let nextIndex = index;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = (index + 1) % tabs.length;
        break;
      case "ArrowLeft":
        nextIndex = (index - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    setActiveIndex(nextIndex);
    buttons.current[nextIndex]?.focus({ preventScroll: true });
  }

  return (
    <div className={styles.demo}>
      <div
        aria-label="Operating features"
        className={styles.tabs}
        role="tablist"
      >
        {tabs.map((tab, index) => (
          <button
            aria-controls={`${id}-panel-${tab.id}`}
            aria-selected={index === activeIndex}
            id={`${id}-tab-${tab.id}`}
            key={tab.id}
            onClick={() => setActiveIndex(index)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            role="tab"
            tabIndex={index === activeIndex ? 0 : -1}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map(({ id: tabId, Panel }, index) => (
        <div
          aria-labelledby={`${id}-tab-${tabId}`}
          className={styles.panel}
          hidden={index !== activeIndex}
          id={`${id}-panel-${tabId}`}
          key={tabId}
          role="tabpanel"
        >
          <Panel active={index === activeIndex} />
        </div>
      ))}
    </div>
  );
}
