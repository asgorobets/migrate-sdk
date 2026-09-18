import type { MigrationMessage } from "migrate-sdk";
import type { MigrateDashboardRow, MigrateTarget } from "migrate-sdk/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MigrationTuiRuntime } from "./runtime.ts";

const noMessages: readonly MigrationMessage[] = [];

export type MigrationMessagesStatus =
  | "not-loaded"
  | "loading"
  | "loaded"
  | "stale"
  | "error";

interface CachedMessages {
  readonly messages: readonly MigrationMessage[];
  readonly revision: number;
  readonly status: MigrationMessagesStatus;
}

const messageTargetKey = (target: MigrateTarget): string =>
  target.kind === "migration"
    ? `migration:${target.definitionId}`
    : `group:${target.groupId}`;

interface ObservedDefinition {
  readonly fingerprint: string;
  readonly group: string | undefined;
}

export const useMigrationMessages = ({
  rows,
  runtime,
  setError,
  target,
}: {
  readonly rows: readonly MigrateDashboardRow[];
  readonly runtime: Pick<MigrationTuiRuntime, "listMessages">;
  readonly setError: (error: string) => void;
  readonly target: MigrateTarget | undefined;
}): {
  readonly load: () => Promise<void>;
  readonly messages: readonly MigrationMessage[];
  readonly status: MigrationMessagesStatus;
} => {
  const session = useMemo(
    () => ({
      runtime,
      definitions: new Map<string, ObservedDefinition>(),
      revisions: new Map<string, number>(),
      entries: new Map<string, CachedMessages>(),
      requests: new Map<string, Promise<void>>(),
    }),
    [runtime]
  );
  const [displayedCache, setDisplayedCache] = useState({
    session,
    entries: session.entries,
  });
  const currentRef = useRef({ session, target });
  currentRef.current = { session, target };
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // There is no message-specific server revision. Run history and durable
  // counts conservatively invalidate messages; source scans and locks do not.
  useEffect(() => {
    const definitions = new Map<string, ObservedDefinition>(
      rows.map((row) => [
        row.entry.id,
        {
          fingerprint: JSON.stringify([
            row.status?.durable,
            row.status?.lastRun,
          ]),
          group: row.entry.group,
        },
      ])
    );
    const changedTargets = new Set<string>();
    const definitionIds = new Set([
      ...session.definitions.keys(),
      ...definitions.keys(),
    ]);
    for (const definitionId of definitionIds) {
      const previous = session.definitions.get(definitionId);
      const next = definitions.get(definitionId);
      if (
        previous?.fingerprint === next?.fingerprint &&
        previous?.group === next?.group
      ) {
        continue;
      }
      changedTargets.add(`migration:${definitionId}`);
      for (const group of [previous?.group, next?.group]) {
        if (group !== undefined) {
          changedTargets.add(`group:${group}`);
        }
      }
    }
    session.definitions = definitions;
    // Versions only advance: A -> B -> A must not revive an old result. Track
    // every definition, including targets whose requests are still in flight.
    for (const key of changedTargets) {
      session.revisions.set(key, (session.revisions.get(key) ?? 0) + 1);
    }
    if ([...changedTargets].some((key) => session.entries.has(key))) {
      setDisplayedCache({ session, entries: new Map(session.entries) });
    }
  }, [rows, session]);

  const load = useCallback(async () => {
    if (target === undefined) {
      return;
    }
    const key = messageTargetKey(target);
    const revision = session.revisions.get(key) ?? 0;
    const cached = session.entries.get(key);
    if (cached?.status === "loaded" && cached.revision === revision) {
      return;
    }
    const pending = session.requests.get(key);
    if (pending !== undefined) {
      return pending;
    }

    const publish = (entry: CachedMessages) => {
      session.entries.set(key, entry);
      if (mountedRef.current && currentRef.current.session === session) {
        setDisplayedCache({ session, entries: new Map(session.entries) });
      }
    };
    publish({ messages: noMessages, revision, status: "loading" });
    const request = Promise.resolve()
      .then(() => runtime.listMessages(target))
      .then(
        (messages) => publish({ messages, revision, status: "loaded" }),
        (cause: unknown) => {
          publish({ messages: noMessages, revision, status: "error" });
          const current = currentRef.current;
          if (
            mountedRef.current &&
            current.session === session &&
            current.target !== undefined &&
            messageTargetKey(current.target) === key
          ) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }
      )
      .finally(() => session.requests.delete(key));
    session.requests.set(key, request);
    await request;
  }, [runtime, session, setError, target]);

  const cached =
    target === undefined || displayedCache.session !== session
      ? undefined
      : displayedCache.entries.get(messageTargetKey(target));
  const revision =
    target === undefined
      ? 0
      : (session.revisions.get(messageTargetKey(target)) ?? 0);
  const status =
    cached?.status === "loaded" && cached.revision !== revision
      ? "stale"
      : (cached?.status ?? "not-loaded");
  return {
    load,
    messages:
      status === "loaded" ? (cached?.messages ?? noMessages) : noMessages,
    status,
  };
};
