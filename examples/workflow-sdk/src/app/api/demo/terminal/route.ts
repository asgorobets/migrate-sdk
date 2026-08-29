import { Effect, Layer } from "effect";
import { PostgresLive } from "@/migrations/database";
import { BrowserTerminalConfig } from "@/server/browser-terminal-config";
import {
  BrowserTerminalSandboxes,
  BrowserTerminalSandboxLease,
} from "@/server/browser-terminal-sandbox";
import {
  createBrowserTerminalSession,
  keepBrowserTerminalSessionActive,
} from "@/server/browser-terminal-session";
import { MigrateServerAccess } from "@/server/migrate-server-access";

export const maxDuration = 60;
export const runtime = "nodejs";

const browserTerminalSandboxesLayer = BrowserTerminalSandboxes.layer;
const browserTerminalConfigLayer = BrowserTerminalConfig.layer.pipe(
  Layer.provide(MigrateServerAccess.layer)
);
const browserTerminalLeaseLayer = BrowserTerminalSandboxLease.layer.pipe(
  Layer.provide(Layer.merge(PostgresLive, browserTerminalSandboxesLayer))
);
const browserTerminalLayer = Layer.mergeAll(
  browserTerminalConfigLayer,
  browserTerminalSandboxesLayer,
  browserTerminalLeaseLayer
);

async function unavailableResponse(
  message: string,
  cause: unknown
): Promise<Response> {
  await Effect.runPromise(Effect.logError(message, cause));
  return Response.json(
    { error: message },
    { headers: { "Cache-Control": "no-store" }, status: 503 }
  );
}

export const POST = async (): Promise<Response> => {
  try {
    return Response.json(
      await Effect.runPromise(
        createBrowserTerminalSession().pipe(
          Effect.provide(browserTerminalLayer)
        )
      ),
      {
        headers: { "Cache-Control": "no-store" },
        status: 201,
      }
    );
  } catch (cause) {
    return unavailableResponse("Unable to start the browser TUI", cause);
  }
};

export const PATCH = async (): Promise<Response> => {
  try {
    const result = await Effect.runPromise(
      keepBrowserTerminalSessionActive().pipe(
        Effect.provide(browserTerminalLayer)
      )
    );
    return result === "active"
      ? new Response(null, { status: 204 })
      : Response.json(
          { error: "The shared playground session has expired" },
          { headers: { "Cache-Control": "no-store" }, status: 410 }
        );
  } catch (cause) {
    return unavailableResponse("Unable to keep the browser TUI active", cause);
  }
};
