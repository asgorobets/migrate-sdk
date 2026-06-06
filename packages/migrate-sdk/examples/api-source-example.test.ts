import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { formatApiSourceExampleResult } from "./api-source/format.ts";
import { runApiSourceExampleWithInspection } from "./api-source/inspection.ts";
import {
  makeScriptedJsonPlaceholderApiState,
  scriptedJsonPlaceholderApiLayer,
} from "./api-source/json-placeholder-api-scripted.ts";

describe("api source example", () => {
  it.effect("runs a JSONPlaceholder-shaped list and detail source", () =>
    Effect.gen(function* () {
      const state = makeScriptedJsonPlaceholderApiState();
      const result = yield* runApiSourceExampleWithInspection({
        apiLayer: scriptedJsonPlaceholderApiLayer(state),
        state,
      });
      const output = formatApiSourceExampleResult(result);

      expect(result.summary.status).toBe("succeeded");
      expect(result.summary.definitions[0]?.definitionId).toBe(
        "jsonplaceholder-posts"
      );
      expect(result.summary.definitions[0]?.counts).toEqual({
        failed: 0,
        migrated: 3,
        needsUpdate: 0,
        skipped: 0,
        unchanged: 0,
      });
      expect(result.inspection.listCalls).toBe(2);
      expect(result.inspection.detailCalls).toEqual([1, 2, 3]);
      expect(
        result.inspection.commandFields.map((fields) => fields.title)
      ).toEqual([
        "Composable source plugins",
        "List plus detail API stitching",
        "Bounded detail fetches",
      ]);
      expect(output).toContain("Effect-Native API Source Example");
      expect(output).toContain("JSONPlaceholder API Calls");
    })
  );

  it.effect(
    "recovers from scripted rate limits and timeouts with retry backoff",
    () =>
      Effect.gen(function* () {
        const state = makeScriptedJsonPlaceholderApiState();
        const fiber = yield* runApiSourceExampleWithInspection({
          apiLayer: scriptedJsonPlaceholderApiLayer(state, {
            detailScripts: {
              2: ["rate-limit", "success"],
              3: ["timeout", "success"],
            },
          }),
          state,
        }).pipe(Effect.forkChild);

        yield* TestClock.adjust("10 seconds");

        const result = yield* Fiber.join(fiber);

        expect(result.summary.status).toBe("succeeded");
        expect(state.detailAttemptsById[1]).toBe(1);
        expect(state.detailAttemptsById[2]).toBe(2);
        expect(state.detailAttemptsById[3]).toBe(2);
      })
  );

  it.effect("bounds concurrent detail lookups inside one cursor page", () =>
    Effect.gen(function* () {
      const state = makeScriptedJsonPlaceholderApiState();
      const fiber = yield* runApiSourceExampleWithInspection({
        apiLayer: scriptedJsonPlaceholderApiLayer(state, {
          detailDelay: "1 second",
        }),
        state,
      }).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("999 millis");

      expect(state.activeDetailCalls).toBe(2);
      expect(state.maxActiveDetailCalls).toBe(2);

      yield* TestClock.adjust("2 seconds");
      const result = yield* Fiber.join(fiber);

      expect(result.summary.status).toBe("succeeded");
      expect(state.activeDetailCalls).toBe(0);
      expect(state.maxActiveDetailCalls).toBe(2);
    })
  );
});
