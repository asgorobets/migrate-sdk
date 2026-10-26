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
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const { packageManager } = JSON.parse(
  await readFile(join(root, "package.json"), "utf8")
);
const packages = [
  "migrate-sdk",
  "commercetools",
  "files-sdk",
  "workflow-sdk",
  "tui",
];
const peerPackages = {
  effect: "migrate-sdk",
  "@effect/platform-node": "migrate-sdk",
  "@commercetools/platform-sdk": "commercetools",
  "@commercetools/importapi-sdk": "commercetools",
  "files-sdk": "files-sdk",
  workflow: "workflow-sdk",
  react: "tui",
};
const customerPeers = Object.fromEntries(
  await Promise.all(
    Object.entries(peerPackages)
      .filter(([name]) => name !== "effect" && name !== "@effect/platform-node")
      .map(async ([name, directory]) => {
        const manifest = JSON.parse(
          await readFile(
            resolve(
              root,
              "packages",
              directory,
              "node_modules",
              name,
              "package.json"
            ),
            "utf8"
          )
        );
        return [name, manifest.version];
      })
  )
);
// Exercise automatic peer installation with the workspace-tested Workflow release.
const overrides = { workflow: customerPeers.workflow };
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

const temporary = await mkdtemp(join(tmpdir(), "migrate-customer-peers-"));
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
    for (const [name, owner] of Object.entries(peerPackages)) {
      if (name === "effect" || owner !== directory) {
        continue;
      }
      assert.match(
        published.peerDependencies?.[name] ?? "",
        /^\^\d+\.\d+\.\d+$/,
        `${name} must be a compatible customer peer`
      );
      assert.equal(
        published.dependencies?.[name],
        undefined,
        `${name} must use the customer's installation`
      );
      assert.notEqual(
        published.peerDependenciesMeta?.[name]?.optional,
        true,
        `${name} must be installed when missing`
      );
    }
    if (directory === "commercetools") {
      assert.equal(
        published.dependencies?.["@commercetools/sdk-client-v2"],
        undefined,
        "The example-only HTTP client builder must not be a runtime dependency"
      );
      assert.equal(
        published.peerDependencies?.["@commercetools/sdk-client-v2"],
        undefined
      );
    }
    if (directory === "migrate-sdk") {
      // pnpm pack resolves these ranges from the effect-peers catalog.
      customerPeers.effect = peerRange;
      customerPeers["@effect/platform-node"] =
        published.peerDependencies["@effect/platform-node"];
    }
    dependencies[manifest.name] = `file:${tarball}`;
  }

  const scenarios = [
    { name: "existing", peers: customerPeers },
    { name: "missing", peers: {} },
    {
      name: "incompatible-effect",
      peers: { ...customerPeers, effect: "3.22.3" },
      rejectedPeer: "effect",
    },
    {
      name: "incompatible-platform",
      peers: { ...customerPeers, "@effect/platform-node": "4.0.4" },
      rejectedPeer: "@effect/platform-node",
    },
  ];

  for (const manager of [npm, pnpm]) {
    for (const scenario of scenarios) {
      const mode = scenario.name;
      const cwd = join(temporary, `${manager}-${mode}`);
      await mkdir(cwd);
      await writeFile(
        join(cwd, "package.json"),
        `${JSON.stringify(
          {
            name: "migrate-effect-consumer",
            private: true,
            type: "module",
            packageManager,
            dependencies: { ...dependencies, ...scenario.peers },
            overrides,
            pnpm: { overrides },
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
      const result = run(
        manager,
        args,
        cwd,
        scenario.rejectedPeer !== undefined
      );
      if (scenario.rejectedPeer === undefined) {
        await copyFile(
          resolve(root, "scripts/fixtures/customer-peer-consumer.mjs"),
          join(cwd, "verify.mjs")
        );
        run(
          process.execPath,
          [
            "--experimental-import-meta-resolve",
            "verify.mjs",
            mode,
            ...Object.keys(dependencies),
          ],
          cwd
        );
      } else {
        assert.notEqual(
          result.status,
          0,
          `${manager} must reject incompatible ${scenario.rejectedPeer}`
        );
        const output = `${result.stdout}\n${result.stderr}`;
        assert.match(
          output,
          manager === pnpm ? /ERR_PNPM_PEER_DEP_ISSUES/ : /ERESOLVE/
        );
        assert.ok(output.includes(`peer ${scenario.rejectedPeer}@`), output);
      }
      process.stdout.write(`${manager}: ${mode} customer peers passed\n`);
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
