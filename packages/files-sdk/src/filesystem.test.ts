import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Files as FilesSDKClient } from "files-sdk";
import { make } from "files-sdk/effect";
import { fs } from "files-sdk/fs";
import { runInlineDefinition } from "migrate-sdk/testing";
import { makeObjectMigration } from "../examples/object-migration.ts";
import { makeSqlBackedObjectMigration } from "../examples/sql-migration.ts";
import { makeMemoryFilesSDK } from "./testing/index.ts";

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
              makeSqlBackedObjectMigration(
                { source: source.client, destination: destination.client },
                sql
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
          const initial = clients();
          yield* make(initial.source).upload("input/a.txt", "filesystem bytes");
          expect(
            (yield* runInlineDefinition(makeObjectMigration(initial))).status
          ).toBe("succeeded");
          const reopened = clients();
          expect(
            (yield* runInlineDefinition(makeObjectMigration(reopened)))
              .definitions[0]?.counts.unchanged
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
