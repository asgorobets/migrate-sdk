"use client";

import type { MigrationMessage } from "migrate-sdk";
import {
  connectBrowserMigrateServer,
  type MigrateConnection,
} from "migrate-sdk/client/web";
import type {
  MigrateDashboard,
  MigrateSourceItemTotal,
} from "migrate-sdk/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type BrowserMigrateDashboardObservationState,
  observeBrowserMigrateDashboard,
} from "./browser-migrate-dashboard-observation";
import {
  documentVisibility,
  startVisibilityControlledObservation,
  type VisibilityControlledObservation,
} from "./visibility-controlled-observation";

type ConnectionState = "connected" | "connecting" | "error";

interface BrowserMigrateDashboardOptions {
  readonly bearerToken: string;
  readonly onActivity: (message: string, tone: "danger" | "success") => void;
  readonly onDashboardChange: (
    previous: MigrateDashboard,
    next: MigrateDashboard
  ) => void;
}

interface BrowserMigrateDashboard {
  readonly connection: MigrateConnection | undefined;
  readonly connectionError: string | undefined;
  readonly connectionState: ConnectionState;
  readonly dashboard: MigrateDashboard | undefined;
  readonly environment: string;
  readonly messages: readonly MigrationMessage[];
  readonly messagesReady: boolean;
  readonly sourceTotals:
    | ReadonlyMap<
        MigrateDashboard["rows"][number]["entry"]["id"],
        MigrateSourceItemTotal
      >
    | undefined;
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const useBrowserMigrateDashboard = ({
  bearerToken,
  onActivity,
  onDashboardChange,
}: BrowserMigrateDashboardOptions): BrowserMigrateDashboard => {
  const latestDashboardRef = useRef<MigrateDashboard | undefined>(undefined);
  const [connection, setConnection] = useState<MigrateConnection>();
  const [connectionError, setConnectionError] = useState<string>();
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const [dashboard, setDashboard] = useState<MigrateDashboard>();
  const [environment, setEnvironment] = useState("Migrate Server");
  const [messages, setMessages] = useState<readonly MigrationMessage[]>([]);
  const [messagesReady, setMessagesReady] = useState(false);
  const [sourceTotals, setSourceTotals] =
    useState<BrowserMigrateDashboard["sourceTotals"]>();

  const applyDashboard = useCallback(
    (next: MigrateDashboard, announceChanges: boolean): void => {
      const previous = latestDashboardRef.current;
      latestDashboardRef.current = next;
      setDashboard(next);
      if (announceChanges && previous !== undefined) {
        onDashboardChange(previous, next);
      }
    },
    [onDashboardChange]
  );

  useEffect(() => {
    let activeConnection: MigrateConnection | undefined;
    let disposed = false;
    let observation: VisibilityControlledObservation | undefined;
    const connectionAbort = new AbortController();
    const observationState: BrowserMigrateDashboardObservationState = {
      initialized: false,
      messagesDashboard: undefined,
      sourceTotalsLoaded: false,
    };

    setConnection(undefined);
    setConnectionError(undefined);
    setConnectionState("connecting");

    const reportConnectionFailure = (cause: unknown): void => {
      if (disposed) {
        return;
      }
      const message = errorMessage(cause);
      setConnectionError(message);
      setConnectionState("error");
      onActivity(`Connection failed: ${message}`, "danger");
    };

    connectBrowserMigrateServer({
      bearerToken,
      credentials: "same-origin",
      signal: connectionAbort.signal,
      url: "/api/migrate",
    })
      .then((connected) => {
        if (disposed) {
          return connected.dispose();
        }

        activeConnection = connected;
        setConnection(connected);
        const environmentLabel =
          connected.serverInfo.environment.label ??
          connected.serverInfo.environment.id;
        setEnvironment(environmentLabel);
        setConnectionState("connected");
        onActivity(`Connected to ${environmentLabel}.`, "success");
        observation = startVisibilityControlledObservation({
          onFailure: reportConnectionFailure,
          run: (signal) =>
            connected.runPromise(
              observeBrowserMigrateDashboard({
                sink: {
                  onDashboard: (next, announceChanges) => {
                    applyDashboard(next, announceChanges);
                    setConnectionError(undefined);
                    setConnectionState("connected");
                  },
                  onMessages: (nextMessages) => {
                    setMessages(nextMessages);
                    setMessagesReady(true);
                  },
                  onSourceTotals: setSourceTotals,
                },
                source: {
                  getMessages: (target) =>
                    connected.client.GetMessages({ target }),
                  getSourceItemTotals: (definitionIds) =>
                    connected.client.GetSourceItemTotals({ definitionIds }),
                  snapshots: connected.client.observeDashboard({}),
                },
                state: observationState,
              }),
              { signal }
            ),
          visibility: documentVisibility,
        });
      })
      .catch(reportConnectionFailure);

    return () => {
      disposed = true;
      connectionAbort.abort();
      observation?.dispose();
      activeConnection?.dispose().catch(() => undefined);
    };
  }, [applyDashboard, bearerToken, onActivity]);

  return {
    connection,
    connectionError,
    connectionState,
    dashboard,
    environment,
    messages,
    messagesReady,
    sourceTotals,
  };
};
