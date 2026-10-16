import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Schema } from "effect";
import {
  createStoredFile,
  FilesError,
  Files as FilesSDKClient,
} from "files-sdk";
import { Files, make } from "files-sdk/effect";
import {
  DestinationError,
  MigrationDefinition,
  type RollbackPipeline,
  SourceIdentity,
  Tracking,
} from "migrate-sdk";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import {
  rollbackInlineDefinition,
  runInlineDefinition,
  useConfiguredSource,
} from "migrate-sdk/testing";
import { objectFromInfo } from "../internal/files.ts";
import { FilesSDKSource } from "../source/source.ts";
import { makeMemoryFilesSDK } from "../testing/index.ts";
import { FilesSDKDestination } from "./destination.ts";

function fixture<RollbackError = never>(
  process: Effect.Effect<void, DestinationError, Tracking>,
  rollback?: RollbackPipeline<RollbackError>
) {
  const state = InMemoryMigrationStore.makeState();
  const migration = MigrationDefinition.make({
    id: "files-destination",
    source: InMemorySource.make({
      identity: SourceIdentity.make({
        id: "fixture@v1",
        schema: SourceIdentity.key("id", Schema.String),
      }),
      sourceSchema: Schema.Struct({}),
      items: [{ identityKey: "one", version: "v1", item: {} }],
    }),
    store: InMemoryMigrationStore.layer(state),
    process: () => process,
    ...(rollback === undefined ? {} : { rollback }),
  });
  return { state, migration };
}

