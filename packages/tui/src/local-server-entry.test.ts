import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProjectServerEntry } from "./local-server-entry.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

const installSdk = async (cwd: string, version: string) => {
  const sdk = join(cwd, "node_modules/migrate-sdk");
  await mkdir(sdk, { recursive: true });
  await writeFile(
    join(sdk, "package.json"),
    JSON.stringify({
      name: "migrate-sdk",
      version,
      exports: {
        "./package.json": "./package.json",
        "./server/node": "./server.js",
      },
    })
  );
  await writeFile(join(sdk, "server.js"), "");
  return sdk;
};

const project = async (version: string) => {
  const cwd = await mkdtemp(join(tmpdir(), "migrate-server-entry-"));
  directories.push(cwd);
  const sdk = await installSdk(cwd, version);
  await writeFile(join(cwd, "migrate.config.ts"), "");
  return { cwd, sdk };
};

describe("standalone project Node server entry", () => {
  it("uses the discovered parent config's SDK instead of a nested project's SDK", async () => {
    const { cwd, sdk } = await project("1.2.3");
    const nested = join(cwd, "app");
    await installSdk(nested, "0.9.0");
    expect(
      await realpath(
        fileURLToPath(resolveProjectServerEntry({ cwd: nested }, "1.2.3"))
      )
    ).toBe(await realpath(join(sdk, "server.js")));
  });
  it.each([
    ["pnpm-workspace.yaml", "packages: []\n"],
    ["package.json", JSON.stringify({ workspaces: [] })],
  ])("does not discover a config above a %s workspace boundary", async (filename, content) => {
    const { cwd } = await project("1.2.3");
    const nested = join(cwd, "workspace");
    await mkdir(nested);
    await writeFile(join(nested, filename), content);
    expect(() => resolveProjectServerEntry({ cwd: nested }, "1.2.3")).toThrow(
      "No migration config was found"
    );
  });
  it("resolves beside the explicit config even when launched from another directory", async () => {
    const { cwd, sdk } = await project("1.2.3");
    expect(
      await realpath(
        fileURLToPath(
          resolveProjectServerEntry(
            { cwd: tmpdir(), configPath: join(cwd, "migrate.config.ts") },
            "1.2.3"
          )
        )
      )
    ).toBe(await realpath(join(sdk, "server.js")));
  });
  it("rejects a project SDK mismatch before spawning a server", async () => {
    const { cwd } = await project("1.2.3");
    expect(() => resolveProjectServerEntry({ cwd }, "1.2.4")).toThrow(
      "does not match TUI 1.2.4"
    );
  });
  it("reports a missing local SDK without the test runner's package resolution", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "migrate-server-entry-"));
    directories.push(cwd);
    await writeFile(join(cwd, "migrate.config.ts"), "");
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { resolveProjectServerEntry } from ${JSON.stringify(new URL("./local-server-entry.ts", import.meta.url).href)};
      try { resolveProjectServerEntry({ cwd: ${JSON.stringify(cwd)} }, "1.2.3"); }
      catch (cause) { console.log(cause.message); }
    `,
      ],
      { encoding: "utf8", env: { ...process.env, NODE_PATH: "" } }
    );
    expect(output).toContain("Install migrate-sdk@1.2.3");
  });
});
