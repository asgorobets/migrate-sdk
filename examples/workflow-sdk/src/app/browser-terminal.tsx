"use client";

import { GhosttyCore } from "@wterm/ghostty";
import { Terminal, useTerminal } from "@wterm/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BROWSER_TERMINAL_HEARTBEAT_INTERVAL_MS,
  browserTerminalHeartbeatAction,
} from "@/terminal/browser-terminal-policy";
import {
  isSandboxTerminalSession,
  makeSandboxPtyResizeMessage,
  makeSandboxPtyStartMessage,
  parseSandboxPtyExitMessage,
  type SandboxPtyDimensions,
} from "@/terminal/sandbox-pty-protocol";
import styles from "./browser-terminal.module.css";

type TerminalStatus = "ended" | "error" | "idle" | "preparing" | "running";

const INITIAL_DIMENSIONS: SandboxPtyDimensions = { cols: 120, rows: 36 };
const inputEncoder = new TextEncoder();

const errorMessageFromResponse = async (
  response: Response
): Promise<string> => {
  const payload: unknown = await response.json().catch(() => undefined);
  return typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string"
    ? payload.error
    : `Unable to start the browser TUI (${response.status})`;
};

export function BrowserTerminal() {
  const { focus, ref, write } = useTerminal();
  const [core, setCore] = useState<GhosttyCore>();
  const [error, setError] = useState<string>();
  const [isInactive, setIsInactive] = useState(false);
  const [status, setStatus] = useState<TerminalStatus>("idle");
  const dimensionsRef = useRef<SandboxPtyDimensions>(INITIAL_DIMENSIONS);
  const hasAutoStartedRef = useRef(false);
  const heartbeatPausedRef = useRef(false);
  const heartbeatPendingRef = useRef(false);
  const lastActivityAtRef = useRef(Date.now());
  const socketRef = useRef<WebSocket | undefined>(undefined);

  useEffect(() => {
    let active = true;
    GhosttyCore.load({
      backgroundColor: "#0d1117",
      foregroundColor: "#e6edf3",
      scrollbackLimit: 128_000,
      wasmPath: "/ghostty-vt.wasm",
    }).then(
      (loadedCore) => {
        if (active) {
          setCore(loadedCore);
        }
      },
      (cause: unknown) => {
        if (active) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to initialize libghostty"
          );
          setStatus("error");
        }
      }
    );

    return () => {
      active = false;
    };
  }, []);

  useEffect(
    () => () => {
      socketRef.current?.close(1000, "Browser terminal closed");
    },
    []
  );

  const stopTerminal = useCallback(() => {
    socketRef.current?.close(1000, "Visitor closed the terminal");
    socketRef.current = undefined;
    heartbeatPausedRef.current = false;
    setIsInactive(false);
    setStatus("ended");
  }, []);

  const markActivity = useCallback(() => {
    lastActivityAtRef.current = Date.now();
  }, []);

  const sendHeartbeat = useCallback(async (force = false) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN || heartbeatPendingRef.current) {
      return;
    }
    const action = browserTerminalHeartbeatAction({
      force,
      inactiveForMs: Date.now() - lastActivityAtRef.current,
      isPaused: heartbeatPausedRef.current,
      isVisible: document.visibilityState === "visible",
    });
    if (action === "skip") {
      return;
    }
    if (action === "pause") {
      heartbeatPausedRef.current = true;
      setIsInactive(true);
      return;
    }

    heartbeatPendingRef.current = true;
    try {
      const response = await fetch("/api/demo/terminal", { method: "PATCH" });
      if (socketRef.current === socket && response.status === 410) {
        socket.close(1000, "Shared playground session expired");
        socketRef.current = undefined;
        setError(await errorMessageFromResponse(response));
        setStatus("error");
      }
    } finally {
      heartbeatPendingRef.current = false;
    }
  }, []);

  const startTerminal = useCallback(async () => {
    if (!core || status === "preparing" || status === "running") {
      return;
    }

    setError(undefined);
    heartbeatPausedRef.current = false;
    setIsInactive(false);
    lastActivityAtRef.current = Date.now();
    setStatus("preparing");
    write(
      "\u001bc\u001b[38;2;88;166;255mJoining the shared migration playground…\u001b[0m\r\n"
    );

    try {
      const response = await fetch("/api/demo/terminal", { method: "POST" });
      if (!response.ok) {
        throw new Error(await errorMessageFromResponse(response));
      }

      const payload: unknown = await response.json();
      if (!isSandboxTerminalSession(payload)) {
        throw new Error("The sandbox returned an invalid terminal session");
      }

      const session = payload;
      const connectionUrl = new URL(session.connection.url);
      connectionUrl.searchParams.set("token", session.connection.token);
      const socket = new WebSocket(connectionUrl);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (socketRef.current !== socket) {
          socket.close(1000, "Terminal session was replaced");
          return;
        }
        socket.send(makeSandboxPtyStartMessage(session, dimensionsRef.current));
        markActivity();
        setStatus("running");
        focus();
      });

      socket.addEventListener("message", async (event) => {
        if (socketRef.current !== socket) {
          return;
        }
        if (typeof event.data === "string") {
          const exit = parseSandboxPtyExitMessage(event.data);
          if (exit) {
            write(
              `\r\n\u001b[38;2;139;148;158mTerminal process exited (${exit.code}).\u001b[0m\r\n`
            );
            setStatus("ended");
          }
          return;
        }

        if (event.data instanceof ArrayBuffer) {
          write(new Uint8Array(event.data));
          return;
        }

        if (event.data instanceof Blob) {
          write(new Uint8Array(await event.data.arrayBuffer()));
        }
      });

      socket.addEventListener("error", () => {
        if (socketRef.current !== socket) {
          return;
        }
        setError("The terminal connection failed");
        setStatus("error");
      });

      socket.addEventListener("close", () => {
        if (socketRef.current !== socket) {
          return;
        }
        socketRef.current = undefined;
        setStatus((current) => (current === "error" ? current : "ended"));
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to start the browser TUI"
      );
      setStatus("error");
    }
  }, [core, focus, markActivity, status, write]);

  useEffect(() => {
    if (!core || hasAutoStartedRef.current) {
      return;
    }
    hasAutoStartedRef.current = true;
    startTerminal();
  }, [core, startTerminal]);

  useEffect(() => {
    if (status !== "running") {
      return;
    }

    const interval = window.setInterval(() => {
      sendHeartbeat().catch(() => undefined);
    }, BROWSER_TERMINAL_HEARTBEAT_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [sendHeartbeat, status]);

  const handleData = useCallback(
    (data: string) => {
      markActivity();
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(inputEncoder.encode(data));
      }
    },
    [markActivity]
  );

  const keepWatching = useCallback(() => {
    markActivity();
    heartbeatPausedRef.current = false;
    setIsInactive(false);
    sendHeartbeat(true).catch(() => undefined);
    focus();
  }, [focus, markActivity, sendHeartbeat]);

  const handleResize = useCallback((cols: number, rows: number) => {
    const dimensions = { cols, rows };
    dimensionsRef.current = dimensions;
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(makeSandboxPtyResizeMessage(dimensions));
    }
  }, []);

  const statusLabel = {
    ended: "session ended",
    error: "unavailable",
    idle: core ? "ready" : "loading libghostty",
    preparing: "joining playground",
    running: isInactive ? "waiting for you" : "live",
  }[status];

  return (
    <section
      aria-label="Browser migration TUI"
      className={styles.shell}
      onPointerDown={markActivity}
    >
      <header className={styles.toolbar}>
        <p className={styles.title}>Migrate</p>
        <p>workflow-sdk · Vercel Sandbox</p>
        <span className={styles.status} data-status={status}>
          {statusLabel}
        </span>
      </header>

      <div className={styles.terminalFrame}>
        {core ? (
          <Terminal
            aria-label="Interactive migration TUI"
            autoResize
            className={styles.terminal}
            core={core}
            cursorBlink
            onData={handleData}
            onError={(cause) => {
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Unable to render the terminal"
              );
              setStatus("error");
            }}
            onReady={focus}
            onResize={handleResize}
            ref={ref}
          />
        ) : (
          <div className={styles.loading}>Loading libghostty…</div>
        )}

        {status === "idle" ? (
          <div className={styles.launcher}>
            <p>Starting the migration TUI…</p>
          </div>
        ) : null}

        {status === "ended" || status === "error" ? (
          <div className={styles.launcher}>
            <p>The TUI process has ended. Rejoin the shared playground.</p>
            <button disabled={!core} onClick={startTerminal} type="button">
              [ restart TUI ]
            </button>
            {error ? <span role="alert">{error}</span> : null}
          </div>
        ) : null}

        {status === "running" && isInactive ? (
          <div className={styles.launcher}>
            <p>Still watching? Activity heartbeats are paused.</p>
            <button onClick={keepWatching} type="button">
              [ keep session active ]
            </button>
          </div>
        ) : null}
      </div>

      <footer className={styles.footer}>
        <span>Shared demo sandbox · one OpenTUI process per visitor</span>
        {status === "running" ? (
          <button onClick={stopTerminal} type="button">
            [ close terminal ]
          </button>
        ) : (
          <span>The TUI starts automatically</span>
        )}
      </footer>
    </section>
  );
}