describe("Files destination helpers", () => {
  it.effect("uses journaled copy validators for guarded rollback", () =>
    Effect.gen(function* () {
      for (const replace of [false, true]) {
        const backend = makeMemoryFilesSDK({
          initial: { original: "original" },
        });
        const requestedEtags: string[] = [];
        const client = new FilesSDKClient({
          adapter: {
            ...backend.adapter,
            // Conditional providers return canonical, unquoted ETags.
            head: async (key) => {
              const info = await backend.adapter.head(key);
              return info.etag === undefined
                ? info
                : { ...info, etag: info.etag.replaceAll('"', "") };
            },
            conditional: {
              delete: (key, etag) => {
                requestedEtags.push(etag);
                const current = backend.adapter.raw.get(key);
                if (current?.etag.replaceAll('"', "") !== etag) {
                  return Promise.reject(
                    new FilesError("Conflict", "ETag mismatch")
                  );
                }
                return backend.adapter.delete(key);
              },
            },
          },
        });
        const destination = FilesSDKDestination.make({
          storageId: "dest",
        }).provide(Files.layer(client));
        const { migration, state } = fixture(
          destination
            .copy({
              from: "original",
              key: "owned/copied",
              write: { kind: "overwrite" },
            })
            .pipe(Effect.asVoid),
          (item) =>
            Effect.gen(function* () {
              for (const entry of item.journal?.process.entries ?? []) {
                if (destination.changes.copied.is(entry)) {
                  const change =
                    yield* destination.changes.copied.decode(entry);
                  if (change.value.etag === undefined) {
                    return yield* new DestinationError({
                      message: "Missing copy ETag",
                    });
                  }
                  yield* destination.delete({
                    key: change.value.key,
                    policy: { kind: "exact", etag: change.value.etag },
                  });
                }
              }
            })
        );
        expect((yield* runInlineDefinition(migration)).status).toBe(
          "succeeded"
        );
        const original = yield* make(client).head("owned/copied");
        const entries =
          [...state.itemStates.values()][0]?.journal?.process.entries.filter(
            destination.changes.copied.is
          ) ?? [];
        expect(entries).toHaveLength(1);
        const entry = entries[0];
        if (entry === undefined) {
          throw new Error("missing copy journal entry");
        }
        const change = yield* destination.changes.copied.decode(entry);
        expect(change.value).toEqual({
          storageId: "dest",
          key: "owned/copied",
          sourceKey: "original",
          size: original.size,
          etag: original.etag,
        });
        if (replace) {
          yield* backend.service.upload("owned/copied", "replacement");
        }
        expect((yield* rollbackInlineDefinition(migration)).status).toBe(
          replace ? "failed" : "succeeded"
        );
        expect(requestedEtags).toEqual([original.etag]);
        expect(state.itemStates.size).toBe(replace ? 1 : 0);
        if (replace) {
          expect(
            yield* (yield* backend.service.download("owned/copied")).text
          ).toBe("replacement");
        } else {
          expect(yield* backend.service.exists("owned/copied")).toBe(false);
        }
      }
    })
  );

  it.effect("keeps copy evidence when the metadata read fails", () =>
    Effect.gen(function* () {
      const backend = makeMemoryFilesSDK({ initial: { original: "original" } });
      const client = new FilesSDKClient({
        adapter: {
          ...backend.adapter,
          head: () =>
            Promise.reject(new FilesError("Provider", "metadata unavailable")),
        },
      });
      const destination = FilesSDKDestination.make({
        storageId: "dest",
      }).provide(Files.layer(client));
      const { migration, state } = fixture(
        destination
          .copy({
            from: "original",
            key: "owned/copied",
            write: { kind: "overwrite" },
          })
          .pipe(Effect.asVoid)
      );
      expect((yield* runInlineDefinition(migration)).status).toBe("failed");
      const entries =
        [...state.itemStates.values()][0]?.journal?.process.entries.filter(
          destination.changes.copied.is
        ) ?? [];
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      if (entry === undefined) {
        throw new Error("missing copy evidence");
      }
      expect((yield* destination.changes.copied.decode(entry)).value).toEqual({
        storageId: "dest",
        key: "owned/copied",
        sourceKey: "original",
      });
      expect(yield* backend.service.exists("owned/copied")).toBe(true);
    })
  );

  it.effect("keeps copy evidence when the metadata read is interrupted", () =>
    Effect.gen(function* () {
      const backend = makeMemoryFilesSDK({ initial: { original: "original" } });
      let ready: () => void = () => undefined;
      const reading = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const client = new FilesSDKClient({
        adapter: {
          ...backend.adapter,
          head: () => {
            ready();
            return new Promise<never>(() => {
              /* Remain pending until interruption. */
            });
          },
        },
      });
      const recorded: unknown[] = [];
      const tracking = Layer.succeed(Tracking, {
        recordChange: (descriptor, value) =>
          Effect.sync(() => {
            recorded.push(value);
            return {
              descriptorId: descriptor.id,
              kind: "change" as const,
              sequence: 0,
              value,
            };
          }),
        logDiagnostic: () =>
          Effect.die(new Error("interruption must remain interruption")),
        setRecord: () => Effect.void,
        setExtension: () => Effect.void,
        removeExtension: () => Effect.void,
      });
      const destination = FilesSDKDestination.make({
        storageId: "dest",
      }).provide(Files.layer(client));
      const fiber = yield* destination
        .copy({
          from: "original",
          key: "owned/copied",
          write: { kind: "overwrite" },
        })
        .pipe(Effect.provide(tracking), Effect.forkChild);
      yield* Effect.promise(() => reading);
      yield* Fiber.interrupt(fiber);
      expect(recorded).toEqual([
        { storageId: "dest", key: "owned/copied", sourceKey: "original" },
      ]);
      expect(yield* backend.service.exists("owned/copied")).toBe(true);
    })
  );

  it.effect("preserves downloaded metadata when source listings omit it", () =>
    Effect.gen(function* () {
      const source = makeMemoryFilesSDK();
      const backend = makeMemoryFilesSDK();
      const contentType = "application/vnd.catalog+json";
      const customMetadata = { owner: "catalog" };
      yield* source.service.upload("input/catalog", "{}", {
        contentType,
        metadata: customMetadata,
      });
      const sourceClient = new FilesSDKClient({
        adapter: {
          ...source.adapter,
          list: async (options) => {
            const page = await source.adapter.list(options);
            return {
              ...page,
              items: page.items.map((info) => ({
                key: info.key,
                size: info.size,
                contentType: "application/octet-stream",
                ...(info.etag === undefined ? {} : { etag: info.etag }),
                ...(info.lastModified === undefined
                  ? {}
                  : { lastModified: info.lastModified }),
              })),
            };
          },
        },
      });
      const configured = FilesSDKSource.objects({
        storageId: "source",
        prefix: "input/",
      }).provide(Files.layer(sourceClient));
      const object = yield* useConfiguredSource(configured, (runtime) =>
        Effect.gen(function* () {
          const page = yield* runtime.read(null);
          const item = page.items[0];
          if (item === undefined) {
            throw new Error("missing source file");
          }
          return item.item;
        })
      );
      expect(object.metadata).toBeUndefined();
      expect(object.contentType).toBe("application/octet-stream");
      const destination = FilesSDKDestination.make({
        storageId: "dest",
      }).provide(backend.layer);
      const policies: readonly ("preserve" | "omit" | undefined)[] = [
        undefined,
        "preserve",
        "omit",
      ];
      for (const metadata of policies) {
        const key = `owned/${metadata ?? "default"}`;
        const { migration } = fixture(
          destination
            .transferFrom({
              source: make(sourceClient),
              object,
              key,
              write: { kind: "overwrite" },
              ...(metadata === undefined ? {} : { metadata }),
              verify: "sha256",
            })
            .pipe(Effect.asVoid)
        );
        expect((yield* runInlineDefinition(migration)).status).toBe(
          "succeeded"
        );
        const result = yield* backend.service.head(key);
        expect(result.contentType).toBe(contentType);
        expect(result.metadata).toEqual(
          metadata === "omit" ? undefined : customMetadata
        );
      }
    })
  );

  it.effect(
    "journals upload/copy/delete with an independent existing store",
    () =>
      Effect.gen(function* () {
        const backend = makeMemoryFilesSDK();
        const destination = FilesSDKDestination.make({
          storageId: "dest",
        }).provide(backend.layer);
        const { migration, state } = fixture(
          Effect.gen(function* () {
            yield* destination.upload({
              key: "owned/a",
              body: "a",
              write: { kind: "overwrite" },
            });
            yield* destination.copy({
              from: "owned/a",
              key: "owned/b",
              write: { kind: "overwrite" },
            });
            yield* destination.delete({
              key: "owned/a",
              policy: { kind: "owned-prefix", prefix: "owned/" },
            });
          })
        );
        expect((yield* runInlineDefinition(migration)).status).toBe(
          "succeeded"
        );
        const item = [...state.itemStates.values()][0];
        expect(
          item?.journal?.process.entries
            .filter((e) => e.kind === "change")
            .map((e) => e.descriptorId)
        ).toEqual([
          "files.object.uploaded",
          "files.object.copied",
          "files.object.deleted",
        ]);
        expect(yield* backend.service.exists("owned/a")).toBe(false);
        expect(yield* (yield* backend.service.download("owned/b")).text).toBe(
          "a"
        );
      })
  );

  it.effect("does not emulate unsupported conditional writes or deletes", () =>
    Effect.gen(function* () {
      const backend = makeMemoryFilesSDK({
        initial: { "owned/a": "original" },
      });
      const destination = FilesSDKDestination.make({
        storageId: "dest",
      }).provide(backend.layer);
      const { migration, state } = fixture(
        destination
          .upload({
            key: "owned/a",
            body: "replacement",
            write: { kind: "create" },
          })
          .pipe(Effect.asVoid)
      );
      expect((yield* runInlineDefinition(migration)).status).toBe("failed");
      expect(yield* (yield* backend.service.download("owned/a")).text).toBe(
        "original"
      );
      const item = [...state.itemStates.values()][0];
      expect(
        item?.journal?.process.entries.some((e) => e.kind === "change")
      ).toBe(false);
      const deletion = fixture(
        destination.delete({
          key: "owned/a",
          policy: { kind: "exact", etag: "unknown" },
        })
      );
      expect((yield* runInlineDefinition(deletion.migration)).status).toBe(
        "failed"
      );
      expect(yield* backend.service.exists("owned/a")).toBe(true);
    })
  );

  it.effect(
    "records known applied failures and redacts provider credentials",
    () =>
      Effect.gen(function* () {
        const backend = makeMemoryFilesSDK();
        const client = new FilesSDKClient({
          adapter: {
            ...backend.adapter,
            upload: async (key, body, opts) => {
              const committed = await backend.adapter.upload(key, body, opts);
              throw FilesError.applied(
                new Error("secret credential"),
                committed.etag
              );
            },
          },
        });
        const destination = FilesSDKDestination.make({
          storageId: "dest",
        }).provide(Files.layer(client));
        const { migration, state } = fixture(
          destination
            .upload({
              key: "owned/a",
              body: "committed",
              write: { kind: "overwrite" },
            })
            .pipe(Effect.asVoid)
        );
        expect((yield* runInlineDefinition(migration)).status).toBe("failed");
        const item = [...state.itemStates.values()][0];
        expect(
          item?.journal?.process.entries.some(destination.changes.uploaded.is)
        ).toBe(true);
        expect(JSON.stringify(item)).not.toContain("secret credential");
        expect(yield* backend.service.exists("owned/a")).toBe(true);
      })
  );

  it.effect(
    "fails checksum verification while retaining destination evidence",
    () =>
      Effect.gen(function* () {
        const source = makeMemoryFilesSDK({ initial: { a: "original" } });
        const backend = makeMemoryFilesSDK();
        const client = new FilesSDKClient({
          adapter: {
            ...backend.adapter,
            upload: async (key, body, opts) => {
              const committed = await backend.adapter.upload(key, body, opts);
              return backend.adapter.upload(
                key,
                new Uint8Array(committed.size),
                opts
              );
            },
          },
        });
        const destination = FilesSDKDestination.make({
          storageId: "dest",
        }).provide(Files.layer(client));
        const object = objectFromInfo(
          "source",
          yield* source.service.head("a")
        );
        const { migration, state } = fixture(
          destination
            .transferFrom({
              source: source.service,
              object,
              key: "owned/a",
              write: { kind: "overwrite" },
              verify: "sha256",
            })
            .pipe(Effect.asVoid)
        );
        expect((yield* runInlineDefinition(migration)).status).toBe("failed");
        const item = [...state.itemStates.values()][0];
        expect(item?.status === "failed" ? item.error.message : "").toContain(
          "checksum mismatch"
        );
        expect(
          item?.journal?.process.entries.some(destination.changes.uploaded.is)
        ).toBe(true);
        expect(yield* backend.service.exists("owned/a")).toBe(true);
      })
  );

  it.effect(
    "fails an incomplete stream and restarts the file on the next pipeline attempt",
    () =>
      Effect.gen(function* () {
        const backend = makeMemoryFilesSDK();
        let downloads = 0;
        let uploads = 0;
        let cancelled = false;
        const metadata = {
          key: "a",
          size: 1,
          contentType: "text/plain",
          etag: "fixture",
          lastModified: 1,
        };
        const sourceClient = new FilesSDKClient({
          adapter: {
            ...backend.adapter,
            head: async () => metadata,
            download: () => {
              const attempt = ++downloads;
              return Promise.resolve(
                createStoredFile(metadata, {
                  kind: "stream",
                  factory: () =>
                    new ReadableStream<Uint8Array>({
                      start(controller) {
                        controller.enqueue(new Uint8Array([65]));
                        if (attempt > 1) {
                          controller.close();
                        }
                      },
                      cancel() {
                        cancelled = true;
                      },
                    }),
                })
              );
            },
          },
        });
        const destinationClient = new FilesSDKClient({
          adapter: {
            ...backend.adapter,
            upload: async (key, body, options) => {
              uploads++;
              if (uploads === 1) {
                if (!(body instanceof ReadableStream)) {
                  throw new Error("expected stream");
                }
                // Acknowledge all advertised bytes without reaching EOF.
                const chunk = await body.getReader().read();
                if (chunk.done) {
                  throw new Error("expected file bytes");
                }
                return backend.adapter.upload(key, chunk.value, options);
              }
              return backend.adapter.upload(key, body, options);
            },
          },
        });
        const destination = FilesSDKDestination.make({
          storageId: "dest",
        }).provide(Files.layer(destinationClient));
        const { migration, state } = fixture(
          destination
            .transferFrom({
              source: make(sourceClient),
              object: objectFromInfo("source", metadata),
              key: "owned/a",
              write: { kind: "overwrite" },
            })
            .pipe(Effect.asVoid)
        );
        expect((yield* runInlineDefinition(migration)).status).toBe("failed");
        const failed = [...state.itemStates.values()][0];
        expect(
          failed?.status === "failed" ? failed.error.message : ""
        ).toContain("not fully consumed");
        expect(
          failed?.journal?.process.entries.some(destination.changes.uploaded.is)
        ).toBe(true);
        expect(cancelled).toBe(true);
        expect((yield* runInlineDefinition(migration)).status).toBe(
          "succeeded"
        );
        expect(downloads).toBe(2);
        expect(uploads).toBe(2);
        expect(yield* (yield* backend.service.download("owned/a")).text).toBe(
          "A"
        );
      })
  );

  it.effect(
    "opens a fresh source stream when the whole transfer is retried",
    () =>
      Effect.gen(function* () {
        const source = makeMemoryFilesSDK({
          initial: { a: "large enough to stream" },
        });
        const backend = makeMemoryFilesSDK();
        let attempts = 0;
        const client = new FilesSDKClient({
          adapter: {
            ...backend.adapter,
            upload: async (key, body, opts) => {
              const result = await backend.adapter.upload(key, body, opts);
              attempts++;
              if (attempts === 1) {
                throw new FilesError("Provider", "response lost");
              }
              return result;
            },
          },
        });
        const destination = FilesSDKDestination.make({
          storageId: "dest",
        }).provide(Files.layer(client));
        const object = objectFromInfo(
          "source",
          yield* source.service.head("a")
        );
        const { migration } = fixture(
          destination
            .transferFrom({
              source: source.service,
              object,
              key: "owned/a",
              write: { kind: "overwrite" },
              verify: "sha256",
            })
            .pipe(Effect.retry({ times: 1 }), Effect.as(undefined))
        );
        expect((yield* runInlineDefinition(migration)).status).toBe(
          "succeeded"
        );
        expect(attempts).toBe(2);
        expect(yield* (yield* backend.service.download("owned/a")).text).toBe(
          "large enough to stream"
        );
      })
  );

  it.effect(
    "keeps applied upload evidence when subsequent verification fails",
    () =>
      Effect.gen(function* () {
        const source = makeMemoryFilesSDK({ initial: { a: "source bytes" } });
        const backend = makeMemoryFilesSDK();
        const client = new FilesSDKClient({
          adapter: {
            ...backend.adapter,
            upload: async (key, body, opts) => {
              const result = await backend.adapter.upload(key, body, opts);
              await source.adapter.upload("a", "changed source bytes");
              return result;
            },
          },
        });
        const destination = FilesSDKDestination.make({
          storageId: "dest",
        }).provide(Files.layer(client));
        const object = objectFromInfo(
          "source",
          yield* source.service.head("a")
        );
        const { migration, state } = fixture(
          destination
            .transferFrom({
              source: source.service,
              object,
              key: "owned/a",
              write: { kind: "overwrite" },
            })
            .pipe(Effect.as(undefined))
        );
        expect((yield* runInlineDefinition(migration)).status).toBe("failed");
        const item = [...state.itemStates.values()][0];
        expect(
          item?.journal?.process.entries.some(destination.changes.uploaded.is)
        ).toBe(true);
        expect(yield* backend.service.exists("owned/a")).toBe(true);
      })
  );

  it.effect("rejects deletion outside the explicitly owned prefix", () =>
    Effect.gen(function* () {
      const backend = makeMemoryFilesSDK({ initial: { "foreign/a": "keep" } });
      const destination = FilesSDKDestination.make({
        storageId: "dest",
      }).provide(backend.layer);
      const { migration } = fixture(
        destination.delete({
          key: "foreign/a",
          policy: { kind: "owned-prefix", prefix: "owned/" },
        })
      );
      expect((yield* runInlineDefinition(migration)).status).toBe("failed");
      expect(yield* backend.service.exists("foreign/a")).toBe(true);
      // The upstream bound service is also usable without this integration.
      expect(yield* make(backend.client).exists("foreign/a")).toBe(true);
    })
  );

  it.effect(
    "interrupts a source stream even while the destination owns its reader",
    () =>
      Effect.gen(function* () {
        const backend = makeMemoryFilesSDK();
        let cancelled = false;
        let ready: () => void = () => undefined;
        const reading = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const metadata = {
          key: "a",
          size: 10,
          contentType: "text/plain",
          etag: "fixture",
          lastModified: 1,
        };
        const sourceClient = new FilesSDKClient({
          adapter: {
            ...backend.adapter,
            head: async () => metadata,
            download: async () =>
              createStoredFile(metadata, {
                kind: "stream",
                factory: () =>
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.enqueue(new Uint8Array([1]));
                    },
                    cancel() {
                      cancelled = true;
                    },
                  }),
              }),
          },
        });
        const destinationClient = new FilesSDKClient({
          adapter: {
            ...backend.adapter,
            upload: async (key, body) => {
              if (!(body instanceof ReadableStream)) {
                throw new Error("expected stream");
              }
              const reader = body.getReader();
              await reader.read();
              ready();
              await reader.read();
              return { ...metadata, key };
            },
          },
        });
        const destination = FilesSDKDestination.make({
          storageId: "dest",
        }).provide(Files.layer(destinationClient));
        const transfer = destination.transferFrom({
          source: make(sourceClient),
          object: objectFromInfo("source", metadata),
          key: "owned/a",
          write: { kind: "overwrite" },
        });
        const unusedTracking = Layer.succeed(Tracking, {
          recordChange: () =>
            Effect.die(new Error("interrupted upload must not record success")),
          logDiagnostic: () =>
            Effect.die(new Error("interruption must remain interruption")),
          setRecord: () => Effect.void,
          setExtension: () => Effect.void,
          removeExtension: () => Effect.void,
        });
        // Interrupt the helper itself. Interrupting run observation deliberately
        // leaves the migration's independently owned execution running.
        const fiber = yield* transfer.pipe(
          Effect.provide(unusedTracking),
          Effect.forkChild
        );
        yield* Effect.promise(() => reading);
        yield* Fiber.interrupt(fiber);
        expect(cancelled).toBe(true);
      })
  );
});
