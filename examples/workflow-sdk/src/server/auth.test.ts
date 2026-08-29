import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAuthorizedCronRequest, isAuthorizedMigrationRequest } from "./auth";
import {
  MigrateServerAccess,
  makeMigrateServerAccess,
} from "./migrate-server-access";

const cronRequest = (authorization?: string): Request =>
  new Request("http://localhost/api/cron/import", {
    headers: authorization === undefined ? undefined : { authorization },
  });

const migrationRequest = (authorization?: string): Request =>
  new Request("http://localhost/api/migrate", {
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

describe("isAuthorizedMigrationRequest", () => {
  it("uses the exact token shared with the browser sandbox", async () => {
    const authorize = (authorization: string) =>
      Effect.runPromise(
        isAuthorizedMigrationRequest(migrationRequest(authorization)).pipe(
          Effect.provideService(
            MigrateServerAccess,
            makeMigrateServerAccess(" migrate-secret ")
          )
        )
      );

    await expect(authorize("Bearer migrate-secret")).resolves.toBe(true);
    await expect(authorize("Bearer  migrate-secret")).resolves.toBe(false);
  });
});
