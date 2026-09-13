import { createServer, type Server } from "node:http";
import { Effect, Layer } from "effect";
import type {
  MigrateOperationRequest,
  MigrateStoreSchemaPlan,
} from "migrate-sdk/protocol";
import { MigrateServer, type MigrateServerBackend } from "migrate-sdk/server";
import { describe, expect, it } from "vitest";
import {
  remoteMigrateServerBackend as backend,
  remoteMigrateDefinitionId as definitionId,
  makeAuthorizedRemoteMigrateServerHttp,
  makeRemoteMigrateServerHttp,
  type RemoteMigrateServerTestOperation,
  remoteMigrateRunId as runId,
  remoteMigrateServerIdentity as serverIdentity,
} from "../../../migrate-sdk/test/fixtures/remote-server.ts";
import { makeMigrationTuiRuntime } from "./tui-runtime.ts";

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

describe("remote TUI runtime", () => {
  it("connects and reviews an upgrade before requesting the remote dashboard", async () => {
    const plan: MigrateStoreSchemaPlan = {
      applied: [
        { id: 1, name: "initial_schema" },
        { id: 2, name: "definition_run_status" },
      ],
      currentVersion: 2,
      database: "sqlite",
      issues: [],
      pending: [
        {
          id: 3,
          name: "operation_history_and_completion",
          description:
            "Record operation history and migration completion separately",
        },
      ],
      planId: "schema-plan",
      status: "upgrade-required",
      tablePrefix: "migrate_sdk",
      targetVersion: 3,
      warnings: [],
    };
    let schema = plan;
    let dashboardReads = 0;
    const serverLayer = Layer.effect(
      MigrateServer,
      Effect.gen(function* () {
        const server = yield* MigrateServer.make({
          backend,
          ...serverIdentity,
        });
        return {
          ...server,
          getStoreSchema: Effect.sync(() => schema),
          upgradeStoreSchema: ({
            acceptedPlanId,
          }: {
            readonly acceptedPlanId: string;
          }) =>
            Effect.sync(() => {
              expect(acceptedPlanId).toBe(plan.planId);
              schema = {
                ...plan,
                currentVersion: 3,
                status: "current",
                pending: [],
              };
              return schema;
            }),
          getDashboard: Effect.sync(() => {
            dashboardReads += 1;
            expect(schema.status).toBe("current");
          }).pipe(Effect.andThen(server.getDashboard)),
        };
      })
    );
    const http = makeRemoteMigrateServerHttp(serverLayer);
    const { server, url } = await listenOnLocalhost(http.handler);
    try {
      const runtime = await makeMigrationTuiRuntime({ server: { url } });
      try {
        expect(runtime.storeSchema).toEqual(plan);
        expect(dashboardReads).toBe(0);
        expect(runtime.rows[0]?.entry.id).toBe(definitionId);
        await expect(
          runtime.upgradeStoreSchema(plan.planId)
        ).resolves.toMatchObject({ currentVersion: 3, status: "current" });
        expect(runtime.storeSchema?.status).toBe("current");
        await runtime.refresh();
        expect(dashboardReads).toBe(1);
      } finally {
        await runtime.dispose?.();
      }
    } finally {
      await closeServer(server);
      await http.dispose();
    }
  });

  it("connects the TUI runtime to a running localhost Migrate Server over HTTP", async () => {
    const completedAt = new Date("2026-09-11T00:00:00.000Z");
    const completionBackend = {
      ...backend,
      getDashboard: backend.getDashboard.pipe(
        Effect.map((dashboard) => ({
          ...dashboard,
          rows: dashboard.rows.map((row) =>
            row.status === undefined
              ? row
              : {
                  ...row,
                  status: {
                    ...row.status,
                    completion: {
                      definitionId,
                      runId,
                      completedAt,
                      sourceCursor: null,
                    },
                  },
                }
          ),
        }))
      ),
    };
    const http = makeAuthorizedRemoteMigrateServerHttp(
      MigrateServer.layer({ backend: completionBackend, ...serverIdentity }),
      (request) =>
        Effect.succeed(request.headers.authorization === "Bearer local-secret")
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
        expect(snapshot.rows[0]?.status?.completion).toEqual({
          definitionId,
          runId,
          completedAt,
          sourceCursor: null,
        });
        expect(snapshot.rows[0]?.status?.durable).toEqual({
          failed: 0,
          migrated: 12,
          needsUpdate: 0,
          skipped: 1,
        });
        await expect(
          runtime.getSourceItemTotals([definitionId])
        ).resolves.toEqual([
          { definitionId, total: { count: 4, kind: "known" } },
        ]);
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
    const requestBackend: MigrateServerBackend<RemoteMigrateServerTestOperation> =
      {
        ...backend,
        prepareOperation: (request) => {
          preparedRequests.push(request);
          return backend.prepareOperation(request);
        },
      };
    const http = makeRemoteMigrateServerHttp(
      MigrateServer.layer({ backend: requestBackend, ...serverIdentity })
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
          { definitionIds: [definitionId], kind: "definitions" },
          "run",
          options
        );
        await runtime.start(operation);

        const expectedRequest: MigrateOperationRequest = {
          action: "run",
          options,
          selection: { definitionIds: [definitionId], kind: "definitions" },
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
    const observationBackend: MigrateServerBackend<RemoteMigrateServerTestOperation> =
      {
        ...backend,
        getRunProgress: () => Effect.sync(() => undefined),
        observeRun: () => Effect.never,
      };
    const http = makeRemoteMigrateServerHttp(
      MigrateServer.layer({
        backend: observationBackend,
        observationLeaseDuration: "20 seconds",
        ...serverIdentity,
      })
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
});
