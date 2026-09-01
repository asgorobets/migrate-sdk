import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAuthorizedCronRequest, isAuthorizedDemoSetupRequest } from "./auth";
import { DemoSetupAccess, makeDemoSetupAccess } from "./demo-setup-access";

const cronRequest = (authorization?: string): Request =>
  new Request("http://localhost/api/cron/import", {
    headers: authorization === undefined ? undefined : { authorization },
  });

const setupRequest = (authorization?: string): Request =>
  new Request("http://localhost/api/demo/setup", {
    headers: authorization === undefined ? undefined : { authorization },
  });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isAuthorizedCronRequest", () => {
  it("accepts the bearer token supplied through CRON_SECRET", () => {
    vi.stubEnv("CRON_SECRET", "cron-secret");

    expect(isAuthorizedCronRequest(cronRequest("Bearer cron-secret"))).toBe(
      true
    );
  });

  it("rejects missing or incorrect bearer tokens", () => {
    vi.stubEnv("CRON_SECRET", "cron-secret");

    expect(isAuthorizedCronRequest(cronRequest())).toBe(false);
    expect(isAuthorizedCronRequest(cronRequest("Bearer wrong-secret"))).toBe(
      false
    );
  });
});

describe("isAuthorizedDemoSetupRequest", () => {
  it("uses the private setup token", async () => {
    const authorize = (authorization: string) =>
      Effect.runPromise(
        isAuthorizedDemoSetupRequest(setupRequest(authorization)).pipe(
          Effect.provideService(
            DemoSetupAccess,
            makeDemoSetupAccess(" setup-secret ")
          )
        )
      );

    await expect(authorize("Bearer setup-secret")).resolves.toBe(true);
    await expect(authorize("Bearer  setup-secret")).resolves.toBe(false);
  });
});
