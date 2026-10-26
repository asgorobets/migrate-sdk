import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { ApiRoot } from "@commercetools/platform-sdk";
import { Effect, Schema } from "effect";
import {
  MigrationStore,
  SourceIdentity,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceVersion,
} from "migrate-sdk";
import { PersistedMigrationItemState } from "migrate-sdk/core";
import { CommercetoolsMigrationStore } from "../src/migration-store/index.ts";

const definitionId = toMigrationDefinitionId("large-journals");
const namespace = "summary-memory";
const identity = SourceIdentity.make({
  id: "summary-memory@v1",
  schema: SourceIdentity.key("id", Schema.String),
});
const hash = (value) => createHash("sha256").update(value).digest("base64url");
const statuses = ["migrated", "skipped", "failed", "needs-update"];
const items = Array.from({ length: 1200 }, (_, index) => {
  const sourceIdentity = SourceIdentity.fromKey(identity, String(index));
  return {
    index,
    key: `${namespace}__migration-item-state__definition-hash_${hash(definitionId)}__source-identity-hash_${hash(sourceIdentity.encoded)}`,
    sourceIdentity,
  };
}).sort((left, right) => (left.key < right.key ? -1 : 1));

let queries = 0;
const apiRoot = new ApiRoot({
  executeRequest: (request) => {
    assert.equal(request.method, "GET");
    assert.equal(request.pathVariables.container, "migrate-sdk");
    const limit = Number(request.queryParams.limit);
    const after = request.queryParams["var.lastKey"];
    queries += 1;
    const selected = items
      .filter((item) => after === undefined || item.key > after)
      .slice(0, limit);
    return Promise.resolve({
      body: {
        count: selected.length,
        limit,
        offset: 0,
        results: selected.map(({ index, key, sourceIdentity }) => {
          const state = Schema.encodeSync(PersistedMigrationItemState)({
            definitionId,
            error: {
              errorTag: "FixtureFailure",
              kind: "process",
              message: "Fixture failure",
            },
            lastRunId: toMigrationRunId("run-memory"),
            reason: "Fixture update",
            skipReason: "Fixture skip",
            sourceIdentity,
            sourceVersion: toSourceVersion("1"),
            status: statuses[index % statuses.length],
            trackingRecord: {
              // Allocate independent flat strings, as JSON responses do. Shared
              // strings would hide retention of previous pages in the summary.
              payload: Buffer.alloc(256 * 1024, (index % 26) + 65).toString(
                "ascii"
              ),
            },
            updatedAt: new Date("2026-10-26T00:00:00.000Z"),
          });
          return {
            container: "migrate-sdk",
            createdAt: state.updatedAt,
            id: key,
            key,
            lastModifiedAt: state.updatedAt,
            value: {
              formatVersion: 1,
              index: {
                definitionId,
                lastRunId: state.lastRunId,
                sourceIdentity: state.sourceIdentity,
                sourceIdentityHash: hash(sourceIdentity.encoded),
                status: state.status,
                updatedAt: state.updatedAt,
              },
              namespace,
              recordKind: "migration-item-state",
              state,
            },
            version: 1,
          };
        }),
      },
    });
  },
});

const summary = await Effect.runPromise(
  Effect.flatMap(MigrationStore, (store) =>
    store.getItemStateSummary(definitionId)
  ).pipe(
    Effect.provide(
      CommercetoolsMigrationStore.layerFromApiRoot({
        apiRoot,
        namespace,
        projectKey: "test-project",
      })
    )
  )
);
assert.deepEqual(summary, {
  failed: 300,
  migrated: 300,
  needsUpdate: 300,
  skipped: 300,
});
console.info(JSON.stringify({ summary, queries }));
