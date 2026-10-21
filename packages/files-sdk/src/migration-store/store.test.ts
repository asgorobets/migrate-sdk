import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { FilesError, Files as FilesSDKClient } from "files-sdk";
import { Files } from "files-sdk/effect";
import {
  type MigrationItemState,
  MigrationStore,
  SourceIdentity,
  toEncodedSourceCursor,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceVersion,
} from "migrate-sdk";
import {
  runMigrationCompletionScenario,
  runSupersededMigrationRunScenario,
} from "migrate-sdk/testing";
import { makeMemoryFilesSDK } from "../testing/index.ts";
import { FilesSDKMigrationStore } from "./store.ts";

const definitionId = toMigrationDefinitionId("files");
const runId = toMigrationRunId("run");
const portableKeyPattern = /^[a-z0-9/-]+\.json$/u;
const identity = SourceIdentity.make({
  id: "fixture@v1",
  schema: SourceIdentity.key("key", Schema.String),
});
const options = {
  storageId: "state",
  namespace: "test",
  locking: "advisory" as const,
  pageSize: 2,
};

function storeLayer(client: FilesSDKClient) {
  return FilesSDKMigrationStore.layer(options).pipe(
    Layer.provide(Files.layer(client))
  );
}

function state(key: string) {
  return {
    definitionId,
    lastRunId: runId,
    sourceIdentity: SourceIdentity.fromKey(identity, key),
    sourceVersion: toSourceVersion("v1"),
    updatedAt: new Date("2026-10-16T00:00:00Z"),
    status: "migrated" as const,
  };
}

