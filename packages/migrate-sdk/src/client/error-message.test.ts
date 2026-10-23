import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { MigrationStoreError } from "../domain/errors.ts";
import { MigrateProtocolError } from "../protocol/index.ts";
import { formatMigrateError } from "./error-message.ts";

describe("migration error messages", () => {
  it.effect(
    "preserves schema paths and reasons after a protocol round trip",
    () =>
      Effect.gen(function* () {
        const cause = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            state: Schema.Struct({ runId: Schema.String }),
          })
        )({ state: {} }).pipe(Effect.flip);
        const failure = new MigrationStoreError({
          message: "Unable to decode record example",
          cause,
        });
        const encoded =
          yield* Schema.encodeEffect(MigrateProtocolError)(failure);
        const remote =
          yield* Schema.decodeUnknownEffect(MigrateProtocolError)(encoded);
        expect(formatMigrateError(remote)).toBe(
          'Unable to decode record example\nCaused by: SchemaError: Missing key\n  at ["state"]["runId"]'
        );
        expect(formatMigrateError(remote, { includeName: true })).toContain(
          "MigrationStoreError: Unable to decode record example"
        );
      })
  );

  it.effect(
    "shows expected types and nested paths for invalid stored values",
    () =>
      Effect.gen(function* () {
        const cause = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            state: Schema.Struct({ runId: Schema.String }),
          })
        )({ state: { runId: 123 } }).pipe(Effect.flip);
        const message = formatMigrateError(
          new MigrationStoreError({
            message: "Unable to decode record example",
            cause,
          })
        );
        expect(message).toContain("Expected string");
        expect(message).toContain('["state"]["runId"]');
      })
  );

  it("handles plain and wrapped errors without stacks or arbitrary payloads", () => {
    const cause = Object.assign(new Error("Expected string at state.runId"), {
      payload: "PRIVATE-PAYLOAD",
    });
    const failure = new Error("Unable to read store", { cause });
    const message = formatMigrateError(failure);
    expect(message).toBe(
      "Unable to read store\nCaused by: Error: Expected string at state.runId"
    );
    expect(message).not.toContain("PRIVATE-PAYLOAD");
    expect(message).not.toContain("error-message.test.ts");
    expect(
      formatMigrateError({
        message: "Remote wrapper",
        cause: { name: "SchemaError", message: "Missing key" },
      })
    ).toContain("Caused by: SchemaError: Missing key");
  });

  it("stops at cyclic causes and skips duplicate wrapper messages", () => {
    const failure = new Error("Store unavailable");
    failure.cause = failure;
    expect(formatMigrateError(failure)).toBe("Store unavailable");
    expect(
      formatMigrateError(
        new Error("Store unavailable", {
          cause: new Error("Store unavailable", {
            cause: new Error("Connection refused"),
          }),
        })
      )
    ).toBe("Store unavailable\nCaused by: Error: Connection refused");
  });

  it("keeps ordinary messages concise", () => {
    expect(formatMigrateError(new Error("Store unavailable"))).toBe(
      "Store unavailable"
    );
    expect(formatMigrateError("Connection refused")).toBe("Connection refused");
    expect(formatMigrateError(undefined)).toBe("Migration run failed");
  });
});
