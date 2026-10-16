import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packages = ["migrate-sdk", "commercetools", "workflow-sdk", "tui"];
const require = createRequire(
  resolve(root, "packages/migrate-sdk/package.json")
);
const effectVersion = require("effect/package.json").version;
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, cwd, allowFailure = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    timeout: 180_000,
    env: { ...process.env, CI: "true" },
  });
  assert.ifError(result.error);
  if (!allowFailure) {
    assert.equal(
      result.status,
      0,
      `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`
    );
  }
  return result;
}

const temporary = await mkdtemp(join(tmpdir(), "migrate-effect-peers-"));
try {
  const dependencies = {};
  let effectPeerRange;
  for (const directory of packages) {
    const cwd = resolve(root, "packages", directory);
    const manifest = JSON.parse(
      await readFile(join(cwd, "package.json"), "utf8")
    );
    const output = run(
      pnpm,
      ["pack", "--json", "--pack-destination", temporary],
      cwd
    ).stdout;
    const packed = JSON.parse(output.slice(output.indexOf("{")));
    const tarball = resolve(temporary, packed.filename);
    const published = JSON.parse(
      run("tar", ["-xOf", tarball, "package/package.json"], root).stdout
    );
    const peerRange = published.peerDependencies?.effect;
    assert.match(
      peerRange ?? "",
      /^\^4\.\d+\.\d+$/,
      `${manifest.name} must accept compatible Effect releases`
    );
    effectPeerRange ??= peerRange;
    assert.equal(
      peerRange,
      effectPeerRange,
      "SDK packages must share the same Effect peer range"
    );
    assert.equal(
      published.dependencies?.effect,
      undefined,
      `${manifest.name} must share the customer's Effect`
    );
    assert.notEqual(
      published.peerDependenciesMeta?.effect?.optional,
      true,
      `${manifest.name} must auto-install missing Effect peers`
    );
    dependencies[manifest.name] = `file:${tarball}`;
  }

  for (const manager of [npm, pnpm]) {
    for (const mode of ["existing", "missing", "incompatible"]) {
      const cwd = join(temporary, `${manager}-${mode}`);
      await mkdir(cwd);
      const consumerDependencies = { ...dependencies };
      if (mode === "existing") {
        consumerDependencies.effect = effectVersion;
      } else if (mode === "incompatible") {
        consumerDependencies.effect = "3.22.3";
      }
      await writeFile(
        join(cwd, "package.json"),
        `${JSON.stringify(
          {
            name: "migrate-effect-consumer",
            private: true,
            type: "module",
            dependencies: consumerDependencies,
          },
          null,
          2
        )}\n`
      );
      const args =
        manager === pnpm
          ? ["install", "--ignore-scripts", "--strict-peer-dependencies"]
          : [
              "install",
              "--ignore-scripts",
              "--strict-peer-deps",
              "--no-audit",
              "--no-fund",
            ];
      const result = run(manager, args, cwd, mode === "incompatible");
      if (mode === "incompatible") {
        assert.notEqual(
          result.status,
          0,
          `${manager} must reject incompatible Effect`
        );
        const output = `${result.stdout}\n${result.stderr}`;
        assert.match(
          output,
          manager === pnpm ? /ERR_PNPM_PEER_DEP_ISSUES/ : /ERESOLVE/
        );
        assert.match(output, /peer effect@/i);
      } else {
        await copyFile(
          resolve(root, "scripts/fixtures/effect-peer-consumer.mjs"),
          join(cwd, "verify.mjs")
        );
        run(
          process.execPath,
          ["verify.mjs", mode, ...Object.keys(dependencies)],
          cwd
        );
      }
      process.stdout.write(`${manager}: ${mode} Effect passed\n`);
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
