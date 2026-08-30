import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  makeLocalMigrateServerEndpoint,
  removeLocalMigrateServerEndpoint,
} from "./local-endpoint.ts";

const POSIX_SOCKET_NAME = /^migrate-501-[a-f0-9]{24}\.sock$/;
const WINDOWS_PIPE_NAME = /^\\\\\.\\pipe\\migrate-user-[a-f0-9]{24}$/;

describe("local Migrate Server endpoint", () => {
  it("uses a filesystem socket on POSIX", () => {
    const endpoint = makeLocalMigrateServerEndpoint(
      { configPath: "migrate.config.ts", cwd: "/workspace" },
      {
        platform: "darwin",
        sdkVersion: "1.2.3",
        serverIdentity: "test",
        tempDirectory: "/tmp/migrate-test",
        user: "501",
      }
    );

    expect(dirname(endpoint)).toBe("/tmp/migrate-test");
    expect(basename(endpoint)).toMatch(POSIX_SOCKET_NAME);
  });

  it("uses a named pipe on Windows", () => {
    const endpoint = makeLocalMigrateServerEndpoint(
      { configPath: "migrate.config.ts", cwd: "C:\\workspace" },
      {
        platform: "win32",
        sdkVersion: "1.2.3",
        serverIdentity: "test",
        tempDirectory: "C:\\Temp",
        user: "user",
      }
    );

    expect(endpoint).toMatch(WINDOWS_PIPE_NAME);
  });

  it("uses the build id to isolate immutable application builds", () => {
    const input = { configPath: "migrate.config.ts", cwd: "/workspace" };
    const environment = {
      platform: "darwin" as const,
      sdkVersion: "1.2.3",
      tempDirectory: "/tmp/migrate-test",
      user: "501",
    };

    const first = makeLocalMigrateServerEndpoint(
      { ...input, buildId: "build-1" },
      environment
    );
    const replacement = makeLocalMigrateServerEndpoint(
      { ...input, buildId: "build-2" },
      environment
    );

    expect(replacement).not.toBe(first);
    expect(
      makeLocalMigrateServerEndpoint(
        { ...input, buildId: "build-1" },
        environment
      )
    ).toBe(first);
  });

  it("does not unlink Windows named pipes", () => {
    const directory = mkdtempSync(join(tmpdir(), "migrate-endpoint-test-"));
    const endpoint = join(directory, "named-pipe-marker");
    writeFileSync(endpoint, "live", "utf8");

    try {
      removeLocalMigrateServerEndpoint(endpoint, "win32");

      expect(existsSync(endpoint)).toBe(true);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
