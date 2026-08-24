import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  MigrationDefinition,
  SourceIdentity,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceVersion,
} from "migrate-sdk";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import { getMigrationMessages } from "./get-migration-messages.ts";

const Article = Schema.Struct({ title: Schema.String });
const ArticleIdentity = SourceIdentity.make({
  id: "message-article@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});

describe("getMigrationMessages", () => {
  it.effect("projects structured durable item and journal evidence", () =>
    Effect.gen(function* () {
      const definitionId = toMigrationDefinitionId("articles");
      const processRunId = toMigrationRunId("run-process");
      const rollbackRunId = toMigrationRunId("run-rollback");
      const updatedAt = new Date("2026-08-23T09:00:00.000Z");
      const failedAt = new Date("2026-08-23T10:00:00.000Z");
      const state = InMemoryMigrationStore.makeState();
      const definition = MigrationDefinition.make({
        id: definitionId,
        process: () => Effect.void,
        source: InMemorySource.make({
          identity: ArticleIdentity,
          items: [],
          sourceSchema: Article,
        }),
        store: InMemoryMigrationStore.layer(state),
      });

      state.itemStates.set(
        InMemoryMigrationStore.itemStateKey(definitionId, "article-1"),
        {
          definitionId,
          error: {
            details: [
              { message: "Expected an existing author", path: "authorId" },
            ],
            errorTag: "MissingAuthor",
            kind: "process",
            message: "Could not resolve the article author",
          },
          journal: {
            process: {
              entries: [
                {
                  details: { authorId: "author-missing" },
                  kind: "diagnostic",
                  message: "Author lookup returned no result",
                  sequence: 0,
                  severity: "warning",
                },
              ],
              runId: processRunId,
            },
            rollbackAttempts: [
              {
                entries: [
                  {
                    details: { route: "/articles/one" },
                    kind: "diagnostic",
                    message: "Route cleanup was incomplete",
                    sequence: 0,
                    severity: "warning",
                  },
                ],
                error: {
                  errorTag: "DeleteRejected",
                  kind: "destination",
                  message: "Could not remove the article route",
                },
                failedAt,
                runId: rollbackRunId,
              },
            ],
          },
          lastRunId: processRunId,
          sourceIdentity: SourceIdentity.fromKey(ArticleIdentity, "article-1"),
          sourceVersion: toSourceVersion("v1"),
          status: "failed",
          updatedAt,
        }
      );
      state.itemStates.set(
        InMemoryMigrationStore.itemStateKey(definitionId, "article-2"),
        {
          definitionId,
          lastRunId: processRunId,
          reason: "Destination version changed",
          sourceIdentity: SourceIdentity.fromKey(ArticleIdentity, "article-2"),
          sourceVersion: toSourceVersion("v2"),
          status: "needs-update",
          updatedAt: new Date("2026-08-23T08:00:00.000Z"),
        }
      );

      const messages = yield* getMigrationMessages({
        definitions: [definition],
      });

      expect(messages).toEqual([
        expect.objectContaining({
          kind: "rollback-error",
          message: "DeleteRejected: Could not remove the article route",
          runId: rollbackRunId,
          sourceIdentity: "article-1",
          updatedAt: failedAt,
        }),
        expect.objectContaining({
          details: { route: "/articles/one" },
          kind: "rollback-diagnostic",
          message: "Route cleanup was incomplete",
          runId: rollbackRunId,
          sequence: 0,
        }),
        expect.objectContaining({
          details: [
            { message: "Expected an existing author", path: "authorId" },
          ],
          errorKind: "process",
          errorTag: "MissingAuthor",
          kind: "item-error",
          message: "MissingAuthor: Could not resolve the article author",
          runId: processRunId,
        }),
        expect.objectContaining({
          details: { authorId: "author-missing" },
          kind: "process-diagnostic",
          message: "Author lookup returned no result",
          runId: processRunId,
          sequence: 0,
        }),
        expect.objectContaining({
          kind: "update-reason",
          message: "Destination version changed",
          runId: processRunId,
          severity: "warning",
          sourceIdentity: "article-2",
        }),
      ]);
    })
  );
});
