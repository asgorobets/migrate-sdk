import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const isWorkspaceRoot = (directory: string): boolean => {
  if (existsSync(resolve(directory, "pnpm-workspace.yaml"))) {
    return true;
  }
  try {
    const manifest = JSON.parse(
      readFileSync(resolve(directory, "package.json"), "utf8")
    ) as { readonly workspaces?: unknown };
    return manifest.workspaces !== undefined;
  } catch {
    return false;
  }
};

// Match the SDK config loader's search order and workspace boundaries before
// choosing which project's SDK will host the Node server.
const discoverConfigPath = (cwd: string): string => {
  let directory = resolve(cwd);
  while (true) {
    for (const extension of ["ts", "mts", "js", "mjs"]) {
      const candidate = resolve(directory, `migrate.config.${extension}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    const parent = dirname(directory);
    if (parent === directory || isWorkspaceRoot(directory)) {
      throw new Error("No migration config was found");
    }
    directory = parent;
  }
};

/** Resolve a real Node entry from the migration project, outside Bun's bundle. */
export const resolveProjectServerEntry = (
  input: { readonly configPath?: string; readonly cwd: string },
  expectedVersion: string
): URL => {
  const configPath =
    input.configPath === undefined
      ? discoverConfigPath(input.cwd)
      : resolve(input.cwd, input.configPath);
  const anchor = resolve(dirname(configPath), "package.json");
  const projectRequire = createRequire(pathToFileURL(anchor));
  // Resolve the consumer's package at runtime, outside the compiled module graph.
  const resolveFromProject = (specifier: string): string =>
    projectRequire.resolve(specifier);
  let manifestPath: string;
  try {
    manifestPath = resolveFromProject("migrate-sdk/package.json");
  } catch (cause) {
    throw new Error(
      `Install migrate-sdk@${expectedVersion} in the migration project to use the local TUI`,
      { cause }
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly version: string;
  };
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `Project Migrate SDK version ${manifest.version} does not match TUI ${expectedVersion}. ` +
        "Install matching migrate-sdk and @migrate-sdk/tui releases."
    );
  }
  try {
    return pathToFileURL(resolveFromProject("migrate-sdk/server/node"));
  } catch (cause) {
    throw new Error(
      "The project's Migrate SDK does not expose its Node server bootstrap. Update the SDK and TUI together.",
      { cause }
    );
  }
};
