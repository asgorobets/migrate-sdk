import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  DuplicateSourceIdentityStatusWarning,
  InvalidSourceItemStatusWarning,
  MigrationStatusRequestError,
  MigrationStatusWarning,
  makeMigrationStatusRequest,
  toEncodedSourceIdentity,
  toMigrationDefinitionId,
} from "migrate-sdk";

describe("migration status public API", () => {
  it("normalizes durable-only status request defaults", () => {
    const request = makeMigrationStatusRequest({
      definitions: [],
      definitionIds: ["articles"],
    });

    expect(request).toEqual({
      definitions: [],
      definitionIds: [toMigrationDefinitionId("articles")],
      scanSource: false,
      concurrency: 1,
    });
  });

  it("rejects concurrency without source scanning", () => {
    expect(() =>
      makeMigrationStatusRequest({
        definitions: [],
        concurrency: 2,
      })
    ).toThrow(MigrationStatusRequestError);
  });

  it.each([
    0, -1, 1.5,
  ])("rejects invalid status concurrency %s", (concurrency) => {
    expect(() =>
      makeMigrationStatusRequest({
        definitions: [],
        scanSource: true,
        concurrency,
      })
    ).toThrow(MigrationStatusRequestError);
  });

  it("normalizes source-scan status request concurrency", () => {
    const request = makeMigrationStatusRequest({
      definitions: [],
      scanSource: true,
      concurrency: 2,
    });

    expect(request.scanSource).toBe(true);
    expect(request.concurrency).toBe(2);
  });

  it.effect("schema-round-trips status warnings", () =>
    Effect.gen(function* () {
      const warnings: readonly MigrationStatusWarning[] = [
        new DuplicateSourceIdentityStatusWarning({
          count: 2,
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: toEncodedSourceIdentity("article-1"),
        }),
        new InvalidSourceItemStatusWarning({
          definitionId: toMigrationDefinitionId("articles"),
          details: [{ message: "Expected string", path: "title" }],
          message: "Source item payload is invalid",
          sourceIdentity: toEncodedSourceIdentity("article-2"),
        }),
      ];

      const encoded = yield* Schema.encodeEffect(
        Schema.Array(MigrationStatusWarning)
      )(warnings);
      const decoded = yield* Schema.decodeUnknownEffect(
        Schema.Array(MigrationStatusWarning)
      )(encoded);

      expect(decoded).toEqual(warnings);
    })
  );
});