describe("FilesSDKMigrationStore", () => {
  for (const afterCommit of [false, true]) {
    for (const boundary of [1, 2, 3]) {
      it.effect(
        `repairs start write ${boundary} failing ${afterCommit ? "after" : "before"} commit`,
        () =>
          Effect.gen(function* () {
            const backend = makeMemoryFilesSDK();
            let enabled = true;
            let writes = 0;
            const client = new FilesSDKClient({
              adapter: {
                ...backend.adapter,
                upload: async (key, body, opts) => {
                  const selected =
                    enabled &&
                    (key.includes("/runs/") ||
                      key.endsWith("/latest-run.json"));
                  if (selected) {
                    writes++;
                  }
                  const fails = selected && writes === boundary;
                  if (fails && !afterCommit) {
                    throw new FilesError("Provider", "before commit");
                  }
                  const result = await backend.adapter.upload(key, body, opts);
                  if (fails) {
                    throw new FilesError("Provider", "lost response");
                  }
                  return result;
                },
              },
            });
            yield* MigrationStore.use((store) =>
              Effect.gen(function* () {
                const ids = [definitionId, toMigrationDefinitionId("second")];
                const input = {
                  runId,
                  definitionIds: ids,
                  operation: "run" as const,
                };
                yield* Effect.flip(store.beginRun(input));
                enabled = false;
                yield* store.beginRun(input);
                for (const id of ids) {
                  expect((yield* store.getLatestRunState(id))?.runId).toBe(
                    runId
                  );
                }
              })
            ).pipe(Effect.provide(storeLayer(client)));
          })
      );
    }
    for (const kind of ["completion", "cursor", "item"]) {
      it.effect(
        `recovers rollback ${kind} deletion failing ${afterCommit ? "after" : "before"} commit`,
        () =>
          Effect.gen(function* () {
            const backend = makeMemoryFilesSDK();
            let enabled = false;
            const client = new FilesSDKClient({
              adapter: {
                ...backend.adapter,
                delete: async (key, opts) => {
                  const selected =
                    enabled &&
                    (kind === "item"
                      ? key.includes("/items/")
                      : key.endsWith(`/${kind}.json`));
                  if (selected && !afterCommit) {
                    throw new FilesError("Provider", "before commit");
                  }
                  await backend.adapter.delete(key, opts);
                  if (selected) {
                    throw new FilesError("Provider", "lost response");
                  }
                },
              },
            });
            yield* MigrationStore.use((store) =>
              Effect.gen(function* () {
                const item = state("one");
                yield* store.upsertItemState(item);
                yield* store.setSourceCursor(
                  definitionId,
                  toEncodedSourceCursor("cursor")
                );
                yield* store.recordSourcePassCompletion({
                  definitionId,
                  runId,
                  completedAt: new Date(),
                  sourceCursor: null,
                });
                enabled = true;
                yield* Effect.flip(
                  store.removeRolledBackItem({
                    definitionId,
                    sourceIdentity: item.sourceIdentity.encoded,
                  })
                );
                if (
                  (yield* store.getItemState(
                    definitionId,
                    item.sourceIdentity.encoded
                  )) === null
                ) {
                  expect(
                    yield* store.getDefinitionCompletion(definitionId)
                  ).toBeNull();
                  expect(yield* store.getSourceCursor(definitionId)).toBeNull();
                }
                enabled = false;
                yield* store.removeRolledBackItem({
                  definitionId,
                  sourceIdentity: item.sourceIdentity.encoded,
                });
                expect(
                  yield* store.getDefinitionCompletion(definitionId)
                ).toBeNull();
                expect(yield* store.getSourceCursor(definitionId)).toBeNull();
                expect(
                  yield* store.getItemState(
                    definitionId,
                    item.sourceIdentity.encoded
                  )
                ).toBeNull();
              })
            ).pipe(Effect.provide(storeLayer(client)));
          })
      );
    }
  }
  it.effect(
    "round-trips every item outcome, journal, and tracking payload",
    () =>
      Effect.gen(function* () {
        const backend = makeMemoryFilesSDK();
        const migrated = state("migrated");
        const states: MigrationItemState[] = [
          {
            ...migrated,
            trackingRecord: { key: "destination/a", etag: null },
            lastSourceInventoryRunId: toMigrationRunId("inventory"),
            journal: {
              process: {
                runId,
                entries: [
                  {
                    kind: "diagnostic",
                    sequence: 0,
                    severity: "warning",
                    message: "fixture",
                    details: { safe: true },
                  },
                ],
              },
              rollbackAttempts: [
                {
                  runId,
                  entries: [],
                  failedAt: migrated.updatedAt,
                  error: {
                    kind: "destination",
                    errorTag: "DestinationError",
                    message: "retry cleanup",
                  },
                },
              ],
            },
          },
          {
            ...state("skipped"),
            status: "skipped",
            skipReason: "not selected",
          },
          {
            ...state("failed"),
            status: "failed",
            error: {
              kind: "process",
              errorTag: "Fixture",
              message: "retry",
              details: [{ path: "key", message: "invalid" }],
            },
          },
          { ...state("stub"), status: "needs-update", reason: "placeholder" },
        ];
        yield* MigrationStore.use((s) =>
          Effect.forEach(states, s.upsertItemState)
        ).pipe(Effect.provide(storeLayer(backend.client)));
        yield* MigrationStore.use((s) =>
          Effect.gen(function* () {
            for (const item of states) {
              expect(
                yield* s.getItemState(definitionId, item.sourceIdentity.encoded)
              ).toEqual(item);
            }
            expect(yield* s.getItemStateSummary(definitionId)).toEqual({
              migrated: 1,
              skipped: 1,
              failed: 1,
              needsUpdate: 1,
            });
          })
        ).pipe(Effect.provide(storeLayer(backend.client)));
      })
  );
  it.effect("passes completion and superseded-run conformance", () => {
    const backend = makeMemoryFilesSDK();
    return Effect.gen(function* () {
      const completion = yield* runMigrationCompletionScenario("files");
      expect(completion.afterNoop.completion).toEqual(completion.completion);
      expect(completion.afterRemoval).toEqual({
        completion: null,
        cursor: null,
        item: null,
      });
      expect(completion.restored).toEqual(completion.completion);
      const runs = yield* runSupersededMigrationRunScenario("files");
      expect(runs.originalRunState?.status).toBe("succeeded");
      expect(runs.dependencyLatest?.runId).toBe(runs.newerRunId);
      expect(runs.selectedLatest?.status).toBe("succeeded");
    }).pipe(Effect.provide(storeLayer(backend.client)));
  });

  it.effect("reopens durable records and isolates namespaces", () =>
    Effect.gen(function* () {
      const backend = makeMemoryFilesSDK();
      const item = state("../../Arbitrary α/KEY");
      yield* Effect.gen(function* () {
        const store = yield* MigrationStore;
        yield* store.upsertItemState(item);
        yield* store.setSourceCursor(
          definitionId,
          toEncodedSourceCursor("cursor")
        );
      }).pipe(Effect.provide(storeLayer(backend.client)));
      yield* Effect.gen(function* () {
        const store = yield* MigrationStore;
        expect(
          yield* store.getItemState(definitionId, item.sourceIdentity.encoded)
        ).toEqual(item);
        expect(yield* store.getSourceCursor(definitionId)).toBe("cursor");
        expect(yield* store.getItemStateSummary(definitionId)).toEqual({
          migrated: 1,
          skipped: 0,
          failed: 0,
          needsUpdate: 0,
        });
      }).pipe(Effect.provide(storeLayer(backend.client)));
      const isolated = FilesSDKMigrationStore.layer({
        ...options,
        namespace: "other",
      }).pipe(Layer.provide(backend.layer));
      expect(
        yield* MigrationStore.use((s) => s.listItemStates(definitionId)).pipe(
          Effect.provide(isolated)
        )
      ).toEqual([]);
      expect(
        [...backend.adapter.raw.keys()].every((key) =>
          portableKeyPattern.test(key)
        )
      ).toBe(true);
    })
  );

  it.effect(
    "serializes stop/completion and never regresses terminal cancellation",
    () => {
      const backend = makeMemoryFilesSDK();
      return Effect.gen(function* () {
        const store = yield* MigrationStore;
        yield* store.beginRun({
          runId,
          definitionIds: [definitionId],
          operation: "run",
        });
        yield* Effect.all(
          [
            store.requestRunCancellation(runId, [definitionId]),
            store.attachRunExecution(runId, [definitionId], {
              adapter: "fixture",
              executionId: "one",
            }),
          ],
          { concurrency: 2 }
        );
        expect((yield* store.getRunState(runId))?.status).toBe("cancelling");
        const completed = yield* store.completeRun(
          runId,
          [definitionId],
          [{ definitionId, status: "succeeded" }]
        );
        expect(completed.status).toBe("cancelled");
        yield* store.queueRun({
          runId,
          definitionIds: [definitionId],
          operation: "rollback",
        });
        yield* store.failRun(
          runId,
          [definitionId],
          [{ definitionId, status: "failed" }]
        );
        expect((yield* store.getRunState(runId))?.status).toBe("cancelled");
        expect((yield* store.getLatestRunState(definitionId))?.operation).toBe(
          "run"
        );
        expect(
          (yield* Effect.flip(store.completeRun(runId, [definitionId], [])))
            .message
        ).toContain("outcomes");
      }).pipe(Effect.provide(storeLayer(backend.client)));
    }
  );

  it.effect("serializes contending fibers and checks lock owner/token", () => {
    const backend = makeMemoryFilesSDK();
    return Effect.gen(function* () {
      const store = yield* MigrationStore;
      const results = yield* Effect.all(
        [
          Effect.result(store.acquireDefinitionLock(definitionId, runId)),
          Effect.result(
            store.acquireDefinitionLock(definitionId, toMigrationRunId("other"))
          ),
        ],
        { concurrency: 2 }
      );
      expect(results.filter((r) => r._tag === "Success")).toHaveLength(1);
      const lock = yield* store.getDefinitionLock(definitionId);
      if (lock === null) {
        throw new Error("missing lock");
      }
      yield* store.assertDefinitionLocks([lock]);
      yield* Effect.flip(
        store.releaseDefinitionLock({
          ...lock,
          ownerRunId: toMigrationRunId("foreign"),
        })
      );
      expect(yield* store.getDefinitionLock(definitionId)).toEqual(lock);
      expect(yield* store.breakDefinitionLock(definitionId)).toEqual(lock);
      yield* Effect.flip(store.assertDefinitionLocks([lock]));
      yield* store.releaseDefinitionLock(lock);
    }).pipe(Effect.provide(storeLayer(backend.client)));
  });

  it.effect(
    "orders orphan pages by encoded identity while earlier pages are deleted",
    () => {
      const backend = makeMemoryFilesSDK();
      return Effect.gen(function* () {
        const store = yield* MigrationStore;
        const items = [state("c"), state("a"), state("b")];
        yield* Effect.forEach(items, store.upsertItemState);
        const inventory = toMigrationRunId("inventory");
        yield* store.observeItemState(
          definitionId,
          SourceIdentity.fromKey(identity, "missing").encoded,
          inventory
        );
        const first = yield* store.listOrphanItemStates(
          definitionId,
          inventory,
          { limit: 1 }
        );
        expect(first.items[0]?.sourceIdentity.key).toBe("a");
        const one = first.items[0];
        if (one === undefined) {
          throw new Error("missing orphan");
        }
        yield* store.removeRolledBackItem({
          definitionId,
          sourceIdentity: one.sourceIdentity.encoded,
        });
        const next = yield* store.listOrphanItemStates(
          definitionId,
          inventory,
          { limit: 2, afterIdentity: one.sourceIdentity.encoded }
        );
        expect(next.items.map((s) => s.sourceIdentity.key)).toEqual(["b", "c"]);
        expect(next.nextAfterIdentity).toBeUndefined();
        yield* store.observeItemState(
          definitionId,
          next.items[0]?.sourceIdentity.encoded ?? one.sourceIdentity.encoded,
          inventory
        );
        expect(
          (yield* store.listOrphanItemStates(definitionId, inventory, {
            limit: 10,
          })).items
        ).toHaveLength(1);
      }).pipe(Effect.provide(storeLayer(backend.client)));
    }
  );

  it.effect(
    "preserves conservative invalidation after an applied-but-failed delete",
    () =>
      Effect.gen(function* () {
        const backend = makeMemoryFilesSDK();
        let failDelete = false;
        const client = new FilesSDKClient({
          adapter: {
            ...backend.adapter,
            delete: async (key, opts) => {
              await backend.adapter.delete(key, opts);
              if (failDelete && key.includes("/items/")) {
                throw new FilesError("Provider", "response lost");
              }
            },
          },
        });
        yield* Effect.gen(function* () {
          const store = yield* MigrationStore;
          const item = state("one");
          yield* store.upsertItemState(item);
          yield* store.setSourceCursor(
            definitionId,
            toEncodedSourceCursor("cursor")
          );
          yield* store.recordSourcePassCompletion({
            definitionId,
            runId,
            completedAt: new Date(),
            sourceCursor: null,
          });
          failDelete = true;
          yield* Effect.flip(
            store.removeRolledBackItem({
              definitionId,
              sourceIdentity: item.sourceIdentity.encoded,
            })
          );
          expect(yield* store.getDefinitionCompletion(definitionId)).toBeNull();
          expect(yield* store.getSourceCursor(definitionId)).toBeNull();
          expect(
            yield* store.getItemState(definitionId, item.sourceIdentity.encoded)
          ).toBeNull();
        }).pipe(Effect.provide(storeLayer(client)));
      })
  );

  it.effect("fails corrupt/future records instead of resetting state", () =>
    Effect.gen(function* () {
      const backend = makeMemoryFilesSDK();
      yield* MigrationStore.use((store) =>
        store.upsertItemState(state("one"))
      ).pipe(Effect.provide(storeLayer(backend.client)));
      const key = [...backend.adapter.raw.keys()].find((key) =>
        key.includes("/items/")
      );
      if (key === undefined) {
        throw new Error("missing record");
      }
      const stored = yield* backend.service.download(key);
      const record = JSON.parse(yield* stored.text);
      record.formatVersion = 999;
      yield* backend.service.upload(key, JSON.stringify(record));
      yield* Effect.flip(
        MigrationStore.use((store) => store.listItemStates(definitionId)).pipe(
          Effect.provide(storeLayer(backend.client))
        )
      );
    })
  );

  it.effect(
    "repairs partial latest-run writes without replacing a newer run",
    () =>
      Effect.gen(function* () {
        const backend = makeMemoryFilesSDK();
        let failPointer = true;
        const client = new FilesSDKClient({
          adapter: {
            ...backend.adapter,
            upload: (key, body, opts) => {
              if (failPointer && key.endsWith("/latest-run.json")) {
                failPointer = false;
                return Promise.reject(
                  new FilesError("Provider", "injected pointer failure")
                );
              }
              return backend.adapter.upload(key, body, opts);
            },
          },
        });
        yield* Effect.gen(function* () {
          const store = yield* MigrationStore;
          const input = {
            runId,
            definitionIds: [definitionId],
            operation: "run" as const,
          };
          yield* Effect.flip(store.beginRun(input));
          expect((yield* store.getRunState(runId))?.status).toBe("running");
          expect(yield* store.getLatestRunState(definitionId)).toBeNull();
          yield* store.beginRun(input);
          expect((yield* store.getLatestRunState(definitionId))?.runId).toBe(
            runId
          );
          const newer = toMigrationRunId("newer");
          yield* store.beginRun({ ...input, runId: newer });
          yield* store.beginRun(input);
          expect((yield* store.getLatestRunState(definitionId))?.runId).toBe(
            newer
          );
        }).pipe(Effect.provide(storeLayer(client)));
      })
  );

  it.effect(
    "demonstrates that independent instances can both pass advisory acquisition",
    () =>
      Effect.gen(function* () {
        const backend = makeMemoryFilesSDK();
        let letFirstWrite: () => void = () => undefined;
        let letSecondWrite: () => void = () => undefined;
        const secondArrived = new Promise<void>((resolve) => {
          letFirstWrite = resolve;
        });
        const firstReadBack = new Promise<void>((resolve) => {
          letSecondWrite = resolve;
        });
        let firstWritten = false;
        const firstClient = new FilesSDKClient({
          adapter: {
            ...backend.adapter,
            upload: async (key, body, opts) => {
              if (key.endsWith("/lock.json")) {
                await secondArrived;
                const result = await backend.adapter.upload(key, body, opts);
                firstWritten = true;
                return result;
              }
              return backend.adapter.upload(key, body, opts);
            },
            download: async (key, opts) => {
              const snapshot = await backend.adapter.download(key, opts);
              if (firstWritten && key.endsWith("/lock.json")) {
                letSecondWrite();
              }
              return snapshot;
            },
          },
        });
        const secondClient = new FilesSDKClient({
          adapter: {
            ...backend.adapter,
            upload: async (key, body, opts) => {
              if (key.endsWith("/lock.json")) {
                letFirstWrite();
                await firstReadBack;
              }
              return backend.adapter.upload(key, body, opts);
            },
          },
        });
        const locks = yield* Effect.all(
          [
            MigrationStore.use((store) =>
              store.acquireDefinitionLock(definitionId, runId)
            ).pipe(Effect.provide(storeLayer(firstClient))),
            MigrationStore.use((store) =>
              store.acquireDefinitionLock(
                definitionId,
                toMigrationRunId("second")
              )
            ).pipe(Effect.provide(storeLayer(secondClient))),
          ],
          { concurrency: 2 }
        );
        expect(locks).toHaveLength(2);
        expect(locks[0]?.token).not.toBe(locks[1]?.token);
      })
  );
});
