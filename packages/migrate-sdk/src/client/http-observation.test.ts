/** @effect-diagnostics asyncFunction:skip-file */
import { it as effectIt } from "@effect/vitest";
import { Clock, Deferred, Effect, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
  remoteMigrateServerBackend as backend,
  remoteMigrateDashboard as dashboard,
  remoteMigrateDefinitionId as definitionId,
  makeRemoteMigrateServerHttp,
  remoteMigrateRunId as runId,
  remoteMigrateServerIdentity as serverIdentity,
} from "../../test/fixtures/remote-server.ts";
import type { MigrateDashboard } from "../protocol/index.ts";
import { MigrateServer, MigrateServerHttp } from "../server/index.ts";
import { connectHttpMigrateServer } from "./http.ts";

describe("HTTP observation sessions", () => {
  effectIt.effect(
    "keeps one quiet response with no backup requests, then resumes if heartbeats stop",
    () =>
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        const received = yield* Deferred.make<void>();
        const stalledResponseAborted = yield* Deferred.make<void>();
        const reconnected = yield* Deferred.make<void>();
        const requests: string[] = [];
        let reads = 0;
        let stalled = false;
        let observationRequests = 0;
        const http = MigrateServerHttp.toWebHandler(
          Layer.merge(
            MigrateServerHttp.layer.pipe(
              Layer.provide(
                MigrateServer.layer({
                  backend: {
                    ...backend,
                    getDashboard: Effect.sync(() => {
                      reads += 1;
                      return dashboard;
                    }),
                  },
                  ...serverIdentity,
                })
              )
            ),
            Layer.succeed(Clock.Clock, clock)
          )
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => http.dispose()));
        const connection = yield* Effect.promise(() =>
          connectHttpMigrateServer({
            fetch: async (input, init) => {
              const request = new Request(input, init);
              const body = await request.clone().text();
              requests.push(body);
              const response = await http.handler(request);
              if (
                !body.includes("ObserveDashboardSession") ||
                response.body === null
              ) {
                return response;
              }
              observationRequests += 1;
              const firstResponse = observationRequests === 1;
              if (!firstResponse) {
                Deferred.doneUnsafe(reconnected, Effect.void);
              }
              request.signal.addEventListener(
                "abort",
                () => Deferred.doneUnsafe(stalledResponseAborted, Effect.void),
                { once: true }
              );
              return new Response(
                response.body.pipeThrough(
                  new TransformStream({
                    transform(chunk, controller) {
                      if (!(stalled && firstResponse)) {
                        controller.enqueue(chunk);
                      }
                    },
                  }),
                  // The in-memory fetch must honor abort like a real network fetch.
                  { signal: request.signal }
                ),
                { headers: response.headers }
              );
            },
            url: "https://migrate.example/rpc",
          })
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => connection.dispose())
        );
        const abort = new AbortController();
        const observing = connection
          .runPromise(
            connection.client.observeDashboard({}).pipe(
              Stream.runForEach(() => Deferred.succeed(received, undefined)),
              Effect.provideService(Clock.Clock, clock)
            ),
            { signal: abort.signal }
          )
          .catch(() => undefined);
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            abort.abort();
            await observing;
          })
        );
        yield* Deferred.await(received);
        yield* TestClock.adjust("90 seconds");
        expect(
          requests.filter((request) =>
            request.includes("ObserveDashboardSession")
          )
        ).toHaveLength(1);
        expect(requests.some((request) => request.includes("Lease"))).toBe(
          false
        );
        expect(reads).toBe(1);
        stalled = true;
        yield* TestClock.adjust("45 seconds");
        yield* Deferred.await(stalledResponseAborted);
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(reconnected);
        expect(observationRequests).toBe(2);
        expect(requests.at(-1)).toContain('"after":');
        expect(requests.some((request) => request.includes("Lease"))).toBe(
          false
        );
        abort.abort();
        yield* Effect.promise(() => observing);
        const readsAfterDetach = reads;
        yield* TestClock.adjust("5 minutes");
        expect(requests).toHaveLength(3);
        expect(reads).toBe(readsAfterDetach);
      })
  );

  it("keeps client totals and resumes the next Workflow chunk on a replacement server without a summary scan", async () => {
    const definitions = dashboard.rows.flatMap((row) =>
      row.status === undefined ? [] : [row.status]
    );
    let fullReads = 0;
    let attachments = 0;
    const makeServer = (replacement: boolean) =>
      makeRemoteMigrateServerHttp(
        MigrateServer.layer({
          backend: {
            ...backend,
            getDashboard: replacement
              ? Effect.die("renewal must not read summaries")
              : Effect.sync(() => {
                  fullReads += 1;
                  return dashboard;
                }),
            watchDashboardRun: (_run, options) =>
              Effect.gen(function* () {
                attachments += 1;
                if (replacement) {
                  expect(options.after).toBe("1");
                } else {
                  yield* options.onEvent?.({
                    kind: "progress",
                    runId,
                    cursor: "0",
                    replaying: true,
                    progress: { kind: "baseline", runId, definitions },
                  }) ?? Effect.void;
                }
                yield* options.onEvent?.({
                  kind: "progress",
                  runId,
                  cursor: replacement ? "2" : "1",
                  progress: {
                    kind: "contribution",
                    runId,
                    partitionId: "a:1",
                    revision: replacement ? 2 : 1,
                    changes: [
                      {
                        definitionId,
                        delta: {
                          migrated: replacement ? 5 : 2,
                          failed: 0,
                          skipped: 0,
                          needsUpdate: 0,
                        },
                      },
                    ],
                  },
                }) ?? Effect.void;
                return yield* Effect.never;
              }),
          },
          observationSessionDuration: replacement ? "4 minutes" : "100 millis",
          ...serverIdentity,
        })
      );
    const original = makeServer(false);
    const replacement = makeServer(true);
    let requests = 0;
    const connection = await connectHttpMigrateServer({
      url: "https://migrate.example/rpc",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (
          !(await request.clone().text()).includes("ObserveDashboardSession")
        ) {
          return original.handler(request);
        }
        requests += 1;
        return (requests === 1 ? original : replacement).handler(request);
      },
    });
    try {
      const counts = await connection.runPromise(
        connection.client.observeDashboard({}).pipe(
          Stream.map(
            (snapshot) => snapshot.dashboard.rows[0]?.status?.durable.migrated
          ),
          Stream.changes,
          Stream.filter((count) => count === 14 || count === 17),
          Stream.take(2),
          Stream.runCollect
        )
      );
      expect(counts).toEqual([14, 17]);
      expect(fullReads).toBe(1);
      expect(requests).toBe(2);
      expect(attachments).toBe(2);
    } finally {
      await connection.dispose();
      await original.dispose();
      await replacement.dispose();
    }
  });

  it.each([
    "broken",
    "truncated",
  ])("recovers from a %s response body using the last delivered run checkpoint", async (interruption) => {
    const original = makeRemoteMigrateServerHttp(
      MigrateServer.layer({
        backend: { ...backend, observeRun: () => Effect.never },
        ...serverIdentity,
      })
    );
    const replacement = makeRemoteMigrateServerHttp(
      MigrateServer.layer({ backend, ...serverIdentity })
    );
    const bodies: string[] = [];
    const connection = await connectHttpMigrateServer({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = await request.clone().text();
        if (!body.includes("ObserveRunSession")) {
          return original.handler(request);
        }
        bodies.push(body);
        if (bodies.length > 1) {
          return replacement.handler(request);
        }
        const response = await original.handler(request);
        const reader = response.body?.getReader();
        if (reader === undefined) {
          throw new Error("Expected a streaming response");
        }
        let deliveredProgress = false;
        return new Response(
          new ReadableStream({
            async pull(controller) {
              if (deliveredProgress) {
                await reader.cancel();
                if (interruption === "broken") {
                  controller.error(new TypeError("Connection reset"));
                } else {
                  controller.close();
                }
                return;
              }
              const chunk = await reader.read();
              if (chunk.done) {
                controller.close();
                return;
              }
              deliveredProgress = new TextDecoder()
                .decode(chunk.value)
                .includes('"kind":"progress"');
              controller.enqueue(chunk.value);
            },
            cancel: () => reader.cancel(),
          }),
          { headers: response.headers }
        );
      },
      url: "https://migrate.example/rpc",
    });
    try {
      const events = await connection.runPromise(
        connection.client.observeRun({ runId }).pipe(Stream.runCollect)
      );
      expect(events.map((event) => event.kind)).toEqual([
        "progress",
        "state",
        "terminal",
      ]);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toContain('"after":"backend:');
    } finally {
      await connection.dispose();
      await original.dispose();
      await replacement.dispose();
    }
  });

  it("keeps one provider observer across multiple committed progress updates", async () => {
    let definitions = dashboard.rows.flatMap((row) =>
      row.status === undefined ? [] : [row.status]
    );
    let providerSubscriptions = 0;
    let requests = 0;
    const http = makeRemoteMigrateServerHttp(
      MigrateServer.layer({
        backend: {
          ...backend,
          getRunProgress: () =>
            Effect.sync(() => ({
              definitions,
              observationDefinitionId: definitionId,
            })),
          observeRun: (_runId, observer) =>
            Effect.gen(function* () {
              providerSubscriptions += 1;
              for (const migrated of [12, 13, 13, 14, 14]) {
                definitions = definitions.map((definition) => ({
                  ...definition,
                  durable: { ...definition.durable, migrated },
                }));
                observer.onProgress({ definitions });
                yield* Effect.sleep("5 millis");
              }
              return {
                outcome: "completed" as const,
                runId,
                message: "Finished",
              };
            }),
        },
        ...serverIdentity,
      })
    );
    const connection = await connectHttpMigrateServer({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if ((await request.clone().text()).includes("ObserveRunSession")) {
          requests += 1;
        }
        return http.handler(request);
      },
      url: "https://migrate.example/rpc",
    });
    try {
      const events = await connection.runPromise(
        connection.client.observeRun({ runId }).pipe(Stream.runCollect)
      );
      const counts = events.flatMap((event) =>
        event.kind === "progress"
          ? event.definitions.map((definition) => definition.durable.migrated)
          : []
      );
      expect(counts).toEqual([12, 13, 14]);
      expect(events.at(-1)?.kind).toBe("terminal");
      expect(providerSubscriptions).toBe(1);
      expect(requests).toBe(1);
    } finally {
      await connection.dispose();
      await http.dispose();
    }
  });

  it("delivers a return to the resumed state before the session renews", async () => {
    let definitions = dashboard.rows.flatMap((row) =>
      row.status === undefined
        ? []
        : [
            {
              ...row.status,
              durable: { ...row.status.durable, failed: 1 },
            },
          ]
    );
    const getRunProgress = () =>
      Effect.sync(() => ({
        definitions,
        observationDefinitionId: definitionId,
      }));
    const original = makeRemoteMigrateServerHttp(
      MigrateServer.layer({
        backend: { ...backend, getRunProgress, observeRun: () => Effect.never },
        observationSessionDuration: "20 millis",
        ...serverIdentity,
      })
    );
    const replacement = makeRemoteMigrateServerHttp(
      MigrateServer.layer({
        backend: {
          ...backend,
          getRunProgress,
          observeRun: (_runId, observer) =>
            Effect.gen(function* () {
              // Retry a failed item successfully, then fail an update of a
              // previously migrated item. Aggregate counts return to the start.
              for (const [migrated, failed] of [
                [13, 0],
                [12, 1],
                [12, 1],
              ] as const) {
                definitions = definitions.map((definition) => ({
                  ...definition,
                  durable: { ...definition.durable, migrated, failed },
                }));
                observer.onProgress({ definitions });
              }
              return yield* Effect.never;
            }),
        },
        observationSessionDuration: "100 millis",
        ...serverIdentity,
      })
    );
    const requests: string[] = [];
    const connection = await connectHttpMigrateServer({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = await request.clone().text();
        if (!body.includes("ObserveRunSession")) {
          return original.handler(request);
        }
        requests.push(body);
        return requests.length === 1
          ? original.handler(request)
          : replacement.handler(request);
      },
      url: "https://migrate.example/rpc",
    });
    try {
      const events = await connection.runPromise(
        connection.client.observeRun({ runId }).pipe(
          Stream.filter((event) => event.kind === "progress"),
          Stream.take(3),
          Stream.runCollect
        )
      );
      expect(
        events.flatMap((event) =>
          event.definitions.map((definition) => ({
            migrated: definition.durable.migrated,
            failed: definition.durable.failed,
          }))
        )
      ).toEqual([
        { migrated: 12, failed: 1 },
        { migrated: 13, failed: 0 },
        { migrated: 12, failed: 1 },
      ]);
      expect(requests).toHaveLength(2);
      expect(requests[1]).toContain('"after":"backend:');
    } finally {
      await connection.dispose();
      await original.dispose();
      await replacement.dispose();
    }
  });

  it("resumes run progress after expiration and a transient HTTP failure without replaying the initial snapshot", async () => {
    const original = makeRemoteMigrateServerHttp(
      MigrateServer.layer({
        backend: { ...backend, observeRun: () => Effect.never },
        observationSessionDuration: "20 millis",
        ...serverIdentity,
      })
    );
    const replacement = makeRemoteMigrateServerHttp(
      MigrateServer.layer({ backend, ...serverIdentity })
    );
    const observationBodies: string[] = [];
    const connection = await connectHttpMigrateServer({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = await request.clone().text();
        if (body.includes("ObserveRunSession")) {
          observationBodies.push(body);
          if (observationBodies.length === 2) {
            return new Response("Unavailable", { status: 503 });
          }
          return observationBodies.length === 1
            ? original.handler(request)
            : replacement.handler(request);
        }
        return original.handler(request);
      },
      url: "https://migrate.example/rpc",
    });
    try {
      const events = await connection.runPromise(
        connection.client.observeRun({ runId }).pipe(Stream.runCollect)
      );
      expect(events.map((event) => event.kind)).toEqual([
        "progress",
        "state",
        "terminal",
      ]);
      expect(observationBodies).toHaveLength(3);
      expect(observationBodies[1]).toContain('"after":"backend:');
      expect(observationBodies[2]).toContain('"after":"backend:');
    } finally {
      await connection.dispose();
      await original.dispose();
      await replacement.dispose();
    }
  });

  it.each([
    "permission",
    "malformed NDJSON",
  ])("does not retry an observation %s failure", async (failure) => {
    let attempts = 0;
    const http = makeRemoteMigrateServerHttp(
      MigrateServer.layer({ backend, ...serverIdentity })
    );
    const connection = await connectHttpMigrateServer({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (
          (await request.clone().text()).includes("ObserveDashboardSession")
        ) {
          attempts += 1;
          return failure === "permission"
            ? new Response("Forbidden", { status: 403 })
            : new Response("not-json\n", {
                headers: { "content-type": "application/ndjson" },
              });
        }
        return http.handler(request);
      },
      url: "https://migrate.example/rpc",
    });
    try {
      await expect(
        connection.runPromise(
          connection.client.observeDashboard({}).pipe(Stream.runCollect)
        )
      ).rejects.toBeDefined();
      expect(attempts).toBe(1);
    } finally {
      await connection.dispose();
      await http.dispose();
    }
  });
  it("delivers run progress and completion through one authenticated session", async () => {
    const requests: string[] = [];
    const authorization: (string | null)[] = [];
    const http = makeRemoteMigrateServerHttp(
      MigrateServer.layer({ backend, ...serverIdentity })
    );
    const connection = await connectHttpMigrateServer({
      bearerToken: "test-token",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(await request.clone().text());
        authorization.push(request.headers.get("authorization"));
        return http.handler(request);
      },
      url: "https://migrate.example/rpc",
    });
    try {
      const events = await connection.runPromise(
        connection.client.observeRun({ runId }).pipe(Stream.runCollect)
      );
      expect(events.map((event) => event.kind)).toEqual([
        "progress",
        "state",
        "terminal",
      ]);
      expect(
        requests.filter((request) => request.includes("GetServerInfo"))
      ).toHaveLength(1);
      expect(
        requests.filter((request) => request.includes("ObserveRunSession"))
      ).toHaveLength(1);
      expect(
        requests.some((request) => request.includes("ObserveRunLease"))
      ).toBe(false);
      expect(
        authorization.every((value) => value === "Bearer test-token")
      ).toBe(true);
    } finally {
      await connection.dispose();
      await http.dispose();
    }
  });

  it("delivers multiple changed dashboards in one request and cancels observation on detach", async () => {
    const snapshots: MigrateDashboard[] = [
      { ...dashboard, activeRuns: [] },
      dashboard,
      { ...dashboard, activeRuns: [] },
    ];
    let reads = 0;
    let observationRequests = 0;
    let observationSignal: AbortSignal | undefined;
    const http = makeRemoteMigrateServerHttp(
      MigrateServer.layer({
        backend: {
          ...backend,
          getDashboard: Effect.sync(() => snapshots[reads++] ?? dashboard),
          getActiveRuns: Effect.sync(
            () => (snapshots[reads++] ?? dashboard).activeRuns
          ),
        },
        dashboardFallbackInterval: "10 millis",
        dashboardProjectionInterval: 0,
        ...serverIdentity,
      })
    );
    const connection = await connectHttpMigrateServer({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (
          (await request.clone().text()).includes("ObserveDashboardSession")
        ) {
          observationRequests += 1;
          observationSignal = request.signal;
        }
        return http.handler(request);
      },
      url: "https://migrate.example/rpc",
    });
    try {
      const observed = await connection.runPromise(
        connection.client
          .observeDashboard({})
          .pipe(Stream.take(3), Stream.runCollect)
      );
      expect(observed.map((snapshot) => snapshot.dashboard)).toEqual(snapshots);
      expect(observationRequests).toBe(1);
      expect(observationSignal?.aborted).toBe(true);
    } finally {
      await connection.dispose();
      await http.dispose();
    }
  });

  it("resumes an expired session on a replacement instance using the last snapshot token", async () => {
    const initial = { ...dashboard, activeRuns: [] };
    const original = makeRemoteMigrateServerHttp(
      MigrateServer.layer({
        backend: { ...backend, getDashboard: Effect.succeed(initial) },
        observationSessionDuration: "20 millis",
        dashboardFallbackInterval: "1 hour",
        ...serverIdentity,
      })
    );
    const replacement = makeRemoteMigrateServerHttp(
      MigrateServer.layer({ backend, ...serverIdentity })
    );
    const observationBodies: string[] = [];
    const connection = await connectHttpMigrateServer({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = await request.clone().text();
        if (body.includes("ObserveDashboardSession")) {
          observationBodies.push(body);
          return observationBodies.length === 1
            ? original.handler(request)
            : replacement.handler(request);
        }
        return original.handler(request);
      },
      url: "https://migrate.example/rpc",
    });
    try {
      const observed = await connection.runPromise(
        connection.client
          .observeDashboard({})
          .pipe(Stream.take(2), Stream.runCollect)
      );
      expect(observed.map((snapshot) => snapshot.dashboard)).toEqual([
        initial,
        dashboard,
      ]);
      expect(observationBodies).toHaveLength(2);
      expect(observationBodies[1]).toContain(observed[0]?.resumeToken);
    } finally {
      await connection.dispose();
      await original.dispose();
      await replacement.dispose();
    }
  });
});
