import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  binaryTargets,
  findBinaryTarget,
  releaseBinaryTargets,
} from "../bin/binary-targets.js";
import { packageManagerCommand } from "./package-manager.mjs";
import { verifyBinary } from "./verify-binary.mjs";

const packageDirectory = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  await readFile(resolve(packageDirectory, "package.json"), "utf8")
);
const outputDirectory = resolve(packageDirectory, "dist/distribution");
const args = process.argv.slice(2);
const release = args.length === 1 && args[0] === "--release";
if (
  !(
    release ||
    args.length === 0 ||
    (args.length === 2 && args[0] === "--target")
  )
) {
  throw new Error(
    "Usage: package-binaries.mjs [--target <target-id> | --release]"
  );
}
const buildDirectories = await readdir(
  resolve(packageDirectory, "dist/binary")
);
let selected = binaryTargets.filter((item) =>
  buildDirectories.includes(item.id)
);
if (release) {
  selected = releaseBinaryTargets;
} else if (args.length === 2) {
  selected = [findBinaryTarget(args[1])];
}
if (selected.length === 0) {
  throw new Error("Build at least one binary before packaging");
}

function run(command, commandArgs, options = {}) {
  const invocation =
    command === "pnpm"
      ? packageManagerCommand(commandArgs)
      : { executable: command, args: commandArgs };
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd: options.cwd ?? packageDirectory,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} failed:\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

async function json(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function pack(directory) {
  const result = JSON.parse(
    run(
      "pnpm",
      [
        "exec",
        "npm",
        "pack",
        "--ignore-scripts",
        "--cache",
        resolve(outputDirectory, ".npm-cache"),
        "--json",
        "--pack-destination",
        resolve(outputDirectory, "tarballs"),
      ],
      { cwd: directory, env: { npm_config_ignore_scripts: "true" } }
    )
  );
  return resolve(outputDirectory, "tarballs", basename(result[0].filename));
}

function archive(target, nativeDirectory) {
  const stem = `migrate-tui-${manifest.version}-${target.id}`;
  const filename = `${stem}.${target.platform === "win32" ? "zip" : "tar.gz"}`;
  const destination = resolve(outputDirectory, "archives", filename);
  if (target.platform === "win32") {
    if (process.platform === "win32") {
      run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Compress-Archive -Path (Join-Path $env:MIGRATE_ARCHIVE_SOURCE '*') -DestinationPath $env:MIGRATE_ARCHIVE_DESTINATION -Force",
        ],
        {
          env: {
            MIGRATE_ARCHIVE_SOURCE: nativeDirectory,
            MIGRATE_ARCHIVE_DESTINATION: destination,
          },
        }
      );
    } else {
      run("zip", ["-q", "-r", destination, "bin", "build.json", "README.md"], {
        cwd: nativeDirectory,
      });
    }
  } else {
    run("tar", [
      "-czf",
      destination,
      "-C",
      nativeDirectory,
      "bin",
      "build.json",
      "README.md",
    ]);
  }
  return destination;
}

