import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  type DestinationCommand,
  type DestinationCommandContext,
  DestinationPlugin,
  DestinationPluginError,
  defineDestinationCommand,
  InMemoryDestinationPlugin,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceIdentity,
  toSourceVersion,
} from "migrate-sdk";
import { InMemoryDestinationTesting } from "migrate-sdk/destinations/in-memory/testing";
import { expectTypeOf } from "vitest";

const ArticleEntryFields = Schema.Struct({
  title: Schema.String,
});

const IndexRecordCommand = Schema.Struct({
  kind: Schema.Literal("IndexRecord"),
  record: Schema.Struct({
    objectId: Schema.String,
    title: Schema.String,
  }),
});
type IndexRecordCommand = typeof IndexRecordCommand.Type;

const indexRecordCommand = defineDestinationCommand("IndexRecord", {
  identity: true,
  make: {
    indexRecord: (
      record: IndexRecordCommand["record"]
    ): IndexRecordCommand => ({
      kind: "IndexRecord",
      record,
    }),
  },
  schema: IndexRecordCommand,
});

const commandContext: DestinationCommandContext = {
  definitionId: toMigrationDefinitionId("articles"),
  runId: toMigrationRunId("run-1"),
  sourceIdentity: toSourceIdentity("article-1"),
  sourceVersion: toSourceVersion("source-version-1"),
};

const assertInMemoryEntryDestinationTypes = () => {
  InMemoryDestinationPlugin.makeEntries({
    commands: {
      publishEntry: true,
    },
    // @ts-expect-error entry destination content types must be non-empty.
    contentType: "",
  });

  InMemoryDestinationPlugin.makeEntries({
    // @ts-expect-error entry destinations require at least one configured command.
    commands: {},
    contentType: "article",
  });

  const publishOnly = InMemoryDestinationPlugin.makeEntries({
    commands: {
      publishEntry: true,
    },
    contentType: "article",
  });
  publishOnly.commands.publishEntry();
  // @ts-expect-error unconfigured commands are not exposed.
  publishOnly.commands.upsertEntry({ title: "Hidden upsert" });

  const deleteOnly = InMemoryDestinationPlugin.makeEntries({
    commands: {
      deleteEntry: true,
    },
    contentType: "article",
  });
  deleteOnly.commands.deleteEntry();
  // @ts-expect-error unconfigured commands are not exposed.
  deleteOnly.commands.publishEntry();

  const upsertOnly = InMemoryDestinationPlugin.makeEntries({
    commands: {
      upsertEntry: { fields: ArticleEntryFields },
    },
    contentType: "article",
  });
  upsertOnly.commands.upsertEntry({ title: "Typed upsert" });
  // @ts-expect-error unconfigured commands are not exposed.
  upsertOnly.commands.publishEntry();
};

