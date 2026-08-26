import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

export interface LocalMigrateServerEndpointInput {
  readonly configPath?: string;
  readonly cwd: string;
}

export interface LocalMigrateServerEndpointEnvironment {
  readonly platform: NodeJS.Platform;
  readonly sdkVersion: string;
  readonly serverIdentity?: string;
  readonly tempDirectory: string;
  readonly user: number | string;
}

export const makeLocalMigrateServerEndpoint = (
  { configPath, cwd }: LocalMigrateServerEndpointInput,
  environment: LocalMigrateServerEndpointEnvironment
): string => {
  const identity = JSON.stringify({
    configPath: configPath === undefined ? undefined : resolve(cwd, configPath),
    cwd: resolve(cwd),
    sdkVersion: environment.sdkVersion,
    serverIdentity: environment.serverIdentity,
  });
  const digest = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 24);
  const name = `migrate-${environment.user}-${digest}`;

  return environment.platform === "win32"
    ? `\\\\.\\pipe\\${name}`
    : join(environment.tempDirectory, `${name}.sock`);
};

export const removeLocalMigrateServerEndpoint = (
  endpoint: string,
  platform: NodeJS.Platform = process.platform
): void => {
  if (platform === "win32") {
    return;
  }

  try {
    unlinkSync(endpoint);
  } catch (cause) {
    if (
      !(cause instanceof Error && "code" in cause) ||
      (cause as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw cause;
    }
  }
};
