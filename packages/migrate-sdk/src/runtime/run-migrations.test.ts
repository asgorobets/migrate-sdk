import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  defineMigration,
  InMemoryDestinationPlugin,
  InMemoryMigrationStore,
  InMemorySourcePlugin,
  runMigration,
} from "../index.ts";

const UpsertEntryCommand = Schema.Struct({
  kind: Schema.Literal("UpsertEntry"),
  contentType: Schema.String,
  fields: Schema.Record(Schema.String, Schema.Unknown),
});

type UpsertEntryCommand = typeof UpsertEntryCommand.Type;

describe("runMigration", () => {
  it.effect("runs one Source Item through in-memory runtime", () =>
    Effect.gen(function* () {
      const destinationState =
        InMemoryDestinationPlugin.makeState<UpsertEntryCommand>();
      const storeState = InMemoryMigrationStore.makeState();

      const definition = defineMigration({
        id: "articles",
        source: InMemorySourcePlugin.make({
          items: [
            {
              identity: "article-1",
              version: "source-version-1",
              item: {
                title: "Hello, migration",
              },
            },
          ],
        }),
        destination: InMemoryDestinationPlugin.make({
          commandSchema: UpsertEntryCommand,
          state: destinationState,
          execute: (_command, context) => ({
            destinationIdentity: `entry-${context.sourceIdentity}`,
            destinationVersion: "destination-version-1",
          }),
        }),
        store: InMemoryMigrationStore.layer(storeState),
        pipeline: (source) =>
          Effect.succeed({
            kind: "UpsertEntry" as const,
            contentType: "article",
            fields: {
              title: source.item.title,
            },
          }),
      });

      const summary = yield* runMigration(definition);

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions).toHaveLength(1);
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 1,
        skipped: 0,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });

      expect(destinationState.executions).toHaveLength(1);
      expect(destinationState.executions[0]?.command).toEqual({
        kind: "UpsertEntry",
        contentType: "article",
        fields: {
          title: "Hello, migration",
        },
      });
      expect(destinationState.executions[0]?.context.sourceIdentity).toBe(
        "article-1"
      );

      const itemState = storeState.itemStates.get(
        InMemoryMigrationStore.itemStateKey("articles", "article-1")
      );

      expect(itemState).toEqual(
        expect.objectContaining({
          status: "migrated",
          sourceVersion: "source-version-1",
          destinationIdentity: "entry-article-1",
          destinationVersion: "destination-version-1",
          lastRunId: summary.runId,
        })
      );
    })
  );
});
