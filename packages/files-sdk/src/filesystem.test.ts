import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, type Layer } from "effect";
import { Files as FilesSDKClient } from "files-sdk";
import { Files, make } from "files-sdk/effect";
import { fs } from "files-sdk/fs";
import {
  MigrationDefinition,
  type MigrationStore,
  type MigrationStoreError,
} from "migrate-sdk";
import { SqlMigrationStore } from "migrate-sdk/stores/sql";
import { runInlineDefinition } from "migrate-sdk/testing";
import { FilesSDKDestination } from "./destination/index.ts";
import { FilesSDKMigrationStore } from "./migration-store/index.ts";
import { FilesSDKSource } from "./source/index.ts";
import { makeMemoryFilesSDK } from "./testing/index.ts";

function makeMigration(
  clients: { source: FilesSDKClient; destination: FilesSDKClient },
  store: Layer.Layer<MigrationStore, MigrationStoreError>
) {
  const destination = FilesSDKDestination.make({
    storageId: "destination",
  }).provide(Files.layer(clients.destination));
  return MigrationDefinition.make({
    id: "filesystem-copy",
    source: FilesSDKSource.objects({
      storageId: "source",
      prefix: "input/",
    }).provide(Files.layer(clients.source)),
    store,
    process: (sourceItem) =>
      destination
        .transferFrom({
          source: make(clients.source),
          object: sourceItem.item,
          key: `output/${sourceItem.item.key.slice("input/".length)}`,
          write: { kind: "overwrite" },
          verify: "sha256",
        })
        .pipe(Effect.asVoid),
  });
}

describe("filesystem provider", () => {
  it.effect(
    "uses the existing SQL store with Files source and destination",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "migrate-files-sql-"))),
        (root) =>
          Effect.gen(function* () {
            const source = makeMemoryFilesSDK({
              initial: { "input/a": "SQL-backed copy" },
            });
            const destination = makeMemoryFilesSDK();
            const sql = SqliteClient.layer({
              filename: join(root, "state.sqlite"),
            });
            const migration = () =>
              makeMigration(
                { source: source.client, destination: destination.client },
                SqlMigrationStore.layerFromClient(sql)
              );
            expect((yield* runInlineDefinition(migration())).status).toBe(
              "succeeded"
            );
            expect(
              (yield* runInlineDefinition(migration())).definitions[0]?.counts
                .unchanged
            ).toBe(1);
          }),
        (root) =>
          Effect.promise(() => rm(root, { recursive: true, force: true }))
      )
  );
  it.effect("persists and reopens real JSON records across new clients", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "migrate-files-sdk-"))),
      (root) =>
        Effect.gen(function* () {
          const clients = () => ({
            source: new FilesSDKClient({
              adapter: fs({ root: join(root, "source") }),
            }),
            destination: new FilesSDKClient({
              adapter: fs({ root: join(root, "destination") }),
            }),
            state: new FilesSDKClient({
              adapter: fs({ root: join(root, "state") }),
            }),
          });
          const migration = (selected: ReturnType<typeof clients>) =>
            makeMigration(
              selected,
              FilesSDKMigrationStore.layerFromClient({
                client: selected.state,
                storageId: "state",
                namespace: "filesystem-test",
                locking: "advisory",
              })
            );
          const initial = clients();
          yield* make(initial.source).upload("input/a.txt", "filesystem bytes");
          expect((yield* runInlineDefinition(migration(initial))).status).toBe(
            "succeeded"
          );
          const reopened = clients();
          expect(
            (yield* runInlineDefinition(migration(reopened))).definitions[0]
              ?.counts.unchanged
          ).toBe(1);
          expect(
            yield* (yield* make(reopened.destination).download("output/a.txt"))
              .text
          ).toBe("filesystem bytes");
        }),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true }))
    )
  );
});