// Validate every input before replacing a previously staged distribution.
const sourceRevision = run("git", ["rev-parse", "HEAD"]).trim();
const builds = await Promise.all(
  selected.map(async (target) => {
    const directory = resolve(packageDirectory, "dist/binary", target.id);
    const metadata = JSON.parse(
      await readFile(resolve(directory, "build.json"), "utf8")
    );
    const bytes = await readFile(resolve(directory, target.executable));
    verifyBinary(bytes, target);
    if (metadata.revision !== sourceRevision) {
      throw new Error(
        `Binary source revision for ${target.id} does not match the current checkout; rebuild before packaging`
      );
    }
    if (
      metadata.version !== manifest.version ||
      metadata.target !== target.id ||
      metadata.bun !== manifest.dependencies.bun ||
      metadata.opentui !== manifest.dependencies["@opentui/core"] ||
      metadata.compileTarget !== target.compileTarget ||
      metadata.executable !== target.executable ||
      metadata.bytes !== bytes.length ||
      metadata.sha256 !== createHash("sha256").update(bytes).digest("hex")
    ) {
      throw new Error(
        `Stale or modified binary for ${target.id}; rebuild before packaging`
      );
    }
    return { target, directory, metadata };
  })
);
const temp = await mkdtemp(join(tmpdir(), "migrate-tui-pack-"));
try {
  // pnpm rewrites workspace/catalog versions and applies the existing package file allowlist.
  run("pnpm", ["pack", "--pack-destination", temp]);
  const [baseTarball] = (await readdir(temp)).filter((file) =>
    file.endsWith(".tgz")
  );
  if (!baseTarball) {
    throw new Error("Base TUI tarball was not produced");
  }
  await rm(outputDirectory, { recursive: true, force: true });
  for (const directory of ["packages", "archives", "tarballs"]) {
    await mkdir(resolve(outputDirectory, directory), { recursive: true });
  }
  const packages = {};
  const artifacts = [];
  for (const { target, directory, metadata } of builds) {
    const nativeDirectory = resolve(outputDirectory, "packages", target.id);
    await mkdir(resolve(nativeDirectory, "bin"), { recursive: true });
    await copyFile(
      resolve(directory, target.executable),
      resolve(nativeDirectory, "bin", target.executable)
    );
    await chmod(resolve(nativeDirectory, "bin", target.executable), 0o755);
    await json(resolve(nativeDirectory, "build.json"), metadata);
    await writeFile(
      resolve(nativeDirectory, "README.md"),
      `# Migrate TUI (${target.id})\n\nNative executable for @migrate-sdk/tui@${manifest.version}.\nRemote use needs no Node or Bun. Local use requires Node >=22.19.0 and a matching project SDK.\n\nSource: https://github.com/asgorobets/migrate-sdk\n`
    );
    await json(resolve(nativeDirectory, "package.json"), {
      name: target.packageName,
      private: !release,
      version: manifest.version,
      description: `${manifest.description} (${target.id})`,
      repository: manifest.repository,
      ...(manifest.license === undefined ? {} : { license: manifest.license }),
      os: [target.platform],
      cpu: [target.arch],
      ...(target.libc === undefined ? {} : { libc: [target.libc] }),
      files: ["bin", "build.json", "README.md"],
      publishConfig: { access: "public" },
      migrateTuiSourceRevision: sourceRevision,
    });
    packages[target.packageName] = manifest.version;
    artifacts.push(pack(nativeDirectory), archive(target, nativeDirectory));
  }
  const umbrella = resolve(outputDirectory, "packages/tui");
  await mkdir(umbrella);
  run("tar", [
    "-xzf",
    resolve(temp, baseTarball),
    "-C",
    umbrella,
    "--strip-components=1",
  ]);
  const stagedManifestPath = resolve(umbrella, "package.json");
  const staged = JSON.parse(await readFile(stagedManifestPath, "utf8"));
  // The executable contains the renderer dependencies. Optional peers retain
  // the JavaScript API without installing its dependency tree for CLI users.
  staged.peerDependencies = Object.fromEntries(
    Object.entries({
      ...staged.peerDependencies,
      ...staged.dependencies,
    }).filter(([name]) => name !== "bun")
  );
  staged.peerDependenciesMeta = Object.fromEntries(
    Object.keys(staged.peerDependencies).map((name) => [
      name,
      { optional: true },
    ])
  );
  staged.dependencies = undefined;
  staged.devDependencies = undefined;
  staged.scripts = undefined;
  staged.optionalDependencies = packages;
  staged.migrateTuiBinaryDistribution = true;
  staged.private = !release;
  staged.migrateTuiSourceRevision = sourceRevision;
  await json(stagedManifestPath, staged);
  artifacts.push(pack(umbrella));
  const checksums = await Promise.all(
    artifacts.map(async (path) => {
      const hash = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      const relative = path
        .slice(outputDirectory.length + 1)
        .replaceAll("\\", "/");
      return `${hash}  ${relative}`;
    })
  );
  await writeFile(
    resolve(outputDirectory, "SHA256SUMS"),
    `${checksums.sort().join("\n")}\n`
  );
  await json(resolve(outputDirectory, "distribution.json"), {
    version: manifest.version,
    revision: sourceRevision,
    targets: selected.map((target) => target.id),
    packages,
    releaseReady: release,
    signed: false,
  });
  console.log(
    `Staged ${selected.length} target(s), npm packages, archives, and SHA256SUMS in ${outputDirectory}`
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
