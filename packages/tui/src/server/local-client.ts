import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { layerNet } from "@effect/platform-node/NodeSocket";
import { Layer, ManagedRuntime } from "effect";
import { layerProtocolSocket } from "effect/unstable/rpc/RpcClient";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { layerNdjson } from "effect/unstable/rpc/RpcSerialization";
import { MIGRATE_SDK_VERSION } from "migrate-sdk";
import { MigrateClient, type MigrateClientService } from "migrate-sdk/client";
import type { MigrateServerInfo } from "migrate-sdk/protocol";
import type { MigrateConnection } from "./connection.ts";
import { validateMigrateServerInfo } from "./connection.ts";
import {
  makeLocalMigrateServerEndpoint,
  removeLocalMigrateServerEndpoint,
} from "./local-endpoint.ts";

const defaultStartupTimeoutMs = 10_000;

export interface LocalMigrateConnectionInput {
  readonly configPath?: string;
  readonly cwd: string;
  readonly nodeExecutable?: string;
  readonly serverEntry?: URL;
  readonly startupTimeoutMs?: number;
}

const defaultServerEntry = (): URL => {
  const sourceEntry = new URL("./node-entry.ts", import.meta.url);
  const compiledSibling = new URL("./node-entry.js", import.meta.url);
  const compiledDistribution = new URL(
    "../../dist/server/node-entry.js",
    import.meta.url
  );
  const compiledEntries = [compiledSibling, compiledDistribution];
  const runningFromInstalledPackage = fileURLToPath(import.meta.url).includes(
    `${sep}node_modules${sep}`
  );
  const entries = runningFromInstalledPackage
    ? compiledEntries
    : [compiledSibling, sourceEntry, compiledDistribution];

  return (
    entries.find((entry) => existsSync(fileURLToPath(entry))) ?? sourceEntry
  );
};

const connectionError = (cause: unknown): Error => {
  const message = cause instanceof Error ? cause.message : String(cause);

  return new Error(
    `Unable to connect to the local Migrate Server: ${message}`,
    { cause }
  );
};

class LocalMigrateServerConnectionFailure extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.cause = cause;
  }
}

class LocalMigrateServerCompatibilityFailure extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.cause = cause;
  }
}

const isSocketTransportFailure = (cause: unknown): boolean =>
  cause instanceof RpcClientError &&
  (cause.reason._tag === "SocketOpenError" ||
    cause.reason._tag === "SocketCloseError" ||
    cause.reason._tag === "SocketReadError" ||
    cause.reason._tag === "SocketWriteError");

export const localMigrateServerEndpoint = ({
  configPath,
  cwd,
}: Pick<LocalMigrateConnectionInput, "configPath" | "cwd">): string => {
  const user = typeof process.getuid === "function" ? process.getuid() : "user";

  return makeLocalMigrateServerEndpoint(
    {
      ...(configPath === undefined ? {} : { configPath }),
      cwd,
    },
    {
      platform: process.platform,
      sdkVersion: MIGRATE_SDK_VERSION,
      ...(process.env.MIGRATE_TUI_SERVER_IDENTITY === undefined
        ? {}
        : {
            serverIdentity: process.env.MIGRATE_TUI_SERVER_IDENTITY,
          }),
      tempDirectory: tmpdir(),
      user,
    }
  );
};

const connectSocket = async (
  socketPath: string
): Promise<MigrateConnection> => {
  const ProtocolLive = layerProtocolSocket().pipe(
    Layer.provide(layerNet({ path: socketPath })),
    Layer.provide(layerNdjson)
  );
  const ClientLive = MigrateClient.streamingLayer.pipe(
    Layer.provide(ProtocolLive)
  );
  const runtime = ManagedRuntime.make(ClientLive);
  let disposed = false;
  const dispose = async () => {
    if (disposed) {
      return;
    }
    disposed = true;
    await runtime.dispose();
  };

  let client: MigrateClientService;
  try {
    client = await runtime.runPromise(MigrateClient);
  } catch (cause) {
    await dispose();
    throw new LocalMigrateServerConnectionFailure(cause);
  }

  let serverInfo: MigrateServerInfo;
  try {
    serverInfo = await runtime.runPromise(client.GetServerInfo());
    validateMigrateServerInfo(serverInfo);
    return {
      client,
      dispose,
      runPromise: (effect, options?: { readonly signal?: AbortSignal }) =>
        runtime.runPromise(effect, options),
      serverInfo,
    };
  } catch (cause) {
    await dispose();
    throw isSocketTransportFailure(cause)
      ? new LocalMigrateServerConnectionFailure(cause)
      : new LocalMigrateServerCompatibilityFailure(cause);
  }
};

const terminateOwnedServer = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolveExit) => {
    const onExit = () => resolveExit();
    child.once("exit", onExit);

    if (!child.kill("SIGKILL")) {
      child.off("exit", onExit);
      resolveExit();
    }
  });
};

const connectPersistentMigrateServer = async ({
  configPath,
  cwd,
  nodeExecutable = process.env.MIGRATE_TUI_NODE_EXECUTABLE ?? "node",
  serverEntry = defaultServerEntry(),
  startupTimeoutMs = defaultStartupTimeoutMs,
}: LocalMigrateConnectionInput): Promise<MigrateConnection> => {
  const socketPath = localMigrateServerEndpoint({
    ...(configPath === undefined ? {} : { configPath }),
    cwd,
  });

  try {
    return await connectSocket(socketPath);
  } catch (cause) {
    if (cause instanceof LocalMigrateServerCompatibilityFailure) {
      throw connectionError(cause.cause);
    }
    removeLocalMigrateServerEndpoint(socketPath);
  }

  const child = spawn(
    nodeExecutable,
    [
      fileURLToPath(serverEntry),
      "--cwd",
      cwd,
      "--socket",
      socketPath,
      ...(configPath === undefined ? [] : ["--config", configPath]),
    ],
    {
      cwd,
      detached: true,
      env: process.env,
      stdio: "ignore",
    }
  );
  let startupError: unknown;
  child.once("error", (cause) => {
    startupError = cause;
  });
  child.unref();

  try {
    const deadline = Date.now() + startupTimeoutMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
      if (startupError !== undefined) {
        throw startupError;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Local Migrate Server exited before startup completed (${child.exitCode ?? child.signalCode})`
        );
      }

      try {
        return await connectSocket(socketPath);
      } catch (cause) {
        if (cause instanceof LocalMigrateServerCompatibilityFailure) {
          throw cause.cause;
        }
        lastError =
          cause instanceof LocalMigrateServerConnectionFailure
            ? cause.cause
            : cause;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
    }

    throw (
      lastError ??
      new Error(`Local Migrate Server startup exceeded ${startupTimeoutMs}ms`)
    );
  } catch (cause) {
    await terminateOwnedServer(child);
    throw connectionError(cause);
  }
};

export const connectLocalMigrateServer = (
  input: LocalMigrateConnectionInput
): Promise<MigrateConnection> => connectPersistentMigrateServer(input);
