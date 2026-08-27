import { createServer, type Server } from "node:http";
import { Effect, Stream } from "effect";
import {
  MigrationDefinitionId,
  type MigrationDefinitionLock,
  MigrationRunId,
  toMigrationDefinitionRegistryId,
} from "migrate-sdk";
import {
  MIGRATE_PROTOCOL_VERSION,
  type MigrateActiveRun,
  type MigrateDashboard,
  type MigrateOperationRequest,
  type MigrateServerInfo,
} from "migrate-sdk/protocol";
import {
  MigrateServer,
  type MigrateServerBackend,
  makeMigrateServerHttpHandler,
} from "migrate-sdk/server";
import { describe, expect, it } from "vitest";
import { connectRemoteMigrateServer } from "./remote-client.ts";
import { makeMigrationTuiRuntime } from "./tui-runtime.ts";

interface FakeOperation {
  readonly kind: "run";
}

const definitionId = MigrationDefinitionId.make("articles");
const runId = MigrationRunId.make("run-remote-1");
const activeRun: MigrateActiveRun = {
  definitionIds: [definitionId],
  execution: { adapter: "workflow-sdk", executionId: "workflow-1" },
  observationDefinitionId: definitionId,
  runId,
  startedAt: new Date("2026-08-25T12:00:00.000Z"),
  status: "running",
  stopSupported: false,
};
const dashboard: MigrateDashboard = {
  activeRuns: [activeRun],
  groups: [],
  rows: [
    {
      entry: {
        dependencies: { optional: [], required: [] },
        hasRollback: true,
        id: definitionId,
      },
      status: {
        definitionId,
        discovery: "incremental",
        durable: { failed: 0, migrated: 12, needsUpdate: 0, skipped: 1 },
        lastRun: null,
        lock: null,
        warnings: [],
      },
    },
  ],
  scannedSource: false,
};
const serverInfo: MigrateServerInfo = {
  environment: { id: "production", label: "Production" },
  protocolVersion: MIGRATE_PROTOCOL_VERSION,
  registryId: toMigrationDefinitionRegistryId("catalog"),
  sdkVersion: "0.5.0",
};

const backend: MigrateServerBackend<FakeOperation> = {
  breakLock: (lock: MigrationDefinitionLock) =>
    Effect.succeed({ definitionId: lock.definitionId, kind: "cleared" }),
  executeOperation: (_operation, observer) => {
    observer.onStateChange({
      adapter: "remote-test",
      definitionId,
      kind: "running",
      ownership: "server",
      runId,
    });
    return Effect.succeed({
      result: Effect.succeed({
        message: `Run ${runId} succeeded`,
        outcome: "completed" as const,
        runId,
      }),
      stop: Effect.succeed({
        kind: "requested" as const,
        message: `Stopping run ${runId}`,
      }),
    });
  },
  getActiveRuns: Effect.succeed([activeRun]),
  getDashboard: Effect.succeed(dashboard),
  getMessages: () => Effect.succeed([]),
  getRunProgress: () =>
    Effect.succeed({
      definitions: dashboard.rows.flatMap((row) =>
        row.status === undefined ? [] : [row.status]
      ),
      observationDefinitionId: definitionId,
    }),
  getSourceIdentityHistory: () => Effect.succeed([]),
  normalizeSourceIdentity: (_definitionId, sourceIdentity) =>
    Effect.succeed(sourceIdentity),
  observeRun: (requestedRunId, observer) => {
    observer.onStateChange({
      adapter: "remote-test",
      definitionId,
      executionId: "workflow-1",
      kind: "running",
      ownership: "provider",
      runId: requestedRunId,
    });

    return Effect.succeed({
      message: `Run ${requestedRunId} succeeded`,
      outcome: "completed" as const,
      runId: requestedRunId,
    });
  },
  prepareOperation: (request) =>
    Effect.succeed({
      executable: { kind: "run" },
      operation: {
        action: request.action,
        dependencyChecks: [],
        observationDefinitionId: definitionId,
        plan: {
          executionDefinitionIds: [definitionId],
          requestedDefinitionIds: [definitionId],
          withDependencies: request.options.withDependencies ?? false,
        },
        planRows: dashboard.rows,
        target: request.target,
      },
    }),
  scanSource: () => Effect.succeed(dashboard),
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((cause) => {
      if (cause === undefined) {
        resolve();
      } else {
        reject(cause);
      }
    });
  });