describe("InMemoryDestinationPlugin.makeEntries", () => {
  it("requires at least one configured command", () => {
    expect(assertInMemoryEntryDestinationTypes).toBeInstanceOf(Function);

    const makeEntriesUnsafe =
      InMemoryDestinationPlugin.makeEntries as unknown as (options: {
        readonly commands: Record<PropertyKey, never>;
        readonly contentType: string;
      }) => unknown;

    expect(() =>
      makeEntriesUnsafe({
        commands: {},
        contentType: "article",
      })
    ).toThrow("In-memory entry destination must define at least one command");
  });

  it("throws when entry destination options are unsafe through an untyped boundary", () => {
    const makeEntriesUnsafe =
      InMemoryDestinationPlugin.makeEntries as unknown as (
        options: unknown
      ) => unknown;

    expect(() => makeEntriesUnsafe(undefined)).toThrow(
      "In-memory entry destination options must be an object"
    );
    expect(() =>
      makeEntriesUnsafe({
        commands: {
          publishEntry: true,
        },
        contentType: "",
      })
    ).toThrow(
      "In-memory entry destination contentType must be a non-empty string"
    );
    expect(() =>
      makeEntriesUnsafe({
        contentType: "article",
      })
    ).toThrow("In-memory entry destination commands must be an object");
    expect(() =>
      makeEntriesUnsafe({
        commands: {
          publishEntry: true,
          publshEntry: true,
        },
        contentType: "article",
      })
    ).toThrow(
      "In-memory entry destination command is not supported: publshEntry"
    );
    expect(() =>
      makeEntriesUnsafe({
        commands: {
          publishEntry: false,
        },
        contentType: "article",
      })
    ).toThrow("In-memory publishEntry command option must be true");
    expect(() =>
      makeEntriesUnsafe({
        commands: {
          deleteEntry: false,
        },
        contentType: "article",
      })
    ).toThrow("In-memory deleteEntry command option must be true");
    expect(() =>
      makeEntriesUnsafe({
        commands: {
          upsertEntry: null,
        },
        contentType: "article",
      })
    ).toThrow("In-memory upsertEntry command options must be an object");
    expect(() =>
      makeEntriesUnsafe({
        commands: {
          upsertEntry: {},
        },
        contentType: "article",
      })
    ).toThrow("In-memory upsertEntry command requires a fields schema");
    expect(() =>
      makeEntriesUnsafe({
        commands: {
          publishEntry: true,
        },
        contentType: "article",
        transientFailures: {
          execute: -1,
        },
      })
    ).toThrow(
      "In-memory destination transientFailures.execute must be a non-negative integer"
    );
  });

  it("throws when lower-level destination options are unsafe through an untyped boundary", () => {
    const makeUnsafe = InMemoryDestinationTesting.make as unknown as (
      options: unknown
    ) => unknown;

    expect(() => makeUnsafe(undefined)).toThrow(
      "In-memory destination options must be an object"
    );
    expect(() =>
      makeUnsafe({
        execute: () => ({}),
        command: {},
      })
    ).toThrow(
      "In-memory destination requires a destination command definition"
    );
    expect(() =>
      makeUnsafe({
        execute: () => ({}),
        command: {
          name: "IndexRecord",
          schema: IndexRecordCommand,
        },
      })
    ).toThrow(
      "In-memory destination requires a destination command definition"
    );
    expect(() =>
      makeUnsafe({
        command: indexRecordCommand,
      })
    ).toThrow("In-memory destination execute must be a function");
    expect(() =>
      makeUnsafe({
        execute: () => ({}),
        command: indexRecordCommand,
        transientFailures: {
          execute: 1.5,
        },
      })
    ).toThrow(
      "In-memory destination transientFailures.execute must be a non-negative integer"
    );
  });

  it("infers lower-level execute input from the plugin definition", () => {
    const destination = InMemoryDestinationTesting.make({
      execute: (command) => {
        expectTypeOf(command).toEqualTypeOf<IndexRecordCommand>();

        return {
          destinationIdentity: `search:${command.record.objectId}`,
        };
      },
      command: indexRecordCommand,
    });
    const command = destination.commands.indexRecord({
      objectId: "article-1",
      title: "Indexed article",
    });

    expect(command).toEqual({
      kind: "IndexRecord",
      record: {
        objectId: "article-1",
        title: "Indexed article",
      },
    });
    expectTypeOf(destination.commands.indexRecord).toEqualTypeOf<
      (record: IndexRecordCommand["record"]) => IndexRecordCommand
    >();
  });

  it.effect("deletes entries by content type and source identity", () =>
    Effect.gen(function* () {
      const fixture = InMemoryDestinationTesting.fixtureEntries({
        contentType: "article",
        commands: {
          deleteEntry: true,
          upsertEntry: { fields: ArticleEntryFields },
        },
      });
      const plugin = yield* DestinationPlugin.pipe(
        Effect.provide(fixture.destination.layer)
      );

      yield* plugin.execute(
        fixture.destination.commands.upsertEntry({
          title: "Article to delete",
        }),
        commandContext
      );
      yield* plugin.execute(
        fixture.destination.commands.deleteEntry(),
        commandContext
      );

      expect(fixture.entry("article:article-1")).toBeUndefined();
      expect(
        fixture.executions().map((execution) => execution.command.kind)
      ).toEqual(["UpsertEntry", "DeleteEntry"]);
    })
  );

  it.effect("counts raw execute attempts before command schema decoding", () =>
    Effect.gen(function* () {
      const fixture = InMemoryDestinationTesting.fixtureEntries({
        contentType: "article",
        commands: {
          publishEntry: true,
          upsertEntry: { fields: ArticleEntryFields },
        },
      });
      const plugin = yield* DestinationPlugin.pipe(
        Effect.provide(fixture.destination.layer)
      );
      const error = yield* plugin
        .execute(
          {
            contentType: "article",
            fields: {},
            kind: "UpsertEntry",
          } as DestinationCommand,
          commandContext
        )
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(DestinationPluginError);
      expect(error.message).toBe(
        "Destination command did not match command schema"
      );
      expect(fixture.executeAttempts()).toBe(1);
      expect(fixture.executions()).toEqual([]);
    })
  );
});
