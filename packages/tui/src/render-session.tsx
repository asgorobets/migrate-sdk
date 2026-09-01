import { createCliRenderer, type KeyEvent } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { MigrationTuiApp } from "./app.tsx";
import type {
  MigrationTuiRenderSession,
  MigrationTuiRenderSessionInput,
} from "./lifecycle-supervisor.ts";
import type { MigrationTuiRuntime } from "./runtime.ts";

interface MigrationTuiRenderErrorBoundaryProps {
  readonly children: ReactNode;
  readonly onError: (cause: unknown) => void;
}

interface MigrationTuiRenderErrorBoundaryState {
  readonly failed: boolean;
}

interface MigrationTuiSessionRenderer {
  readonly destroy: () => void;
  readonly keyInput: {
    readonly off: (
      event: "keypress",
      listener: (key: KeyEvent) => void
    ) => void;
    readonly on: (event: "keypress", listener: (key: KeyEvent) => void) => void;
  };
  readonly setTerminalTitle: (title: string) => void;
}

export class MigrationTuiRenderErrorBoundary extends Component<
  MigrationTuiRenderErrorBoundaryProps,
  MigrationTuiRenderErrorBoundaryState
> {
  override state: MigrationTuiRenderErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): MigrationTuiRenderErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo): void {
    setTimeout(() => this.props.onError(error), 0);
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <box
          style={{
            alignItems: "center",
            flexDirection: "column",
            height: "100%",
            justifyContent: "center",
            width: "100%",
          }}
        >
          <text content="The UI renderer failed. Recovering…" fg="#f87171" />
        </box>
      );
    }

    return this.props.children;
  }
}

export const initializeMigrationTuiRenderSession = ({
  mount,
  onControlC,
  renderer,
}: {
  readonly mount: () => void;
  readonly onControlC: () => void;
  readonly renderer: MigrationTuiSessionRenderer;
}): MigrationTuiRenderSession => {
  let destroyed = false;
  let keyHandlerRegistered = false;
  const handleKeypress = (key: KeyEvent) => {
    if (!(key.ctrl && key.name === "c")) {
      return;
    }

    key.preventDefault();
    key.stopPropagation();
    onControlC();
  };
  const destroy = () => {
    if (destroyed) {
      return;
    }

    destroyed = true;
    try {
      if (keyHandlerRegistered) {
        renderer.keyInput.off("keypress", handleKeypress);
      }
    } finally {
      renderer.destroy();
    }
  };

  try {
    renderer.keyInput.on("keypress", handleKeypress);
    keyHandlerRegistered = true;
    renderer.setTerminalTitle("Migrate");
    mount();
  } catch (cause) {
    try {
      destroy();
    } catch {
      // Preserve the renderer setup failure after terminal cleanup was attempted.
    }
    throw cause;
  }

  return { destroy };
};

export const createMigrationTuiRenderSession = async ({
  initialRows,
  lifecycle,
  onControlC,
  onRenderError,
  recoveryNotice,
  runtime,
}: MigrationTuiRenderSessionInput & {
  readonly runtime: MigrationTuiRuntime;
}): Promise<MigrationTuiRenderSession> => {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
    screenMode: "alternate-screen",
  });

  return initializeMigrationTuiRenderSession({
    mount: () =>
      createRoot(renderer).render(
        <MigrationTuiRenderErrorBoundary onError={onRenderError}>
          <MigrationTuiApp
            {...(initialRows === undefined ? {} : { initialRows })}
            lifecycle={lifecycle}
            {...(recoveryNotice === undefined ? {} : { recoveryNotice })}
            runtime={runtime}
          />
        </MigrationTuiRenderErrorBoundary>
      ),
    onControlC,
    renderer,
  });
};
