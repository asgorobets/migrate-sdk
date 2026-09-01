import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  remoteMigrateServerBackend as backend,
  remoteMigrateDashboard as dashboard,
  makeAuthorizedRemoteMigrateServerHttp,
  makeRemoteMigrateServerHttp,
  remoteMigrateRunId as runId,
  remoteMigrateServerIdentity as serverIdentity,
  remoteMigrateServerInfo as serverInfo,
} from "../../../test/fixtures/remote-server.ts";
import {
  MIGRATE_PROTOCOL_VERSION,
  type MigrateDashboard,
} from "../../protocol/index.ts";
import { MigrateServer } from "../../server/index.ts";
import { connectRemoteMigrateServer } from "./remote-connection.ts";

describe("remote Migrate Server connection", () => {
  it("rejects plain HTTP outside loopback before sending a request", async () => {
    let requested = false;

    await expect(
      connectRemoteMigrateServer({
        bearerToken: "secret",
        fetch: () => {
          requested = true;
          return Promise.resolve(new Response());
        },
        url: "http://migrate.example/rpc",
      })
    ).rejects.toThrow("must use HTTPS");
    expect(requested).toBe(false);

    await expect(
      connectRemoteMigrateServer({
        fetch: () => Promise.resolve(new Response()),
        url: "http://127.example/rpc",
      })
    ).rejects.toThrow("must use HTTPS");
  });

  it("authenticates, reads the dashboard, and resumes observation leases", async () => {
    const authorizationHeaders: string[] = [];
    let observationRequests = 0;
    let transientStatusFailures = 0;
    const http = makeAuthorizedRemoteMigrateServerHttp(
      MigrateServer.layer({ backend, ...serverIdentity }),
      (request) =>
        Effect.sync(() => {
          const authorization = request.headers.authorization ?? "";
          authorizationHeaders.push(authorization);
          return authorization === "Bearer secret";
        })
    );
    const fetch = async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const request = new Request(input, init);
      const body = await request.clone().text();

      if (body.includes("ObserveRunLease")) {
        observationRequests += 1;
        if (observationRequests === 2) {
          transientStatusFailures += 1;
          return new Response("Temporarily unavailable", { status: 503 });
        }
      }

      return http.handler(request);
    };
    const connection = await connectRemoteMigrateServer({
      bearerToken: "secret",
      fetch,
      url: "https://migrate.example/rpc",
    });

    try {
      expect(connection.serverInfo.environment).toEqual({
        id: "production",
        label: "Production",
      });
      expect(
        await connection.runPromise(connection.client.GetDashboard())
      ).toMatchObject({ dashboard });
      await expect(
        connection.runPromise(connection.client.GetRegistry())
      ).resolves.toEqual({
        entries: dashboard.rows.map((row) => row.entry),
        groups: dashboard.groups,
      });
      await expect(
        connection.runPromise(
          connection.client.GetRegistryStatus({
            scanSource: false,
            selection: { kind: "all" },
            withDependencies: false,
          })
        )
      ).resolves.toMatchObject({
        includedDefinitionIds: ["articles"],
        requestedDefinitionIds: "all",
        scanSource: false,
      });
      await expect(
        connection.runPromise(
          connection.client.GetRegistryMessages({
            selection: { kind: "all" },
            withDependencies: false,
          })
        )
      ).resolves.toMatchObject({
        includedDefinitionIds: ["articles"],
        messages: [],
        requestedDefinitionIds: "all",
      });
      const dashboardSnapshots = await connection.runPromise(
        connection.client
          .observeDashboard({})
          .pipe(Stream.take(1), Stream.runCollect)
      );
      const events = await connection.runPromise(
        connection.client.observeRun({ runId }).pipe(Stream.runCollect)
      );

      expect(events.map((event) => event.kind)).toEqual([
        "progress",
        "state",
        "terminal",
      ]);
      expect(dashboardSnapshots.map((snapshot) => snapshot.dashboard)).toEqual([
        dashboard,
      ]);
      expect(authorizationHeaders).not.toContain("");
      expect(authorizationHeaders).toContain("Bearer secret");
      expect(transientStatusFailures).toBe(1);
    } finally {
      await connection.dispose();
      await http.dispose();
    }
  });

  it("resumes dashboard observation against a fresh HTTP server instance", async () => {
    const initialDashboard: MigrateDashboard = {
      ...dashboard,
      activeRuns: [],
    };
    const original = makeRemoteMigrateServerHttp(
      MigrateServer.layer({
        backend: { ...backend, getDashboard: Effect.succeed(initialDashboard) },
        ...serverIdentity,
      })
    );
    const replacement = makeRemoteMigrateServerHttp(
      MigrateServer.layer({ backend, ...serverIdentity })
    );
    let dashboardLeaseRequests = 0;
    const fetch = async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const request = new Request(input, init);
      const body = await request.clone().text();

      if (body.includes("ObserveDashboardLease")) {
        dashboardLeaseRequests += 1;

        return dashboardLeaseRequests === 1
          ? original.handler(request)
          : replacement.handler(request);
      }

      return original.handler(request);
    };
    const connection = await connectRemoteMigrateServer({
      fetch,
      url: "https://migrate.example/rpc",
    });

    try {
      const snapshots = await connection.runPromise(
        connection.client
          .observeDashboard({})
          .pipe(Stream.take(2), Stream.runCollect)
      );

      expect(snapshots.map((snapshot) => snapshot.dashboard)).toEqual([
        initialDashboard,
        dashboard,
      ]);
      expect(dashboardLeaseRequests).toBe(2);
    } finally {
      await connection.dispose();
      await original.dispose();
      await replacement.dispose();
    }
  });

  it("rejects a remote connection when authorization fails", async () => {
    const http = makeAuthorizedRemoteMigrateServerHttp(
      MigrateServer.layer({ backend, ...serverIdentity }),
      () => Effect.succeed(false)
    );

    try {
      await expect(
        connectRemoteMigrateServer({
          fetch: (input, init) => http.handler(new Request(input, init)),
          url: "https://migrate.example/rpc",
        })
      ).rejects.toThrow(
        "Permission denied by Migrate Server (HTTP 401 Unauthorized). Check MIGRATE_SERVER_TOKEN."
      );
    } finally {
      await http.dispose();
    }
  });

  it("reports forbidden remote connections as permission errors", async () => {
    await expect(
      connectRemoteMigrateServer({
        fetch: () =>
          Promise.resolve(new Response("Forbidden", { status: 403 })),
        url: "https://migrate.example/rpc",
      })
    ).rejects.toThrow(
      "Permission denied by Migrate Server (HTTP 403 Forbidden)."
    );
  });

  it("connects to a remote server with the same protocol and a different SDK version", async () => {
    const mismatchedServerLayer = Layer.effect(
      MigrateServer,
      MigrateServer.make({ backend, ...serverIdentity }).pipe(
        Effect.map((server) =>
          MigrateServer.of({
            ...server,
            getServerInfo: Effect.succeed({
              ...serverInfo,
              sdkVersion: "999.0.0",
            }),
          })
        )
      )
    );
    const http = makeRemoteMigrateServerHttp(mismatchedServerLayer);

    try {
      const connection = await connectRemoteMigrateServer({
        fetch: (input, init) => http.handler(new Request(input, init)),
        url: "https://migrate.example/rpc",
      });

      try {
        expect(connection.serverInfo.sdkVersion).toBe("999.0.0");
        await expect(
          connection.runPromise(connection.client.GetDashboard())
        ).resolves.toMatchObject({ dashboard });
      } finally {
        await connection.dispose();
      }
    } finally {
      await http.dispose();
    }
  });

  it("rejects a remote server with a different protocol version", async () => {
    const mismatchedServerLayer = Layer.effect(
      MigrateServer,
      MigrateServer.make({ backend, ...serverIdentity }).pipe(
        Effect.map((server) =>
          MigrateServer.of({
            ...server,
            getServerInfo: Effect.succeed({
              ...serverInfo,
              protocolVersion: MIGRATE_PROTOCOL_VERSION + 1,
            }),
          })
        )
      )
    );
    const http = makeRemoteMigrateServerHttp(mismatchedServerLayer);

    try {
      await expect(
        connectRemoteMigrateServer({
          fetch: (input, init) => http.handler(new Request(input, init)),
          url: "https://migrate.example/rpc",
        })
      ).rejects.toThrow(
        `Migrate Protocol version ${MIGRATE_PROTOCOL_VERSION + 1} is not supported`
      );
    } finally {
      await http.dispose();
    }
  });
});
