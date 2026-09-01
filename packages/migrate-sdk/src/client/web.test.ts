import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  remoteMigrateDashboard as dashboard,
  makeAuthorizedRemoteMigrateServerHttp,
  makeRemoteMigrateServerHttp,
  remoteMigrateServerBackend,
  remoteMigrateServerIdentity,
} from "../../test/fixtures/remote-server.ts";
import { MigrateServer } from "../server/index.ts";
import { connectBrowserMigrateServer, type MigrateConnection } from "./web.ts";

const trailingSlash = /\/$/;

describe("browser Migrate Server connection", () => {
  it("connects to a same-origin relative endpoint with browser fetch", () => {
    vi.stubGlobal("location", new URL("https://workflow.demo/playground"));
    const requestedUrls: string[] = [];
    const requestCredentials: RequestCredentials[] = [];
    const http = makeRemoteMigrateServerHttp(
      MigrateServer.layer({
        backend: remoteMigrateServerBackend,
        ...remoteMigrateServerIdentity,
      })
    );
    let connection: MigrateConnection | undefined;

    return connectBrowserMigrateServer({
      credentials: "same-origin",
      fetch: (input, init) => {
        const request = new Request(input, init);
        requestedUrls.push(request.url);
        requestCredentials.push(request.credentials);
        return http.handler(request);
      },
      url: "/api/demo/migrate",
    })
      .then((connected) => {
        connection = connected;
        return connected
          .runPromise(connected.client.GetDashboard())
          .then((snapshot) => {
            expect(snapshot).toMatchObject({ dashboard });
            expect(requestedUrls).not.toHaveLength(0);
            expect(
              requestedUrls.every(
                (url) =>
                  url.replace(trailingSlash, "") ===
                  "https://workflow.demo/api/demo/migrate"
              )
            ).toBe(true);
            expect(requestCredentials).toContain("same-origin");
          });
      })
      .finally(() =>
        Promise.all([
          connection?.dispose() ?? Promise.resolve(),
          http.dispose(),
        ]).then(() => vi.unstubAllGlobals())
      );
  });

  it("cancels connection establishment with the caller signal", () => {
    vi.stubGlobal("location", new URL("https://workflow.demo/playground"));
    const controller = new AbortController();
    const http = makeAuthorizedRemoteMigrateServerHttp(
      MigrateServer.layer({
        backend: remoteMigrateServerBackend,
        ...remoteMigrateServerIdentity,
      }),
      () => Effect.never
    );
    let requestSignal: AbortSignal | undefined;
    const connection = connectBrowserMigrateServer({
      fetch: (input, init) => {
        const request = new Request(input, init);
        requestSignal = request.signal;
        const response = http.handler(request);
        controller.abort();
        return response;
      },
      signal: controller.signal,
      url: "/api/demo/migrate",
    });

    return expect(connection)
      .rejects.toThrow("Unable to connect to Migrate Server")
      .then(() => expect(requestSignal?.aborted).toBe(true))
      .finally(() =>
        http.dispose().then(() => {
          vi.unstubAllGlobals();
        })
      );
  });
});
