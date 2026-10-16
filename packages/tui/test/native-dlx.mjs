import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { packageManagerCommand } from "../scripts/package-manager.mjs";

const serverOption = /--server/;
const buildApproval = /Ignored build scripts|approve-builds/;

/** Exercise registry optional-dependency selection with pnpm's build policy enabled. */
export async function testNativeDlx({ distribution, target, version, temp }) {
  const packages = new Map();
  for (const [name, directory, filename] of [
    ["@migrate-sdk/tui", "tui", `migrate-sdk-tui-${version}.tgz`],
    [
      target.packageName,
      target.id,
      `migrate-sdk-tui-${target.id}-${version}.tgz`,
    ],
  ]) {
    packages.set(name, {
      manifest: JSON.parse(
        await readFile(
          resolve(distribution, "packages", directory, "package.json"),
          "utf8"
        )
      ),
      filename,
      bytes: await readFile(resolve(distribution, "tarballs", filename)),
    });
  }
  const unexpected = new Set();
  const server = createServer((request, response) => {
    const path = decodeURIComponent(
      new URL(request.url, "http://localhost").pathname
    ).slice(1);
    const tarball = [...packages.values()].find(
      (item) => path === `tarballs/${item.filename}`
    );
    if (tarball) {
      response.end(tarball.bytes);
      return;
    }
    const entry = packages.get(path);
    if (!entry) {
      if (!path.startsWith("@migrate-sdk/tui-")) {
        unexpected.add(path);
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "package not in native release" }));
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        name: entry.manifest.name,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            ...entry.manifest,
            dist: {
              tarball: `http://127.0.0.1:${server.address().port}/tarballs/${entry.filename}`,
              integrity: `sha512-${createHash("sha512").update(entry.bytes).digest("base64")}`,
            },
          },
        },
      })
    );
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    const cwd = resolve(temp, "native-dlx");
    await mkdir(cwd);
    await writeFile(resolve(cwd, "package.json"), '{"private":true}\n');
    const command = packageManagerCommand([
      `--config.registry=http://127.0.0.1:${server.address().port}`,
      "--config.strict-dep-builds=true",
      "dlx",
      `@migrate-sdk/tui@${version}`,
      "--help",
    ]);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          ![
            "npm_config_ignore_scripts",
            "npm_config_cache_dir",
            "npm_config_side_effects_cache",
          ].includes(key.toLowerCase())
      )
    );
    const result = await new Promise((done, reject) => {
      const child = spawn(command.executable, command.args, {
        cwd,
        env: {
          ...env,
          npm_config_ignore_scripts: "false",
          npm_config_cache_dir: resolve(temp, "native-dlx-cache"),
          npm_config_side_effects_cache: "false",
        },
        timeout: 120_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (data) => {
        output += data;
      });
      child.stderr.on("data", (data) => {
        output += data;
      });
      child.once("error", reject);
      child.once("close", (status) => done({ status, output }));
    });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, serverOption);
    assert.doesNotMatch(result.output, buildApproval);
    assert.deepEqual(
      [...unexpected],
      [],
      "Native dlx must not fetch JavaScript renderer/server dependencies"
    );
    console.log(
      "Fresh pnpm dlx selects the native package with strict build checks and no approvals"
    );
  } finally {
    server.closeAllConnections();
    await new Promise((done, reject) =>
      server.close((error) => (error ? reject(error) : done()))
    );
  }
}