const listenOnLocalhost = async (
  handler: (request: Request) => Promise<Response>
): Promise<{ readonly server: Server; readonly url: string }> => {
  const server = createServer(async (request, response) => {
    try {
      const chunks: Uint8Array[] = [];

      for await (const chunk of request) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }

      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined) {
          continue;
        }
        if (Array.isArray(value)) {
          for (const entry of value) {
            headers.append(name, entry);
          }
        } else {
          headers.set(name, value);
        }
      }

      const body = Buffer.concat(chunks);
      const webResponse = await handler(
        new Request(
          `http://${request.headers.host ?? "127.0.0.1"}${request.url ?? "/"}`,
          {
            ...(body.byteLength === 0 ? {} : { body }),
            headers,
            method: request.method ?? "GET",
          }
        )
      );
      response.writeHead(
        webResponse.status,
        Object.fromEntries(webResponse.headers.entries())
      );
      response.end(Buffer.from(await webResponse.arrayBuffer()));
    } catch (cause) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(cause instanceof Error ? cause.message : String(cause));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();

  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Local Migrate Server did not bind a TCP port");
  }

  return { server, url: `http://127.0.0.1:${address.port}/rpc` };
};

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

  it("requires explicit HTTP authentication ownership", () => {
    expect(() =>
      makeMigrateServerHttpHandler(
        MigrateServer.layer({ backend, serverInfo }),
        { path: "/rpc" } as never
      )
    ).toThrow("authentication must be provided or delegated externally");
  });

  it("connects the TUI runtime to a running localhost Migrate Server over HTTP", async () => {
    const http = makeMigrateServerHttpHandler(
      MigrateServer.layer({ backend, serverInfo }),
      {
        authorize: (request) =>
          Effect.succeed(
            request.headers.get("authorization") === "Bearer local-secret"
          ),
        path: "/rpc",
      }
    );
    let localhost:
      | { readonly server: Server; readonly url: string }
      | undefined;

    try {
      localhost = await listenOnLocalhost(http.handler);
      const runtime = await makeMigrationTuiRuntime({
        server: {
          bearerToken: "local-secret",
          url: localhost.url,
        },
      });

      try {
        const snapshot = await runtime.refresh();

        expect(runtime.environmentLabel).toBe("Production");
        expect(snapshot.rows[0]?.status?.durable).toEqual({
          failed: 0,
          migrated: 12,
          needsUpdate: 0,
          skipped: 1,
        });
        await expect(runtime.observeRun(runId)).resolves.toMatchObject({
          outcome: "completed",
          runId,
        });
      } finally {
        await runtime.dispose?.();
      }
    } finally {
      if (localhost !== undefined) {
        await closeServer(localhost.server);
      }
      await http.dispose();
    }
  });

  it("starts the exact request returned with the prepared operation", async () => {
    const preparedRequests: MigrateOperationRequest[] = [];
    const requestBackend: MigrateServerBackend<FakeOperation> = {
      ...backend,
      prepareOperation: (request) => {
        preparedRequests.push(request);
        return backend.prepareOperation(request);
      },
    };
    const http = makeMigrateServerHttpHandler(
      MigrateServer.layer({ backend: requestBackend, serverInfo }),
      { authentication: "external", path: "/rpc" }
    );
    let localhost:
      | { readonly server: Server; readonly url: string }
      | undefined;

    try {
      localhost = await listenOnLocalhost(http.handler);
      const runtime = await makeMigrationTuiRuntime({
        server: { url: localhost.url },
      });
      const options = {
        execution: {
          process: { concurrency: 3 as const },
          rollback: { concurrency: "unbounded" as const },
        },
        force: true,
        sourceIdentities: ["article:1", "article:2"],
        withDependencies: true,
      };

      try {
        const operation = await runtime.prepare(
          { definitionId, kind: "migration" },
          "run",
          options
        );
        await runtime.start(operation);

        const expectedRequest: MigrateOperationRequest = {
          action: "run",
          options,
          target: { definitionId, kind: "migration" },
        };
        expect(operation.request).toEqual(expectedRequest);
        expect(preparedRequests).toEqual([expectedRequest, expectedRequest]);
      } finally {
        await runtime.dispose?.();
      }
    } finally {
      if (localhost !== undefined) {
        await closeServer(localhost.server);
      }
      await http.dispose();
    }
  });

  it("detaches remote observation when its caller aborts", async () => {
    const observationBackend: MigrateServerBackend<FakeOperation> = {
      ...backend,
      getRunProgress: () => Effect.sync(() => undefined),
      observeRun: () => Effect.never,
    };
    const http = makeMigrateServerHttpHandler(
      MigrateServer.layer({
        backend: observationBackend,
        observationLeaseDuration: "20 seconds",
        serverInfo,
      }),
      { authentication: "external", path: "/rpc" }
    );
    let localhost:
      | { readonly server: Server; readonly url: string }
      | undefined;

    try {
      localhost = await listenOnLocalhost(http.handler);
      const runtime = await makeMigrationTuiRuntime({
        server: { url: localhost.url },
      });
      const controller = new AbortController();

      try {
        const observation = runtime.observeRun(runId, {
          signal: controller.signal,
        });
        controller.abort();

        await expect(observation).resolves.toEqual({
          message: `Run ${runId} continues in the background`,
          outcome: "detached",
          runId,
        });
      } finally {
        await runtime.dispose?.();
      }
    } finally {
      if (localhost !== undefined) {
        await closeServer(localhost.server);
      }
      await http.dispose();
    }
  });

  it("authenticates, reads the dashboard, and resumes observation leases", async () => {
    const authorizationHeaders: string[] = [];
    let observationRequests = 0;
    let transientStatusFailures = 0;
    const http = makeMigrateServerHttpHandler(
      MigrateServer.layer({ backend, serverInfo }),
      {
        authorize: (request) =>
          Effect.sync(() => {
            const authorization = request.headers.get("authorization") ?? "";
            authorizationHeaders.push(authorization);
            return authorization === "Bearer secret";
          }),
        path: "/rpc",
      }
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
    const original = makeMigrateServerHttpHandler(
      MigrateServer.layer({
        backend: { ...backend, getDashboard: Effect.succeed(initialDashboard) },
        serverInfo,
      }),
      { authentication: "external", path: "/rpc" }
    );
    const replacement = makeMigrateServerHttpHandler(
      MigrateServer.layer({ backend, serverInfo }),
      { authentication: "external", path: "/rpc" }
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
    const http = makeMigrateServerHttpHandler(
      MigrateServer.layer({ backend, serverInfo }),
      { authorize: () => Effect.succeed(false), path: "/rpc" }
    );

    try {
      await expect(
        connectRemoteMigrateServer({
          fetch: (input, init) => http.handler(new Request(input, init)),
          url: "https://migrate.example/rpc",
        })
      ).rejects.toThrow("Unable to connect to Migrate Server");
    } finally {
      await http.dispose();
    }
  });

  it("rejects a remote server with a different SDK version", async () => {
    const http = makeMigrateServerHttpHandler(
      MigrateServer.layer({
        backend,
        serverInfo: { ...serverInfo, sdkVersion: "999.0.0" },
      }),
      { authentication: "external", path: "/rpc" }
    );

    try {
      await expect(
        connectRemoteMigrateServer({
          fetch: (input, init) => http.handler(new Request(input, init)),
          url: "https://migrate.example/rpc",
        })
      ).rejects.toThrow("Migrate SDK version 999.0.0 is not supported");
    } finally {
      await http.dispose();
    }
  });
});
