import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { releaseBinaryTargets } from "../bin/binary-targets.js";
import { packageManagerCommand } from "./package-manager.mjs";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

export async function validateNativeRelease(directory, manifest, revision) {
  const distribution = await readJson(resolve(directory, "distribution.json"));
  const targets = releaseBinaryTargets.map((target) => target.id).sort();
  if (
    distribution.releaseReady !== true ||
    distribution.version !== manifest.version ||
    distribution.revision !== revision ||
    JSON.stringify([...distribution.targets].sort()) !== JSON.stringify(targets)
  ) {
    throw new Error(
      "Native release requires every tested target at the current version and revision"
    );
  }
  const packages = Object.fromEntries(
    releaseBinaryTargets.map((target) => [target.packageName, manifest.version])
  );
  if (
    JSON.stringify(Object.entries(distribution.packages).sort()) !==
    JSON.stringify(Object.entries(packages).sort())
  ) {
    throw new Error("Native release platform package versions do not match");
  }
  const umbrella = await readJson(
    resolve(directory, "packages/tui/package.json")
  );
  if (
    umbrella.name !== manifest.name ||
    umbrella.version !== manifest.version ||
    umbrella.private !== false ||
    umbrella.migrateTuiBinaryDistribution !== true ||
    umbrella.migrateTuiSourceRevision !== revision ||
    Object.keys(umbrella.dependencies ?? {}).length !== 0 ||
    Object.keys(umbrella.scripts ?? {}).length !== 0 ||
    Object.keys(umbrella.peerDependencies ?? {}).some(
      (name) => umbrella.peerDependenciesMeta?.[name]?.optional !== true
    ) ||
    JSON.stringify(Object.entries(umbrella.optionalDependencies).sort()) !==
      JSON.stringify(Object.entries(packages).sort())
  ) {
    throw new Error(
      "Native launcher must use only exact platform dependencies and no required JavaScript peers or scripts"
    );
  }
  const checksums = new Map(
    (await readFile(resolve(directory, "SHA256SUMS"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => {
        const [hash, filename] = line.split("  ");
        return [filename, hash];
      })
  );
  const releases = [];
  for (const target of releaseBinaryTargets) {
    const native = await readJson(
      resolve(directory, "packages", target.id, "package.json")
    );
    if (
      native.name !== target.packageName ||
      native.version !== manifest.version ||
      native.private !== false ||
      native.migrateTuiSourceRevision !== revision
    ) {
      throw new Error(`Invalid native package: ${target.packageName}`);
    }
    releases.push({
      name: target.packageName,
      version: manifest.version,
      tarball: resolve(
        directory,
        "tarballs",
        `migrate-sdk-tui-${target.id}-${manifest.version}.tgz`
      ),
    });
  }
  for (const release of [
    ...releases,
    {
      tarball: resolve(
        directory,
        "tarballs",
        `migrate-sdk-tui-${manifest.version}.tgz`
      ),
    },
  ]) {
    const relative = `tarballs/${basename(release.tarball)}`;
    const actual = createHash("sha256")
      .update(await readFile(release.tarball))
      .digest("hex");
    if (checksums.get(relative) !== actual) {
      throw new Error(`Native release checksum mismatch: ${relative}`);
    }
  }
  return releases;
}

function npm(args) {
  const invocation = packageManagerCommand(["exec", "npm", ...args]);
  const result = spawnSync(invocation.executable, invocation.args, {
    encoding: "utf8",
    cwd: resolve(import.meta.dirname, ".."),
    env: { ...process.env, NPM_CONFIG_IGNORE_SCRIPTS: "true" },
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

export function publishedPackage(name, version, run = npm) {
  const result = run([
    "view",
    `${name}@${version}`,
    "--json",
    "--prefer-online",
  ]);
  if (result.status === 0) {
    return JSON.parse(result.stdout);
  }
  // Authentication/network failures must not be interpreted as unpublished versions.
  let code;
  try {
    code = JSON.parse(result.stdout).error?.code;
  } catch {
    // npm reports some failures only on stderr.
  }
  if (code === "E404") {
    return;
  }
  throw new Error(
    `Unable to check ${name}@${version}:\n${result.stdout}${result.stderr}`
  );
}

export function publishNativePackages(releases, revision, run = npm) {
  for (const release of releases) {
    const published = publishedPackage(release.name, release.version, run);
    if (published) {
      if (published.migrateTuiSourceRevision !== revision) {
        throw new Error(
          `Published ${release.name}@${release.version} belongs to another source revision`
        );
      }
      console.log(`Already published ${release.name}@${release.version}`);
      continue;
    }
    const result = run([
      "publish",
      release.tarball,
      "--access",
      "public",
      "--ignore-scripts",
    ]);
    if (result.status !== 0) {
      throw new Error(
        `Native publish failed for ${release.name}:\n${result.stdout}${result.stderr}`
      );
    }
    const verified = publishedPackage(release.name, release.version, run);
    if (verified?.migrateTuiSourceRevision !== revision) {
      throw new Error(
        `Cannot verify published ${release.name}@${release.version}; launcher publication stopped`
      );
    }
    console.log(`Published ${release.name}@${release.version}`);
  }
}

async function main(args) {
  if (!(args.length === 0 || (args.length === 1 && args[0] === "--dry-run"))) {
    throw new Error("Usage: publish-native.mjs [--dry-run]");
  }
  const packageDirectory = resolve(import.meta.dirname, "..");
  const manifestPath = resolve(packageDirectory, "package.json");
  const manifest = await readJson(manifestPath);
  const revision = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: packageDirectory,
    encoding: "utf8",
  });
  if (revision.status !== 0) {
    throw new Error("Unable to identify the release source revision");
  }
  const sourceRevision = revision.stdout.trim();
  const releases = await validateNativeRelease(
    resolve(packageDirectory, "dist/distribution"),
    manifest,
    sourceRevision
  );
  if (args.includes("--dry-run")) {
    console.log(
      JSON.stringify(
        {
          platforms: releases,
          launcher: `${manifest.name}@${manifest.version}`,
        },
        null,
        2
      )
    );
    return;
  }
  if (publishedPackage(manifest.name, manifest.version)) {
    console.log(
      `${manifest.name}@${manifest.version} is already published; waiting for the next Changesets version`
    );
    return;
  }
  publishNativePackages(releases, sourceRevision);
  // Changesets publishes this staged native launcher instead of the development
  // package. Keep this override ephemeral so workspace installs still use Bun.
  manifest.publishConfig.directory = "dist/distribution/packages/tui";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const withChangesets = process.argv[2] === "--with-changesets";
  await main(process.argv.slice(withChangesets ? 3 : 2));
  if (withChangesets) {
    const command = packageManagerCommand(["exec", "changeset", "publish"]);
    const result = spawnSync(command.executable, command.args, {
      cwd: resolve(import.meta.dirname, "../../.."),
      stdio: "inherit",
    });
    if (result.error) {
      throw result.error;
    }
    process.exitCode = result.status ?? 1;
  }
}
