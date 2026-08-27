import { afterEach, describe, expect, it, vi } from "vitest";
import { isAuthorizedCronRequest } from "./auth";

const cronRequest = (authorization?: string): Request =>
  new Request("http://localhost/api/cron/import", {
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
