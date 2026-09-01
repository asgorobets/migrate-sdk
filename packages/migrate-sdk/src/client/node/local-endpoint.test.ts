import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  guardLocalMigrateServerEndpoint,
  makeLocalMigrateServerEndpoint,
  publishLocalMigrateServerTcpDiscovery,
  readLocalMigrateServerPosixEndpointIdentity,
  removeLocalMigrateServerEndpoint,
  settleLocalMigrateServerEndpointClaim,
} from "./local-endpoint.ts";

const POSIX_SOCKET_NAME = /^migrate-501-[a-f0-9]{24}\.sock$/;
const WINDOWS_DISCOVERY_NAME = /^migrate-user-[a-f0-9]{24}\.json$/;

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

  it("uses a TCP discovery file on Windows", () => {
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

    expect(dirname(endpoint)).toBe("C:\\Temp");
    expect(basename(endpoint)).toMatch(WINDOWS_DISCOVERY_NAME);
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

  it("only unlinks the Windows discovery file owned by the caller", () => {
    const directory = mkdtempSync(join(tmpdir(), "migrate-endpoint-test-"));
    const endpoint = join(directory, "discovery.json");
    writeFileSync(endpoint, "live", "utf8");

    try {
      removeLocalMigrateServerEndpoint(endpoint, "win32");
      removeLocalMigrateServerEndpoint(endpoint, "win32", "replaced");

      expect(readFileSync(endpoint, "utf8")).toBe("live");

      removeLocalMigrateServerEndpoint(endpoint, "win32", "live");

      expect(existsSync(endpoint)).toBe(false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("only unlinks the POSIX endpoint inode owned by the caller", () => {
    const directory = mkdtempSync(join(tmpdir(), "migrate-endpoint-test-"));
    const endpoint = join(directory, "server.sock");
    const replacement = join(directory, "replacement.sock");
    writeFileSync(endpoint, "stale", "utf8");
    const staleIdentity = readLocalMigrateServerPosixEndpointIdentity(endpoint);

    try {
      expect(staleIdentity).toBeDefined();
      writeFileSync(replacement, "live", "utf8");
      renameSync(replacement, endpoint);

      removeLocalMigrateServerEndpoint(
        endpoint,
        "linux",
        undefined,
        staleIdentity
      );

      expect(readFileSync(endpoint, "utf8")).toBe("live");

      const liveIdentity =
        readLocalMigrateServerPosixEndpointIdentity(endpoint);
      expect(liveIdentity).toBeDefined();
      removeLocalMigrateServerEndpoint(
        endpoint,
        "linux",
        undefined,
        liveIdentity
      );

      expect(existsSync(endpoint)).toBe(false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("removes a restored claim when ownership verification fails", () => {
    if (process.platform === "win32") {
      return;
    }

    const directory = mkdtempSync(join(tmpdir(), "migrate-endpoint-test-"));
    const endpoint = join(directory, "discovery.json");
    writeFileSync(endpoint, "live", "utf8");
    chmodSync(endpoint, 0o000);

    try {
      expect(() =>
        removeLocalMigrateServerEndpoint(endpoint, "win32", "live")
      ).toThrow();
      expect(existsSync(endpoint)).toBe(true);
      expect(readdirSync(directory)).toEqual(["discovery.json"]);
    } finally {
      if (existsSync(endpoint)) {
        chmodSync(endpoint, 0o600);
      }
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("guards listener teardown without deleting a later publisher", () => {
    const directory = mkdtempSync(join(tmpdir(), "migrate-endpoint-test-"));
    const endpoint = join(directory, "server.sock");
    writeFileSync(endpoint, "owned", "utf8");
    const identity = readLocalMigrateServerPosixEndpointIdentity(endpoint);

    if (identity === undefined) {
      throw new Error("Test endpoint identity was not captured");
    }

    const guard = guardLocalMigrateServerEndpoint(endpoint, (guardPath) => {
      const guardIdentity =
        readLocalMigrateServerPosixEndpointIdentity(guardPath);
      return (
        guardIdentity !== undefined &&
        guardIdentity.device === identity.device &&
        guardIdentity.inode === identity.inode
      );
    });

    if (guard === undefined) {
      throw new Error("Test endpoint guard was not created");
    }

    try {
      expect(() =>
        writeFileSync(endpoint, "too-early", {
          encoding: "utf8",
          flag: "wx",
        })
      ).toThrow();

      unlinkSync(endpoint);
      writeFileSync(endpoint, "new-publisher", {
        encoding: "utf8",
        flag: "wx",
      });
      settleLocalMigrateServerEndpointClaim(guard);

      expect(readFileSync(endpoint, "utf8")).toBe("new-publisher");
      expect(readdirSync(directory)).toEqual(["server.sock"]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("publishes complete Windows discovery without replacing an owner", () => {
    const directory = mkdtempSync(join(tmpdir(), "migrate-endpoint-test-"));
    const endpoint = join(directory, "discovery.json");

    try {
      publishLocalMigrateServerTcpDiscovery(endpoint, "first");

      expect(readFileSync(endpoint, "utf8")).toBe("first");
      expect(() =>
        publishLocalMigrateServerTcpDiscovery(endpoint, "second")
      ).toThrow();
      expect(readFileSync(endpoint, "utf8")).toBe("first");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
